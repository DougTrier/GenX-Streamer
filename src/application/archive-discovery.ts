/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createArchiveCatalog,
  isArchiveDiscoverySourceFailure,
  validateArchiveDiscoverReceipt,
  validateArchiveProgress,
  validateArchiveDiscoveryView,
  type ArchiveDiscoveryView,
  type ArchiveDiscoverReceipt,
  type ArchiveProgress,
  type ArchiveDecade,
  type ArchiveFileProgress,
} from '../platform/archive-catalog';
import { boundedUtf8Text } from '../platform/bounded-text';
import { createOwnedAbortSignals } from '../platform/abort';
import {
  validatePublicArchiveDiscoverReceipt,
  type PublicArchiveDiscoverReceipt,
} from '../platform/archive-public-providers';

export type ArchiveDiscoveryIntent = 'search' | 'continue' | 'rescan';
export type ArchiveDiscoveryState =
  | 'idle'
  | 'reading'
  | 'discovering'
  | 'complete'
  | 'partial'
  | 'waiting'
  | 'capacity'
  | 'canceled'
  | 'failed'
  | 'disposed';
export interface ArchiveDiscoverySnapshot {
  pendingFilePages: ArchiveFileProgress[];
  state: ArchiveDiscoveryState;
  generation: number;
  query: string;
  decade: ArchiveDecade | null;
  year: number | null;
  page: number | null;
  revision: string | null;
  examined: number;
  admitted: number;
  excludedUnknownYear: number;
  unavailable: number;
  transientFailures: number;
  confirmedDead: number;
  titleCount: number;
  yearsChecked: number;
  yearsTotal: number;
  yearsComplete: number;
  yearsPending: number;
  capacityReached: boolean;
  /** Absolute epoch-millisecond deadline from native durable progress. */
  retryAfterMs: number | null;
  message: string | null;
}
export interface ArchiveDiscoveryResult {
  revision: string;
  outcome: 'complete' | 'partial' | 'waiting' | 'capacity' | 'canceled';
  examined: number;
  admitted: number;
}
export interface ArchiveDiscoveryHost {
  catalog?: Pick<ReturnType<typeof createArchiveCatalog>, 'progress' | 'discoverStep'> &
    Partial<Pick<ReturnType<typeof createArchiveCatalog>, 'publicDiscoverStep'>>;
  /** Stable application/storage epoch. It must not depend on tab, query or catalog revision. */
  readyScope(): string | null;
  now?(): number;
  /** Synchronous metadata observation; must not launch acquisition work. */
  progress?(snapshot: Readonly<ArchiveDiscoverySnapshot>): void;
  /** Metadata reconciliation only; the receipt is authoritative even on late abort. */
  committed?(receipt: Readonly<ArchiveDiscoverReceipt>): void | Promise<void>;
  publicCommitted?(receipt: Readonly<PublicArchiveDiscoverReceipt>): void | Promise<void>;
}
export class ArchiveDiscoveryError extends Error {
  constructor(readonly revision: string | null) {
    super(
      'Archive discovery stopped. Saved progress was reloaded where possible; select Search to continue.',
    );
  }
}
const canceled = () => new DOMException('Archive discovery was canceled.', 'AbortError');
function queryText(value: string): string {
  if (!boundedUtf8Text(value, 256, true) || /[\p{Cc}\p{Cf}]/u.test(value) || value.includes('://'))
    throw new Error('The Archive search text is invalid.');
  return value.trim();
}
function initial(generation = 0, query = ''): ArchiveDiscoverySnapshot {
  return {
    pendingFilePages: [],
    state: 'idle',
    generation,
    query,
    decade: null,
    year: null,
    page: null,
    revision: null,
    examined: 0,
    admitted: 0,
    excludedUnknownYear: 0,
    unavailable: 0,
    transientFailures: 0,
    confirmedDead: 0,
    titleCount: 0,
    yearsChecked: 0,
    yearsTotal: query ? 0 : 40,
    yearsComplete: 0,
    yearsPending: 0,
    capacityReached: false,
    retryAfterMs: null,
    message: null,
  };
}

/** Explicit, finite acquisition coordinator. Construction/typing never starts native work. */
export function createArchiveDiscovery(host: ArchiveDiscoveryHost) {
  const catalog = host.catalog ?? createArchiveCatalog();
  const now = host.now ?? (() => Date.now());
  let generation = 0;
  let owner: AbortController | null = null;
  let queue: Promise<void> = Promise.resolve();
  let closing = false,
    closed = false;
  let disposal: Promise<void> | null = null;
  let snapshot = initial();
  let durableObservation: { snapshot: ArchiveDiscoverySnapshot; scope: string } | null = null;
  const listeners = new Set<(snapshot: Readonly<ArchiveDiscoverySnapshot>) => void>();
  const failedSignals = new Set<() => void>();
  const disposeSignals = (dispose: () => void) => {
    try {
      dispose();
      failedSignals.delete(dispose);
    } catch {
      failedSignals.add(dispose);
      throw new Error('Archive discovery cleanup could not finish. Retry Stop.');
    }
  };
  const notify = (value: ArchiveDiscoverySnapshot, guard: () => boolean = () => true) => {
    if (!guard()) return;
    snapshot = { ...value };
    const observation = { ...snapshot };
    for (const callback of [host.progress, ...listeners]) {
      if (!guard()) break;
      try {
        callback?.({ ...observation });
      } catch {
        /* Optional observers do not own acquisition. */
      }
    }
  };
  const active = (captured: number, owned: AbortController, signal: AbortSignal, scope: string) =>
    !closed &&
    !closing &&
    generation === captured &&
    owner === owned &&
    !signal.aborted &&
    host.readyScope() === scope;
  function discover(
    rawQuery: string,
    signal?: AbortSignal,
    intent: ArchiveDiscoveryIntent = 'search',
    decade: ArchiveDecade | null = null,
    view?: ArchiveDiscoveryView,
  ): Promise<ArchiveDiscoveryResult> {
    if (closed || closing) return Promise.reject(new Error('Archive discovery is closed.'));
    const query = queryText(rawQuery);
    // Copy primitive view values before queuing/awaiting; filter controls may change.
    const capturedView = view === undefined ? undefined : validateArchiveDiscoveryView(view);
    if (decade !== null && ![1960, 1970, 1980, 1990, 2000, 2010, 2020].includes(decade))
      return Promise.reject(new Error('The Archive decade is invalid.'));
    if (!query && decade !== null && decade >= 2000)
      return Promise.reject(
        new Error('Archive curation covers 1960 through 1999. Use a named search for newer years.'),
      );
    if (!['search', 'continue', 'rescan'].includes(intent))
      return Promise.reject(new Error('The Archive discovery action is invalid.'));
    signal?.throwIfAborted();
    const scope = host.readyScope();
    if (scope === null)
      return Promise.reject(new Error('Archive discovery is waiting for local storage.'));
    const captured = ++generation;
    owner?.abort();
    const owned = new AbortController();
    owner = owned;
    const combined = createOwnedAbortSignals(signal ? [owned.signal, signal] : [owned.signal]);
    const status = initial(captured, query);
    status.decade = decade;
    status.yearsTotal = query ? 0 : decade === null ? 40 : 10;
    let lastCommitted: ArchiveDiscoverReceipt | PublicArchiveDiscoverReceipt | null = null;
    let revision: string | null = null;
    let currentYear: number | null = query ? null : (decade ?? 1960);
    const check = () => {
      if (!active(captured, owned, combined.signal, scope)) throw canceled();
    };
    const publish = (state: ArchiveDiscoveryState, message: string | null = null) => {
      status.state = state;
      status.message = message;
      if (active(captured, owned, combined.signal, scope))
        notify(status, () => active(captured, owned, combined.signal, scope));
    };
    const result = (outcome: ArchiveDiscoveryResult['outcome']): ArchiveDiscoveryResult => {
      if (revision === null) throw canceled();
      return { revision, outcome, examined: status.examined, admitted: status.admitted };
    };
    const read = async (year: number | null): Promise<ArchiveProgress> => {
      check();
      currentYear = year;
      status.year = year;
      publish('reading', 'Reading saved Archive progress…');
      const request = { schemaVersion: 1 as const, query, year, decade };
      const progress = validateArchiveProgress(
        await catalog.progress(request, combined.signal),
        request,
      );
      check();
      revision = progress.revision;
      status.revision = revision;
      status.titleCount = progress.titleCount;
      status.page = progress.nextPage;
      return progress;
    };
    const write = async (
      year: number | null,
      page: number,
      restart: boolean,
    ): Promise<ArchiveDiscoverReceipt> => {
      check();
      if (revision === null) throw new ArchiveDiscoveryError(null);
      status.year = year;
      status.page = page;
      publish(
        'discovering',
        year === null
          ? 'Checking Archive search candidates…'
          : `Checking Archive candidates for ${year}…`,
      );
      const request = {
        schemaVersion: 1 as const,
        query,
        year,
        decade,
        page,
        expectedRevision: revision,
        explicitAction: true as const,
        ...(restart ? { restart: true } : {}),
        ...(query && capturedView ? { view: { ...capturedView } } : {}),
      };
      const receipt = validateArchiveDiscoverReceipt(
        await catalog.discoverStep(request, combined.signal),
        request,
      );
      // Capture actual COMMIT before checking late cancellation or an obsolete UI scope.
      lastCommitted = receipt;
      revision = receipt.revision;
      status.revision = revision;
      status.titleCount = receipt.titleCount;
      status.pendingFilePages = receipt.pendingFilePages.map((item) => ({ ...item }));
      status.examined += receipt.examined;
      status.admitted += receipt.admitted;
      status.excludedUnknownYear += receipt.excludedUnknownYear;
      status.unavailable += receipt.unavailable;
      status.transientFailures += receipt.transientFailures;
      status.confirmedDead += receipt.confirmedDead;
      if (host.readyScope() === scope) durableObservation = { snapshot: { ...status }, scope };
      if (host.readyScope() === scope) {
        try {
          await host.committed?.({ ...receipt });
        } catch {
          /* A failed observer cannot erase COMMIT. */
        }
      }
      check();
      return receipt;
    };
    const work = queue.then(async (): Promise<ArchiveDiscoveryResult> => {
      try {
        for (const cleanup of [...failedSignals]) disposeSignals(cleanup);
        check();
        if (query) {
          let progress = await read(null);
          let publicIncomplete = false;
          if (catalog.publicDiscoverStep && !capturedView?.favoritesOnly) {
            const request = {
              schemaVersion: 1 as const,
              expectedRevision: progress.revision,
              query,
              decade,
              languageMode: capturedView?.languageMode ?? ('all' as const),
              contentType: capturedView?.contentType ?? ('all' as const),
              curatedOnly: capturedView?.curatedOnly ?? false,
              favoritesOnly: false,
              restart: intent === 'rescan',
              explicitAction: true as const,
            };
            publish('discovering', 'Checking public archive sources…');
            const receipt = validatePublicArchiveDiscoverReceipt(
              await catalog.publicDiscoverStep(request, combined.signal),
              request,
            );
            // Retain a durable receipt even when cancellation arrives after COMMIT.
            lastCommitted = receipt;
            revision = receipt.revision;
            status.revision = revision;
            status.examined += receipt.examined;
            status.admitted += receipt.admitted;
            publicIncomplete =
              receipt.more || receipt.providers.some((p) => p.state !== 'complete');
            if (host.readyScope() === scope) {
              durableObservation = { snapshot: { ...status }, scope };
              try {
                await host.publicCommitted?.(receipt);
              } catch {
                /* COMMIT remains authoritative. */
              }
            }
            check();
            // All subsequent IA reads/writes use the post-public catalog revision.
            progress = await read(null);
          }
          let next = intent === 'rescan' ? 1 : progress.nextPage;
          if (intent !== 'rescan' && progress.complete) {
            publish(
              publicIncomplete ? 'partial' : 'complete',
              publicIncomplete
                ? 'Available matches are saved. Some sources have more results or are unavailable; select Search to continue.'
                : 'The checked archive search pages are complete.',
            );
            return result(publicIncomplete ? 'partial' : 'complete');
          }
          if (intent !== 'rescan' && (progress.capacityReached || next > 20)) {
            status.capacityReached = true;
            publish('capacity', 'The bounded Archive search reached its page limit.');
            return result('capacity');
          }
          if (progress.retryAfterMs !== null && progress.retryAfterMs > now()) {
            status.retryAfterMs = progress.retryAfterMs;
            publish(
              'waiting',
              'Archive is temporarily unavailable. Saved progress will be retried after its deadline.',
            );
            return result('waiting');
          }
          // Reserve two IA pages when public sources share this click; IA-only
          // adapters retain their three-page bound. View-aware callers
          // stop on new visible identities, never a duplicate/filtered admission.
          // Legacy callers keep their receipt/admission behavior. No sweep/retry.
          const maxPages = catalog.publicDiscoverStep ? 2 : 3;
          for (let attempt = 0; attempt < maxPages; attempt++) {
            const receipt = await write(null, next, intent === 'rescan' && attempt === 0);
            status.capacityReached = receipt.capacityReached;
            status.retryAfterMs = receipt.retryAfterMs;
            if (receipt.transientFailures > 0 || receipt.retryAfterMs !== null) {
              publish(
                'waiting',
                'Some archive checks were inconclusive. Search resumes the saved page after its retry deadline.',
              );
              return result('waiting');
            }
            if (receipt.capacityReached) {
              publish(
                'capacity',
                'The bounded Archive search reached its page limit; other matches may exist.',
              );
              return result('capacity');
            }
            if (receipt.nextPage === null) {
              publish(
                publicIncomplete ? 'partial' : 'complete',
                publicIncomplete
                  ? 'Available matches are saved. Some sources have more results or are unavailable; select Search to continue.'
                  : 'The checked archive search pages are complete.',
              );
              return result(publicIncomplete ? 'partial' : 'complete');
            }
            next = receipt.nextPage;
            if (capturedView ? receipt.newVisibleMatches! > 0 : receipt.admitted > 0) break;
            if (attempt < maxPages - 1) {
              progress = await read(null);
              next = progress.nextPage;
              if (progress.complete) {
                publish(
                  publicIncomplete ? 'partial' : 'complete',
                  publicIncomplete
                    ? 'Some sources have more results or are unavailable. Search continues the saved search.'
                    : 'The checked archive search pages are complete.',
                );
                return result(publicIncomplete ? 'partial' : 'complete');
              }
              if (progress.capacityReached || next > 20) {
                status.capacityReached = true;
                publish('capacity', 'The bounded Archive search reached its page limit.');
                return result('capacity');
              }
              if (progress.retryAfterMs !== null && progress.retryAfterMs > now()) {
                status.retryAfterMs = progress.retryAfterMs;
                publish('waiting', 'Saved Archive progress is waiting for its retry deadline.');
                return result('waiting');
              }
            }
          }
          publish(
            'partial',
            status.admitted
              ? 'Archive candidates were saved. Search continues from the saved page.'
              : 'No suitable entries in the checked pages. Search continues the saved search.',
          );
          return result('partial');
        }
        // One next page per year per explicit pass: at most 40 native steps.
        // Native persists each acknowledged cursor and caps every year at 20 pages.
        for (let year = decade ?? 1960; year <= (decade === null ? 1999 : decade + 9); year++) {
          const progress = await read(year);
          status.yearsChecked++;
          if (progress.retryAfterMs !== null && progress.retryAfterMs > now()) {
            status.retryAfterMs = Math.max(status.retryAfterMs ?? 0, progress.retryAfterMs);
            status.yearsPending++;
            continue;
          }
          if (intent !== 'rescan' && progress.complete) {
            status.yearsComplete++;
            continue;
          }
          if (intent !== 'rescan' && (progress.capacityReached || progress.nextPage > 20)) {
            status.capacityReached = true;
            continue;
          }
          const receipt = await write(
            year,
            intent === 'rescan' ? 1 : progress.nextPage,
            intent === 'rescan',
          );
          status.capacityReached ||= receipt.capacityReached;
          if (receipt.retryAfterMs !== null)
            status.retryAfterMs = Math.max(status.retryAfterMs ?? 0, receipt.retryAfterMs);
          if (
            receipt.nextPage === null &&
            !receipt.capacityReached &&
            receipt.transientFailures === 0
          )
            status.yearsComplete++;
          else if (!receipt.capacityReached) status.yearsPending++;
        }
        if (status.yearsComplete === status.yearsTotal) {
          publish(
            'complete',
            'All selected year searches reached their native completion checkpoints.',
          );
          return result('complete');
        }
        publish(
          'partial',
          'The bounded year pass finished. Saved year cursors remain available for explicit Continue; counts below ten are valid.',
        );
        return result('partial');
      } catch (error) {
        if (!active(captured, owned, combined.signal, scope)) {
          if (lastCommitted !== null) return result('canceled');
          throw canceled();
        }
        // Native may have refused CAS or progress ownership. Read the exact saved
        // cursor once; never guess a revision or retry a write blindly.
        let rereadSucceeded = false;
        try {
          await read(currentYear);
          rereadSucceeded = true;
        } catch {
          /* The fixed error reports that refetch may be unavailable. */
        }
        if (!active(captured, owned, combined.signal, scope)) {
          if (lastCommitted !== null) return result('canceled');
          throw canceled();
        }
        if (lastCommitted !== null && rereadSucceeded && isArchiveDiscoverySourceFailure(error)) {
          status.transientFailures++;
          publish(
            'waiting',
            'Some archive sources could not be checked. Saved matches are available; Search can continue later.',
          );
          return result('waiting');
        }
        publish(
          'failed',
          'Archive discovery stopped. Saved progress was reloaded where possible; select Search to continue.',
        );
        void error;
        throw new ArchiveDiscoveryError(revision);
      } finally {
        disposeSignals(combined.dispose);
        if (owner === owned) owner = null;
      }
    });
    queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  async function stop(): Promise<void> {
    if (closed) return;
    const captured = ++generation;
    const scope = host.readyScope();
    const interrupted = owner !== null;
    owner?.abort();
    const joined = queue;
    await joined;
    for (const cleanup of [...failedSignals]) disposeSignals(cleanup);
    if (interrupted && captured === generation && !closing) {
      const acknowledged =
        durableObservation?.scope === scope &&
        host.readyScope() === scope &&
        durableObservation.snapshot.generation === snapshot.generation
          ? durableObservation.snapshot
          : snapshot;
      notify(
        {
          ...acknowledged,
          state: 'canceled',
          generation: captured,
          message: 'Archive discovery canceled. Acknowledged native progress is saved.',
        },
        () => captured === generation && !closing,
      );
    }
  }
  return {
    get snapshot(): Readonly<ArchiveDiscoverySnapshot> {
      return { ...snapshot };
    },
    subscribe(listener: (snapshot: Readonly<ArchiveDiscoverySnapshot>) => void): () => void {
      if (closed) return () => {};
      listeners.add(listener);
      try {
        listener({ ...snapshot });
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => listeners.delete(listener);
    },
    discover,
    rescan: (query: string, signal?: AbortSignal, decade: ArchiveDecade | null = null) =>
      discover(query, signal, 'rescan', decade),
    stop,
    suspend: stop,
    dispose(): Promise<void> {
      if (closed) return Promise.resolve();
      if (disposal) return disposal;
      closing = true;
      const work = stop().then(() => {
        closed = true;
        listeners.clear();
        snapshot = { ...snapshot, state: 'disposed' };
      });
      disposal = work;
      void work.catch(() => {
        if (disposal === work) disposal = null;
      });
      return work;
    },
  };
}
