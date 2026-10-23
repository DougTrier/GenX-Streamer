import type { DailyRefreshClock } from '../catalog/daily-refresh';
import { GUIDE_SOURCE_LIMIT } from './limits';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface GuideRefreshPlanEntry {
  sourceId: string;
  sourceRevision: number;
  nextDueMs: number;
}
export interface GuideRefreshResult {
  status: 'refreshed' | 'not-modified' | 'not-due' | 'deferred';
  nextDueMs: number;
}
export interface DailyGuideRefreshOptions {
  canRun(): boolean;
  plan(signal: AbortSignal): Promise<GuideRefreshPlanEntry[]>;
  refresh(entry: Readonly<GuideRefreshPlanEntry>, signal: AbortSignal): Promise<GuideRefreshResult>;
  onChanged?(): void;
  onError?(error: Error): void;
  clock?: DailyRefreshClock;
}
const DAY = 86_400_000;
const RETRY = 900_000;
const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** Foreground scheduling only; the backend admits revisioned work and persists actual attempts. */
export function createDailyGuideRefresh(options: DailyGuideRefreshOptions): {
  wake(): Promise<void>;
  suspend(): Promise<void>;
  dispose(): Promise<void>;
} {
  const clock = options.clock ?? {
    now: Date.now,
    setTimer: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let closed = false,
    generation = 0;
  let timer: unknown = null,
    pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let planRetryAt = 0;
  const retries = new Map<string, { revision: number; due: number }>();
  const clear = () => {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
  };
  const report = () =>
    options.onError?.(
      new Error('Automatic program guide refresh could not finish. Retry from Guide.'),
    );
  const arm = (due: number) => {
    clear();
    if (closed || !options.canRun() || !Number.isFinite(due)) return;
    timer = clock.setTimer(
      () => {
        timer = null;
        void wake().catch(report);
      },
      Math.min(DAY, Math.max(1, due - clock.now())),
    );
  };
  const suspend = async () => {
    generation++;
    clear();
    controller?.abort();
    await pending;
  };
  const wake = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (!options.canRun()) return suspend();
    if (pending) return controller?.signal.aborted ? pending.then(wake) : pending;
    clear();
    if (planRetryAt > clock.now()) {
      arm(planRetryAt);
      return Promise.resolve();
    }
    const owned = generation;
    const cancel = new AbortController();
    controller = cancel;
    const lifecycleCurrent = () => !closed && generation === owned && !cancel.signal.aborted;
    const current = () => lifecycleCurrent() && options.canRun();
    let nextDue = Number.POSITIVE_INFINITY;
    const task = Promise.resolve().then(async () => {
      if (!current()) return;
      let entries: GuideRefreshPlanEntry[];
      try {
        const supplied = await options.plan(cancel.signal);
        if (!current()) return;
        if (!Array.isArray(supplied) || supplied.length > GUIDE_SOURCE_LIMIT)
          throw new Error('plan-limit');
        const ids = new Set<string>();
        entries = supplied.map((entry) => {
          if (
            !entry ||
            !boundedUtf8Text(entry.sourceId, 256) ||
            ids.has(entry.sourceId) ||
            !Number.isSafeInteger(entry.sourceRevision) ||
            entry.sourceRevision < 0 ||
            !Number.isSafeInteger(entry.nextDueMs) ||
            entry.nextDueMs < 0
          )
            throw new Error('plan-invalid');
          ids.add(entry.sourceId);
          return { ...entry };
        });
        for (const id of retries.keys()) if (!ids.has(id)) retries.delete(id);
      } catch (error) {
        if (cancel.signal.aborted) {
          if (!aborted(error))
            // eslint-disable-next-line preserve-caught-error -- Native/provider diagnostics may contain private URLs; cleanup failures expose only a fixed message.
            throw new Error('Program guide refresh cancellation could not be confirmed.');
          return;
        }
        if (!current()) return;
        planRetryAt = clock.now() + RETRY;
        nextDue = planRetryAt;
        report();
        return;
      }
      for (const entry of entries) {
        if (!current()) return;
        const prior = retries.get(entry.sourceId);
        const due = Math.max(
          entry.nextDueMs,
          prior?.revision === entry.sourceRevision ? prior.due : 0,
        );
        if (due > clock.now()) {
          nextDue = Math.min(nextDue, due);
          continue;
        }
        try {
          const result = await options.refresh(entry, cancel.signal);
          // A dialog can prevent starting another acquisition without invalidating
          // an already durable receipt needed to update that dialog's Guide view.
          if (!lifecycleCurrent()) return;
          if (
            !result ||
            !['refreshed', 'not-modified', 'not-due', 'deferred'].includes(result.status) ||
            !Number.isSafeInteger(result.nextDueMs) ||
            result.nextDueMs < 0
          )
            throw new Error('reply-invalid');
          const safeDue =
            result.status === 'deferred' || result.nextDueMs <= clock.now()
              ? Math.max(result.nextDueMs, clock.now() + RETRY)
              : result.nextDueMs;
          retries.set(entry.sourceId, { revision: entry.sourceRevision, due: safeDue });
          nextDue = Math.min(nextDue, safeDue);
          if (result.status === 'refreshed') options.onChanged?.();
        } catch (error) {
          if (cancel.signal.aborted) {
            if (!aborted(error))
              // eslint-disable-next-line preserve-caught-error -- Native/provider diagnostics may contain private URLs; cleanup failures expose only a fixed message.
              throw new Error('Program guide refresh cancellation could not be confirmed.');
            return;
          }
          if (!current()) return;
          const retry = clock.now() + RETRY;
          retries.set(entry.sourceId, { revision: entry.sourceRevision, due: retry });
          nextDue = Math.min(nextDue, retry);
          report();
        }
      }
    });
    const settled = task.finally(() => {
      if (pending === settled) {
        pending = null;
        controller = null;
        if (current()) arm(nextDue);
      }
    });
    pending = settled;
    return settled;
  };
  return {
    wake,
    suspend,
    dispose() {
      closed = true;
      return suspend();
    },
  };
}
