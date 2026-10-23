import type { ChannelCandidate, Source } from '../catalog/parser';
import type { PreferredRegion } from '../location/region';
import { boundedUtf8Text } from '../platform/bounded-text';
import { validateSource } from '../catalog';
import type { IndexFreshness } from './index-freshness';
import { unavailableReason, type UnavailableReason } from './unavailable-sources';

/** Native indexing and media verification remain separate durable operations. */
/** 'slow' checks the Slow list from the sources as last read: nothing is downloaded. */
export type IncrementalRefreshIntent = 'refresh' | 'full-recheck' | 'slow';
export interface SourceSnapshotEntry {
  /** Provisional staging identity only; whole-source native promotion owns stable identity. */
  readonly entryId: string;
  readonly channel: ChannelCandidate & { readonly id?: string };
}
export interface SourceSnapshotBegin {
  readonly schemaVersion: 1;
  readonly source: Source;
  readonly expectedSourceRevision: string;
  readonly entryCount: number;
  readonly platform: string;
  readonly observerProfile: string;
}
export interface SourceSnapshotStage {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly nextIndex: number;
  readonly entryCount: number;
}
export interface SourceSnapshotPromotion {
  readonly schemaVersion: 1;
  readonly committed: true;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly duplicates: number;
  readonly total: number;
}
export interface IncrementalSnapshotTransport {
  begin(input: SourceSnapshotBegin, signal: AbortSignal): Promise<SourceSnapshotStage>;
  append(
    input: {
      snapshotId: string;
      expectedNextIndex: number;
      entries: readonly SourceSnapshotEntry[];
    },
    signal: AbortSignal,
  ): Promise<SourceSnapshotStage>;
  promote(
    input: { snapshotId: string; expectedSourceRevision: string; completed: true },
    signal: AbortSignal,
  ): Promise<SourceSnapshotPromotion>;
}
export interface IncrementalRefreshScope {
  /** Root-issued identity binds source permissions, catalog/preferences and generation. */
  readonly scopeId: string;
  readonly sources: readonly { source: Source; sourceRevision: string }[];
  readonly platform: string;
  readonly observerProfile: string;
  readonly query: string;
  readonly region?: PreferredRegion;
  readonly intent: IncrementalRefreshIntent;
}
export interface CollectedSourceEntries {
  /** Detected content hints; origin identity and network permission stay fixed. */
  readonly source?: Source;
  readonly entryCount: number;
  /** All raw entries, including duplicates. Native promotion reconciles the whole stage. */
  readonly pages: AsyncIterable<readonly SourceSnapshotEntry[]>;
  /** Joins the actual fetch/parser owner and releases immutable source input. */
  dispose(): Promise<void>;
}
export interface IncrementalRefreshHost {
  readonly snapshots: IncrementalSnapshotTransport;
  current(scope: IncrementalRefreshScope): boolean;
  /** Parse ALL entries off thread before constructing pages; query applies only to checks. */
  collect(source: Source, signal: AbortSignal): Promise<CollectedSourceEntries>;
  /** Native index→protected manifest→existing bounded resume service, never a full UI review. */
  activateChecks(
    scope: IncrementalRefreshScope,
    promotions: readonly SourceSnapshotPromotion[],
    signal: AbortSignal,
    /** Unchanged sources this instance indexed recently, reused for a query search. */
    reused?: readonly { sourceId: string; sourceRevision: string }[],
  ): Promise<void>;
  /** Optional session memory of recent promotions; absent means always collect. */
  readonly freshness?: IndexFreshness;
  /** Permanently unavailable sources from this run (404/410/placeholder; DNS only if another source succeeded). */
  unavailable?(entries: readonly { location: string; reason: UnavailableReason }[]): Promise<void>;
  /** Actual retained checkpoint admission/worker Continue. Never fresh collect/discover. */
  continueChecks(signal: AbortSignal): Promise<void>;
  /** Joins retained probe/publication/checkpoint work; no fake cancellation ACK. */
  stopChecks(): Promise<void>;
  progress?(
    value: Readonly<{
      phase: 'indexing' | 'checking' | 'stopped' | 'completed';
      indexedSources: number;
      failedSources: number;
      indexedEntries: number;
      totalSources?: number;
      activeSource?: number;
      stagedEntries?: number;
      sourceEntries?: number;
      elapsedMilliseconds?: number;
    }>,
  ): void;
}
export interface IncrementalRefreshResult {
  readonly status: 'completed' | 'stopped';
  readonly promotions: readonly SourceSnapshotPromotion[];
  readonly failedSourceIds: readonly string[];
}
export class IncrementalRefreshCapacityError extends Error {
  constructor() {
    super(
      'Source refresh exceeds the 100,000-entry capture limit. Saved channels remain available.',
    );
    this.name = 'IncrementalRefreshCapacityError';
  }
}
const fail = () => new Error('Source refresh scope or staged entries could not be admitted.');
function revision(value: string) {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(value) || BigInt(value) > 9223372036854775807n) throw fail();
}
function capture(input: IncrementalRefreshScope): IncrementalRefreshScope {
  if (
    !['refresh', 'full-recheck', 'slow'].includes(input.intent) ||
    input.sources.length > 100 ||
    !boundedUtf8Text(input.scopeId, 128) ||
    !boundedUtf8Text(input.query, 256, true) ||
    !boundedUtf8Text(input.platform, 256) ||
    !boundedUtf8Text(input.observerProfile, 256)
  )
    throw fail();
  const ids = new Set<string>();
  const sources = input.sources.map(({ source, sourceRevision }) => {
    revision(sourceRevision);
    if (!boundedUtf8Text(source.id, 256) || ids.has(source.id)) throw fail();
    ids.add(source.id);
    return Object.freeze({ source: Object.freeze({ ...source }), sourceRevision });
  });
  return Object.freeze({
    ...input,
    sources: Object.freeze(sources),
    region: input.region ? Object.freeze({ ...input.region }) : undefined,
  });
}
/** One explicit indexing/verification episode; failed sources never replace prior snapshots. */
export function createIncrementalRefreshCoordinator(host: IncrementalRefreshHost) {
  let closed = false;
  let active: { controller: AbortController; work: Promise<IncrementalRefreshResult> } | undefined;
  let stopWork: Promise<void> | undefined;
  let continuing: { controller: AbortController; work: Promise<void> } | undefined;
  const notify = (value: Parameters<NonNullable<IncrementalRefreshHost['progress']>>[0]) => {
    try {
      host.progress?.(Object.freeze(value));
    } catch {
      /* Observations cannot fail an owner. */
    }
  };
  const joinStop = async () => {
    const jobs = await Promise.allSettled([
      active?.work,
      continuing?.work,
      Promise.resolve().then(() => host.stopChecks()),
    ]);
    const rejected = jobs.find((job): job is PromiseRejectedResult => job.status === 'rejected');
    if (rejected) throw rejected.reason;
  };
  function start(
    input: IncrementalRefreshScope,
    signal?: AbortSignal,
  ): Promise<IncrementalRefreshResult> {
    if (closed || active || continuing || stopWork)
      return Promise.reject(new Error('Source refresh is busy or closed.'));
    signal?.throwIfAborted();
    const scope = capture(input),
      controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const promotions: SourceSnapshotPromotion[] = [],
      reused: { sourceId: string; sourceRevision: string }[] = [],
      dead: { location: string; reason: UnavailableReason }[] = [],
      failed: string[] = [];
    let indexedEntries = 0;
    let capturedEntries = 0;
    let cleanupFailed = false;
    const disposeCollected = async (collected: CollectedSourceEntries) => {
      try {
        await collected.dispose();
      } catch (error) {
        cleanupFailed = true;
        throw error;
      }
    };
    const admitted = () => {
      controller.signal.throwIfAborted();
      if (closed || !host.current(scope)) throw fail();
    };
    const work = Promise.resolve().then(async (): Promise<IncrementalRefreshResult> => {
      try {
        admitted();
        for (const item of scope.sources) {
          admitted();
          // The Slow list comes only from sources already read (a snapshot,
          // revision above 0); a source never read has nothing on it to check.
          if (scope.intent === 'slow' && BigInt(item.sourceRevision) === 0n) continue;
          if (
            scope.intent === 'slow' ||
            host.freshness?.reusable(item.source, item.sourceRevision, scope)
          ) {
            reused.push(
              Object.freeze({ sourceId: item.source.id, sourceRevision: item.sourceRevision }),
            );
            continue;
          }
          // A source that just failed is reported unavailable again without a request.
          if (host.freshness?.recentlyFailed(item.source, scope)) {
            failed.push(item.source.id);
            continue;
          }
          const activeSource = promotions.length + reused.length + failed.length + 1;
          const sourceStarted = performance.now();
          let stagedCount = 0;
          let sourceCount: number | undefined;
          const indexingProgress = (stagedEntries = stagedCount, sourceEntries = sourceCount) => {
            stagedCount = stagedEntries;
            sourceCount = sourceEntries;
            notify({
              phase: 'indexing',
              indexedSources: promotions.length,
              failedSources: failed.length,
              indexedEntries,
              totalSources: scope.sources.length,
              activeSource,
              stagedEntries,
              elapsedMilliseconds: Math.max(0, Math.floor(performance.now() - sourceStarted)),
              ...(sourceEntries === undefined ? {} : { sourceEntries }),
            });
          };
          indexingProgress();
          const heartbeat = setInterval(() => {
            if (!controller.signal.aborted && !closed && host.current(scope)) indexingProgress();
          }, 1000);
          let collected: CollectedSourceEntries | undefined;
          try {
            collected = await host.collect(item.source, controller.signal);
            admitted();
            if (
              !Number.isSafeInteger(collected.entryCount) ||
              collected.entryCount < 0 ||
              collected.entryCount > 100_000
            )
              throw fail();
            if (capturedEntries + collected.entryCount > 100_000)
              throw new IncrementalRefreshCapacityError();
            capturedEntries += collected.entryCount;
            indexingProgress(0, collected.entryCount);
            const detected = validateSource(collected.source ?? item.source);
            if (
              detected.id !== item.source.id ||
              detected.kind !== item.source.kind ||
              detected.location !== item.source.location ||
              (detected.allowHttp === true) !== (item.source.allowHttp === true)
            )
              throw fail();
            let stage = await host.snapshots.begin(
              {
                schemaVersion: 1,
                source: detected,
                expectedSourceRevision: item.sourceRevision,
                entryCount: collected.entryCount,
                platform: scope.platform,
                observerProfile: scope.observerProfile,
              },
              controller.signal,
            );
            admitted();
            if (
              stage.sourceId !== item.source.id ||
              stage.sourceRevision !== item.sourceRevision ||
              stage.entryCount !== collected.entryCount ||
              stage.nextIndex !== 0
            )
              throw fail();
            for await (const entries of collected.pages) {
              admitted();
              if (
                !entries.length ||
                entries.length > 64 ||
                stage.nextIndex + entries.length > collected.entryCount
              )
                throw fail();
              const previous = stage;
              stage = await host.snapshots.append(
                { snapshotId: stage.snapshotId, expectedNextIndex: stage.nextIndex, entries },
                controller.signal,
              );
              if (
                stage.snapshotId !== previous.snapshotId ||
                stage.sourceId !== previous.sourceId ||
                stage.sourceRevision !== previous.sourceRevision ||
                stage.entryCount !== previous.entryCount ||
                stage.nextIndex !== previous.nextIndex + entries.length
              )
                throw fail();
              admitted();
              indexingProgress(stage.nextIndex, collected.entryCount);
            }
            if (stage.nextIndex !== collected.entryCount) throw fail();
            admitted();
            const promoted = await host.snapshots.promote(
              {
                snapshotId: stage.snapshotId,
                expectedSourceRevision: item.sourceRevision,
                completed: true,
              },
              controller.signal,
            );
            if (
              promoted.sourceId !== item.source.id ||
              BigInt(promoted.sourceRevision) !== BigInt(item.sourceRevision) + 1n ||
              promoted.added + promoted.changed + promoted.unchanged !== promoted.total ||
              promoted.total + promoted.duplicates !== collected.entryCount
            )
              throw fail();
            // A native COMMIT survives late cancellation. Do not invent Reachable evidence.
            promotions.push(promoted);
            host.freshness?.record(item.source, promoted.sourceRevision, scope.query);
            indexedEntries += promoted.total;
            notify({
              phase: 'indexing',
              indexedSources: promotions.length,
              failedSources: failed.length,
              indexedEntries,
            });
          } catch (error) {
            if (
              error instanceof IncrementalRefreshCapacityError ||
              controller.signal.aborted ||
              closed ||
              !host.current(scope)
            )
              throw error;
            failed.push(item.source.id);
            host.freshness?.recordFailure(item.source);
            const reason = unavailableReason(error, item.source.location);
            if (reason) dead.push({ location: item.source.location, reason });
          } finally {
            clearInterval(heartbeat);
            if (collected) await disposeCollected(collected);
          }
        }
        // A nonexistent domain only counts when the network demonstrably worked in this run.
        const permanent = dead.filter((d) => d.reason !== 'dns-failure' || promotions.length > 0);
        if (permanent.length) await host.unavailable?.(permanent).catch(() => undefined);
        admitted();
        notify({
          phase: 'checking',
          indexedSources: promotions.length,
          failedSources: failed.length,
          indexedEntries,
        });
        // Reused sources are passed only when present; an ordinary refresh keeps its call shape.
        // A Slow pass with no source read yet has nothing to check.
        if (scope.intent === 'slow' && !reused.length) {
          // Nothing activated: the caller treats this as an empty Slow list.
        } else if (reused.length)
          await host.activateChecks(
            scope,
            Object.freeze([...promotions]),
            controller.signal,
            Object.freeze([...reused]),
          );
        else await host.activateChecks(scope, Object.freeze([...promotions]), controller.signal);
        admitted();
        notify({
          phase: 'completed',
          indexedSources: promotions.length,
          failedSources: failed.length,
          indexedEntries,
        });
        return Object.freeze({
          status: 'completed',
          promotions: Object.freeze([...promotions]),
          failedSourceIds: Object.freeze([...failed]),
        });
      } catch (error) {
        if (
          cleanupFailed ||
          !controller.signal.aborted ||
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          throw error;
        notify({
          phase: 'stopped',
          indexedSources: promotions.length,
          failedSources: failed.length,
          indexedEntries,
        });
        return Object.freeze({
          status: 'stopped',
          promotions: Object.freeze([...promotions]),
          failedSourceIds: Object.freeze([...failed]),
        });
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    });
    active = { controller, work };
    void work
      .finally(() => {
        if (active?.work === work) active = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  function stop(): Promise<void> {
    if (stopWork) return stopWork;
    active?.controller.abort();
    continuing?.controller.abort();
    stopWork = Promise.resolve()
      .then(joinStop)
      .finally(() => {
        stopWork = undefined;
      });
    return stopWork;
  }
  return {
    start,
    stop,
    suspend: stop,
    continue: (signal: AbortSignal): Promise<void> => {
      if (closed || active || continuing || stopWork)
        return Promise.reject(new Error('Source refresh is busy or closed.'));
      signal.throwIfAborted();
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      // Continue delegates only to actual persistent admission, never this collection loop.
      const work = Promise.resolve()
        .then(() => host.continueChecks(controller.signal))
        .catch((error: unknown) => {
          if (!(
            controller.signal.aborted &&
            error instanceof DOMException &&
            error.name === 'AbortError'
          ))
            throw error;
        })
        .finally(() => signal.removeEventListener('abort', abort));
      continuing = { controller, work };
      void work
        .finally(() => {
          if (continuing?.work === work) continuing = undefined;
        })
        .catch(() => undefined);
      return work;
    },
    dispose: async () => {
      closed = true;
      await stop();
    },
  };
}
