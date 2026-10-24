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

/**
 * What the bounded scan resume tests share: candidates, observations and the
 * native owner fixtures.
 */
import { type ReviewCandidate } from '../../src/discovery/scan';
import { createHealthObservation, type HealthObservation } from '../../src/discovery/health';
import {
  scanResumeCommitWindow,
  type BoundedScanCandidateRow,
  type BoundedScanCommit,
  type BoundedScanResumeHost,
  type BoundedScanResumePlan,
} from '../../src/application/bounded-scan-resume';
import { expect, vi } from 'vitest';

export const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

export const candidate = (i: number): ReviewCandidate => ({
  key: `key-${i}`,
  sourceId: 'source',
  sourceFingerprint: 'captured',
  sessionRevision: 'original',
  channel: {
    sourceId: 'source',
    name: `Channel ${i}`,
    category: 'News',
    urls: [`https://origin-${i % 16}.fixture.invalid/${i}`],
  },
});

export const observation = (
  c: ReviewCandidate,
  kind:
    | 'recognized-media-response'
    | 'timeout'
    | 'http'
    | 'slow'
    | 'host-down' = 'recognized-media-response',
): HealthObservation =>
  createHealthObservation(
    { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
    { platform: 'native', observedAt: 1000 },
    kind === 'http' ? { kind, status: 429 } : { kind },
  );

export function fixture(total: number, storedPositive = false, window = false) {
  const nativeCounts = {
    total,
    checked: storedPositive ? 1 : 0,
    responded: storedPositive ? 1 : 0,
    published: 0,
  };
  const revisions = { catalogRevision: '1', healthRevision: '0', checkpointRevision: '1' };
  const plan: BoundedScanResumePlan = {
    schemaVersion: 1,
    ...(window ? { commitWindow: scanResumeCommitWindow } : {}),
    planId: 'plan',
    jobId: 'job',
    reviewDigest: 'a'.repeat(64),
    sessionRevision: 'original',
    query: 'News',
    createdAtMs: 1000,
    platform: 'native',
    observerProfile: 'native-response-v1',
    budgetMs: 20000,
    sourcePolicies: [{ sourceId: 'source', fingerprint: 'captured', allowHttp: false }],
    counts: { ...nativeCounts },
    revisions: { ...revisions },
  };
  const deferred = new Set<number>();
  const settled = new Set<number>(),
    reserved = new Map<string, BoundedScanCandidateRow>();
  let peakReservations = 0;
  const requests: { limit: number; blockedOrigins: readonly string[] }[] = [],
    batches: BoundedScanCommit[] = [];
  const host: BoundedScanResumeHost = {
    admit: vi.fn(async () => ({
      ...plan,
      counts: { ...nativeCounts },
      revisions: { ...revisions },
    })),
    take: vi.fn(
      async (_id: string, request: { limit: number; blockedOrigins: readonly string[] }) => {
        requests.push(request);
        const rows: BoundedScanCandidateRow[] = [],
          blocked = new Set(request.blockedOrigins);
        for (let i = 0; i < total && rows.length < request.limit; i++) {
          const token = `origin-${i % 16}`,
            reservationId = `reservation-${i}`;
          if (
            settled.has(i) ||
            deferred.has(i) ||
            reserved.has(reservationId) ||
            blocked.has(token)
          )
            continue;
          const row: BoundedScanCandidateRow = {
            candidateIndex: i,
            candidate: candidate(i),
            originToken: token,
            reservationId,
            work: storedPositive && i === 0 ? 'publish' : 'probe',
            ...(storedPositive && i === 0 ? { observation: observation(candidate(0)) } : {}),
          };
          blocked.add(token);
          rows.push(row);
          reserved.set(reservationId, row);
        }
        peakReservations = Math.max(peakReservations, reserved.size);
        return {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows,
          exhausted: settled.size + reserved.size + deferred.size === total,
        };
      },
    ),
    probe: vi.fn(async (c) => observation(c)),
    commit: vi.fn(async (_id: string, request: BoundedScanCommit) => {
      batches.push(request);
      expect(request.observations.length).toBeLessThanOrEqual(window ? 240 : 64);
      expect(request.expectedRevisions).toEqual(revisions);
      for (const x of request.observations) {
        const row = reserved.get(`reservation-${x.candidateIndex}`)!;
        expect(row).toBeTruthy();
        if (row.work === 'probe') {
          nativeCounts.checked++;
          if (['Reachable', 'PlayedHere'].includes(x.observation.verdict)) nativeCounts.responded++;
        }
        settled.add(x.candidateIndex);
      }
      nativeCounts.published += request.publicationIndices.length;
      revisions.checkpointRevision = String(BigInt(revisions.checkpointRevision) + 1n);
      revisions.healthRevision = String(BigInt(revisions.healthRevision) + 1n);
      if (request.publicationIndices.length)
        revisions.catalogRevision = String(BigInt(revisions.catalogRevision) + 1n);
      return {
        committed: true as const,
        planId: 'plan',
        ...revisions,
        counts: { ...nativeCounts },
        acknowledgedIndices: request.observations.map((x) => x.candidateIndex),
        publicationIndices: [...request.publicationIndices],
      };
    }),
    defer: vi.fn(async (_id, ids) => {
      for (const id of ids) {
        const row = reserved.get(id);
        if (!row) throw new Error('Unknown reservation');
        deferred.add(row.candidateIndex);
        reserved.delete(id);
      }
    }),
    release: vi.fn(async (_id, ids) => {
      for (const id of ids) reserved.delete(id);
    }),
    close: vi.fn(async () => {
      reserved.clear();
      deferred.clear();
    }),
  };
  return { host, plan, requests, batches, peak: () => peakReservations, reserved, nativeCounts };
}

// Sixteen independently cooling origins exercise retained observations across real timer turns.
export function coolingFixture(total: number, delay: number) {
  const f = fixture(total, false, true);
  f.host.admit = async () => ({
    ...f.plan,
    takeTiming: { schemaVersion: 1, maxCoolingDelayMs: 60000 },
  });
  const originalTake = f.host.take;
  const eligible = new Map<string, number>();
  f.host.probe = vi.fn(async (c) => {
    eligible.set(`origin-${Number(c.key.split('-')[1]) % 16}`, Date.now() + delay);
    return observation(c, 'timeout');
  });
  f.host.take = vi.fn(async (id, request, signal) => {
    const cooling = [...eligible].filter(([, at]) => at > Date.now());
    const page = await originalTake(
      id,
      {
        ...request,
        blockedOrigins: [
          ...new Set([...request.blockedOrigins, ...cooling.map(([origin]) => origin)]),
        ],
      },
      signal,
    );
    if (page.rows.length || page.exhausted) return page;
    if (f.reserved.size >= 256) return { ...page, capacityBlocked: true as const };
    // Every site busy (not cooling): an ordinary empty page.
    if (!cooling.length) return page;
    return { ...page, coolingDelayMs: Math.min(...cooling.map(([, at]) => at - Date.now())) };
  });
  return f;
}
