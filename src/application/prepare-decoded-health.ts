import type { Channel, Source } from '../catalog';
import {
  fingerprintHealthTarget,
  serializeHealthPayload,
  validateHealthRecord,
  type PersistedHealthRecord,
} from '../catalog/health-record';
import { validDecodedProgress, type DecodedProgressEvidence } from '../playback/controller';
export interface PrepareDecodedHealthInput {
  channel: Channel;
  source: Source;
  checkedUrlOrdinal: number;
  evidence: DecodedProgressEvidence;
  platform: string;
  observerProfile: string;
  observedAt: number;
}
export interface PreparedDecodedHealth {
  health: string;
  record: PersistedHealthRecord;
}
export async function prepareDecodedHealth(
  input: PrepareDecodedHealthInput,
  signal?: AbortSignal,
): Promise<PreparedDecodedHealth> {
  signal?.throwIfAborted();
  const captured = structuredClone(input);
  if (!validDecodedProgress(captured.evidence))
    throw new Error('Decoded progress is not established.');
  if (
    [captured.platform, captured.observerProfile].some(
      (value) => !value.trim() || /https?:\/\//i.test(value),
    )
  )
    throw new Error('Decoder context is unavailable.');
  const targetFingerprint = await fingerprintHealthTarget(
    captured.source,
    captured.channel,
    captured.checkedUrlOrdinal,
  );
  signal?.throwIfAborted();
  const record = validateHealthRecord({
    schemaVersion: 1,
    channelId: captured.channel.id,
    sourceId: captured.source.id,
    checkedUrlOrdinal: captured.checkedUrlOrdinal,
    targetFingerprint,
    platform: captured.platform,
    observerProfile: captured.observerProfile,
    observedAt: captured.observedAt,
    verdict: 'PlayedHere',
    evidence: captured.evidence,
    origin: 'local',
  });
  return { health: serializeHealthPayload([record]), record };
}
