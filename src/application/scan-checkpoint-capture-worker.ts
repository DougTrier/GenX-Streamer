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
  captureScanCheckpoint,
  captureInitialProgressCheckpoint,
  captureInitialPackedProgressCheckpoint,
  parseCapturedScanCheckpoint,
  type ScanCheckpointCaptureInput,
  captureStoredScanCheckpoint,
  parseStoredCapturedScanCheckpoint,
  restoreReferencedCapturedScanCheckpoint,
  restorePackedCapturedScanCheckpoint,
} from './scan-checkpoint-capture';
import { scanReconstructionFailureCode } from '../discovery/scan-checkpoint';

self.onmessage = async (
  event: MessageEvent<{
    operation:
      | 'prepare'
      | 'parse'
      | 'prepare-stored'
      | 'parse-stored'
      | 'parse-stored-packed'
      | 'restore-packed-reference'
      | 'restore-reference'
      | 'prepare-progress-initial'
      | 'prepare-progress-initial-packed';
    input: unknown;
  }>,
) => {
  const { operation, input } = event.data;
  try {
    const value =
      operation === 'prepare-progress-initial-packed'
        ? await captureInitialPackedProgressCheckpoint(input as ScanCheckpointCaptureInput)
        : operation === 'prepare-progress-initial'
          ? await captureInitialProgressCheckpoint(input as ScanCheckpointCaptureInput)
          : operation === 'prepare'
            ? await captureScanCheckpoint(input as ScanCheckpointCaptureInput)
            : operation === 'prepare-stored'
              ? await captureStoredScanCheckpoint(input as ScanCheckpointCaptureInput)
              : (operation === 'parse-stored' || operation === 'parse-stored-packed') &&
                  typeof input === 'string'
                ? await parseStoredCapturedScanCheckpoint(input)
                : operation === 'restore-packed-reference'
                  ? await restorePackedCapturedScanCheckpoint(
                      input as Parameters<typeof restorePackedCapturedScanCheckpoint>[0],
                    )
                  : operation === 'restore-reference'
                    ? await restoreReferencedCapturedScanCheckpoint(
                        input as Parameters<typeof restoreReferencedCapturedScanCheckpoint>[0],
                      )
                    : operation === 'parse' && typeof input === 'string'
                      ? await parseCapturedScanCheckpoint(input)
                      : (() => {
                          throw new Error('Invalid operation');
                        })();
    self.postMessage({ operation, ok: true, value });
  } catch (error) {
    const reconstructionFailure =
      operation === 'restore-reference' || operation === 'restore-packed-reference'
        ? scanReconstructionFailureCode(error)
        : null;
    self.postMessage({
      operation,
      ok: false,
      ...(reconstructionFailure === null ? {} : { reconstructionFailure }),
    });
  }
};
