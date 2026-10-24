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

import { describe, expect, it } from 'vitest';
import {
  createHealthObservation,
  reconcileHealth,
  type HealthEvidence,
} from '../../src/discovery/health';
const identity = { channelId: 'channel', sourceId: 'source', fingerprint: 'opaque-revision' };
const metadata = { platform: 'Windows-WebView', observedAt: 100 };
const before = { mediaTime: 1, decodedFrames: 1, width: 640, height: 360 };
const decoded: HealthEvidence = {
  kind: 'decoded',
  before,
  after: { ...before, mediaTime: 2, decodedFrames: 31 },
  elapsedMilliseconds: 1000,
};
describe('evidence-scoped stream health', () => {
  it('recognition and transport failures retain their evidence without inventing HTTP status or decoder proof', () => {
    expect(
      createHealthObservation(identity, metadata, { kind: 'recognized-media-response' }).verdict,
    ).toBe('Reachable');
    const failed = createHealthObservation(identity, metadata, { kind: 'network-failure' });
    expect(failed.verdict).toBe('TemporaryUnavailable');
    expect(failed.evidence).toEqual({ kind: 'network-failure' });
    expect(reconcileHealth(identity, null, failed).canRemove).toBe(false);
  });
  it('HTTP success means reachable, never proof of decoded playback', () => {
    for (const status of [200, 206])
      expect(
        createHealthObservation(identity, metadata, {
          kind: 'http',
          status,
          contentRecognized: true,
        }).verdict,
      ).toBe('Reachable');
    expect(createHealthObservation(identity, metadata, { kind: 'http', status: 200 }).verdict).toBe(
      'NotChecked',
    );
  });
  it('requires both actual decoded frames and media-time progress for PlayedHere', () => {
    expect(createHealthObservation(identity, metadata, decoded).verdict).toBe('PlayedHere');
    for (const after of [
      { ...before, mediaTime: 2 },
      { ...before, decodedFrames: 2 },
      { ...before, mediaTime: 2, decodedFrames: 2, width: 0 },
    ])
      expect(
        createHealthObservation(identity, metadata, {
          kind: 'decoded',
          before,
          after,
          elapsedMilliseconds: 1000,
        }).verdict,
      ).toBe('NotChecked');
  });
  it('records timeout, access denial and platform incompatibility without declaring permanent removal', () => {
    const cases: Array<[HealthEvidence, string]> = [
      [{ kind: 'timeout' }, 'TimedOut'],
      [{ kind: 'unsupported' }, 'UnsupportedHere'],
      [{ kind: 'http', status: 403 }, 'AccessDenied'],
      [{ kind: 'http', status: 451 }, 'AccessDenied'],
      [{ kind: 'http', status: 429 }, 'TemporaryUnavailable'],
      [{ kind: 'http', status: 404 }, 'TemporaryUnavailable'],
    ];
    for (const [evidence, verdict] of cases) {
      const observation = createHealthObservation(identity, metadata, evidence);
      expect(observation.verdict).toBe(verdict);
      expect(reconcileHealth(identity, null, observation).canRemove).toBe(false);
    }
  });
  it('ignores stale source/URL fingerprints and preserves current observation', () => {
    const previous = createHealthObservation(identity, metadata, decoded);
    const stale = createHealthObservation({ ...identity, fingerprint: 'old-revision' }, metadata, {
      kind: 'timeout',
    });
    expect(reconcileHealth(identity, previous, stale)).toEqual({
      record: previous,
      accepted: false,
      canRemove: false,
    });
  });
  it('cancellation and local network loss preserve prior health; no prior cancellation is not a failure', () => {
    const previous = createHealthObservation(identity, metadata, decoded);
    for (const kind of ['canceled', 'local-network-unavailable', 'not-checked'] as const) {
      const observation = createHealthObservation(
        identity,
        { ...metadata, observedAt: 101 },
        { kind },
      );
      expect(reconcileHealth(identity, previous, observation).record).toEqual(previous);
    }
    expect(
      reconcileHealth(
        identity,
        null,
        createHealthObservation(identity, metadata, { kind: 'canceled' }),
      ).record?.verdict,
    ).toBe('Canceled');
  });
  it('rejects out-of-order result and reclassifies fabricated decoder success', () => {
    const previous = createHealthObservation(identity, metadata, decoded);
    expect(
      reconcileHealth(
        identity,
        previous,
        createHealthObservation(identity, { ...metadata, observedAt: 99 }, { kind: 'timeout' }),
      ).accepted,
    ).toBe(false);
    const reachable = createHealthObservation(identity, metadata, {
      kind: 'http',
      status: 200,
      contentRecognized: true,
    });
    expect(
      reconcileHealth(identity, null, { ...reachable, verdict: 'PlayedHere' }).record?.verdict,
    ).toBe('Reachable');
  });
  it('does not retain caller-owned mutable decode samples or raw URL identity diagnostics', () => {
    const sample = { ...before };
    const observation = createHealthObservation(identity, metadata, {
      kind: 'decoded',
      before: sample,
      after: { ...sample, mediaTime: 2, decodedFrames: 2 },
      elapsedMilliseconds: 1000,
    });
    sample.mediaTime = 99;
    expect(observation.evidence.kind === 'decoded' && observation.evidence.before.mediaTime).toBe(
      1,
    );
    expect(() =>
      createHealthObservation(
        { ...identity, fingerprint: 'https://private.invalid/token' },
        metadata,
        decoded,
      ),
    ).toThrow('metadata is invalid');
  });
});
