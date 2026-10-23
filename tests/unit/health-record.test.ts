import { describe, it, expect } from 'vitest';
import {
  fingerprintHealthTarget,
  validateHealthRecord,
  validateHealthRecords,
  reconcileHealthRecords,
  healthFreshness,
  remapReviewedHealth,
  type PersistedHealthRecord,
  type ReviewedHealthMapping,
  parseHealthPayload,
  serializeHealthPayload,
} from '../../src/catalog/health-record';
import { createHealthObservation, type HealthEvidence } from '../../src/discovery/health';
import type { Channel, Source } from '../../src/catalog/parser';
const source: Source = {
  id: 'source',
  name: 'Source',
  kind: 'url',
  location: 'https://example.test/list?token=exact',
};
const channel: Channel = {
  id: 'canonical',
  sourceId: 'source',
  name: 'Channel',
  category: 'Sports',
  urls: ['https://example.test/feed?sig=one', 'https://example.test/alternate'],
};
async function record(
  evidence: HealthEvidence = { kind: 'http', status: 200, contentRecognized: true },
  at = 1000,
): Promise<PersistedHealthRecord> {
  const observed = createHealthObservation(
    { channelId: 'fixture', sourceId: 'source', fingerprint: 'job' },
    { platform: 'windows-webview2', observedAt: at },
    evidence,
  );
  return {
    schemaVersion: 1,
    channelId: channel.id,
    sourceId: source.id,
    checkedUrlOrdinal: 0,
    targetFingerprint: await fingerprintHealthTarget(source, channel, 0),
    platform: 'windows-webview2',
    observerProfile: 'engine-fixture-1',
    observedAt: at,
    verdict: observed.verdict,
    evidence: observed.evidence,
    origin: 'local',
  };
}
function mapping(): ReviewedHealthMapping {
  return {
    candidate: {
      key: '1:0:0',
      sourceId: 'source',
      sourceFingerprint: 'job',
      sessionRevision: '1',
      channel: {
        sourceId: channel.sourceId,
        name: channel.name,
        category: channel.category,
        urls: [...channel.urls],
      },
    },
    channel: structuredClone(channel),
    source: { source: structuredClone(source), fingerprint: 'job' },
    checkedUrlOrdinal: 0,
  };
}
describe('persistable contextual health only', () => {
  it('standalone versioned payload roundtrips separately from catalog and rejects malformed/unknown schema', async () => {
    const observed = await record();
    expect(parseHealthPayload(serializeHealthPayload([observed]))).toEqual({
      schemaVersion: 1,
      records: [observed],
    });
    expect(() => parseHealthPayload('{bad')).toThrow(/JSON/);
    expect(() => parseHealthPayload('{"schemaVersion":2,"records":[]}')).toThrow(/schema/);
    expect(() => parseHealthPayload('{"schemaVersion":1,"records":[],"channels":[]}')).toThrow(
      /unsupported/,
    );
    expect(() => parseHealthPayload(' '.repeat(20 * 1024 * 1024 + 1))).toThrow(/bound/);
  });
  it('fingerprints exact source/permission/canonical URL ownership, including signed queries and alternate ordinals', async () => {
    const original = await fingerprintHealthTarget(source, channel, 0);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await fingerprintHealthTarget(
        { ...source, name: 'Renamed' },
        { ...channel, name: 'Renamed' },
        0,
      ),
    ).toBe(original);
    const cases: [Source, Channel, number][] = [
      [{ ...source, location: source.location + '&new=1' }, channel, 0],
      [{ ...source, allowHttp: true }, channel, 0],
      [source, { ...channel, id: 'other' }, 0],
      [source, { ...channel, urls: ['https://example.test/feed?sig=two'] }, 0],
      [source, channel, 1],
    ];
    for (const [s, c, n] of cases)
      expect(await fingerprintHealthTarget(s, c, n)).not.toBe(original);
    await expect(
      fingerprintHealthTarget(source, { ...channel, sourceId: 'other' }, 0),
    ).rejects.toThrow();
    await expect(
      fingerprintHealthTarget(source, { ...channel, urls: ['http://example.test/live'] }, 0),
    ).rejects.toThrow();
  });
  it('roundtrips bounded copied evidence and refuses fabricated PlayedHere or diagnostic extras', async () => {
    const original = await record();
    const result = validateHealthRecord(JSON.parse(JSON.stringify(original)));
    expect(result).toEqual(original);
    expect(() => validateHealthRecord({ ...original, verdict: 'PlayedHere' })).toThrow(/evidence/);
    expect(() =>
      validateHealthRecord({
        ...original,
        evidence: { ...original.evidence, url: 'https://private.test' },
      }),
    ).toThrow(/unsupported/);
    expect(() => validateHealthRecord({ ...original, error: 'provider raw body' })).toThrow(
      /unsupported/,
    );
    expect(() => validateHealthRecord({ ...original, schemaVersion: 2 })).toThrow(/schema/);
    expect(() => validateHealthRecord({ ...original, observedAt: -1 })).toThrow();
  });
  it('requires both real sample dimensions and advancing frames/media time, not an HTTP or playing label', async () => {
    const before = { mediaTime: 1, decodedFrames: 10, width: 640, height: 360 };
    const decoded = await record({
      kind: 'decoded',
      before,
      after: { ...before, mediaTime: 2, decodedFrames: 20 },
      elapsedMilliseconds: 1000,
    });
    expect(validateHealthRecord(decoded).verdict).toBe('PlayedHere');
    const staticFrames = await record({
      kind: 'decoded',
      before,
      after: { ...before, mediaTime: 2 },
      elapsedMilliseconds: 1000,
    });
    expect(staticFrames.verdict).toBe('NotChecked');
    expect(() =>
      validateHealthRecord({
        ...decoded,
        evidence: { ...decoded.evidence, before: { ...before, width: 0 } },
      }),
    ).toThrow(/sample/);
    expect(() => validateHealthRecord({ ...decoded, evidence: { kind: 'playing' } })).toThrow();
  });
  it('retains latest local observation across cancel/offline/notchecked, older responses and imported newer claims', async () => {
    const prior = await record();
    const targets = [prior];
    for (const kind of ['canceled', 'local-network-unavailable', 'not-checked'] as const)
      expect(reconcileHealthRecords([prior], [await record({ kind }, 2000)], targets)).toEqual([
        prior,
      ]);
    expect(
      reconcileHealthRecords([prior], [await record({ kind: 'timeout' }, 999)], targets),
    ).toEqual([prior]);
    expect(
      reconcileHealthRecords(
        [prior],
        [{ ...(await record({ kind: 'timeout' }, 2000)), origin: 'imported' }],
        targets,
      ),
    ).toEqual([prior]);
    const timeout = await record({ kind: 'timeout' }, 2000);
    expect(reconcileHealthRecords([prior], [timeout], targets)).toEqual([timeout]);
    expect(channel.id).toBe('canonical'); // This API emits observations only, never catalog removals.
  });
  it('invalidates changed targets while keeping distinct platform/profile and alternate checked URL evidence', async () => {
    const original = await record();
    const android = { ...original, platform: 'android-webview' };
    const otherProfile = { ...original, observerProfile: 'engine-fixture-2' };
    const records = reconcileHealthRecords([], [original, android, otherProfile], [original]);
    expect(records).toHaveLength(3);
    expect(
      reconcileHealthRecords(records, [], [{ ...original, targetFingerprint: 'a'.repeat(64) }]),
    ).toEqual([]);
    expect(() => validateHealthRecords([original, { ...original, observedAt: 2000 }])).toThrow(
      /Duplicate/,
    );
  });
  it('uses injected TTL and clock, marks future/imported checks stale and separates platform/profile', async () => {
    const observed = await record();
    const context = {
      now: 1000,
      platform: observed.platform,
      observerProfile: observed.observerProfile,
    };
    expect(healthFreshness(observed, context)).toBe('current');
    expect(healthFreshness(observed, { ...context, now: 3601000 })).toBe('stale');
    expect(healthFreshness(observed, { ...context, now: 999 })).toBe('stale');
    expect(healthFreshness({ ...observed, origin: 'imported' }, context)).toBe('stale');
    expect(healthFreshness(observed, { ...context, platform: 'android-webview' })).toBe(
      'different-platform',
    );
    expect(healthFreshness(observed, { ...context, observerProfile: 'new-engine' })).toBe(
      'different-profile',
    );
    expect(healthFreshness(await record({ kind: 'timeout' }), { ...context, now: 601000 })).toBe(
      'stale',
    );
  });
  it('maps only reviewed selected keys to canonical IDs, never temporary keys or unselected candidates', async () => {
    const selected = mapping();
    const observed = createHealthObservation(
      { channelId: selected.candidate.key, sourceId: 'source', fingerprint: 'job' },
      { platform: 'windows-webview2', observedAt: 1000 },
      { kind: 'http', status: 403 },
    );
    const result = await remapReviewedHealth({
      mappings: [selected],
      observations: [observed, { ...observed, channelId: 'unselected' }],
      platform: 'windows-webview2',
      observerProfile: 'engine',
    });
    expect(result.records[0].channelId).toBe('canonical');
    expect(result.records[0].verdict).toBe('AccessDenied');
    expect(result.ignoredCandidateKeys).toEqual(['unselected']);
    const retainedAlternates = {
      ...selected,
      channel: {
        ...selected.channel,
        urls: ['https://example.test/retained', ...selected.channel.urls],
        geography: { country: 'US' },
      },
      checkedUrlOrdinal: 1,
    };
    const retained = await remapReviewedHealth({
      mappings: [retainedAlternates],
      observations: [observed],
      platform: 'windows-webview2',
      observerProfile: 'engine',
    });
    expect(retained.records[0].checkedUrlOrdinal).toBe(1);
    expect(retained.records[0].targetFingerprint).toBe(
      await fingerprintHealthTarget(source, retainedAlternates.channel, 1),
    );
    const input = {
      mappings: [selected],
      observations: [observed],
      platform: 'windows-webview2',
      observerProfile: 'engine',
    };
    await expect(
      remapReviewedHealth({ ...input, observations: [{ ...observed, fingerprint: 'old' }] }),
    ).rejects.toThrow(/obsolete/);
    await expect(
      remapReviewedHealth({
        ...input,
        mappings: [
          { ...selected, channel: { ...selected.channel, urls: ['https://example.test/changed'] } },
        ],
      }),
    ).rejects.toThrow(/mapping/);
    await expect(remapReviewedHealth({ ...input, platform: 'android-webview' })).rejects.toThrow(
      /obsolete/,
    );
  });
  it('snapshots remapping inputs and rejects cancellation after hashing settles without partial result', async () => {
    const selected = mapping();
    const observed = createHealthObservation(
      { channelId: selected.candidate.key, sourceId: 'source', fingerprint: 'job' },
      { platform: 'windows-webview2', observedAt: 1000 },
      { kind: 'timeout' },
    );
    const input = {
      mappings: [selected],
      observations: [observed],
      platform: 'windows-webview2',
      observerProfile: 'engine',
    };
    const pending = remapReviewedHealth(input);
    selected.channel.id = 'newer';
    expect((await pending).records[0].channelId).toBe('canonical');
    const controller = new AbortController();
    const canceled = remapReviewedHealth({
      ...input,
      mappings: [mapping()],
      signal: controller.signal,
    });
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('fails whole batch limits and invalid text identities, with no truncation', async () => {
    const original = await record();
    expect(() => validateHealthRecords(Array(100001).fill(original))).toThrow(/bound/);
    expect(() => validateHealthRecord({ ...original, channelId: 'ü'.repeat(8193) })).toThrow();
    expect(() => validateHealthRecord({ ...original, observerProfile: 'bad\nprofile' })).toThrow();
    expect(() =>
      validateHealthRecord({ ...original, targetFingerprint: 'https://private.test' }),
    ).toThrow();
  });
});
