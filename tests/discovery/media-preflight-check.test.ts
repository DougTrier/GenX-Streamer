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

import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }));
import { inspectCheckedMediaSource } from '../../src/sources/media-preflight';
import { checkScanCandidates } from '../../src/discovery/automatic-check';
import { createHealthObservation, type HealthEvidence } from '../../src/discovery/health';
import type { ScanReview } from '../../src/discovery/scan';
beforeEach(() => {
  api.invoke.mockReset();
});
const modes = ['root502', 'manifest502', 'segment502', 'reset', 'timeout', 'healthy'] as const;
type Mode = (typeof modes)[number];
function review(sequence: readonly Mode[]): ScanReview {
  return {
    sessionRevision: 'revision',
    query: '',
    status: 'completed',
    sources: [],
    counts: {
      inspected: sequence.length,
      matched: sequence.length,
      failedSources: 0,
      canceledSources: 0,
    },
    candidates: sequence.map((mode, index) => ({
      key: `c${index}`,
      sourceId: 's',
      sourceFingerprint: 'scope',
      sessionRevision: 'revision',
      channel: {
        sourceId: 's',
        name: mode,
        category: 'General',
        urls: [`https://${mode}.fixture.invalid/live`],
      },
    })),
  };
}
function install() {
  const counts = new Map<string, number>();
  api.invoke.mockImplementation(
    async (command: string, args: { requestId: string; url: string }) => {
      expect(command).toBe('inspect_media_resources');
      const mode = new URL(args.url).hostname.split('.')[0] as Mode;
      counts.set(mode, (counts.get(mode) ?? 0) + 1);
      return {
        requestId: args.requestId,
        status: mode === 'healthy' ? 'resources-responded' : 'unavailable',
        reasonCode:
          mode === 'healthy'
            ? 'media-resources-responded'
            : mode === 'timeout'
              ? 'timeout'
              : mode === 'reset'
                ? 'resource-read-unavailable'
                : 'resource-http-unavailable',
        checkedResources: mode === 'root502' ? 1 : mode === 'manifest502' ? 2 : 3,
        ...(['root502', 'manifest502', 'segment502'].includes(mode)
          ? { httpStatus: 502 }
          : mode === 'reset'
            ? { httpStatus: 200 }
            : {}),
      };
    },
  );
  return counts;
}
async function check(input: ScanReview) {
  return checkScanCandidates(input, {
    signal: new AbortController().signal,
    platform: 'fixture',
    now: () => 1000,
    maxConcurrency: 1,
    sourcePolicies: [{ sourceId: 's', fingerprint: 'scope', allowHttp: false }],
    probe: async (candidate, signal, budget) => {
      let evidence: HealthEvidence;
      try {
        const inspected = await inspectCheckedMediaSource(
          candidate.channel.urls[0],
          false,
          signal,
          budget,
        );
        evidence =
          inspected.status < 200 || inspected.status >= 300
            ? { kind: 'http', status: inspected.status }
            : {
                kind: 'http',
                status: inspected.status,
                contentRecognized: inspected.kind === 'media' || inspected.kind === 'hls',
              };
      } catch (error) {
        evidence = error === 'timeout' ? { kind: 'timeout' } : { kind: 'network-failure' };
      }
      return createHealthObservation(
        {
          channelId: candidate.key,
          sourceId: candidate.sourceId,
          fingerprint: candidate.sourceFingerprint,
        },
        { platform: 'fixture', observedAt: 1000 },
        evidence,
      );
    },
  });
}
it('actual adapter failures at every resource depth/reset/timeout leave following healthy candidates eligible', async () => {
  const counts = install();
  const result = await check(review(modes));
  expect(result.observations.map((observation) => observation.evidence)).toEqual([
    { kind: 'http', status: 502 },
    { kind: 'http', status: 502 },
    { kind: 'http', status: 502 },
    { kind: 'network-failure' },
    { kind: 'timeout' },
    { kind: 'http', status: 200, contentRecognized: true },
  ]);
  expect(result.observations.map((observation) => observation.verdict)).toEqual([
    'TemporaryUnavailable',
    'TemporaryUnavailable',
    'TemporaryUnavailable',
    'TemporaryUnavailable',
    'TimedOut',
    'Reachable',
  ]);
  expect(result.eligibleKeys).toEqual(['c5']);
  expect([...counts.keys()]).toEqual([...modes]);
});
it('does not reuse HTTP/transport/timeout failures but reuses a compatible healthy response for fresh identities', async () => {
  const counts = install();
  const sequence = modes.flatMap((mode) => [mode, mode]);
  const result = await check(review(sequence));
  for (const mode of modes) expect(counts.get(mode)).toBe(mode === 'healthy' ? 1 : 2);
  expect(result.observations).toHaveLength(12);
  expect(result.eligibleKeys).toEqual(['c10', 'c11']);
  expect(result.observations.slice(-2).map((observation) => observation.channelId)).toEqual([
    'c10',
    'c11',
  ]);
});
