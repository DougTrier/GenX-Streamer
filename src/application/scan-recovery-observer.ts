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
  isScanReconstructionFailureCode,
  type ScanReconstructionFailureCode,
} from '../discovery/scan-checkpoint';

export type ScanRecoveryStage =
  | 'idle'
  | 'reading'
  | 'decoding'
  | 'source-authority'
  | 'policy'
  | 'candidate-storage'
  | 'candidate-restore'
  | 'reacquiring'
  | 'source-definition'
  | 'immutable-review'
  | 'catalog-fence'
  | 'accepted'
  | 'absent'
  | 'refused';
export type ScanRecoveryReason =
  | 'none'
  | 'read-unavailable'
  | 'invalid-checkpoint'
  | 'unsupported-format'
  | 'source-settings-changed'
  | 'expired-or-policy-changed'
  | 'candidate-storage-unavailable'
  | 'source-unavailable'
  | 'immutable-review-changed'
  | 'saved-catalog-changed'
  | 'canceled';

/** Fixed scalar observations only; old completions cannot overwrite a newer recovery. */
export function createScanRecoveryObserver() {
  let current = Symbol(),
    generation = 0;
  let stage: ScanRecoveryStage = 'idle',
    reason: ScanRecoveryReason = 'none';
  let reconstructionFailure: ScanReconstructionFailureCode | null = null;
  let storedVersion: 1 | 2 | 3 | null = null,
    checked = 0,
    published = 0;
  return {
    begin() {
      current = Symbol();
      generation = Math.min(Number.MAX_SAFE_INTEGER, generation + 1);
      stage = 'reading';
      reason = 'none';
      reconstructionFailure = null;
      storedVersion = null;
      checked = 0;
      published = 0;
      return current;
    },
    step(token: symbol, next: ScanRecoveryStage) {
      if (token === current) stage = next;
    },
    decoded(token: symbol, version: 1 | 2 | 3, checks: number, saves: number) {
      if (token !== current) return;
      storedVersion = version;
      checked = checks;
      published = saves;
    },
    refuse(token: symbol, why: ScanRecoveryReason, detail?: ScanReconstructionFailureCode | null) {
      if (token !== current) return;
      stage = 'refused';
      reason = why;
      reconstructionFailure =
        why === 'immutable-review-changed' && isScanReconstructionFailureCode(detail)
          ? detail
          : null;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 1 as const,
        generation,
        stage,
        reason,
        storedVersion,
        checked,
        published,
        reconstructionFailure,
      });
    },
  };
}
