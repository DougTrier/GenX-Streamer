export const startupStages = [
  'close-bridge',
  'close-start-listen',
  'close-blocked-listen',
  'close-progress-listen',
  'retry-storage',
  'read-record-pair',
  'health-decode',
  'preferences',
  'apply-settings',
  'capabilities',
  'runtime-info',
  'scan-checkpoint-summary',
  'ready',
] as const;
export type StartupStage = (typeof startupStages)[number];
export type StartupState = 'pending' | 'completed' | 'failed' | 'cancelled';
export interface StartupAttempt {
  run<T>(stage: StartupStage, operation: () => T | Promise<T>): Promise<T>;
  finish(state: Exclude<StartupState, 'pending'>): void;
}
/** Fixed metadata only. Operations remain awaited; this observer never cancels or times out work. */
export function createStartupObserver(clock: () => number = () => performance.now()) {
  let generation = 0;
  let lastTime = 0;
  const now = () => {
    const value = clock();
    if (Number.isFinite(value)) lastTime = Math.max(lastTime, value);
    return lastTime;
  };
  let started = now();
  let state: StartupState = 'pending';
  let finishedMs: number | null = null;
  type Entry = {
    stage: StartupStage;
    state: StartupState;
    enteredMs: number;
    settledMs: number | null;
  };
  let entries = new Map<StartupStage, Entry>();
  const elapsed = () => Math.max(0, now() - started);
  return {
    begin(): StartupAttempt {
      generation++;
      const ownGeneration = generation;
      started = now();
      state = 'pending';
      finishedMs = null;
      entries = new Map();
      return {
        async run<T>(stage: StartupStage, operation: () => T | Promise<T>): Promise<T> {
          if (!startupStages.includes(stage)) throw new Error('Startup stage is invalid.');
          const entry: Entry = { stage, state: 'pending', enteredMs: elapsed(), settledMs: null };
          if (ownGeneration === generation) entries.set(stage, entry);
          const settle = (result: StartupState) => {
            if (ownGeneration !== generation || entries.get(stage) !== entry) return;
            entry.state = result;
            entry.settledMs = elapsed();
          };
          try {
            const result = await operation();
            settle('completed');
            return result;
          } catch (error) {
            settle(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed');
            throw error;
          }
        },
        finish(result) {
          if (ownGeneration === generation) {
            state = result;
            finishedMs = elapsed();
          }
        },
      };
    },
    snapshot() {
      const stages = startupStages.flatMap((stage) => {
        const entry = entries.get(stage);
        return entry ? [Object.freeze({ ...entry })] : [];
      });
      return Object.freeze({
        schemaVersion: 1 as const,
        generation,
        state,
        elapsedMs: finishedMs ?? elapsed(),
        pendingStages: Object.freeze(
          stages.filter((entry) => entry.state === 'pending').map((entry) => entry.stage),
        ),
        stages: Object.freeze(stages),
      });
    },
  };
}
