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
  prepareCapture,
  prepareStoredCapture,
  prepareInitialProgressCapture,
  prepareInitialPackedProgressCapture,
  type ScanCheckpointProgressCaptureOptions,
} from './scan-checkpoint-capture-service';

export type ScanCheckpointCaptureMode = 'legacy' | 'version1' | 'version2' | 'version3';
export interface ScanCheckpointCapability {
  advance: boolean;
  packedReference: boolean;
}
export interface ResumedCheckpointFormat {
  jobId: string;
  schemaVersion: 1 | 2 | 3;
}

/** A restarted job keeps its acknowledged format; capability upgrades apply to new jobs. */
export function selectScanCheckpointMode(
  capability: ScanCheckpointCapability,
  resumed: ResumedCheckpointFormat | null,
  jobId: string,
): ScanCheckpointCaptureMode {
  if (resumed?.jobId === jobId) {
    if (resumed.schemaVersion === 3 && !(capability.advance && capability.packedReference))
      throw new Error('Saved scan format is not supported by this version.');
    return `version${resumed.schemaVersion}`;
  }
  return capability.advance ? (capability.packedReference ? 'version3' : 'version2') : 'legacy';
}

type Hooks = {
  plain: typeof prepareCapture;
  stored: typeof prepareStoredCapture;
  reference: typeof prepareInitialProgressCapture;
  packed: typeof prepareInitialPackedProgressCapture;
};
/** Preserve V1 with full saves; V2/3 can use the unchanged negotiated delta protocol. */
export function scanCheckpointModeOptions(
  capability: ScanCheckpointCapability,
  mode: ScanCheckpointCaptureMode,
  hooks: Hooks = {
    plain: prepareCapture,
    stored: prepareStoredCapture,
    reference: prepareInitialProgressCapture,
    packed: prepareInitialPackedProgressCapture,
  },
): ScanCheckpointProgressCaptureOptions {
  if (mode === 'version3' && !(capability.advance && capability.packedReference))
    throw new Error('Saved scan format is not supported by this version.');
  return {
    supportsAdvance: capability.advance && (mode === 'version2' || mode === 'version3'),
    supportsPackedReference: mode === 'version3',
    initial: hooks.reference,
    packedInitial: hooks.packed,
    legacy:
      mode === 'version1'
        ? hooks.plain
        : mode === 'version2'
          ? async (input, signal) => (await hooks.reference(input, signal))?.checkpoint ?? null
          : hooks.stored,
  };
}
