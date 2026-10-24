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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeCatalog } from '../../src/catalog';
import {
  fingerprintHealthTarget,
  serializeHealthPayload,
  type PersistedHealthRecord,
} from '../../src/catalog/health-record';
import {
  decodeSavedHealth,
  decodeSavedHealthOnly,
  evaluateHealthHistory,
  type SavedHealthSnapshot,
} from '../../src/application/health/health-history';
import {
  decodeSavedHealthInWorker,
  decodeSavedHealthOnlyInWorker,
} from '../../src/application/health/health-history-read';
import {
  DECODER_HEALTH_PROFILE,
  reachabilityHealthProfile,
} from '../../src/application/health/health-profile';
const source = {
  id: 'source',
  kind: 'url' as const,
  name: 'My source',
  location: 'https://example.org/catalog?token=secret',
};
const context = {
  now: 2000,
  platform: 'windows',
  observerProfile: 'reachability-v1/native-http-v1',
};
async function snapshot(count = 55): Promise<SavedHealthSnapshot> {
  const channels = Array.from({ length: count }, (_, index) => ({
    id: `channel-${index}`,
    sourceId: source.id,
    name: `Ｆｏｘ ${index}`,
    category: 'Sports',
    urls: [`https://example.org/${index}?token=secret`],
  }));
  const health = await Promise.all(
    channels.map(async (channel, index): Promise<PersistedHealthRecord> => ({
      schemaVersion: 1,
      channelId: channel.id,
      sourceId: source.id,
      checkedUrlOrdinal: 0,
      targetFingerprint: await fingerprintHealthTarget(source, channel, 0),
      platform: context.platform,
      observerProfile: context.observerProfile,
      observedAt: 1000 + index,
      verdict: 'Reachable',
      evidence: { kind: 'http', status: 200, contentRecognized: true },
      origin: 'local',
    })),
  );
  return {
    catalog: serializeCatalog({ schemaVersion: 1, sources: [source], channels }),
    health: serializeHealthPayload(health),
    catalogRevision: '7',
    healthRevision: '9',
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('saved health history', () => {
  it('health-only admission preserves evidence validation without weakening full catalog admission', async () => {
    const state = await snapshot(2);
    expect(decodeSavedHealthOnly(state)).toEqual({ health: decodeSavedHealth(state).health });
    expect(decodeSavedHealthOnly({ health: null })).toEqual({ health: [] });
    const broken = { ...state, catalog: '{malformed catalog' };
    expect(decodeSavedHealthOnly(broken).health).toHaveLength(2);
    expect(() => decodeSavedHealth(broken)).toThrow();
    const payload = JSON.parse(state.health!);
    payload.records[0].evidence.status = 999;
    expect(() => decodeSavedHealthOnly({ health: JSON.stringify(payload) })).toThrow();
    expect(() => decodeSavedHealthOnly({ health: '{"schemaVersion":2,"records":[]}' })).toThrow();
  });
  it('400 batch reads clone only bounded health, release every worker and never touch source catalog data', async () => {
    const state = await snapshot(400);
    let active = 0;
    let peak = 0;
    let requests = 0;
    let terminated = 0;
    let largestRequest = 0;
    class HealthWorker {
      onmessage?: (event: unknown) => void;
      constructor() {
        active++;
        peak = Math.max(peak, active);
      }
      terminate() {
        expect(this.onmessage).toBeNull();
        active--;
        terminated++;
      }
      postMessage(request: { kind: string; snapshot: { health: string | null } }) {
        requests++;
        expect(request.kind).toBe('decode-health');
        expect(Object.keys(request.snapshot)).toEqual(['health']);
        // postMessage structured-clones this string; it does not JSON-escape its contents.
        largestRequest = Math.max(
          largestRequest,
          new TextEncoder().encode(request.snapshot.health ?? '').length,
        );
        queueMicrotask(() =>
          this.onmessage?.({ data: { ok: true, value: decodeSavedHealthOnly(request.snapshot) } }),
        );
      }
    }
    vi.stubGlobal('Worker', HealthWorker);
    const input = {
      health: state.health,
      get catalog(): never {
        throw new Error('Catalog and source URLs must not be read by health-only admission');
      },
    };
    for (let batch = 0; batch < 400; batch++) {
      const decoded = await decodeSavedHealthOnlyInWorker(input);
      expect(decoded.health).toHaveLength(400);
      expect(decoded.health[399]!.channelId).toBe('channel-399');
      expect(active).toBe(0);
    }
    expect({ requests, terminated, peak, active }).toEqual({
      requests: 400,
      terminated: 400,
      peak: 1,
      active: 0,
    });
    expect(largestRequest).toBe(new TextEncoder().encode(state.health!).length);
  });
  it('keeps check budgets distinct and compares decoded observations to their own policy', async () => {
    const profiles = [20000, 45000, 60000].map((budget) => reachabilityHealthProfile(true, budget));
    expect(new Set(profiles).size).toBe(3);
    expect(profiles.every((profile) => profile.endsWith('/sequential'))).toBe(true);
    expect(reachabilityHealthProfile(false)).not.toBe(profiles[0]);
    expect(() => reachabilityHealthProfile(true, 30000)).toThrow(/supported/);
    const state = await snapshot(1);
    const payload = JSON.parse(state.health!);
    const record = payload.records[0];
    record.observerProfile = DECODER_HEALTH_PROFILE;
    record.verdict = 'PlayedHere';
    record.evidence = {
      kind: 'decoded',
      before: { mediaTime: 1, decodedFrames: 10, width: 320, height: 180 },
      after: { mediaTime: 2, decodedFrames: 20, width: 320, height: 180 },
      elapsedMilliseconds: 1000,
    };
    state.health = serializeHealthPayload(payload.records);
    const current = await evaluateHealthHistory(
      state,
      { offset: 0, pageSize: 50, query: '' },
      { ...context, observerProfile: profiles[0]!, decoderObserverProfile: DECODER_HEALTH_PROFILE },
    );
    expect(current.rows[0]!.freshness).toBe('current');
    expect(current.rows[0]!.evidence).toEqual(record.evidence);
    const legacy = await evaluateHealthHistory(
      await snapshot(1),
      { offset: 0, pageSize: 50, query: '' },
      { ...context, observerProfile: profiles[0]! },
    );
    expect(legacy.rows[0]!.freshness).toBe('different-profile');
  });
  it('returns bounded ordered metadata pages with no provider URLs or canonical identities', async () => {
    const state = await snapshot();
    const first = await evaluateHealthHistory(
      state,
      { offset: 0, pageSize: 50, query: 'Fox Sports' },
      context,
    );
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(55);
    expect(first.revision).toBe('7:9');
    expect(first.rows[0]!.name).toBe('Ｆｏｘ 54');
    expect(first.rows[0]!.freshness).toBe('current');
    expect(first.rows[0]!.evidence).toEqual({
      kind: 'http',
      status: 200,
      contentRecognized: true,
    });
    expect(JSON.stringify(first)).not.toMatch(/secret|example\.org|channel-54|targetFingerprint/);
    const last = await evaluateHealthHistory(
      state,
      { offset: 50, pageSize: 50, query: 'fox sports', revision: first.revision },
      context,
    );
    expect(last.rows).toHaveLength(5);
    await expect(
      evaluateHealthHistory(
        state,
        { offset: 50, pageSize: 50, query: '', revision: '7:8' },
        context,
      ),
    ).rejects.toThrow(/first page/);
  });
  it('keeps imported observations historical and refuses changed checked URLs', async () => {
    const state = await snapshot(1);
    const payload = JSON.parse(state.health!);
    payload.records[0].origin = 'imported';
    state.health = JSON.stringify(payload);
    expect(
      (await evaluateHealthHistory(state, { offset: 0, pageSize: 50, query: '' }, context)).rows[0]!
        .freshness,
    ).toBe('stale');
    const catalog = JSON.parse(state.catalog!);
    catalog.channels[0].urls[0] = 'https://example.org/changed';
    state.catalog = JSON.stringify(catalog);
    await expect(
      evaluateHealthHistory(state, { offset: 0, pageSize: 50, query: '' }, context),
    ).rejects.toThrow(/no longer match/);
  });
  it('separates platform observations and rejects invalid page bounds', async () => {
    const state = await snapshot(1);
    expect(
      (
        await evaluateHealthHistory(
          state,
          { offset: 0, pageSize: 50, query: '' },
          { ...context, platform: 'android' },
        )
      ).rows[0]!.freshness,
    ).toBe('different-platform');
    await expect(
      evaluateHealthHistory(state, { offset: -1, pageSize: 50, query: '' }, context),
    ).rejects.toThrow(/query/);
  });
  it('terminates the read worker on cancellation and ignores its late reply', async () => {
    class FakeWorker {
      static instances: FakeWorker[] = [];
      onmessage?: (event: unknown) => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        FakeWorker.instances.push(this);
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const abort = new AbortController();
    const work = decodeSavedHealthInWorker(await snapshot(1), abort.signal);
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    FakeWorker.instances[0]!.onmessage?.({ data: { ok: true, value: {} } });
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
    const healthAbort = new AbortController();
    const healthOnly = decodeSavedHealthOnlyInWorker({ health: null }, healthAbort.signal);
    healthAbort.abort();
    await expect(healthOnly).rejects.toMatchObject({ name: 'AbortError' });
    FakeWorker.instances[1]!.onmessage?.({ data: { ok: true, value: { health: [] } } });
    expect(FakeWorker.instances[1]!.terminate).toHaveBeenCalledTimes(1);
  });
});
