import { createJoinedWorkTimings } from './joined-work-timings';

export type CloseFinalizationStage =
  | 'idle'
  | 'catalog-writes'
  | 'preferences'
  | 'event-history'
  | 'diagnostics'
  | 'native-acknowledgment'
  | 'completed';

/** Observe actual awaited finalizers without retaining errors, tokens or user data. */
export function createCloseFinalizationObserver(now?: () => number) {
  const timings = createJoinedWorkTimings(now);
  let stage: CloseFinalizationStage = 'idle';
  let failed = false;
  let pending = 0;
  return {
    snapshot() {
      return Object.freeze({
        schemaVersion: 1 as const,
        stage,
        failed,
        pending: pending > 0,
        timings: timings.snapshot(),
      });
    },
    async run<T>(next: CloseFinalizationStage, work: () => Promise<T>): Promise<T> {
      stage = next;
      failed = false;
      pending++;
      try {
        return await timings.run(next, 0, work);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        pending--;
      }
    },
    complete() {
      stage = 'completed';
      failed = false;
    },
  };
}
