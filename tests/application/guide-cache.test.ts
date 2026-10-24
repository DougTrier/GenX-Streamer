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

import { describe, expect, it, vi } from 'vitest';
import {
  createGuideCacheReady,
  createGuideAcquisitionAllowed,
} from '../../src/application/guide-cache';
import type { GuideSource, SourceCoverage } from '../../src/guide/native';

const now = Date.UTC(2026, 9, 15, 22);
const source: GuideSource = {
  id: 'guide',
  name: 'Selected',
  kind: 'url',
  location: 'https://fixture.invalid/guide.xml',
  allowHttp: false,
  revision: 3,
  updatedMs: now - 3600000,
};
const coverage = (): SourceCoverage => ({
  sourceRevision: 3,
  publishedRevision: 3,
  channelCount: 54,
  programCount: 54,
  unknownEndCount: 0,
  firstStartMs: now - 7200000,
  lastStartMs: now - 3600000,
  lastStopMs: now + 4 * 86400000,
  mappedTargets: {
    version: 1,
    assessedMs: now,
    cooldownUntilMs: now + 3600000,
    targetCount: 53,
    knownEndCount: 53,
    missingEndCount: 0,
    expiredCount: 52,
    earliestLastStopMs: now - 3600000,
  },
});

describe('explicit Find saved-guide cache readiness', () => {
  it('throttles automatic incomplete publication persistently while manual Find can retry', async () => {
    const host = { sources: async () => [source], coverage: async () => coverage() };
    const provider = { location: source.location };
    const signal = new AbortController().signal;
    expect(
      await createGuideAcquisitionAllowed(host, () => now)(provider, signal, { automatic: true }),
    ).toBe(false);
    expect(
      await createGuideAcquisitionAllowed(host, () => now)(provider, signal, { automatic: false }),
    ).toBe(true);
    // New helper instance has no in-memory throttle; the native DTO remains authority.
    expect(
      await createGuideAcquisitionAllowed(host, () => now + 3600000)(provider, signal, {
        automatic: true,
      }),
    ).toBe(true);
    const malformed = {
      ...coverage(),
      mappedTargets: { ...coverage().mappedTargets!, version: 9 },
    };
    const badHost = { ...host, coverage: async () => malformed as SourceCoverage };
    expect(
      await createGuideAcquisitionAllowed(badHost, () => now)(provider, signal, {
        automatic: true,
      }),
    ).toBe(false);
  });
  it('requests renewal of mapped deficits without requiring automatic-update permission', async () => {
    const host = { sources: vi.fn(async () => [source]), coverage: vi.fn(async () => coverage()) };
    const ready = createGuideCacheReady(host, () => now);
    expect(await ready({ location: source.location }, new AbortController().signal)).toBe(false);
    expect(host.coverage).toHaveBeenCalledWith(source.id);
    host.coverage.mockResolvedValue({
      ...coverage(),
      mappedTargets: {
        ...coverage().mappedTargets!,
        expiredCount: 0,
        earliestLastStopMs: now + 3600000,
      },
    });
    expect(await ready({ location: source.location }, new AbortController().signal)).toBe(true);
    expect(Object.keys(host)).toEqual(['sources', 'coverage']);
  });
  it('cannot authorize a source by a different location, and preserves cancellation', async () => {
    const host = { sources: vi.fn(async () => [source]), coverage: vi.fn(async () => coverage()) };
    const ready = createGuideCacheReady(host, () => now);
    expect(
      await ready({ location: 'https://other.invalid/guide.xml' }, new AbortController().signal),
    ).toBe(false);
    expect(host.coverage).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(ready({ location: source.location }, controller.signal)).rejects.toThrow();
    expect(host.sources).toHaveBeenCalledTimes(1);
  });
});

describe('relevance-gated automatic guide acquisition', () => {
  const signal = new AbortController().signal;
  const irrelevant = (updatedMs: number) => ({
    source: { ...source, updatedMs },
    coverage: {
      ...coverage(),
      programCount: 0,
      unknownEndCount: 0,
      projectionCompatible: true,
      projectionInterestCount: 0,
      mappedTargets: {
        version: 1 as const,
        assessedMs: now,
        cooldownUntilMs: updatedMs + 3600000,
        targetCount: 0,
        knownEndCount: 0,
        missingEndCount: 0,
        expiredCount: 0,
        earliestLastStopMs: null,
      },
    } satisfies SourceCoverage,
  });
  it('backs off a saved feed serving no current channel for a week, unless Find is explicit', async () => {
    for (const [ageMs, expected] of [
      [2 * 86400000, false],
      [6 * 86400000, false],
      [7 * 86400000, true],
    ] as const) {
      const fixture = irrelevant(now - ageMs);
      const host = {
        sources: async () => [fixture.source],
        coverage: async () => fixture.coverage,
      };
      const allowed = createGuideAcquisitionAllowed(host, () => now);
      expect(await allowed({ location: source.location }, signal, { automatic: true })).toBe(
        expected,
      );
      expect(await allowed({ location: source.location }, signal, { automatic: false })).toBe(true);
    }
  });
  it('keeps refreshing a feed once any current channel is interested in it', async () => {
    const fixture = irrelevant(now - 2 * 86400000);
    const host = {
      sources: async () => [fixture.source],
      coverage: async () => ({ ...fixture.coverage, projectionInterestCount: 3 }),
    };
    expect(
      await createGuideAcquisitionAllowed(host, () => now)({ location: source.location }, signal, {
        automatic: true,
      }),
    ).toBe(true);
  });
  it('skips never-fetched per-country files for countries with no saved channels', async () => {
    const host = { sources: async () => [], coverage: async () => coverage() };
    const allowed = createGuideAcquisitionAllowed(host, () => now);
    const feed = (code: string) => ({
      location: `https://epgshare01.online/epgshare01/epg_ripper_${code}1.xml.gz`,
    });
    const context = { automatic: true, catalogCountries: ['US', 'UK'] };
    expect(await allowed(feed('US'), signal, context)).toBe(true);
    expect(await allowed(feed('UK'), signal, context)).toBe(true);
    expect(await allowed(feed('GB'), signal, context)).toBe(true);
    expect(await allowed(feed('AL'), signal, context)).toBe(false);
    // Non-country files, missing country context and explicit Find are unchanged.
    expect(await allowed(feed('ALJAZEERA'), signal, context)).toBe(true);
    expect(await allowed(feed('AL'), signal, { automatic: true })).toBe(true);
    expect(await allowed(feed('AL'), signal, { automatic: false, catalogCountries: [] })).toBe(
      true,
    );
  });
});
