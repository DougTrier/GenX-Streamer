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

/** Health belongs to an exact channel/source revision and platform observation. */
export interface HealthIdentity {
  channelId: string;
  sourceId: string;
  fingerprint: string;
}
export type HealthVerdict =
  | 'NotChecked'
  | 'Reachable'
  | 'PlayedHere'
  | 'TimedOut'
  | 'AccessDenied'
  | 'UnsupportedHere'
  | 'TemporaryUnavailable'
  | 'Canceled';
export interface DecodeSample {
  mediaTime: number;
  decodedFrames: number;
  width: number;
  height: number;
}
export type HealthEvidence =
  | { kind: 'http'; status: number; contentRecognized?: boolean }
  | { kind: 'recognized-media-response' }
  | { kind: 'decoded'; before: DecodeSample; after: DecodeSample; elapsedMilliseconds: number }
  | { kind: 'timeout' }
  /** No first answer within the scan's 3 s triage: kept for the Slow pass. */
  | { kind: 'slow' }
  | { kind: 'unsupported' }
  | { kind: 'canceled' }
  | { kind: 'local-network-unavailable' }
  | { kind: 'network-failure' }
  /** Not requested: earlier checks in this scan could not reach the site. */
  | { kind: 'host-down' }
  | { kind: 'not-checked' };
export interface HealthObservation extends HealthIdentity {
  platform: string;
  observedAt: number;
  verdict: HealthVerdict;
  evidence: HealthEvidence;
}
function validate(identity: HealthIdentity, platform: string, observedAt: number): void {
  if (
    [identity.channelId, identity.sourceId, identity.fingerprint, platform].some(
      (value) => !value.trim() || value.length > 256 || /https?:\/\//i.test(value),
    ) ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0
  )
    throw new Error('Health identity or observation metadata is invalid.');
}
function progress(evidence: Extract<HealthEvidence, { kind: 'decoded' }>): boolean {
  const samples = [evidence.before, evidence.after];
  return (
    Number.isFinite(evidence.elapsedMilliseconds) &&
    evidence.elapsedMilliseconds > 0 &&
    samples.every(
      (sample) =>
        Number.isFinite(sample.mediaTime) &&
        sample.mediaTime >= 0 &&
        Number.isSafeInteger(sample.decodedFrames) &&
        sample.decodedFrames >= 0 &&
        Number.isInteger(sample.width) &&
        sample.width > 0 &&
        Number.isInteger(sample.height) &&
        sample.height > 0,
    ) &&
    evidence.after.mediaTime > evidence.before.mediaTime &&
    evidence.after.decodedFrames > evidence.before.decodedFrames
  );
}
export function createHealthObservation(
  identity: HealthIdentity,
  metadata: { platform: string; observedAt: number },
  evidence: HealthEvidence,
): HealthObservation {
  validate(identity, metadata.platform, metadata.observedAt);
  const verdict = healthVerdict(evidence);
  const copy =
    evidence.kind === 'decoded'
      ? { ...evidence, before: { ...evidence.before }, after: { ...evidence.after } }
      : { ...evidence };
  return { ...identity, ...metadata, evidence: copy, verdict };
}
/** The fixed verdict for one piece of evidence (scan health and saved-channel checks). */
export function healthVerdict(evidence: HealthEvidence): HealthVerdict {
  let verdict: HealthVerdict = 'NotChecked';
  if (evidence.kind === 'http') {
    if (!Number.isInteger(evidence.status) || evidence.status < 100 || evidence.status > 599)
      throw new Error('Health HTTP status is invalid.');
    if (evidence.status >= 200 && evidence.status < 300 && evidence.contentRecognized === true)
      verdict = 'Reachable';
    else if ([401, 403, 451].includes(evidence.status)) verdict = 'AccessDenied';
    else if (evidence.status >= 400) verdict = 'TemporaryUnavailable';
  } else if (evidence.kind === 'recognized-media-response') verdict = 'Reachable';
  else if (evidence.kind === 'decoded') verdict = progress(evidence) ? 'PlayedHere' : 'NotChecked';
  else if (evidence.kind === 'timeout' || evidence.kind === 'slow') verdict = 'TimedOut';
  else if (evidence.kind === 'unsupported') verdict = 'UnsupportedHere';
  else if (evidence.kind === 'canceled') verdict = 'Canceled';
  else if (evidence.kind === 'network-failure' || evidence.kind === 'host-down')
    verdict = 'TemporaryUnavailable';
  return verdict;
}
function same(a: HealthIdentity, b: HealthIdentity): boolean {
  return (
    a.channelId === b.channelId && a.sourceId === b.sourceId && a.fingerprint === b.fingerprint
  );
}
export function reconcileHealth(
  current: HealthIdentity,
  previous: HealthObservation | null,
  observation: HealthObservation,
): { record: HealthObservation | null; accepted: boolean; canRemove: false } {
  const retained = previous && same(current, previous) ? previous : null;
  if (
    !same(current, observation) ||
    (retained && observation.observedAt < retained.observedAt) ||
    (retained &&
      ['canceled', 'local-network-unavailable', 'not-checked'].includes(observation.evidence.kind))
  )
    return { record: retained, accepted: false, canRemove: false };
  // Reclassify rather than trusting a fabricated PlayedHere verdict from callers.
  const checked = createHealthObservation(current, observation, observation.evidence);
  return { record: checked, accepted: true, canRemove: false };
}
