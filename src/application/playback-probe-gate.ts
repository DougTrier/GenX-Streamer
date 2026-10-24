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

/**
 * Background channel checks yield bandwidth to the viewer: while something is
 * playing (or starting/buffering), at most `limit` checks run at once. Waiting
 * checks start as slots free up or playback ends; cancellation stays prompt.
 */
export function createPlaybackProbeGate(
  viewing: () => boolean,
  options: { limit?: number; pollMs?: number } = {},
) {
  const limit = options.limit ?? 2;
  const pollMs = options.pollMs ?? 250;
  let active = 0;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const admitted = () => !viewing() || active < limit;
  const acquire = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (admitted()) {
        active++;
        return resolve();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        waiters.delete(check);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const check = () => {
        if (!admitted()) return;
        done();
        active++;
        resolve();
      };
      const abort = () => {
        done();
        reject(signal!.reason);
      };
      // Playback can stop without a slot being released; poll as well.
      const poll = () => {
        check();
        if (waiters.has(check)) timer = setTimeout(poll, pollMs);
      };
      waiters.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(poll, pollMs);
    });
  return {
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await work();
      } finally {
        active--;
        wake();
      }
    },
    get active() {
      return active;
    },
  };
}
