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

/** The visible Exit action uses the same joined native cleanup as window Close. */
export function mountExit(
  button: HTMLButtonElement,
  host: { native(): boolean; request(): Promise<void>; notice(message: string): void },
): () => void {
  let pending = false;
  let disposed = false;
  const exit = () => {
    if (pending || disposed) return;
    if (!host.native()) {
      host.notice('Close this browser tab to exit the preview.');
      return;
    }
    pending = true;
    button.disabled = true;
    void host.request().catch(() => {
      pending = false;
      if (!disposed) {
        button.disabled = false;
        host.notice('Closing could not start. Try Exit app again.');
      }
    });
  };
  button.addEventListener('click', exit);
  return () => {
    disposed = true;
    button.removeEventListener('click', exit);
  };
}
