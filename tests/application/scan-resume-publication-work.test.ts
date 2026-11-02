// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import type { BoundedScanResumeHost } from '../../src/application/discovery/bounded-scan-resume';
import type { ScanEnvironment } from '../../src/application/discovery/scan-controller';
import type { ScanResumeWiringShared } from '../../src/application/discovery/scan-resume-wiring';
import type { BoundedScanTransportDiagnostic } from '../../src/platform/bounded-scan-resume';
import { fixture } from './bounded-scan-resume.fixture';
import { ScanCheckpointExpired } from '../../src/ui/scan/source-scan-model';

const state = vi.hoisted(() => ({
  host: null as BoundedScanResumeHost | null,
  captured: null as BoundedScanResumeHost | null,
  capabilities: null as (() => Promise<boolean>) | null,
  diagnose: null as ((event: BoundedScanTransportDiagnostic) => void) | null,
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('../../src/platform/bounded-scan-resume', () => ({
  createBoundedNativeScanResumeTransport: (options: {
    onDiagnostic?: (event: BoundedScanTransportDiagnostic) => void;
  }) => {
    state.diagnose = options.onDiagnostic ?? null;
    return {
      capabilities: async () => (state.capabilities ? state.capabilities() : true),
      host: state.host,
    };
  },
}));
vi.mock('../../src/platform/scan-checkpoint-summary', () => ({
  nativeScanCheckpointSummary: {
    read: async () => ({
      checkpointStatus: 'valid',
      storedVersion: 3,
      catalogRevision: '1',
      checkpointRevision: '1',
      jobId: 'job',
    }),
  },
}));
vi.mock('../../src/application/discovery/bounded-scan-resume-service', () => ({
  createBoundedScanResumeService: (host: BoundedScanResumeHost) => {
    state.captured = host;
    return { prepare: () => host.admit(new AbortController().signal) };
  },
}));
vi.mock('../../src/platform/scan-resume-publication-projection', () => ({
  createScanPublicationProjectionReader:
    () => async (receipt: { publicationIndices: number[] }) => {
      const i = receipt.publicationIndices[0]!;
      return {
        sources:
          i === 0
            ? [
                {
                  id: 'source',
                  name: 'Fixture',
                  kind: 'url',
                  location: 'https://fixture.invalid/index.m3u',
                },
              ]
            : [],
        channels: [
          {
            id: `saved-${i}`,
            sourceId: 'source',
            name: `Channel ${i}`,
            category: 'Sports',
            urls: [`https://fixture.invalid/${i}.m3u8`],
          },
        ],
      };
    },
}));
import { createScanResumeWiring } from '../../src/application/discovery/scan-resume-wiring';

afterEach(() => {
  vi.unstubAllGlobals();
  state.host = state.captured = null;
  state.capabilities = null;
  state.diagnose = null;
});

it('defers source/catalog/Guide rebuilds across batches while the viewer browses the Guide', async () => {
  vi.stubGlobal('window', {});
  const f = fixture(3, false, true);
  state.host = f.host;
  const env = {
    catalog: { schemaVersion: 1, sources: [], channels: [] },
    settings: { sources: [] },
    persistedCatalogRevision: '1',
    catalogRevision: 0,
    catalogBrowseViewRevision: 0,
    catalogWrites: Promise.resolve(),
    applicationClosing: false,
    importRunning: false,
    transferBusy: false,
    preferences: {
      settledSources: async () => [],
      adoptAcknowledgedSources: async (s: unknown[]) => s,
    },
    scanPlaybackBusy: () => true,
    renderCatalog: vi.fn(),
    browser: { search: vi.fn() },
    guide: { catalogChanged: vi.fn() },
    geographyControls: { update: vi.fn() },
    updateVisibleGuide: vi.fn(),
    automaticGuides: { request: vi.fn(async () => undefined) },
    notice: vi.fn(),
    diagnostics: { emit: vi.fn() },
  } as unknown as ScanEnvironment;
  const shared = {
    automaticScanActive: true,
    SCAN_LIST_BATCH: 300,
    scanStorageRevision: '1',
    scanBatchThrottle: {
      listed: 0,
      guidePending: false,
      startedMs: 0,
      listPending: false,
      catalogRenderPending: false,
    },
    scanProbeGate: { run: async (work: () => Promise<unknown>) => work() },
  } as unknown as ScanResumeWiringShared;
  const wiring = createScanResumeWiring(env, shared);
  const signal = new AbortController().signal;
  await wiring.createApplicationBoundedResume({ jobId: null }, signal);
  const host = state.captured!;
  const plan = await host.admit(signal);
  expect(Reflect.get(window, '__GENX_BOUNDED_SCAN__').root.stage).toBe('admission-acknowledged');
  let revisions = plan.revisions;
  for (let i = 0; i < 3; i++) {
    const page = await host.take(plan.planId, { limit: 1, blockedOrigins: [] }, signal);
    const row = page.rows[0]!;
    const observation = await host.probe(
      row.candidate,
      signal,
      plan.budgetMs,
      plan.sourcePolicies[0]!,
    );
    const receipt = await host.commit(
      plan.planId,
      {
        expectedRevisions: revisions,
        observations: [{ candidateIndex: i, observation }],
        publicationIndices: [i],
      },
      signal,
    );
    revisions = {
      catalogRevision: receipt.catalogRevision,
      healthRevision: receipt.healthRevision,
      checkpointRevision: receipt.checkpointRevision,
    };
    await host.release(plan.planId, [row.reservationId], signal);
  }
  expect(env.catalog.channels).toHaveLength(3);
  expect(env.automaticGuides.request).not.toHaveBeenCalled();
  expect(env.renderCatalog).not.toHaveBeenCalled();
  expect(env.guide.catalogChanged).not.toHaveBeenCalled();
  expect(env.browser.search).not.toHaveBeenCalled();
  expect(shared.scanBatchThrottle).toMatchObject({
    guidePending: true,
    listPending: true,
    catalogRenderPending: true,
  });
});

it.each([
  'disabled-capability',
  'changed-job',
  'native-refusal',
  'closed-policy-refusal',
  'joined-expired',
  'unconfirmed-expired',
] as const)(
  'admission root diagnostics distinguish %s without exposing an error payload',
  async (kind) => {
    vi.stubGlobal('window', {});
    const f = fixture(1, false, true);
    state.host = f.host;
    let capabilityCalls = 0;
    state.capabilities = async () => ++capabilityCalls === 1 || kind !== 'disabled-capability';
    if (kind === 'native-refusal')
      f.host.admit = vi.fn(async () => {
        throw new Error('https://private.invalid/password?token=secret');
      });
    if (kind === 'closed-policy-refusal')
      f.host.admit = vi.fn(async () => {
        state.diagnose?.({
          command: 'open_scan_resume_plan',
          stage: 'native-refusal',
          code: 'scan-checkpoint-policy-stale',
        });
        throw Object.assign(new Error('Native admission has closed.'), {
          name: 'ScanAdmissionClosedError',
        });
      });
    if (kind === 'joined-expired' || kind === 'unconfirmed-expired')
      f.host.admit = vi.fn(async () => {
        state.diagnose?.({
          command: 'open_scan_resume_plan',
          stage: 'native-refusal',
          code: 'scan-checkpoint-expired',
        });
        throw Object.assign(new Error('Native admission could not finish.'), {
          name: kind === 'joined-expired' ? 'ScanAdmissionClosedError' : 'CancelUnconfirmed',
        });
      });
    const env = {
      catalog: { schemaVersion: 1, sources: [], channels: [] },
      settings: { sources: [] },
      persistedCatalogRevision: '1',
      catalogWrites: Promise.resolve(),
      applicationClosing: false,
      importRunning: false,
      transferBusy: false,
      preferences: { settledSources: async () => [] },
      scanPlaybackBusy: () => true,
    } as unknown as ScanEnvironment;
    const shared = {
      automaticScanActive: true,
      SCAN_LIST_BATCH: 300,
      scanStorageRevision: '1',
      scanBatchThrottle: {
        listed: 0,
        guidePending: false,
        startedMs: 0,
        listPending: false,
        catalogRenderPending: false,
      },
      scanProbeGate: { run: async (work: () => Promise<unknown>) => work() },
    } as unknown as ScanResumeWiringShared;
    const wiring = createScanResumeWiring(env, shared),
      signal = new AbortController().signal;
    const service = await wiring.createApplicationBoundedResume(
      { jobId: kind === 'changed-job' ? 'different-job' : null },
      signal,
    );
    const admission = kind.endsWith('expired') ? service!.prepare() : state.captured!.admit(signal);
    if (kind === 'joined-expired')
      await expect(admission).rejects.toBeInstanceOf(ScanCheckpointExpired);
    else if (kind === 'closed-policy-refusal')
      await expect(admission).rejects.toMatchObject({ name: 'ScanAdmissionClosedError' });
    else await expect(admission).rejects.toThrow();
    if (kind === 'unconfirmed-expired')
      await expect(admission).rejects.not.toBeInstanceOf(ScanCheckpointExpired);
    const diagnostic = Reflect.get(window, '__GENX_BOUNDED_SCAN__');
    expect(diagnostic.root).toEqual({
      stage:
        kind === 'disabled-capability'
          ? 'capability-refused'
          : kind === 'changed-job'
            ? 'admission-job-refused'
            : 'native-admission',
      catalogMatches: true,
      importRunning: false,
      transferBusy: false,
      closing: false,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|password|token|secret|different-job/);
    if (kind === 'closed-policy-refusal')
      expect(diagnostic.transportFailure).toMatchObject({
        command: 'open_scan_resume_plan',
        code: 'scan-checkpoint-policy-stale',
      });
    expect(f.host.admit).toHaveBeenCalledTimes(kind === 'disabled-capability' ? 0 : 1);
    expect(f.host.close).toHaveBeenCalledTimes(kind === 'changed-job' ? 1 : 0);
  },
);
