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

import { expect, test, type Page } from '@playwright/test';
import { preparePackedScanCheckpoint } from '../../src/discovery/scan-checkpoint';
import { reachabilityHealthProfile } from '../../src/application/health-profile';
import type { ScanReview } from '../../src/discovery/scan';

// Bundled main + real checkpoint/manifest workers. The retained bridge below is
// deliberately not a SQLite, platform encryption, network, or decoder proof.
const location = 'https://cold-manifest.fixture.invalid/playlist.m3u';
const urls = Array.from({ length: 3 }, (_, i) => `https://cold-${i}.fixture.invalid/live`);
type Mode =
  | 'sealed'
  | 'absent'
  | 'lookup-failure'
  | 'read-failure'
  | 'bounded-admission-failure'
  | 'bounded-admission-close-failure'
  | 'capability-failure';
type Entry = { candidateIndex: number; urls: string[] };
type Args = {
  requestId?: string;
  openingRequestId?: string;
  active?: boolean;
  contents?: string;
  checkpoint?: string;
  url?: string;
  request?: {
    jobId?: string;
    reviewDigest?: string;
    manifestId?: string;
    startIndex?: number;
    expectedCatalogRevision?: string;
    expectedCheckpointRevision?: string;
  };
};

async function coldFixture(page: Page, mode: Mode) {
  const source = {
    id: 'cold-source',
    name: 'Explicit controlled source',
    kind: 'url' as const,
    location,
    allowHttp: false,
    contentKind: 'catalog' as const,
    mediaMime: 'text/plain',
  };
  const providers = [
    {
      id: 'cold-provider',
      name: source.name,
      location,
      provenance: 'https://github.com/Controlled/cold-fixture',
      allowHttp: false,
    },
  ];
  const preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources: [],
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    sourceRefreshAttemptAt: 0,
    voiceSearchConsent: false,
    reviewedChannelProviders: providers,
    reviewedGuideProviders: [],
  });
  const review: ScanReview = {
    sessionRevision: 'original-runtime',
    query: '',
    status: 'completed',
    sources: [
      {
        sourceId: source.id,
        fingerprint: 'original-source-fingerprint',
        status: 'completed',
        inspected: 3,
        matched: 3,
        warnings: 0,
      },
    ],
    candidates: urls.map((url, i) => ({
      key: `original-${i}`,
      sourceId: source.id,
      sourceFingerprint: 'original-source-fingerprint',
      sessionRevision: 'original-runtime',
      channel: { sourceId: source.id, name: `Original ${i}`, category: 'Fixture', urls: [url] },
    })),
    counts: { inspected: 3, matched: 3, failedSources: 0, canceledSources: 0 },
  };
  const packed = await preparePackedScanCheckpoint({
    jobId: 'cold-original-job',
    createdAtMs: Date.now(),
    catalogRevision: '0',
    budgetMs: 20000,
    platform: 'android',
    observerProfile: reachabilityHealthProfile(true),
    sources: [source],
    providers,
    canonicalSources: [],
    review,
    observations: [
      {
        channelId: review.candidates[0]!.key,
        sourceId: source.id,
        fingerprint: review.sources[0]!.fingerprint,
        platform: 'android',
        observedAt: Date.now(),
        verdict: 'TemporaryUnavailable',
        evidence: { kind: 'network-failure' },
      },
    ],
    publishedKeys: [],
  });
  const checkpoint = JSON.stringify(packed);
  const header = {
    schemaVersion: 1,
    manifestId: 'cold-owned-manifest',
    manifestRevision: '1',
    jobId: packed.jobId,
    reviewDigest: packed.reviewDigest,
    candidateCount: 3,
    nextIndex: 3,
  };
  const entries: Entry[] = urls.map((url, candidateIndex) => ({ candidateIndex, urls: [url] }));
  const calls: string[] = [],
    probes: string[] = [],
    releases = new Map<string, () => void>();
  let checkpointRevision = '7';
  let savedCheckpoint = checkpoint;
  let savedPreferences = preferences;
  let openingRequestId: string | undefined;
  let openerCanceled = false;
  let releaseAdmissionClose!: () => void;
  const admissionClose = new Promise<void>((resolve) => {
    releaseAdmissionClose = resolve;
  });
  const pair = () => ({
    catalog: null,
    health: null,
    preferences: savedPreferences,
    catalogRevision: '0',
    healthRevision: '0',
  });
  const receipt = () => ({
    committed: true,
    catalogRevision: '0',
    healthRevision: '0',
    checkpointRevision,
  });
  const checkCas = (args: Args) => {
    expect(args.request?.expectedCatalogRevision).toBe('0');
    expect(args.request?.expectedCheckpointRevision).toBe(checkpointRevision);
  };
  await page.exposeBinding('__coldInvoke', async (_binding, command: string, args: Args = {}) => {
    calls.push(command);
    if (command === 'plugin:event|listen') return 1;
    if (command === 'plugin:event|unlisten' || command === 'cancel_catalog_query') return;
    if (command === 'device_capabilities') return { isTelevision: false };
    if (command === 'runtime_info') return { platform: 'android', dataMode: 'application' };
    if (command === 'set_viewing_active')
      return {
        schemaVersion: 1,
        adapterVersion: 'viewing-wake-v1',
        requestedActive: args.active,
        foreground: true,
        platform: 'android',
        windowKeepScreenOn: args.active,
        webViewKeepScreenOn: args.active,
        decorKeepScreenOn: args.active,
      };
    if (command === 'read_record_pair') return pair();
    if (command === 'read_record') return savedPreferences;
    if (command === 'write_record_receipt') {
      savedPreferences = args.contents!;
      return receipt();
    }
    if (command === 'scan_checkpoint_capabilities')
      return { schemaVersion: 1, advance: 1, packedReference: 3 };
    if (command === 'scan_resume_capabilities') {
      if (mode === 'capability-failure') throw new Error('controlled-capability-unavailable');
      return { schemaVersion: 1, boundedResume: mode.startsWith('bounded-admission-') ? 1 : 0 };
    }
    if (command === 'open_scan_resume_plan') {
      expect(mode.startsWith('bounded-admission-')).toBe(true);
      expect(args.requestId).toMatch(/^[a-f0-9-]{36}$/);
      openingRequestId = args.requestId;
      throw 'scan-resume-index-unavailable';
    }
    if (command === 'close_scan_resume_open') {
      expect(openingRequestId).toBeDefined();
      expect(args.openingRequestId).toBe(openingRequestId);
      expect(openerCanceled).toBe(true);
      if (mode === 'bounded-admission-close-failure')
        throw new Error('controlled-opener-cleanup-unconfirmed');
      await admissionClose;
      return;
    }
    if (command === 'read_scan_checkpoint_summary')
      return {
        schemaVersion: 1,
        checkpointStatus: 'valid',
        storedVersion: 3,
        total: 3,
        checked: 1,
        responded: 0,
        published: 0,
        unfinished: true,
        catalogRevision: '0',
        checkpointRevision,
      };
    if (command === 'scan_batch_capabilities') return { schemaVersion: 1, scanBatch: 1 };
    if (command === 'scan_window_capabilities') throw 'Command scan_window_capabilities not found';
    if (command === 'scan_candidate_manifest_capabilities')
      return { schemaVersion: 1, candidateManifest: 1 };
    if (command === 'read_scan_checkpoint')
      return {
        checkpoint: savedCheckpoint,
        checkpointStatus: 'valid',
        jobId: packed.jobId,
        checkpointRevision,
        catalogRevision: '0',
      };
    if (command === 'find_scan_candidate_manifest') {
      checkCas(args);
      expect(args.request?.jobId).toBe(packed.jobId);
      expect(args.request?.reviewDigest).toBe(packed.reviewDigest);
      if (mode === 'lookup-failure') throw new Error('controlled-storage-unavailable');
      return mode === 'absent'
        ? { schemaVersion: 1, status: 'absent' }
        : { ...header, status: 'sealed' };
    }
    if (command === 'read_scan_candidate_manifest_page') {
      checkCas(args);
      expect(args.request?.manifestId).toBe(header.manifestId);
      expect(args.request?.startIndex).toBe(0);
      if (mode === 'read-failure') throw new Error('controlled-storage-unavailable');
      const { candidateCount: _candidateCount, ...pageHeader } = header;
      return { ...pageHeader, startIndex: 0, nextIndex: 3, entries };
    }
    if (command === 'inspect_source') {
      expect(mode).toBe('absent');
      expect(args.url).toBe(location);
      return {
        kind: 'catalog',
        mime: 'text/plain',
        text:
          '#EXTM3U\n' +
          urls.map((url, i) => `#EXTINF:-1 group-title="Fixture",Original ${i}\n${url}\n`).join(''),
      };
    }
    if (command === 'inspect_media_resources') {
      expect(args.url).not.toBe(urls[0]);
      probes.push(args.url!);
      await new Promise<void>((resolve) => releases.set(args.requestId!, resolve));
      releases.delete(args.requestId!);
      return {
        requestId: args.requestId,
        status: 'unavailable',
        reasonCode: 'fixture-unavailable',
        checkedResources: 0,
        httpStatus: 503,
      };
    }
    if (command === 'cancel_playlist') {
      if (openingRequestId && args.requestId === openingRequestId) openerCanceled = true;
      releases.get(args.requestId!)?.();
      return;
    }
    if (command === 'advance_scan_checkpoint' || command === 'write_scan_checkpoint') {
      if (args.checkpoint) savedCheckpoint = args.checkpoint;
      checkpointRevision = String(BigInt(checkpointRevision) + 1n);
      return receipt();
    }
    // Unsupported guide/diagnostics/optional indexed browsing fail explicitly.
    // A fresh job or catalog publication must never be hidden by a generic ACK.
    throw new Error('controlled-command-unavailable');
  });
  // Establish one document, then cold-reload with retained storage/manifest.
  // Every Worker remains the real bundled implementation; no worker replacement.
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.addInitScript(() => {
    let callbackId = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__coldInvoke')(command, args),
      transformCallback: () => ++callbackId,
      unregisterCallback: () => undefined,
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: () => undefined,
    });
  });
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  return {
    calls,
    probes,
    checkpoint,
    releaseAdmissionClose,
    state: () => ({
      checkpoint: savedCheckpoint,
      checkpointRevision,
      preferences: savedPreferences,
    }),
    release: () => releases.forEach((resolve) => resolve()),
  };
}

async function preflight(page: Page) {
  // A different query must not silently replace the retained original job.
  await page.locator('#search').fill('Different query');
  await page.locator('#search-programs').click();
}
async function recovery(page: Page) {
  return page.evaluate(() => Reflect.get(window, '__GENX_SCAN_RECOVERY__'));
}
async function scan(page: Page) {
  return page.evaluate(() => Reflect.get(window, '__GENX_SCAN__'));
}
async function stop(page: Page) {
  await page.locator('#inline-scan-stop').click();
  await expect.poll(async () => (await scan(page)).busy).toBe(false);
}

test('cold sealed manifest restores the original job offline; Continue skips settled candidates', async ({
  page,
}) => {
  const fixture = await coldFixture(page, 'sealed');
  await preflight(page);
  await expect.poll(async () => (await recovery(page)).stage).toBe('accepted');
  await expect(page.locator('#inline-scan-continue')).toBeVisible();
  expect((await scan(page)).checked).toBe(1);
  expect(fixture.probes).toEqual([]);
  expect(fixture.calls).not.toContain('inspect_source');
  expect(fixture.calls).not.toContain('inspect_source_directory');
  await page.locator('#inline-scan-continue').click();
  await expect.poll(() => fixture.probes.length).toBe(2);
  expect(fixture.calls).toContain('scan_batch_capabilities');
  expect([...fixture.probes].sort()).toEqual(urls.slice(1).sort());
  await stop(page);
  expect((await scan(page)).total).toBe(3);
  expect(fixture.calls).not.toContain('begin_scan_candidate_manifest');
  expect(fixture.calls).not.toContain('commit_scan_batch');
  fixture.release();
});

test('absent manifest alone permits guarded original-source reacquisition', async ({ page }) => {
  const fixture = await coldFixture(page, 'absent');
  await preflight(page);
  await expect.poll(async () => (await recovery(page)).stage).toBe('accepted');
  await expect(page.locator('#inline-scan-continue')).toBeVisible();
  expect(fixture.calls.filter((command) => command === 'inspect_source')).toHaveLength(1);
  expect(fixture.calls).not.toContain('inspect_source_directory');
  expect(fixture.probes).toEqual([]);
  expect(fixture.state().checkpoint).toBe(fixture.checkpoint);
  expect(fixture.state().checkpointRevision).toBe('7');
});

for (const mode of ['lookup-failure', 'read-failure'] as const) {
  test(`cold ${mode} preserves the checkpoint without acquisition, probes, or fresh-job reset`, async ({
    page,
  }) => {
    const fixture = await coldFixture(page, mode);
    const before = fixture.state();
    await preflight(page);
    await expect
      .poll(async () => (await recovery(page)).reason)
      .toBe('candidate-storage-unavailable');
    expect(fixture.probes).toEqual([]);
    expect(fixture.state()).toEqual(before);
    for (const command of [
      'inspect_source',
      'inspect_source_directory',
      'begin_scan_candidate_manifest',
      'discard_scan_checkpoint',
      'write_scan_checkpoint',
      'commit_scan_batch',
    ])
      expect(fixture.calls).not.toContain(command);
    await expect(page.locator('#inline-scan-continue')).toBeHidden();
    expect((await scan(page)).busy).toBe(false);
  });
}
for (const mode of ['bounded-admission-failure', 'capability-failure'] as const) {
  test(`cold ${mode} refuses before full checkpoint or native plan admission`, async ({ page }) => {
    const fixture = await coldFixture(page, mode);
    const before = fixture.state();
    await page.locator('#search-programs').click();
    if (mode === 'bounded-admission-failure') {
      await expect.poll(() => fixture.calls).toContain('close_scan_resume_open');
      expect(await scan(page)).toMatchObject({ total: 3, checked: 1, published: 0, busy: true });
      expect(fixture.state()).toEqual(before);
      await expect(page.locator('#inline-scan-error')).toBeHidden();
      fixture.releaseAdmissionClose();
    }
    await expect(page.locator('#search-programs')).toBeEnabled();
    await expect(page.locator('#inline-scan-error')).toBeVisible();
    expect(await scan(page)).toMatchObject({ total: 3, checked: 1, published: 0, busy: false });
    expect(fixture.state()).toEqual(before);
    for (const command of [
      'read_scan_checkpoint',
      'find_scan_candidate_manifest',
      'inspect_source',
      'inspect_source_directory',
      'commit_scan_resume_candidates',
      'discard_scan_checkpoint',
    ])
      expect(fixture.calls).not.toContain(command);
    expect(fixture.calls.filter((command) => command === 'scan_resume_capabilities')).toHaveLength(
      mode === 'bounded-admission-failure' ? 2 : 1,
    );
    expect(fixture.calls.filter((command) => command === 'open_scan_resume_plan')).toHaveLength(
      mode === 'bounded-admission-failure' ? 1 : 0,
    );
    expect(fixture.calls.filter((command) => command === 'close_scan_resume_open')).toHaveLength(
      mode === 'bounded-admission-failure' ? 1 : 0,
    );
  });
}

test('cold opener cleanup rejection shows a failed scan and retains all saved progress', async ({
  page,
}) => {
  const fixture = await coldFixture(page, 'bounded-admission-close-failure');
  const before = fixture.state();
  await page.locator('#search-programs').click();
  await expect(page.locator('#inline-scan-error')).toContainText(
    'Scan cleanup could not be confirmed. Reopen the app before continuing.',
  );
  await expect(page.locator('#inline-scan-status')).toContainText('Scan stopped');
  expect(await scan(page)).toMatchObject({
    phase: 'failed',
    total: 3,
    checked: 1,
    published: 0,
    busy: false,
    lastFailure: 'cancel-ack',
  });
  expect(fixture.state()).toEqual(before);
  expect(fixture.probes).toEqual([]);
  for (const command of [
    'read_scan_checkpoint',
    'find_scan_candidate_manifest',
    'inspect_source',
    'inspect_source_directory',
    'commit_scan_resume_candidates',
    'discard_scan_checkpoint',
  ])
    expect(fixture.calls).not.toContain(command);
  expect(fixture.calls.filter((command) => command === 'open_scan_resume_plan')).toHaveLength(1);
  expect(fixture.calls.filter((command) => command === 'close_scan_resume_open')).toHaveLength(1);
});

for (const library of ['live', 'genxtra'] as const) {
  test(`Import configured scan remains visible in ${library} and joins native plan refusal`, async ({
    page,
  }) => {
    const fixture = await coldFixture(page, 'bounded-admission-failure');
    if (library === 'genxtra') {
      await page.locator('#genxtra-button').click();
      await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
    }
    await page.locator('#settings-button').click();
    await page.locator('#import-button').click();
    await expect(page.locator('#automatic-scan-button')).toHaveText('Scan configured sources');
    await expect(page.locator('#automatic-scan-button')).toBeVisible();
    for (const command of [
      'inspect_source',
      'inspect_source_directory',
      'open_scan_resume_plan',
      'begin_scan_candidate_manifest',
    ])
      expect(fixture.calls).not.toContain(command);
    await page.locator('#automatic-scan-button').click();
    await expect.poll(() => fixture.calls).toContain('close_scan_resume_open');
    const modal = page.getByRole('dialog', { name: 'Review source scan' });
    if (library === 'genxtra') {
      await expect(modal).toBeVisible();
      await expect(page.locator('#inline-source-scan')).toBeHidden();
    } else {
      await expect(page.locator('#inline-source-scan')).toBeVisible();
    }
    fixture.releaseAdmissionClose();
    await expect.poll(async () => (await scan(page)).busy).toBe(false);
    if (library === 'genxtra') {
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('alert')).toBeVisible();
      await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
    } else await expect(page.locator('#inline-scan-error')).toBeVisible();
    expect(fixture.probes).toEqual([]);
    expect(fixture.calls.filter((command) => command === 'open_scan_resume_plan')).toHaveLength(1);
    // The actual episode transport must negotiate too; a cached temporary transport loses its window.
    expect(fixture.calls.filter((command) => command === 'scan_resume_capabilities')).toHaveLength(
      2,
    );
    for (const command of [
      'inspect_source',
      'inspect_source_directory',
      'begin_scan_candidate_manifest',
    ])
      expect(fixture.calls).not.toContain(command);
    fixture.release();
  });
}
