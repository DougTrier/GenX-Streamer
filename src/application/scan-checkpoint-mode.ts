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
