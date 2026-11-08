// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import {
  isSourceCleanupNotCommitted,
  type SourceCleanupReceipt,
  type SourceCleanupRound,
  type SourceCleanupTransport,
} from '../../platform/source-cleanup';
import type { Preferences, SerializedPreferencesStore } from '../../preferences';
import type { PlaybackSnapshot } from '../../playback/controller';

/** A chosen paused stream still owns playback; Web Stream has a separate page. */
export function sourceCleanupPlaybackIdle(input: {
  readonly snapshot: Pick<PlaybackSnapshot, 'state' | 'selection'>;
  readonly accountSelected?: boolean;
  readonly archiveSelected?: boolean;
  readonly webPageOpen?: boolean;
  readonly pendingPlayback?: boolean;
  readonly retainedPlayback?: boolean;
}): boolean {
  return (
    input.snapshot.selection === null &&
    ['idle', 'paused', 'failed'].includes(input.snapshot.state) &&
    !input.accountSelected &&
    !input.archiveSelected &&
    !input.webPageOpen &&
    !input.pendingPlayback &&
    !input.retainedPlayback
  );
}

class CleanupAdmissionCanceled extends Error {}
export class SourceCleanupProjectionError extends Error {
  constructor() {
    super(
      'Cleanup was saved, but the channel list could not reload. Reopen the application before continuing.',
    );
  }
}
export interface SourceCleanupCommitHost {
  queue<T>(operation: () => Promise<T>): Promise<T>;
  readonly preferences: Pick<SerializedPreferencesStore, 'mutateExternally'>;
  admitted(): boolean;
  /** Storage/root identity only: late abort must not prevent durable adoption. */
  current(): boolean;
  acknowledge(receipt: SourceCleanupReceipt): void;
  adopt(settings: Preferences, receipt: SourceCleanupReceipt): void;
}
/** Mirrors the catalog group's two write queues, with an explicit durable ACK. */
export function finishAndAdoptSourceCleanup(
  host: SourceCleanupCommitHost,
  transport: SourceCleanupTransport,
  roundId: string,
  signal: AbortSignal,
): Promise<SourceCleanupReceipt> {
  return host.queue(async () => {
    let receipt: SourceCleanupReceipt | undefined;
    try {
      const settings = await host.preferences.mutateExternally(async () => {
        if (signal.aborted || !host.current() || !host.admitted())
          throw new CleanupAdmissionCanceled();
        receipt = await transport.finish(roundId, signal);
        // Do not check cancellation between an actual COMMIT and adoption.
        // A different storage root must never receive this receipt's revisions.
        if (!host.current()) throw new SourceCleanupProjectionError();
        host.acknowledge(receipt);
      });
      if (!receipt) throw new Error('Cleanup acknowledgment missing.');
      if (!host.current()) throw new SourceCleanupProjectionError();
      host.adopt(settings, receipt);
      return receipt;
    } catch (error) {
      if (receipt) throw new SourceCleanupProjectionError();
      throw error;
    }
  });
}

export type SourceCleanupOutcome =
  | { readonly status: 'deferred-playback' | 'coverage-incomplete' | 'interrupted' }
  | { readonly status: 'finished'; readonly receipt: SourceCleanupReceipt };

export function sourceCleanupRequested(input: {
  readonly sources?: unknown;
  readonly query: string;
  readonly intent: string;
}): boolean {
  return (
    input.sources === undefined &&
    !input.query.trim() &&
    (input.intent === 'refresh' || input.intent === 'full-recheck')
  );
}

export interface SourceCleanupEpisodeHost {
  readonly transport: SourceCleanupTransport;
  readonly expectedCatalogRevision: string;
  current(): boolean;
  playbackIdle(): boolean;
  /** Notify on playback, foreground, and configuration changes. */
  observe(changed: () => void): () => void;
  /** Holds catalog/preferences queues; adopts any durable receipt before resolving. */
  finishAndAdopt(roundId: string, signal: AbortSignal): Promise<SourceCleanupReceipt>;
}

/** One optional cleanup capability; canceling it never cancels source indexing. */
export function createSourceCleanupEpisode(host: SourceCleanupEpisodeHost, signal: AbortSignal) {
  const owned = new AbortController();
  let round: SourceCleanupRound | null = null;
  let cancellation: Promise<void> | undefined;
  let unobserve: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  let outcome: SourceCleanupOutcome = { status: 'interrupted' };
  let finished = false;
  let begun = false;
  const operations = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    operations.add(work);
    void work.finally(() => operations.delete(work)).catch(() => undefined);
    return work;
  };
  const cancel = (): Promise<void> => {
    if (cancellation) return cancellation;
    if (!round) return Promise.resolve();
    const id = round.roundId;
    const work = host.transport.cancel(id).then(() => {
      if (round?.roundId === id) round = null;
    });
    cancellation = work;
    void work
      .finally(() => {
        if (cancellation === work) cancellation = undefined;
      })
      .catch(() => undefined);
    return work;
  };
  const invalidate = () => {
    if (!host.playbackIdle()) outcome = { status: 'deferred-playback' };
    owned.abort();
    // Errors are observed again by finish/dispose; cancellation never detaches.
    void cancel().catch(() => undefined);
  };
  const check = () => {
    if (signal.aborted || !host.current() || !host.playbackIdle()) invalidate();
  };
  const stopObserving = () => {
    unobserve?.();
    unobserve = undefined;
  };
  signal.addEventListener('abort', invalidate, { once: true });
  const episode = {
    async begin(): Promise<void> {
      if (begun) throw new Error('Source cleanup was already started.');
      begun = true;
      signal.throwIfAborted();
      check();
      if (owned.signal.aborted) return;
      unobserve = host.observe(check);
      check();
      if (owned.signal.aborted) return;
      try {
        round = await host.transport.begin(host.expectedCatalogRevision, owned.signal);
      } catch (error) {
        if (
          !owned.signal.aborted ||
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          throw error;
        signal.throwIfAborted();
        return;
      }
      check();
      if (owned.signal.aborted) await cancel();
      else if (round.sourceCount === 0) {
        await cancel();
        outcome = { status: 'coverage-incomplete' };
        stopObserving();
      }
    },
    async finish(checkingSignal?: AbortSignal): Promise<SourceCleanupOutcome> {
      if (checkingSignal?.aborted) invalidate();
      checkingSignal?.addEventListener('abort', invalidate, { once: true });
      check();
      if (!round || owned.signal.aborted) {
        try {
          await cancel();
          signal.throwIfAborted();
          return outcome;
        } finally {
          checkingSignal?.removeEventListener('abort', invalidate);
        }
      }
      try {
        const receipt = await host.finishAndAdopt(round.roundId, owned.signal);
        // An acknowledged COMMIT remains true despite late cancellation. The
        // host must finish authoritative preference adoption before returning.
        round = null;
        finished = true;
        outcome = { status: 'finished', receipt };
        return outcome;
      } catch (error) {
        if (!(error instanceof CleanupAdmissionCanceled) && !isSourceCleanupNotCommitted(error))
          throw error;
        await cancel();
        signal.throwIfAborted();
        return outcome;
      } finally {
        checkingSignal?.removeEventListener('abort', invalidate);
        stopObserving();
      }
    },
    dispose(): Promise<void> {
      if (!disposal)
        disposal = (async () => {
          stopObserving();
          signal.removeEventListener('abort', invalidate);
          owned.abort();
          const settled = await Promise.allSettled([...operations]);
          if (!finished) await cancel();
          else await cancellation;
          const failure = settled.find(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected' &&
              !(result.reason instanceof DOMException && result.reason.name === 'AbortError'),
          );
          if (failure) throw failure.reason;
        })();
      return disposal;
    },
    snapshot: (): SourceCleanupOutcome => outcome,
  };
  return {
    begin: () => track(episode.begin()),
    finish: (checkingSignal?: AbortSignal) => track(episode.finish(checkingSignal)),
    dispose: episode.dispose,
    snapshot: episode.snapshot,
  };
}

export function sourceCleanupOutcomeText(outcome: SourceCleanupOutcome): string | null {
  if (outcome.status === 'deferred-playback')
    return 'Cleanup was deferred while playback was active. Stop playback and Refresh to clean up missing, unavailable channels.';
  if (
    outcome.status === 'coverage-incomplete' ||
    (outcome.status === 'finished' && outcome.receipt.status === 'coverage-incomplete')
  )
    return 'Cleanup was skipped because complete refreshed source coverage could not be confirmed. Saved channels were retained.';
  if (outcome.status !== 'finished') return null;
  const { archivedCount, deferredCount, expiredEventIds, status } = outcome.receipt;
  const expired = expiredEventIds.length;
  const events = expired
    ? `${expired.toLocaleString()} expired game ${expired === 1 ? 'listing was' : 'listings were'} removed.`
    : '';
  const removed =
    archivedCount > 0
      ? `${archivedCount.toLocaleString()} missing, unavailable ${archivedCount === 1 ? 'channel was' : 'channels were'} removed. Restore removed channels in Settings.`
      : '';
  const deferred =
    status === 'budget-exhausted' || deferredCount > 0
      ? 'More cleanup checks were deferred until a later Refresh.'
      : '';
  return [events, removed, deferred].filter(Boolean).join(' ') || null;
}
