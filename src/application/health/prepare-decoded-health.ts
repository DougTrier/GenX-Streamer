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

import type { Channel, Source } from '../../catalog';
import {
  fingerprintHealthTarget,
  serializeHealthPayload,
  validateHealthRecord,
  type PersistedHealthRecord,
} from '../../catalog/health-record';
import { validDecodedProgress, type DecodedProgressEvidence } from '../../playback/controller';
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
