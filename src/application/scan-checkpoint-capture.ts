import { PackedCheckpointSizeError } from '../discovery/scan-checkpoint-packed';
import { validateSource } from '../catalog/codec';
import {
  MAX_SCAN_CHECKPOINT_BYTES,
  prepareScanCheckpoint,
  prepareSupportedScanCheckpoint,
  fingerprintScanSource,
  isScanCheckpointSourceResumable,
  serializeScanCheckpoint,
  parseScanCheckpoint,
  prepareReferencedScanCheckpoint,
  parseStoredScanCheckpoint,
  restoreReferencedScanCheckpoint,
  type ReferencedScanCheckpoint,
  type PackedScanCheckpoint,
  restorePackedScanCheckpoint,
  preparePackedScanCheckpoint,
  validateCheckpointSourceAdmission,
} from '../discovery/scan-checkpoint';
import type { ScanReview } from '../discovery/scan';
import { boundedUtf8Text } from '../platform/bounded-text';

export type ScanCheckpointCaptureInput = Parameters<typeof prepareScanCheckpoint>[0];

/** CPU-only worker boundary; unsupported source scope and size are deliberate refusals. */
export async function captureScanCheckpoint(
  input: ScanCheckpointCaptureInput,
): Promise<string | null> {
  if (!input || !Array.isArray(input.sources))
    throw new Error('Scan checkpoint capture is invalid.');
  if ((input.canonicalSources?.length ?? 0) > 100)
    throw new Error('Scan checkpoint capture is invalid.');
  const canonical = new Map<string, string>();
  for (const raw of input.canonicalSources ?? []) {
    const source = validateSource(raw);
    if (canonical.has(source.id)) throw new Error('Scan checkpoint capture is invalid.');
    canonical.set(source.id, await fingerprintScanSource(source));
  }
  for (const raw of input.sources) {
    const source = validateSource(raw);
    if (!isScanCheckpointSourceResumable(source)) return null;
    const saved = canonical.get(source.id);
    if (saved !== undefined) {
      if (saved !== (await fingerprintScanSource(source))) return null;
      continue;
    }
    if (
      source.kind !== 'url' ||
      input.providers === null ||
      !input.providers.some(
        (provider) =>
          provider.location === source.location &&
          (provider.allowHttp === true) === (source.allowHttp === true),
      )
    )
      return null;
  }
  if (!boundedUtf8Text(JSON.stringify(input), MAX_SCAN_CHECKPOINT_BYTES)) return null;
  // Hash strings have fixed size; check the eventual envelope before hashing/validation.
  const { sources, providers: _providers, canonicalSources: _canonicalSources, ...state } = input;
  const sizedEnvelope = {
    ...state,
    schemaVersion: 1,
    policyFingerprint: '0'.repeat(64),
    sourceDefinitions: sources.map((source) => ({ source, definitionFingerprint: '0'.repeat(64) })),
    review: {
      ...state.review,
      sources: state.review.sources.map(
        ({ sourceId, fingerprint, status, inspected, matched, warnings }) => ({
          sourceId,
          fingerprint,
          status,
          inspected,
          matched,
          warnings,
        }),
      ),
    },
  };
  if (!boundedUtf8Text(JSON.stringify(sizedEnvelope), MAX_SCAN_CHECKPOINT_BYTES)) return null;
  const checkpoint = await prepareSupportedScanCheckpoint(input);
  return checkpoint === null ? null : serializeScanCheckpoint(checkpoint);
}

export const parseCapturedScanCheckpoint = parseScanCheckpoint;

/** Additive v2 fallback. Refusals never drop candidates or persist excluded stream addresses. */
export async function captureStoredScanCheckpoint(
  input: ScanCheckpointCaptureInput,
): Promise<string | null> {
  const ordinary = await captureScanCheckpoint(input);
  if (ordinary !== null) return ordinary;
  if (!boundedUtf8Text(JSON.stringify(input), MAX_SCAN_CHECKPOINT_BYTES)) return null;
  try {
    const reference = await prepareReferencedScanCheckpoint(input);
    const { validateCheckpointSourceAdmission } = await import('../discovery/scan-checkpoint');
    await validateCheckpointSourceAdmission(
      reference,
      input.canonicalSources ?? [],
      input.providers,
    );
    const text = JSON.stringify(reference);
    return boundedUtf8Text(text, MAX_SCAN_CHECKPOINT_BYTES) ? text : null;
  } catch {
    return null;
  }
}
export const parseStoredCapturedScanCheckpoint = parseStoredScanCheckpoint;
export function restoreReferencedCapturedScanCheckpoint(input: {
  reference: ReferencedScanCheckpoint;
  review: ScanReview;
}) {
  return restoreReferencedScanCheckpoint(input.reference, input.review);
}

export interface InitialProgressCapture {
  checkpoint: string;
  reviewDigest: string;
  policyFingerprint: string;
}
/** Native progress protocol requires one forced URL-free v2 snapshot, never a plaintext v1 seed. */
export async function captureInitialProgressCheckpoint(
  input: ScanCheckpointCaptureInput,
): Promise<InitialProgressCapture | null> {
  if (!boundedUtf8Text(JSON.stringify(input), MAX_SCAN_CHECKPOINT_BYTES)) return null;
  const definitions = [];
  for (const source of input.sources)
    definitions.push({ source, definitionFingerprint: await fingerprintScanSource(source) });
  const { validateCheckpointSourceAdmission } = await import('../discovery/scan-checkpoint');
  try {
    await validateCheckpointSourceAdmission(
      { sourceDefinitions: definitions },
      input.canonicalSources ?? [],
      input.providers,
    );
  } catch {
    return null;
  }
  if (input.sources.some((source) => source.kind !== 'url')) return null;
  const reference = await prepareReferencedScanCheckpoint(input),
    checkpoint = JSON.stringify(reference);
  return boundedUtf8Text(checkpoint, MAX_SCAN_CHECKPOINT_BYTES)
    ? {
        checkpoint,
        reviewDigest: reference.reviewDigest,
        policyFingerprint: reference.policyFingerprint,
      }
    : null;
}

/** Consumer only; no production packed emission is enabled here. */
export function restorePackedCapturedScanCheckpoint(input: {
  reference: PackedScanCheckpoint;
  review: ScanReview;
}) {
  return restorePackedScanCheckpoint(input.reference, input.review);
}

/** Explicit capability-selected v3 seed. Expanded review size is not the persisted wire size. */
export async function captureInitialPackedProgressCheckpoint(
  input: ScanCheckpointCaptureInput,
): Promise<InitialProgressCapture | null> {
  if (!input || !Array.isArray(input.sources) || input.sources.length > 100)
    throw new Error('Scan checkpoint capture is invalid.');
  const definitions = [];
  for (const source of input.sources)
    definitions.push({ source, definitionFingerprint: await fingerprintScanSource(source) });
  try {
    await validateCheckpointSourceAdmission(
      { sourceDefinitions: definitions },
      input.canonicalSources ?? [],
      input.providers,
    );
  } catch {
    return null;
  }
  if (input.sources.some((source) => source.kind !== 'url')) return null;
  try {
    const packed = await preparePackedScanCheckpoint(input);
    const checkpoint = JSON.stringify(packed);
    return boundedUtf8Text(checkpoint, MAX_SCAN_CHECKPOINT_BYTES)
      ? {
          checkpoint,
          reviewDigest: packed.reviewDigest,
          policyFingerprint: packed.policyFingerprint,
        }
      : null;
  } catch (error) {
    if (error instanceof PackedCheckpointSizeError) return null;
    throw error;
  }
}
