import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn(), native: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => api.native }));
import { nativeGuide } from '../../src/guide/native';

const receipt = {
  catalogRevision: '1',
  matched: 50,
  unmatched: 2308,
  ambiguous: 0,
  preservedMappings: 6,
  checkedSources: 11,
};
const outcome = {
  status: 'available',
  code: null,
  canonicalIdentities: 220,
  ambiguousIdentities: 5,
  cacheHit: false,
};
const connect = () => nativeGuide.connectCached('1', [], [], 'crosswalk-test');
beforeEach(() => {
  api.invoke.mockReset();
  api.native = true;
});

describe('native reviewed guide crosswalk outcome boundary', () => {
  it('retains native ambiguity counts without treating excluded identities as mappings', async () => {
    api.invoke.mockResolvedValue({ ...receipt, reviewedCrosswalk: outcome });
    const result = await connect();
    expect(result.reviewedCrosswalk).toEqual(outcome);
    expect(result.matched).toBe(50);
    expect(api.invoke).toHaveBeenCalledWith('guide_connect_cached_catalog', {
      expectedCatalogRevision: '1',
      sources: [],
      aliases: [],
      requestId: 'crosswalk-test',
      cacheOnly: false,
    });
  });

  it('normalizes only omitted legacy ambiguity to zero', async () => {
    const legacy = {
      status: outcome.status,
      code: outcome.code,
      canonicalIdentities: outcome.canonicalIdentities,
      cacheHit: outcome.cacheHit,
    };
    api.invoke.mockResolvedValue({ ...receipt, reviewedCrosswalk: legacy });
    expect((await connect()).reviewedCrosswalk).toEqual({ ...legacy, ambiguousIdentities: 0 });
    api.invoke.mockResolvedValue(receipt);
    expect((await connect()).reviewedCrosswalk).toBeUndefined();
  });

  it.each([-1, 1.5, '5', null, undefined, 1025, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an explicitly malformed ambiguity count %s',
    async (ambiguousIdentities) => {
      api.invoke.mockResolvedValue({
        ...receipt,
        reviewedCrosswalk: { ...outcome, ambiguousIdentities },
      });
      await expect(connect()).rejects.toThrow('identity metadata outcome is invalid');
    },
  );

  it('refuses counts whose distinct identity union exceeds the metadata bound', async () => {
    api.invoke.mockResolvedValue({
      ...receipt,
      reviewedCrosswalk: { ...outcome, canonicalIdentities: 1020, ambiguousIdentities: 5 },
    });
    await expect(connect()).rejects.toThrow('identity metadata outcome is invalid');
  });

  it.each(['not-requested', 'unavailable'])('refuses partial authority on %s', async (status) => {
    api.invoke.mockResolvedValue({
      ...receipt,
      reviewedCrosswalk: {
        status,
        code: status === 'unavailable' ? 'guide-crosswalk-timeout' : null,
        canonicalIdentities: 0,
        ambiguousIdentities: 5,
        cacheHit: false,
      },
    });
    await expect(connect()).rejects.toThrow('identity metadata outcome is invalid');
  });

  it('admits fixed zero-count refusal and not-requested outcomes', async () => {
    for (const status of ['unavailable', 'not-requested']) {
      const value = {
        status,
        code: status === 'unavailable' ? 'guide-crosswalk-timeout' : null,
        canonicalIdentities: 0,
        ambiguousIdentities: 0,
        cacheHit: false,
      };
      api.invoke.mockResolvedValue({ ...receipt, reviewedCrosswalk: value });
      expect((await connect()).reviewedCrosswalk).toEqual(value);
    }
  });

  it('refuses unknown fields, unknown failure codes and a false available state', async () => {
    for (const value of [
      { ...outcome, arbitrarySource: 'untrusted' },
      {
        ...outcome,
        status: 'unavailable',
        code: 'arbitrary',
        canonicalIdentities: 0,
        ambiguousIdentities: 0,
      },
      { ...outcome, canonicalIdentities: 0 },
    ]) {
      api.invoke.mockResolvedValue({ ...receipt, reviewedCrosswalk: value });
      await expect(connect()).rejects.toThrow('identity metadata outcome is invalid');
    }
  });
});
