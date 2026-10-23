import { createJoinedWorkTimings } from './joined-work-timings';

export interface CleanupToken {
  requestId: string;
  generation: number;
}
export type CleanupResult = 'drained' | 'failed';
export interface CloseOwnerHost {
  freeze(): void;
  owners: readonly (() => void | Promise<void>)[];
  acknowledge(token: CleanupToken, result: CleanupResult): Promise<void>;
  timingNow?(): number;
}
export interface CloseOwnerSnapshot {
  readonly schemaVersion: 1;
  readonly frozen: boolean;
  readonly freezeFailed: boolean;
  readonly generation: number;
  readonly running: boolean;
  readonly acknowledged: boolean;
  readonly acknowledgmentPending: boolean;
  readonly slots: readonly ('idle' | 'pending' | 'failed' | 'done')[];
  readonly timings: ReturnType<ReturnType<typeof createJoinedWorkTimings>['snapshot']>;
}
function validToken(value: CleanupToken): boolean {
  return (
    !!value &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    ![...value.requestId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}
/** One permanent close gate; retries drain existing owners rather than create replacements. */
export function createCloseOwner(host: CloseOwnerHost): {
  begin(token: CleanupToken): Promise<void>;
  snapshot(): CloseOwnerSnapshot;
} {
  const timings = createJoinedWorkTimings(host.timingNow);
  const slots = host.owners.map((owner) => ({
    owner,
    done: false,
    pending: null as Promise<void> | null,
    failed: false,
  }));
  let frozen = false;
  let freezeFailed = false;
  let current: CleanupToken | null = null;
  let request: Promise<void> | null = null;
  let acknowledged = false;
  let acknowledgmentPending = 0;
  function drain(generation: number): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      slots.map((slot, index) => {
        if (slot.done) return Promise.resolve();
        if (slot.pending) return slot.pending;
        // Reserve the promise before invoking an owner, including synchronously throwing owners.
        slot.failed = false;
        slot.pending = Promise.resolve()
          .then(() => timings.run('close-owner', generation, slot.owner, index))
          .then(
            () => {
              slot.done = true;
            },
            (error: unknown) => {
              slot.failed = true;
              throw error;
            },
          )
          .finally(() => {
            slot.pending = null;
          });
        return slot.pending;
      }),
    );
  }
  return {
    snapshot() {
      return Object.freeze({
        schemaVersion: 1 as const,
        frozen,
        freezeFailed,
        generation: current?.generation ?? 0,
        running: request !== null,
        acknowledged,
        acknowledgmentPending: acknowledgmentPending > 0,
        timings: timings.snapshot(),
        slots: Object.freeze(
          slots.map((slot) =>
            slot.done ? 'done' : slot.pending ? 'pending' : slot.failed ? 'failed' : 'idle',
          ),
        ),
      });
    },
    begin(raw) {
      if (!validToken(raw)) return Promise.reject(new Error('Invalid cleanup request.'));
      const token = { requestId: raw.requestId, generation: raw.generation };
      if (current && token.generation < current.generation)
        return Promise.reject(new Error('Cleanup request superseded.'));
      if (current && token.generation === current.generation) {
        if (token.requestId !== current.requestId)
          return Promise.reject(new Error('Invalid cleanup request.'));
        if (request) return request;
        if (acknowledged) return Promise.resolve();
      } else {
        current = token;
        acknowledged = false;
      }
      let complete!: () => void;
      let reject!: (error: Error) => void;
      const attempt = new Promise<void>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      request = attempt;
      if (!frozen) {
        frozen = true;
        try {
          host.freeze();
        } catch {
          freezeFailed = true;
        }
      }
      void drain(token.generation)
        .then(async (settled) => {
          if (current?.generation !== token.generation || current.requestId !== token.requestId)
            throw new Error('Cleanup request superseded.');
          const failed = freezeFailed || settled.some((result) => result.status === 'rejected');
          acknowledgmentPending++;
          try {
            await timings.run('close-acknowledge', token.generation, () =>
              host.acknowledge({ ...token }, failed ? 'failed' : 'drained'),
            );
          } catch {
            throw new Error('Cleanup acknowledgment could not be confirmed.');
          } finally {
            acknowledgmentPending--;
          }
          // A newer request may have arrived while its predecessor's transport was settling.
          if (current?.generation !== token.generation || current.requestId !== token.requestId)
            throw new Error('Cleanup request superseded.');
          if (failed) throw new Error('Cleanup could not be confirmed.');
          acknowledged = true;
        })
        .then(complete, reject);
      void attempt
        .finally(() => {
          if (request === attempt) request = null;
        })
        .catch(() => {});
      return attempt;
    },
  };
}
