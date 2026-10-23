const stages = [
  'starting',
  'frontend-and-native',
  'frontend',
  'native',
  'final-native-drain',
  'activity-finish',
  'settled',
  'failed',
] as const;
const reasons = [
  'observation-deadline',
  'event-unavailable',
  'frontend-failed',
  'frontend-unconfirmed',
  'native-failed',
  'request-lock',
  'activity-unconfirmed',
] as const;
export interface CloseProgress {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly running: boolean;
  readonly stage: (typeof stages)[number];
  readonly reason: (typeof reasons)[number] | null;
  readonly frontendSettled: boolean;
  readonly nativeSettled: boolean;
}
/** Admit only the fixed scalar native diagnostic contract, never arbitrary event data. */
export function createCloseProgressObserver() {
  let current: Readonly<CloseProgress> | null = null;
  return {
    snapshot: () => current,
    receive(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const v = value as Record<string, unknown>;
      if (
        v.schemaVersion !== 1 ||
        !Number.isSafeInteger(v.generation) ||
        (v.generation as number) < 1 ||
        typeof v.running !== 'boolean' ||
        !stages.includes(v.stage as CloseProgress['stage']) ||
        (v.reason !== null &&
          !reasons.includes(v.reason as Exclude<CloseProgress['reason'], null>)) ||
        typeof v.frontendSettled !== 'boolean' ||
        typeof v.nativeSettled !== 'boolean' ||
        (current && (v.generation as number) < current.generation)
      )
        return;
      current = Object.freeze({
        schemaVersion: 1,
        generation: v.generation as number,
        running: v.running,
        stage: v.stage as CloseProgress['stage'],
        reason: v.reason as CloseProgress['reason'],
        frontendSettled: v.frontendSettled,
        nativeSettled: v.nativeSettled,
      });
    },
  };
}
