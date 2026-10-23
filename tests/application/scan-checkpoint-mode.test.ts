import { describe, expect, it } from 'vitest';
import {
  selectScanCheckpointMode,
  scanCheckpointModeOptions,
} from '../../src/application/scan-checkpoint-mode';
import { createScanCheckpointProgressCapture } from '../../src/application/scan-checkpoint-capture-service';
import {
  captureScanCheckpoint,
  captureStoredScanCheckpoint,
  captureInitialProgressCheckpoint,
  captureInitialPackedProgressCheckpoint,
  type ScanCheckpointCaptureInput,
} from '../../src/application/scan-checkpoint-capture';
import { checkpointFixture, checkpointProviders } from '../discovery/helpers/scan-checkpoint';

const modern = { advance: true, packedReference: true };
const hooks = {
  plain: async (input: ScanCheckpointCaptureInput) => captureScanCheckpoint(input),
  stored: async (input: ScanCheckpointCaptureInput) => captureStoredScanCheckpoint(input),
  reference: async (input: ScanCheckpointCaptureInput) => captureInitialProgressCheckpoint(input),
  packed: async (input: ScanCheckpointCaptureInput) =>
    captureInitialPackedProgressCheckpoint(input),
};
async function input(): Promise<ScanCheckpointCaptureInput> {
  const {
    schemaVersion: _schema,
    sourceDefinitions,
    policyFingerprint: _policy,
    ...state
  } = await checkpointFixture();
  return {
    ...state,
    sources: sourceDefinitions.map((entry) => entry.source),
    providers: checkpointProviders,
  };
}

describe('resumed scan format negotiation', () => {
  it.each([1, 2, 3] as const)(
    'preserves a V%i job under V3 capability through an actual save and acknowledged continuation',
    async (version) => {
      const value = await input();
      const mode = selectScanCheckpointMode(
        modern,
        { jobId: value.jobId, schemaVersion: version },
        value.jobId,
      );
      const owner = createScanCheckpointProgressCapture(
        scanCheckpointModeOptions(modern, mode, hooks),
      );
      const save = await owner.prepareMutation(value, new AbortController().signal);
      expect(save?.kind).toBe('save');
      if (save?.kind !== 'save') throw new Error('Missing initial save');
      const wire = JSON.parse(save.checkpoint);
      expect(wire.schemaVersion).toBe(version);
      owner.acknowledgeMutation(save, '1');
      const next = await owner.prepareMutation(
        { ...value, publishedKeys: ['captured-key'] },
        new AbortController().signal,
      );
      if (version === 1) {
        expect(next?.kind).toBe('save');
        if (next?.kind !== 'save') throw new Error('Missing legacy save');
        expect(JSON.parse(next.checkpoint).schemaVersion).toBe(1);
      } else {
        expect(next).toMatchObject({
          kind: 'advance',
          jobId: value.jobId,
          reviewDigest: wire.reviewDigest,
          publishedKeys: ['captured-key'],
        });
      }
      await owner.dispose();
    },
  );

  it('capability changes apply to new job identities and preserve browser/older-native defaults', () => {
    expect(selectScanCheckpointMode(modern, { jobId: 'old', schemaVersion: 1 }, 'new')).toBe(
      'version3',
    );
    expect(selectScanCheckpointMode({ advance: true, packedReference: false }, null, 'new')).toBe(
      'version2',
    );
    expect(selectScanCheckpointMode({ advance: false, packedReference: false }, null, 'new')).toBe(
      'legacy',
    );
    expect(() =>
      selectScanCheckpointMode(
        { advance: false, packedReference: true },
        { jobId: 'old', schemaVersion: 3 },
        'old',
      ),
    ).toThrow('not supported');
  });

  it('a V2 job on a full-save backend remains V2 without pretending to acknowledge a delta', async () => {
    const value = await input(),
      capability = { advance: false, packedReference: false };
    const mode = selectScanCheckpointMode(
      capability,
      { jobId: value.jobId, schemaVersion: 2 },
      value.jobId,
    );
    const owner = createScanCheckpointProgressCapture(
      scanCheckpointModeOptions(capability, mode, hooks),
    );
    const save = await owner.prepareMutation(value, new AbortController().signal);
    if (save?.kind !== 'save') throw new Error('Missing full save');
    expect(JSON.parse(save.checkpoint).schemaVersion).toBe(2);
    owner.acknowledgeMutation(save, '1');
    const next = await owner.prepareMutation(value, new AbortController().signal);
    expect(next?.kind).toBe('save');
    await owner.dispose();
  });

  it('a pinned V1 whole-size refusal stays a refusal rather than migrating or truncating', async () => {
    const value = await input();
    value.review.query = 'x'.repeat(20 * 1024 * 1024);
    const options = scanCheckpointModeOptions(modern, 'version1', hooks);
    const owner = createScanCheckpointProgressCapture(options);
    expect(await owner.prepareMutation(value, new AbortController().signal)).toBeNull();
    expect(owner.hasPendingPreparation).toBe(false);
    await owner.dispose();
  });
});
