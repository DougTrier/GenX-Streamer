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

import { validateReviewedGuideAliases, type GuideCommitAliases } from './reviewed-aliases';
import { GUIDE_SOURCE_LIMIT } from './limits';

export interface AutomaticGuideProvider {
  name: string;
  location: string;
  allowHttp: boolean;
  aliases?: GuideCommitAliases;
}
export interface AutomaticGuidePreview {
  ticket: string;
  sourceRevision: number;
  proposed?: true;
}
export interface AutomaticGuideBuildResult {
  connected: number;
  unmatched: number;
  checked: number;
  failed: number;
  skipped: number;
  unmappedAmbiguous?: number | null;
  mappingConflictAssessment?: 'complete' | 'not-assessed';
  preservedMappingConflicts?: number | null;
  discoveryFailed?: number;
  maintenance?: 'skipped' | 'compacted' | 'deferred' | 'failed' | 'reopen-required';
}
export type AutomaticGuideBuildPhase =
  | 'capturing'
  | 'reading-playlists'
  | 'checking-cache'
  | 'fetching'
  | 'publishing'
  | 'connecting'
  | 'optimizing'
  | 'completed';
export interface AutomaticGuideBuildProgress extends AutomaticGuideBuildResult {
  total: number;
  /** Unique settled provider operations, including failure and permission/cooldown skips. */
  attempted: number;
  phase: AutomaticGuideBuildPhase;
}
export interface GuideScopeConnection {
  catalogRevision: string;
  matched: number;
  unmatched: number;
  ambiguous?: number;
  mappingConflictAssessment?: 'complete' | 'not-assessed';
  preservedMappingConflicts?: number | null;
}
export interface AutomaticGuideBuildHost {
  capture(
    signal: AbortSignal,
    reportPhase?: (phase: 'reading-playlists') => void,
  ): Promise<{
    catalogRevision: string;
    channelCount: number;
    providers: readonly AutomaticGuideProvider[];
    discoveryFailed?: number;
    /** Two-letter countries declared by saved channels; gates never-fetched country feeds. */
    catalogCountries?: readonly string[];
  }>;
  isCurrent(catalogRevision: string): boolean;
  /** Captured permissions/removals remain valid even while catalog batches advance. */
  isScopeCurrent?(): boolean;
  canRun(): boolean;
  /** Automatic requests may be disabled while an explicit manual run remains available. */
  canRequest?(): boolean;
  cacheReady?(provider: AutomaticGuideProvider, signal: AbortSignal): Promise<boolean>;
  /** A cooldown skip is not evidence of usable coverage. Explicit Find may bypass it. */
  acquisitionAllowed?(
    provider: AutomaticGuideProvider,
    signal: AbortSignal,
    context: { automatic: boolean; catalogCountries?: readonly string[] },
  ): Promise<boolean>;
  /** Cache publication does not change catalog mappings; connection uses a fresh atomic catalog fence. */
  publishCache?(
    preview: AutomaticGuidePreview,
    provider: AutomaticGuideProvider,
    signal: AbortSignal,
  ): Promise<void>;
  connectLatest?(
    provider: AutomaticGuideProvider,
    signal: AbortSignal,
  ): Promise<{ catalogRevision: string; matched: number; unmatched: number }>;
  /** Connect all admitted caches in one native snapshot, preserving cross-feed ambiguity. */
  connectScopeLatest?(signal: AbortSignal): Promise<GuideScopeConnection>;
  /** Already configured/published caches only: no discovery, source save or fetch. */
  connectCacheOnly?(signal: AbortSignal): Promise<GuideScopeConnection>;
  /** Full builds only, after all publication/connection work has settled. Never startup cache-only. */
  maintain?(signal: AbortSignal): Promise<AutomaticGuideBuildResult['maintenance']>;
  preview(provider: AutomaticGuideProvider, signal: AbortSignal): Promise<AutomaticGuidePreview>;
  /** The backend atomically checks BOTH revisions and exact channel identifiers before publication. Receipt consumes ticket. */
  commitMatched(
    preview: AutomaticGuidePreview,
    catalogRevision: string,
    signal: AbortSignal,
    provider: AutomaticGuideProvider,
  ): Promise<{ committed: boolean; matched: number; unmatched: number }>;
  discard(ticket: string): Promise<void>;
  /** Join rejected previews whose opaque native ticket never reached this builder. */
  settlePreviews?(): Promise<void>;
  onProgress?(progress: Readonly<AutomaticGuideBuildProgress>): void;
}
/** One sequential foreground pipeline, retaining real pending work and unconfirmed ticket cleanup. */
export function createAutomaticGuideBuilder(
  host: AutomaticGuideBuildHost,
  options: { now?: () => number } = {},
) {
  let closed = false;
  let controller: AbortController | null = null;
  let active: Promise<AutomaticGuideBuildResult> | null = null;
  let activeCached = false;
  let deferredFull: Promise<AutomaticGuideBuildResult> | null = null;
  let lifecycleEpoch = 0;
  let closing: Promise<void> | null = null;
  const tickets = new Set<string>();
  const failedAcquisitions = new Map<string, number>();
  // Consecutive failures per descriptor: 1 min doubling to a 6 h ceiling.
  const failureCounts = new Map<string, number>();
  let retryScope: readonly string[] | null = null;
  let retryRevision: string | null = null;
  let previousNow: number | null = null;
  const RETRY_MS = 60000;
  const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
  const MAX_RETRY_KEY_BYTES = 2 * 1024 * 1024;
  const forgetFailure = (key: string) => {
    failedAcquisitions.delete(key);
    failureCounts.delete(key);
  };
  const clearRetries = () => {
    failedAcquisitions.clear();
    failureCounts.clear();
    retryScope = null;
    retryRevision = null;
  };
  const now = () => {
    const instant = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(instant) || instant < 0)
      throw new Error('Program guide retry clock is invalid.');
    // A backward wall-clock adjustment cannot leave an old cooldown stuck.
    if (previousNow !== null && instant < previousNow) {
      failedAcquisitions.clear();
      failureCounts.clear();
    }
    previousNow = instant;
    return instant;
  };
  let requestVersion = 0;
  const abort = () => new DOMException('Program guide build canceled.', 'AbortError');
  const emitProgress = (progress: AutomaticGuideBuildProgress) => {
    try {
      host.onProgress?.(Object.freeze(progress));
    } catch {
      // Presentation is an observer, never the owner of a durable guide receipt.
    }
  };
  async function discardOwned(): Promise<void> {
    if (host.settlePreviews) await host.settlePreviews();
    for (const ticket of tickets) {
      await host.discard(ticket);
      tickets.delete(ticket);
    }
  }
  function run(signal?: AbortSignal, automatic = false): Promise<AutomaticGuideBuildResult> {
    if (active) return active;
    if (closed || !host.canRun() || signal?.aborted) return Promise.reject(abort());
    const owned = new AbortController();
    activeCached = false;
    controller = owned;
    const cancel = () => owned.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const task = (async () => {
      const starting = (phase: 'capturing' | 'reading-playlists') =>
        emitProgress({
          connected: 0,
          unmatched: 0,
          checked: 0,
          failed: 0,
          skipped: 0,
          total: 0,
          attempted: 0,
          phase,
        });
      starting('capturing');
      if (host.connectScopeLatest && host.isScopeCurrent?.() === false) clearRetries();
      now();
      await discardOwned();
      owned.signal.throwIfAborted();
      let captured: Awaited<ReturnType<AutomaticGuideBuildHost['capture']>>;
      let captureOpen = true;
      try {
        captured = await host.capture(owned.signal, (phase) => {
          if (captureOpen && !closed && !owned.signal.aborted && host.canRun()) starting(phase);
        });
      } finally {
        captureOpen = false;
      }
      if (
        !captured ||
        !/^(0|[1-9][0-9]{0,18})$/.test(captured.catalogRevision) ||
        !Number.isSafeInteger(captured.channelCount) ||
        captured.channelCount < 0 ||
        captured.channelCount > 100000 ||
        !Array.isArray(captured.providers) ||
        captured.providers.length > GUIDE_SOURCE_LIMIT ||
        (captured.discoveryFailed !== undefined &&
          (!Number.isSafeInteger(captured.discoveryFailed) ||
            captured.discoveryFailed < 0 ||
            captured.discoveryFailed > 100)) ||
        (host.connectScopeLatest && !host.isScopeCurrent) ||
        (captured.catalogCountries !== undefined &&
          (!Array.isArray(captured.catalogCountries) ||
            captured.catalogCountries.length > 300 ||
            captured.catalogCountries.some((code) => !/^[A-Z]{2}$/.test(code))))
      )
        throw new Error('The program guide build snapshot is invalid.');
      let revision = captured.catalogRevision;
      const catalogCountries = captured.catalogCountries
        ? Object.freeze([...captured.catalogCountries])
        : undefined;
      const providers = captured.providers.map((provider) => {
        if (
          !provider ||
          typeof provider.name !== 'string' ||
          !provider.name.trim() ||
          provider.name.length > 512 ||
          typeof provider.location !== 'string' ||
          provider.location.length > 16384 ||
          typeof provider.allowHttp !== 'boolean'
        )
          throw new Error('The program guide provider is invalid.');
        const url = new URL(provider.location);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
          throw new Error('The program guide provider is invalid.');
        const aliases =
          provider.aliases === undefined
            ? undefined
            : validateReviewedGuideAliases(provider.aliases);
        if (aliases && aliases.guideLocation !== provider.location)
          throw new Error('The program guide alias scope is invalid.');
        return Object.freeze({ ...provider, ...(aliases ? { aliases } : {}) });
      });
      // Exact validated descriptor order/permissions/aliases define retry scope.
      // Bound retained key text to 2MiB and entries to the 1000-provider limit.
      // Larger scopes remain valid but have no partial negative cache.
      let keys: string[] = [];
      let keyBytes = 0;
      for (const provider of providers) {
        const key = JSON.stringify([
          provider.name,
          provider.location,
          provider.allowHttp,
          provider.aliases ?? null,
        ]);
        keyBytes += key.length * 2;
        if (keyBytes > MAX_RETRY_KEY_BYTES) {
          keys.length = 0;
          break;
        }
        keys.push(key);
      }
      const boundedRetryScope = keys.length === providers.length;
      const scopedRevision = host.connectScopeLatest ? null : captured.catalogRevision;
      const sameRetryScope =
        boundedRetryScope &&
        retryRevision === scopedRevision &&
        retryScope !== null &&
        retryScope.length === keys.length &&
        retryScope.every((key, index) => key === keys[index]);
      if (!sameRetryScope) clearRetries();
      else keys = [...retryScope!]; // Reuse retained strings; don't duplicate map/scope key text.
      if (boundedRetryScope) {
        retryScope = keys;
        retryRevision = scopedRevision;
      }
      const result: AutomaticGuideBuildResult = {
        connected: 0,
        unmatched: 0,
        checked: 0,
        failed: 0,
        skipped: 0,
        unmappedAmbiguous: null,
        mappingConflictAssessment: 'not-assessed',
        preservedMappingConflicts: null,
        ...(captured.discoveryFailed !== undefined
          ? { discoveryFailed: captured.discoveryFailed }
          : {}),
      };
      let attempted = 0;
      let phase: AutomaticGuideBuildPhase = 'checking-cache';
      const progress = (next: AutomaticGuideBuildPhase = phase) => {
        phase = next;
        emitProgress({ ...result, total: providers.length, attempted, phase });
      };
      const guard = () => {
        owned.signal.throwIfAborted();
        if (
          closed ||
          !host.canRun() ||
          (host.connectScopeLatest ? host.isScopeCurrent?.() === false : !host.isCurrent(revision))
        )
          throw abort();
      };
      let connectedRequestVersion = -1;
      let successfulPublications = 0;
      let publicationsSinceConnection = 0;
      let connectionDirty = false;
      const connectScope = async () => {
        guard();
        progress('connecting');
        const version = requestVersion;
        // Failed connection attempts stay dirty, but cannot turn subsequent
        // provider publications into an unbounded retry loop.
        publicationsSinceConnection = 0;
        const connected = await host.connectScopeLatest!(owned.signal);
        if (
          !/^(0|[1-9][0-9]{0,18})$/.test(connected.catalogRevision) ||
          ![connected.matched, connected.unmatched].every(
            (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100000,
          )
        )
          throw new Error('The cached guide connection receipt is invalid.');
        if (
          connected.ambiguous !== undefined &&
          (!Number.isSafeInteger(connected.ambiguous) ||
            connected.ambiguous < 0 ||
            connected.ambiguous > connected.unmatched)
        )
          throw new Error('The cached guide ambiguity receipt is invalid.');
        const assessment = connected.mappingConflictAssessment;
        const conflicts = connected.preservedMappingConflicts;
        if (
          (assessment === undefined && conflicts !== undefined) ||
          (assessment !== undefined &&
            assessment !== 'complete' &&
            assessment !== 'not-assessed') ||
          (assessment === 'complete' &&
            (!Number.isSafeInteger(conflicts) ||
              (conflicts as number) < 0 ||
              (conflicts as number) > 100000)) ||
          (assessment === 'not-assessed' && conflicts !== null)
        )
          throw new Error('The cached guide conflict receipt is invalid.');
        revision = connected.catalogRevision;
        result.connected += connected.matched;
        result.unmatched = connected.unmatched;
        result.unmappedAmbiguous = connected.ambiguous ?? null;
        result.mappingConflictAssessment = assessment ?? 'not-assessed';
        result.preservedMappingConflicts = assessment === 'complete' ? conflicts! : null;
        connectedRequestVersion = version;
        publicationsSinceConnection = 0;
        connectionDirty = false;
        guard();
      };
      if (host.connectScopeLatest) await connectScope();
      if (!host.publishCache) guard();
      for (const [providerIndex, provider] of providers.entries()) {
        owned.signal.throwIfAborted();
        if (closed || !host.canRun()) throw abort();
        if (host.connectScopeLatest) guard();
        let ticket: string | null = null;
        let acquisitionPending = false;
        const retryKey = boundedRetryScope ? keys[providerIndex] : undefined;
        try {
          progress('checking-cache');
          if (
            host.cacheReady &&
            (host.connectLatest || host.connectScopeLatest) &&
            (await host.cacheReady(provider, owned.signal))
          ) {
            if (retryKey !== undefined) forgetFailure(retryKey);
            if (host.connectScopeLatest) {
              result.checked++;
              guard();
              continue;
            }
            const connected = await host.connectLatest!(provider, owned.signal);
            if (
              !/^(0|[1-9][0-9]{0,18})$/.test(connected.catalogRevision) ||
              ![connected.matched, connected.unmatched].every(
                (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100000,
              )
            )
              throw new Error('The cached guide connection receipt is invalid.');
            revision = connected.catalogRevision;
            result.connected += connected.matched;
            result.unmatched = connected.unmatched;
            result.checked++;
            guard();
            continue;
          }
          if (!host.publishCache) guard();
          if (new URL(provider.location).protocol === 'http:' && !provider.allowHttp) {
            result.skipped++;
            continue;
          }
          if (host.connectScopeLatest) guard();
          if (automatic && retryKey !== undefined) {
            const eligibleAt = failedAcquisitions.get(retryKey);
            const instant = now();
            if (eligibleAt !== undefined && instant < eligibleAt) {
              result.skipped++;
              continue;
            }
            failedAcquisitions.delete(retryKey);
          }
          if (host.acquisitionAllowed) {
            const allowed = await host.acquisitionAllowed(provider, owned.signal, {
              automatic,
              ...(catalogCountries ? { catalogCountries } : {}),
            });
            guard();
            if (!allowed) {
              result.skipped++;
              continue;
            }
          }
          acquisitionPending = true;
          progress('fetching');
          const preview = await host.preview(provider, owned.signal);
          if (
            !preview ||
            typeof preview.ticket !== 'string' ||
            !preview.ticket ||
            preview.ticket.length > 256 ||
            !Number.isSafeInteger(preview.sourceRevision) ||
            (preview.proposed === true ? preview.sourceRevision !== 0 : preview.sourceRevision < 1)
          )
            throw new Error('The program guide preview receipt is invalid.');
          acquisitionPending = false;
          if (retryKey !== undefined) forgetFailure(retryKey);
          ticket = preview.ticket;
          tickets.add(ticket);
          let receipt: { committed: boolean; matched: number; unmatched: number };
          if (host.publishCache && (host.connectLatest || host.connectScopeLatest)) {
            owned.signal.throwIfAborted();
            if (closed || !host.canRun()) throw abort();
            if (host.connectScopeLatest) guard();
            progress('publishing');
            await host.publishCache(preview, provider, owned.signal);
            if (retryKey !== undefined) forgetFailure(retryKey);
            tickets.delete(ticket);
            ticket = null;
            if (host.connectScopeLatest) {
              successfulPublications++;
              publicationsSinceConnection++;
              connectionDirty = true;
              result.checked++;
              // Publish useful mappings progressively instead of waiting for
              // 32 potentially minute-long provider operations to complete.
              if (successfulPublications === 1 || publicationsSinceConnection >= 4)
                await connectScope();
              guard();
              continue;
            }
            const connected = await host.connectLatest!(provider, owned.signal);
            if (!/^(0|[1-9][0-9]{0,18})$/.test(connected.catalogRevision))
              throw new Error('The fresh guide catalog revision is invalid.');
            revision = connected.catalogRevision;
            receipt = {
              committed: true,
              matched: connected.matched,
              unmatched: connected.unmatched,
            };
          } else {
            guard();
            progress('publishing');
            receipt = await host.commitMatched({ ...preview }, revision, owned.signal, provider);
          }
          if (
            !receipt ||
            typeof receipt.committed !== 'boolean' ||
            ![receipt.matched, receipt.unmatched].every(
              (count) => Number.isSafeInteger(count) && count >= 0,
            ) ||
            (!receipt.committed && receipt.matched !== 0)
          )
            throw new Error('The program guide save receipt is invalid.');
          // A definite atomic receipt wins cancellation during settlement; do not discard a consumed ticket.
          if (ticket) tickets.delete(ticket);
          if (receipt.committed && retryKey !== undefined) forgetFailure(retryKey);
          ticket = null;
          result.checked++;
          if (receipt.committed) result.connected += receipt.matched;
          else result.skipped++;
          result.unmatched = host.connectLatest
            ? receipt.unmatched
            : Math.max(result.unmatched, receipt.unmatched);
          guard();
        } catch (error) {
          if (ticket) {
            await host.discard(ticket);
            tickets.delete(ticket);
          }
          if (
            owned.signal.aborted ||
            closed ||
            !host.canRun() ||
            (host.connectScopeLatest
              ? host.isScopeCurrent?.() === false
              : !host.isCurrent(revision))
          )
            // A host cancellation/cleanup failure must not become an invented
            // successful abort merely because lifecycle changed meanwhile.
            throw error;
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          if (acquisitionPending && retryKey !== undefined) {
            const instant = now();
            const failures = Math.min(20, (failureCounts.get(retryKey) ?? 0) + 1);
            failureCounts.set(retryKey, failures);
            const delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (failures - 1));
            failedAcquisitions.set(retryKey, Math.min(Number.MAX_SAFE_INTEGER, instant + delay));
          }
          result.failed++;
        } finally {
          attempted++;
          if (
            !closed &&
            !owned.signal.aborted &&
            host.canRun() &&
            (host.connectScopeLatest ? host.isScopeCurrent?.() !== false : host.isCurrent(revision))
          )
            progress();
        }
      }
      if (
        host.connectScopeLatest &&
        (connectionDirty || connectedRequestVersion !== requestVersion)
      )
        await connectScope();
      if (host.connectScopeLatest) requested = connectedRequestVersion !== requestVersion;
      guard();
      if (host.maintain) {
        progress('optimizing');
        try {
          const receipt = await host.maintain(owned.signal);
          if (receipt !== undefined) {
            if (
              !['skipped', 'compacted', 'deferred', 'failed', 'reopen-required'].includes(receipt)
            )
              throw new Error('The guide maintenance receipt is invalid.');
            // A settled maintenance receipt may include a durable retention commit.
            // Keep it truthful even if cancellation arrived during settlement.
            result.maintenance = receipt;
          } else guard();
        } catch (error) {
          if (
            owned.signal.aborted ||
            closed ||
            !host.canRun() ||
            (host.connectScopeLatest
              ? host.isScopeCurrent?.() === false
              : !host.isCurrent(revision))
          )
            throw error;
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          result.maintenance = 'failed';
        }
      }
      progress('completed');
      return Object.freeze({ ...result });
    })();
    const settled = task.finally(() => {
      signal?.removeEventListener('abort', cancel);
      if (controller === owned) controller = null;
      if (active === settled) active = null;
    });
    active = settled;
    return settled;
  }
  let requested = false;
  let cachedRequested = false;
  let draining: Promise<void> | null = null;
  function runCached(): Promise<AutomaticGuideBuildResult> {
    if (!host.connectCacheOnly || closed || !host.canRun() || host.canRequest?.() === false)
      return Promise.reject(abort());
    const owned = new AbortController();
    activeCached = true;
    controller = owned;
    const task = (async () => {
      await discardOwned();
      owned.signal.throwIfAborted();
      if (closed || !host.canRun() || host.canRequest?.() === false) throw abort();
      const connected = await host.connectCacheOnly!(owned.signal);
      if (
        !/^(0|[1-9][0-9]{0,18})$/.test(connected.catalogRevision) ||
        ![connected.matched, connected.unmatched].every(
          (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100000,
        )
      )
        throw new Error('The cached guide connection receipt is invalid.');
      return Object.freeze({
        connected: connected.matched,
        unmatched: connected.unmatched,
        checked: 0,
        failed: 0,
        skipped: 0,
        unmappedAmbiguous: connected.ambiguous ?? null,
        mappingConflictAssessment: connected.mappingConflictAssessment ?? 'not-assessed',
        preservedMappingConflicts: connected.preservedMappingConflicts ?? null,
      });
    })();
    const settled = task.finally(() => {
      if (controller === owned) controller = null;
      if (active === settled) active = null;
    });
    active = settled;
    return settled;
  }
  function drainRequested(): Promise<void> {
    if (draining) return draining;
    const work = (async () => {
      while (
        (requested || cachedRequested) &&
        !closed &&
        host.canRun() &&
        host.canRequest?.() !== false
      ) {
        // Do not consume a requested mode while another actual run is active.
        // A manual/full run and cache-only connection retain the same owner.
        if (active) {
          await active;
          continue;
        }
        const full = requested;
        if (full) {
          requested = false;
          cachedRequested = false;
        } else cachedRequested = false;
        try {
          if (full) await run(undefined, true);
          else await runCached();
        } catch (error) {
          if (
            !(error instanceof DOMException && error.name === 'AbortError') &&
            !requested &&
            !cachedRequested
          )
            throw error;
        }
      }
    })().finally(() => {
      if (draining === work) draining = null;
    });
    draining = work;
    return work;
  }
  function request(): Promise<void> {
    if (closed || !host.canRun() || host.canRequest?.() === false) return Promise.resolve();
    requested = true;
    requestVersion++;
    return drainRequested();
  }
  function requestCached(): Promise<void> {
    if (closed || !host.connectCacheOnly || !host.canRun() || host.canRequest?.() === false)
      return Promise.resolve();
    cachedRequested = true;
    return drainRequested();
  }
  function suspend(): Promise<void> {
    lifecycleEpoch++;
    requested = false;
    cachedRequested = false;
    const owned = controller;
    const pipeline = active;
    const requests = draining;
    const deferred = deferredFull;
    owned?.abort();
    return (async () => {
      let refused = false;
      let refusal: unknown;
      // Capture and join both owners even when one reports an operation failure.
      // Native refusal codes are admitted only after our cancellation and the
      // actual host promise settles. Messages cannot assert a noncommit receipt.
      for (const pending of [pipeline, requests, deferred]) {
        try {
          await pending;
        } catch (error) {
          const stopped =
            (error instanceof DOMException && error.name === 'AbortError') ||
            (owned?.signal.aborted === true &&
              (error === 'application-closing' ||
                error === 'canceled' ||
                error === 'guide-cancelled'));
          if (!stopped && !refused) {
            refused = true;
            refusal = error;
          }
        }
      }
      // Ticket cleanup remains mandatory and failures remain owned for retry.
      await discardOwned();
      if (refused) throw refusal;
    })();
  }
  function dispose(): Promise<void> {
    if (closing) return closing;
    closed = true;
    clearRetries();
    const attempt = suspend();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = null;
    });
    return attempt;
  }
  function runWithIntent(signal?: AbortSignal): Promise<AutomaticGuideBuildResult> {
    if (!active || !activeCached) return run(signal);
    if (deferredFull) return deferredFull;
    const prior = active;
    const epoch = lifecycleEpoch;
    const task = (async () => {
      await prior;
      if (epoch !== lifecycleEpoch || closed || signal?.aborted) throw abort();
      return run(signal);
    })();
    const settled = task.finally(() => {
      if (deferredFull === settled) deferredFull = null;
    });
    deferredFull = settled;
    return settled;
  }
  return { run: runWithIntent, request, requestCached, suspend, dispose };
}
