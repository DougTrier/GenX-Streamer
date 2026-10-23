/**
 * The Slow list check (owner design, October 21, 2026) uses few resources so
 * the viewer can watch TV: one check at a time, a rest after each, and none
 * while something is playing or the app is out of sight. Waiting checks start
 * when the way is clear; cancellation stays prompt.
 */
export function createSlowPassGate(
  blocked: () => boolean,
  options: { restMs?: number; pollMs?: number } = {},
) {
  const restMs = options.restMs ?? 3000;
  const pollMs = options.pollMs ?? 1000;
  let tail: Promise<void> = Promise.resolve();
  let active = 0;
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  return {
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      return (async () => {
        let started = false;
        try {
          // A canceled waiter still keeps its place until the one ahead is done.
          await previous;
          signal?.throwIfAborted();
          while (blocked()) await wait(pollMs, signal);
          started = true;
          active++;
          try {
            return await work();
          } finally {
            active--;
            // The rest belongs to the queue, not to the finished caller.
            void wait(restMs).then(release);
          }
        } catch (error) {
          if (!started) release();
          throw error;
        }
      })();
    },
    get active() {
      return active;
    },
  };
}
