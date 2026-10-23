const phases = [
  'archive-stop-total',
  'archive-queue-wait',
  'archive-decoder-stop',
  'archive-decoder-join',
  'archive-bookmark-save',
  'archive-bookmark-join',
  'archive-renewal-join',
  'archive-native-stop',
  'archive-native-retry',
  'close-owner',
  'close-acknowledge',
  'catalog-writes',
  'preferences',
  'event-history',
  'diagnostics',
  'native-acknowledgment',
  'idle',
  'completed',
] as const;
export type JoinedWorkPhase = (typeof phases)[number];
type Outcome = 'fulfilled' | 'rejected';
interface Span {
  phase: JoinedWorkPhase;
  generation: number;
  slot: number | null;
  startedMs: number;
  endedMs: number | null;
  elapsedMs: number;
  outcome: Outcome | 'pending';
}
const LIMIT = 64;
/** Passive monotonic observations only. Dropped observations never drop owned work.
 * Fixed phase/slot/generation scalars exclude caller tokens, media identity and errors.
 */
export function createJoinedWorkTimings(now: () => number = () => performance.now()) {
  let last = 0,
    clockFaults = 0,
    droppedActive = 0,
    droppedCompleted = 0;
  const active = new Set<Span>(),
    completed: Span[] = [];
  const instant = () => {
    try {
      const value = now();
      if (Number.isFinite(value) && value >= last && value <= Number.MAX_SAFE_INTEGER) {
        last = value;
        return value;
      }
    } catch {
      /* A broken observation clock cannot alter disposal. */
    }
    clockFaults++;
    return last;
  };
  const begin = (phase: JoinedWorkPhase, generation: number, slot: number | null = null) => {
    if (
      !phases.includes(phase) ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      (slot !== null && (!Number.isSafeInteger(slot) || slot < 0 || slot > 127)) ||
      active.size >= LIMIT
    ) {
      droppedActive++;
      return (_outcome: Outcome) => {};
    }
    const span: Span = {
      phase,
      generation,
      slot,
      startedMs: instant(),
      endedMs: null,
      elapsedMs: 0,
      outcome: 'pending',
    };
    active.add(span);
    return (outcome: Outcome) => {
      if (!active.delete(span)) return;
      const endedMs = instant();
      completed.push({ ...span, endedMs, elapsedMs: endedMs - span.startedMs, outcome });
      if (completed.length > LIMIT) {
        completed.shift();
        droppedCompleted++;
      }
    };
  };
  return {
    begin,
    async run<T>(
      phase: JoinedWorkPhase,
      generation: number,
      work: () => T | Promise<T>,
      slot: number | null = null,
    ): Promise<T> {
      const finish = begin(phase, generation, slot);
      try {
        const result = await work();
        finish('fulfilled');
        return result;
      } catch (error) {
        finish('rejected');
        throw error;
      }
    },
    snapshot() {
      const observedMs = instant();
      return Object.freeze({
        schemaVersion: 1 as const,
        observedMs,
        clockFaults,
        droppedActive,
        droppedCompleted,
        active: Object.freeze(
          [...active].map((span) =>
            Object.freeze({ ...span, elapsedMs: observedMs - span.startedMs }),
          ),
        ),
        completed: Object.freeze(completed.map((span) => Object.freeze({ ...span }))),
      });
    },
  };
}
