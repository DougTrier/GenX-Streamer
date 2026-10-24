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

/** Holds wake transport until the actual native listener acknowledgments arrive. */
export function createWakeTransportAdmission() {
  let state: 'pending' | 'released' | 'failed' = 'pending';
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const create = () => {
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Admission can fail before a wake caller attaches; the same promise remains rejected.
    void promise.catch(() => undefined);
    return promise;
  };
  let admission = create();
  return {
    wait(): Promise<void> {
      return admission;
    },
    release(): void {
      if (state !== 'pending') return;
      state = 'released';
      resolve();
    },
    fail(): void {
      if (state !== 'pending') return;
      state = 'failed';
      reject(new Error('Native wake transport admission failed.'));
    },
    retry(): void {
      if (state !== 'failed') return;
      state = 'pending';
      admission = create();
    },
  };
}
