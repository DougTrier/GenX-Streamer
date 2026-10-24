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

import {
  validateAutomaticGuideCapture,
  type AutomaticGuideCapture,
  type AutomaticGuideSavedSnapshot,
} from './automatic-guide-capture';

/** One CPU-only worker; abort and every completion terminate it before settlement. */
export function captureAutomaticGuideInWorker(
  snapshot: AutomaticGuideSavedSnapshot,
  signal: AbortSignal,
): Promise<AutomaticGuideCapture> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./automatic-guide-capture-worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker.terminate();
      action();
    };
    const cancel = () =>
      finish(() => reject(new DOMException('Program guide capture canceled.', 'AbortError')));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value: unknown }>) => {
      finish(() => {
        try {
          if (!event.data?.ok) throw new Error('Saved channels could not prepare a program guide.');
          resolve(validateAutomaticGuideCapture(event.data.value));
        } catch (error) {
          reject(error);
        }
      });
    };
    worker.onerror = () =>
      finish(() => reject(new Error('Program guide capture could not finish.')));
    worker.onmessageerror = () =>
      finish(() => reject(new Error('Program guide capture reply was invalid.')));
    try {
      worker.postMessage(snapshot);
    } catch {
      finish(() => reject(new Error('Program guide capture could not start.')));
    }
    if (signal.aborted) cancel();
  });
}
