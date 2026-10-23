import { describe, expect, it } from 'vitest';
import { assessGuideCache, type GuideCacheInput } from '../../src/guide/cache-policy';

const now = Date.UTC(2026, 9, 11, 12);
const hour = 3600000;
function fixture(): GuideCacheInput {
  return {
    source: { revision: 3, updatedMs: now - 5 * 60000 },
    expectedSourceRevision: 3,
    coverage: {
      sourceRevision: 3,
      publishedRevision: 3,
      channelCount: 2,
      programCount: 12,
      firstStartMs: now - hour,
      lastStartMs: now + hour,
      lastStopMs: now + 2 * hour,
      unknownEndCount: 0,
    },
    nowMs: now,
    maxAgeMs: 24 * hour,
  };
}

describe('mapped guide horizon capability', () => {
  const mapped = () => ({
    version: 1 as const,
    assessedMs: now,
    cooldownUntilMs: now + 3600000,
    targetCount: 53,
    knownEndCount: 53,
    missingEndCount: 0,
    expiredCount: 52,
    earliestLastStopMs: now - hour,
  });
  it('cannot hide 52 expired mapped targets behind one far-future source maximum', () => {
    const input = fixture();
    input.coverage!.lastStopMs = now + 4 * 24 * hour;
    input.coverage!.mappedTargets = mapped();
    expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'expired' });
    input.coverage!.mappedTargets = {
      ...mapped(),
      expiredCount: 0,
      earliestLastStopMs: now + 2 * hour,
    };
    expect(assessGuideCache(input).usable).toBe(true);
  });
  it('renews missing known ends and the 15 minute lead without fabricating intervals', () => {
    const input = fixture();
    input.coverage!.mappedTargets = {
      ...mapped(),
      knownEndCount: 52,
      missingEndCount: 1,
      expiredCount: 0,
      earliestLastStopMs: now + hour,
    };
    expect(assessGuideCache(input).reason).toBe('unknown-end');
    input.coverage!.mappedTargets = {
      ...mapped(),
      expiredCount: 0,
      earliestLastStopMs: now + 15 * 60000,
    };
    expect(assessGuideCache(input).reason).toBe('renewal-due');
  });
  it('retains aggregate fallback only for absent legacy capability', () => {
    expect(assessGuideCache(fixture()).usable).toBe(true);
    const input = fixture();
    input.coverage!.mappedTargets = {
      ...mapped(),
      targetCount: 0,
      knownEndCount: 0,
      expiredCount: 0,
      earliestLastStopMs: null,
    };
    expect(assessGuideCache(input).usable).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...mapped(), version: 2 },
      { ...mapped(), targetCount: NaN },
      { ...mapped(), targetCount: 500001 },
      { ...mapped(), missingEndCount: 1 },
      { ...mapped(), expiredCount: 54 },
      { ...mapped(), expiredCount: 0 },
      { ...mapped(), assessedMs: now + 1 },
      { ...mapped(), earliestLastStopMs: null },
    ]) {
      Reflect.set(input.coverage!, 'mappedTargets', invalid);
      expect(assessGuideCache(input).reason, JSON.stringify(invalid)).toBe('invalid');
    }
  });
});

describe('aggregate guide cache admission', () => {
  it('accepts actual known future coverage without claiming every channel or seven days', () => {
    const input = fixture();
    const before = structuredClone(input);
    const decision = assessGuideCache(input);
    expect(decision).toEqual({ usable: true, reason: 'usable' });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(input).toEqual(before);
    expect(Object.keys(decision)).toEqual(['usable', 'reason']);
  });

  it('refuses recently downloaded schedules which already expired, including exact end boundary', () => {
    for (const stop of [now - 1, now]) {
      const input = fixture();
      input.coverage!.lastStopMs = stop;
      input.coverage!.lastStartMs = now - 60000;
      expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'expired' });
    }
  });

  it('refuses a future successful-update timestamp after clock rollback', () => {
    const input = fixture();
    input.source!.updatedMs = now + 1;
    expect(assessGuideCache(input).reason).toBe('clock');
    input.source!.updatedMs = now;
    expect(assessGuideCache(input).usable).toBe(true);
  });

  it('requires all source and published revisions to equal the captured revision', () => {
    const changes = [
      (input: GuideCacheInput) => (input.source!.revision = 4),
      (input: GuideCacheInput) => (input.coverage!.sourceRevision = 4),
      (input: GuideCacheInput) => (input.coverage!.publishedRevision = 4),
      (input: GuideCacheInput) => (input.coverage!.publishedRevision = null),
    ];
    for (const change of changes) {
      const input = fixture();
      change(input);
      expect(assessGuideCache(input).reason).toBe('revision');
    }
    expect(assessGuideCache({ ...fixture(), expectedSourceRevision: 2 }).reason).toBe('revision');
  });

  it('never treats unknown-ended future starts as usable coverage', () => {
    const input = fixture();
    input.coverage!.lastStopMs = null;
    input.coverage!.unknownEndCount = 12;
    expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'unknown-end' });
    input.coverage!.unknownEndCount = 1;
    input.coverage!.lastStopMs = now + 1;
    expect(assessGuideCache(input).usable).toBe(true);
    // An unknown future programme does not extend the known horizon.
    input.coverage!.lastStopMs = now - 1;
    expect(assessGuideCache(input).reason).toBe('expired');
  });

  it('accepts future-only known schedules as aggregate upcoming data, not current playback', () => {
    const input = fixture();
    input.coverage!.firstStartMs = now + hour;
    expect(assessGuideCache(input)).toEqual({ usable: true, reason: 'usable' });
  });

  it('refuses absent, empty and aged caches at the exact age boundary', () => {
    expect(assessGuideCache({ ...fixture(), source: null }).reason).toBe('missing');
    expect(assessGuideCache({ ...fixture(), coverage: null }).reason).toBe('missing');
    for (const field of ['channelCount', 'programCount'] as const) {
      const input = fixture();
      input.coverage![field] = 0;
      expect(assessGuideCache(input).reason).toBe('missing');
    }
    const input = fixture();
    input.source!.updatedMs = null;
    expect(assessGuideCache(input).reason).toBe('missing');
    input.source!.updatedMs = now - 24 * hour;
    expect(assessGuideCache(input).reason).toBe('aged');
    input.source!.updatedMs++;
    expect(assessGuideCache(input).usable).toBe(true);
  });

  it('rejects malformed runtime receipts and nonfinite injected clocks without leaking input', () => {
    const changes = [
      (input: GuideCacheInput) => (input.coverage!.programCount = Infinity),
      (input: GuideCacheInput) => (input.coverage!.unknownEndCount = 13),
      (input: GuideCacheInput) => (input.coverage!.firstStartMs = now + 3 * hour),
      (input: GuideCacheInput) => (input.coverage!.lastStopMs = now - 2 * hour),
      (input: GuideCacheInput) => (input.source!.updatedMs = NaN),
      (input: GuideCacheInput) => (input.coverage!.lastStartMs = null),
    ];
    for (const change of changes) {
      const input = fixture();
      change(input);
      expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'invalid' });
    }
    for (const clock of [NaN, Infinity, -1, 8.64e15 + 1])
      expect(assessGuideCache({ ...fixture(), nowMs: clock }).reason).toBe('invalid');
    for (const maxAgeMs of [NaN, Infinity, -1, 8.64e15 + 1])
      expect(assessGuideCache({ ...fixture(), maxAgeMs }).reason).toBe('invalid');
    expect(assessGuideCache({ ...fixture(), maxAgeMs: 0 }).reason).toBe('aged');
  });

  it('honors cancellation without acknowledging a cache or creating work', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => assessGuideCache({ ...fixture(), signal: controller.signal })).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(assessGuideCache({ ...fixture(), signal: new AbortController().signal }).usable).toBe(
      true,
    );
  });

  it('requires reacquisition when the native projection no longer covers saved-channel interests', () => {
    const input = fixture();
    Reflect.set(input.coverage!, 'projectionCompatible', false);
    expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'scope' });
    Reflect.set(input.coverage!, 'projectionCompatible', true);
    expect(assessGuideCache(input)).toEqual({ usable: true, reason: 'usable' });
  });

  it('rejects malformed projection admission instead of treating it as a legacy reply', () => {
    for (const value of [null, 'true', 'false', 0, 1, {}, []]) {
      const input = fixture();
      Reflect.set(input.coverage!, 'projectionCompatible', value);
      expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'invalid' });
    }
  });

  it('does not let a compatible projection override source revision, age or actual schedule expiry', () => {
    const input = fixture();
    Reflect.set(input.coverage!, 'projectionCompatible', true);
    input.coverage!.publishedRevision = 2;
    expect(assessGuideCache(input).reason).toBe('revision');
    input.coverage!.publishedRevision = 3;
    input.source!.updatedMs = now - 24 * hour;
    expect(assessGuideCache(input).reason).toBe('aged');
    input.source!.updatedMs = now - 60000;
    input.coverage!.lastStopMs = now;
    expect(assessGuideCache(input).reason).toBe('expired');
  });

  it('reuses a fresh complete zero-interest projection without claiming any schedules', () => {
    const input = fixture();
    Object.assign(input.coverage!, {
      projectionCompatible: true,
      projectionInterestCount: 0,
      programCount: 0,
      firstStartMs: null,
      lastStartMs: null,
      lastStopMs: null,
    });
    expect(assessGuideCache(input)).toEqual({ usable: true, reason: 'unneeded' });
    input.source!.updatedMs = now + 1;
    expect(assessGuideCache(input).reason).toBe('clock');
    input.source!.updatedMs = now - 24 * hour;
    expect(assessGuideCache(input).reason).toBe('aged');
    input.source!.updatedMs = now - 1;
    input.coverage!.projectionCompatible = false;
    expect(assessGuideCache(input).reason).toBe('scope');
  });

  it('does not confuse missing listings for interested channels with an unneeded feed', () => {
    const input = fixture();
    input.coverage!.projectionCompatible = true;
    input.coverage!.projectionInterestCount = 1;
    input.coverage!.programCount = 0;
    expect(assessGuideCache(input).reason).toBe('missing');
    input.coverage!.projectionInterestCount = 0;
    input.coverage!.programCount = 1;
    expect(assessGuideCache(input).reason).toBe('invalid');
    for (const bad of [null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
      Reflect.set(input.coverage!, 'projectionInterestCount', bad);
      expect(assessGuideCache(input).reason).toBe('invalid');
    }
    Reflect.deleteProperty(input.coverage!, 'projectionCompatible');
    input.coverage!.projectionInterestCount = 0;
    expect(assessGuideCache(input).reason).toBe('invalid');
  });

  it('retains missing mapped targets as interests instead of treating them as an irrelevant feed', () => {
    const input = fixture();
    input.coverage!.projectionCompatible = true;
    input.coverage!.projectionInterestCount = 3;
    input.coverage!.programCount = 0;
    expect(assessGuideCache(input)).toEqual({ usable: false, reason: 'missing' });
  });
});
