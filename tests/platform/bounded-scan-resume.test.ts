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

import {
  scanResumeCommitWindow,
  scanResumeTakeTiming,
} from '../../src/application/discovery/bounded-scan-resume';
import { expect, it, vi } from 'vitest';
import { createBoundedNativeScanResumeTransport } from '../../src/platform/bounded-scan-resume';
import { createHealthObservation } from '../../src/discovery/health';
const source = {
  id: 's',
  name: 'User selected',
  kind: 'url',
  location: 'https://fixture.invalid/list',
  allowHttp: false,
};
const header = () => ({
  schemaVersion: 1,
  planId: 'plan',
  jobId: 'job',
  reviewDigest: 'a'.repeat(64),
  sessionRevision: 'original',
  query: 'News',
  createdAtMs: 1000,
  platform: 'native',
  observerProfile: 'native-v1',
  budgetMs: 20000,
  sourcePolicies: [
    { source, definitionFingerprint: 'b'.repeat(64), capturedFingerprint: 'captured' },
  ],
  counts: { total: 1, checked: 0, responded: 0, published: 0 },
  revisions: { catalogRevision: '1', healthRevision: '0', checkpointRevision: '1' },
});
const c = {
  key: 'key',
  sourceId: 's',
  sourceFingerprint: 'captured',
  sessionRevision: 'original',
  channel: {
    sourceId: 's',
    name: 'Owned',
    category: 'News',
    urls: ['https://stream.fixture.invalid/live'],
  },
};
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
it('strictnativeheader mapscanonicalpolicies and probe wire contains key only; falsecapability startsnothing', async () => {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'scan_resume_capabilities') return { schemaVersion: 1, boundedResume: 0 };
    const r = args?.request as Record<string, unknown>;
    if (command === 'open_scan_resume_plan') {
      expect(r).toEqual({
        schemaVersion: 1,
        expectedCatalogRevision: '1',
        expectedCheckpointRevision: '1',
      });
      return header();
    }
    if (command === 'probe_scan_resume_candidate') {
      expect(r).toEqual({ schemaVersion: 1, planId: 'plan', candidateKey: 'key' });
      return createHealthObservation(
        { channelId: 'key', sourceId: 's', fingerprint: 'captured' },
        { platform: 'native', observedAt: 1000 },
        { kind: 'recognized-media-response' },
      );
    }
    if (command === 'close_scan_resume_plan') return null;
    throw new Error('Unknown controlled command');
  });
  const transport = createBoundedNativeScanResumeTransport({
    runtime: { invoke },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  expect(await transport.capabilities()).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
  const plan = await transport.host.admit(new AbortController().signal);
  expect(plan.sourcePolicies).toEqual([
    { sourceId: 's', fingerprint: 'captured', allowHttp: false },
  ]);
  expect(transport.sources()).toEqual([source]);
  expect(Object.isFrozen(transport.lastPlanSnapshot())).toBe(true);
  await transport.host.probe(c, new AbortController().signal, 20000, plan.sourcePolicies[0]);
  await expect(
    transport.host.probe(c, new AbortController().signal, 20000, {
      ...plan.sourcePolicies[0],
      allowHttp: true,
    }),
  ).rejects.toThrow();
  expect(
    invoke.mock.calls.filter(([command]) => command === 'probe_scan_resume_candidate'),
  ).toHaveLength(1);
  await transport.host.close('plan');
  expect(transport.lastPlanSnapshot()).toBeNull();
  expect(transport.sources()).toEqual([]);
});
it('actualknownlateopen closes exactlease after command ANDcancel join; unknown metadata isnever granted', async () => {
  const main = gate(),
    cancel = gate(),
    controller = new AbortController();
  const invoke = vi.fn(async (command: string) => {
    if (command === 'open_scan_resume_plan') {
      await main.promise;
      return header();
    }
    if (command === 'cancel_playlist') {
      await cancel.promise;
      return;
    }
    if (command === 'close_scan_resume_open') return null;
    throw new Error('Unknown');
  });
  const t = createBoundedNativeScanResumeTransport({
    runtime: { invoke },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  let settled = false;
  const admitted = t.host.admit(controller.signal).catch((error) => {
    settled = true;
    throw error;
  });
  const rejection = expect(admitted).rejects.toMatchObject({ name: 'ScanAdmissionClosedError' });
  controller.abort();
  main.resolve();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('cancel_playlist', expect.any(Object)),
  );
  expect(settled).toBe(false);
  expect(invoke.mock.calls.some(([c]) => c === 'close_scan_resume_open')).toBe(false);
  cancel.resolve();
  await rejection;
  expect(invoke.mock.calls.filter(([c]) => c === 'close_scan_resume_open')).toHaveLength(1);
  expect(t.lastPlanSnapshot()).toBeNull();
  const bad = createBoundedNativeScanResumeTransport({
    runtime: { invoke: async () => ({ ...header(), review: { candidates: Array(100).fill(c) } }) },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  await expect(bad.host.admit(new AbortController().signal)).rejects.toThrow();
  expect(bad.sources()).toEqual([]);
});
it('lateactualdurableACK winsabort and malformedreceipt cannotpromote clientrevisions', async () => {
  const main = gate(),
    cancel = gate();
  const invoke = vi.fn(async (command: string) => {
    if (command === 'open_scan_resume_plan') return header();
    if (command === 'commit_scan_resume_candidates') {
      await main.promise;
      return {
        committed: true,
        planId: 'plan',
        catalogRevision: '2',
        healthRevision: '1',
        checkpointRevision: '2',
        acknowledgedIndices: [0],
        publicationIndices: [0],
        counts: { total: 1, checked: 1, responded: 1, published: 1 },
      };
    }
    if (command === 'cancel_playlist') {
      await cancel.promise;
      return;
    }
    throw new Error('Unknown');
  });
  const t = createBoundedNativeScanResumeTransport({
    runtime: { invoke },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  const plan = await t.host.admit(new AbortController().signal),
    controller = new AbortController();
  const o = createHealthObservation(
    { channelId: 'key', sourceId: 's', fingerprint: 'captured' },
    { platform: 'native', observedAt: 1000 },
    { kind: 'recognized-media-response' },
  );
  const pending = t.host.commit(
    'plan',
    {
      expectedRevisions: plan.revisions,
      observations: [{ candidateIndex: 0, observation: o }],
      publicationIndices: [0],
    },
    controller.signal,
  );
  controller.abort();
  main.resolve();
  cancel.resolve();
  expect((await pending).committed).toBe(true);
  // This metadata getter does not promote nativeplan/client revisions on receipt.
  expect(t.lastPlanSnapshot()?.revisions.catalogRevision).toBe('1');
});

it('negotiates exact version2 capacity while legacy capability replies keep 64-row admission', async () => {
  for (const negotiated of [false, true]) {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'scan_resume_capabilities') {
        expect(args).toMatchObject({ windowVersion: 2, requestId: expect.any(String) });
        return {
          schemaVersion: 1,
          boundedResume: 1,
          ...(negotiated ? { commitWindow: scanResumeCommitWindow } : {}),
        };
      }
      if (command === 'open_scan_resume_plan') return header();
      if (command === 'take_scan_resume_candidates') {
        const request = args?.request as { schemaVersion: number };
        expect(request.schemaVersion).toBe(negotiated ? 2 : 1);
        return {
          schemaVersion: 1,
          planId: 'plan',
          rows: [],
          exhausted: !negotiated,
          ...(negotiated ? { capacityBlocked: true } : {}),
        };
      }
      throw new Error('Unknown fixture command');
    });
    const transport = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
    });
    expect(await transport.capabilities()).toBe(true);
    const admitted = await transport.host.admit(new AbortController().signal);
    expect(admitted.commitWindow).toEqual(negotiated ? scanResumeCommitWindow : undefined);
    const page = await transport.host.take(
      'plan',
      { limit: 16, blockedOrigins: [] },
      new AbortController().signal,
    );
    expect(page.capacityBlocked).toBe(negotiated ? true : undefined);
  }
});

it.each([
  ['scan-resume-owner-busy', 'scan-resume-owner-busy'],
  ['https://private.invalid/secret?token=hidden', 'native-refusal-unclassified'],
])('redacts native refusal while preserving command failure (%s)', async (failure, expected) => {
  const events: unknown[] = [];
  const transport = createBoundedNativeScanResumeTransport({
    runtime: {
      invoke: async (command) => {
        if (command === 'open_scan_resume_plan') return header();
        if (command === 'take_scan_resume_candidates') throw failure;
        if (command === 'close_scan_resume_plan') return null;
        throw new Error('fixture');
      },
    },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
    onDiagnostic(event) {
      events.push(event);
      throw new Error('observer');
    },
  });
  await transport.host.admit(new AbortController().signal);
  await expect(
    transport.host.take('plan', { limit: 1, blockedOrigins: [] }, new AbortController().signal),
  ).rejects.toThrow('Native command could not finish.');
  expect(events).toEqual([
    { command: 'take_scan_resume_candidates', stage: 'native-dispatch', code: null },
    { command: 'take_scan_resume_candidates', stage: 'native-refusal', code: expected },
  ]);
  expect(events.every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private.invalid');
  await transport.host.close('plan');
});
it('distinguishes local commit rejection from malformed native reply without publishing', async () => {
  const events: unknown[] = [],
    invoke = vi.fn(async (command: string) => {
      if (command === 'open_scan_resume_plan') return header();
      if (command === 'take_scan_resume_candidates') return { unexpected: 'private payload' };
      if (command === 'close_scan_resume_plan') return null;
      throw new Error('fixture');
    });
  const t = createBoundedNativeScanResumeTransport({
    runtime: { invoke },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
    onDiagnostic: (event) => events.push(event),
  });
  const plan = await t.host.admit(new AbortController().signal);
  await expect(
    t.host.commit(
      'plan',
      { expectedRevisions: plan.revisions, observations: [], publicationIndices: [] },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(invoke.mock.calls.some(([c]) => c === 'commit_scan_resume_candidates')).toBe(false);
  expect(events).toEqual([
    {
      command: 'commit_scan_resume_candidates',
      stage: 'local-validation',
      code: 'bounded-request-invalid',
    },
  ]);
  await expect(
    t.host.take('plan', { limit: 1, blockedOrigins: [] }, new AbortController().signal),
  ).rejects.toThrow();
  expect(events.at(-1)).toEqual({
    command: 'take_scan_resume_candidates',
    stage: 'response-validation',
    code: 'bounded-response-invalid',
  });
  expect(t.lastPlanSnapshot()?.revisions.catalogRevision).toBe('1');
  expect(JSON.stringify(events)).not.toContain('private payload');
  await t.host.close('plan');
});

it('negotiates take timing independently and never sends new timing fields to old window hosts', async () => {
  for (const timing of [false, true]) {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'scan_resume_capabilities') {
        expect(args).toMatchObject({ windowVersion: 2, takeTimingVersion: 1 });
        return {
          schemaVersion: 1,
          boundedResume: 1,
          commitWindow: scanResumeCommitWindow,
          ...(timing ? { takeTiming: scanResumeTakeTiming } : {}),
        };
      }
      if (command === 'open_scan_resume_plan') return header();
      if (command === 'take_scan_resume_candidates') {
        const r = args?.request as Record<string, unknown>;
        expect(Object.hasOwn(r, 'takeTimingVersion')).toBe(timing);
        if (timing) expect(r.takeTimingVersion).toBe(1);
        return {
          schemaVersion: 1,
          planId: 'plan',
          rows: [],
          exhausted: !timing,
          ...(timing ? { coolingDelayMs: 60000 } : {}),
        };
      }
      throw new Error('unexpected');
    });
    const t = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
    });
    await t.capabilities();
    const plan = await t.host.admit(new AbortController().signal);
    expect(plan.takeTiming).toEqual(timing ? scanResumeTakeTiming : undefined);
    expect(
      (await t.host.take('plan', { limit: 16, blockedOrigins: [] }, new AbortController().signal))
        .coolingDelayMs,
    ).toBe(timing ? 60000 : undefined);
  }
});
it.each(['commitWindow', 'takeTiming'])(
  'raw admitted headers cannot grant local %s authority',
  async (field) => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'open_scan_resume_plan')
        return {
          ...header(),
          [field]: field === 'commitWindow' ? scanResumeCommitWindow : scanResumeTakeTiming,
        };
      if (command === 'cancel_playlist' || command === 'close_scan_resume_open') return null;
      throw new Error('unexpected');
    });
    const t = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
    });
    await expect(t.host.admit(new AbortController().signal)).rejects.toMatchObject({
      name: 'ScanAdmissionClosedError',
    });
    expect(invoke.mock.calls.map((c) => c[0])).toContain('close_scan_resume_open');
  },
);
it.each([
  { schemaVersion: 2, maxCoolingDelayMs: 60000 },
  { schemaVersion: 1, maxCoolingDelayMs: 60001 },
  { schemaVersion: 1, maxCoolingDelayMs: 60000, extra: 1 },
])('refuses malformed timing capabilities before admission (%j)', async (takeTiming) => {
  const t = createBoundedNativeScanResumeTransport({
    runtime: {
      invoke: async () => ({
        schemaVersion: 1,
        boundedResume: 1,
        commitWindow: scanResumeCommitWindow,
        takeTiming,
      }),
    },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  await expect(t.capabilities()).rejects.toThrow();
  expect(t.lastPlanSnapshot()).toBeNull();
});
it('refuses a timing capability without the independent commit-window agreement', async () => {
  const t = createBoundedNativeScanResumeTransport({
    runtime: {
      invoke: async () => ({
        schemaVersion: 1,
        boundedResume: 1,
        takeTiming: scanResumeTakeTiming,
      }),
    },
    currentFence: () => ({ expectedCatalogRevision: '1', expectedCheckpointRevision: '1' }),
  });
  await expect(t.capabilities()).rejects.toThrow();
});
