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
