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
import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { configureControlledDiscoveryProviders } from './helpers/source-scan';

const provider = 'https://iptv-org.github.io/iptv/index.m3u';
const second = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';

// Bundled main/storage-transport seam only. SQLite atomicity belongs to the
// separate real native fixtures; this bridge does not simulate a native decoder.
async function prepare(
  page: Page,
  stale: boolean,
  holdRevisions = false,
  count = 16,
  manifestMode?: 'held' | 'fail',
  windowMode = false,
  sizeRefusal = false,
) {
  await installOnlineDirectoryFixture(page, [provider, second]);
  await page.route('https://iptv-org.github.io/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  const playlist =
    '#EXTM3U\n' +
    Array.from(
      { length: count },
      (_, index) =>
        `#EXTINF:-1 group-title="Fixture",Batch ${index}\nhttps://batch-${index}.fixture.invalid/feed\n`,
    ).join('');
  await page.route(provider, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: playlist }),
  );
  await page.route(second, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '#EXTM3U\n' }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await configureControlledDiscoveryProviders(page);
  // The transport/profile remains stable for the entire scan job.
  await page.evaluate(
    async ({ rejectStale, holdRevisionRead, manifestMode, windowMode, sizeRefusal }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tmg-tv', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Fixture store unavailable'));
      });
      const revisions = await new Promise<string[]>((resolve, reject) => {
        const tx = database.transaction('records', 'readonly');
        const store = tx.objectStore('records');
        const reads = [
          'catalogRevision',
          'healthRevision',
          'scanCheckpointRevision',
          'preferences',
        ].map((key) => store.get(key));
        tx.oncomplete = () => resolve(reads.map((read) => String(read.result ?? '0')));
        tx.onabort = () => reject(new Error('Fixture revision read unavailable'));
      });
      database.close();
      const state = {
        calls: [] as string[],
        packets: [] as unknown[],
        catalogRevision: revisions[0]!,
        healthRevision: revisions[1]!,
        checkpointRevision: revisions[2]!,
        releaseAck: undefined as (() => void) | undefined,
        probeReleases: [] as (() => void)[],
        inspections: 0,
        autoProbes: false,
        workerMessages: [] as { kind: string; hasCatalog: boolean; candidates: number }[],
        actorWorker: undefined as Worker | undefined,
        actorErrors: [] as string[],
        sizeRefusalSent: false,
        checkpoint: null as string | null,
        preferences: revisions[3],
        releaseRevisions: undefined as (() => void) | undefined,
        manifestSeed: null as string | null,
        manifestHeader: null as {
          schemaVersion: 1;
          manifestId: string;
          manifestRevision: string;
          jobId: string;
          reviewDigest: string;
          candidateCount: number;
          nextIndex: number;
        } | null,
        manifestPages: [] as { candidateIndex: number; urls: string[] }[][],
        fixtureRelease: undefined as (() => void) | undefined,
        manifestSealed: false,
        initialCheckpointRevision: revisions[2]!,
      };
      Reflect.set(window, '__BATCH_SEAM__', state);
      const OriginalWorker = window.Worker;
      window.Worker = new Proxy(OriginalWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          if (String(args[0]).includes('selection-session-worker')) {
            state.actorWorker = worker;
            worker.addEventListener('error', (event) => state.actorErrors.push(event.message));
            const post = worker.postMessage.bind(worker);
            worker.postMessage = (message) => {
              if (
                sizeRefusal &&
                message.kind === 'prepare-window' &&
                message.input.chunks.length > 1 &&
                !state.sizeRefusalSent
              ) {
                state.sizeRefusalSent = true;
                queueMicrotask(() =>
                  worker.dispatchEvent(
                    new MessageEvent('message', {
                      data: {
                        requestId: message.requestId,
                        ok: false,
                        code: 'selection-window-size',
                      },
                    }),
                  ),
                );
                return;
              }
              state.workerMessages.push({
                kind: message.kind,
                hasCatalog: !!message.bootstrap?.catalog || !!message.input?.catalog,
                candidates:
                  message.input?.selection?.sources.reduce(
                    (n: number, source: { candidates: unknown[] }) => n + source.candidates.length,
                    0,
                  ) ??
                  message.input?.chunks?.reduce(
                    (sum: number, chunk: { selection: { sources: { candidates: unknown[] }[] } }) =>
                      sum +
                      chunk.selection.sources.reduce(
                        (n, source) => n + source.candidates.length,
                        0,
                      ),
                    0,
                  ) ??
                  0,
              });
              post(message);
            };
          }
          return worker;
        },
      });
      Reflect.set(window, 'isTauri', true);
      Reflect.set(window, '__TAURI_INTERNALS__', {
        invoke: async (
          command: string,
          args?: {
            batch?: unknown;
            window?: unknown;
            url?: string;
            contents?: string;
            checkpoint?: string;
            requestId?: string;
            request?: {
              checkpoint?: string;
              entries?: { candidateIndex: number; urls: string[] }[];
              expectedManifestRevision?: string;
              expectedCatalogRevision?: string;
              expectedCheckpointRevision?: string;
            };
          },
        ) => {
          state.calls.push(command);
          if (command === 'inspect_source_directory') {
            const response = await fetch(args!.url!);
            return { httpStatus: response.status, json: await response.json() };
          }
          if (command === 'fetch_playlist') return (await fetch(args!.url!)).text();
          if (command === 'inspect_source')
            return {
              kind: 'catalog',
              mime: 'text/plain',
              text: await (await fetch(args!.url!)).text(),
            };
          if (command === 'inspect_media_resources') {
            state.inspections++;
            if (!state.autoProbes)
              await new Promise<void>((resolve) => state.probeReleases.push(resolve));
            return {
              requestId: args!.requestId,
              status: 'resources-responded',
              reasonCode: 'resources-responded',
              checkedResources: 1,
            };
          }
          if (command === 'scan_resume_capabilities') return { schemaVersion: 1, boundedResume: 0 };
          if (manifestMode && command === 'scan_checkpoint_capabilities')
            return { schemaVersion: 1, advance: 1, packedReference: 3 };
          if (manifestMode && command === 'scan_candidate_manifest_capabilities')
            return { schemaVersion: 1, candidateManifest: 1 };
          if (manifestMode && command === 'begin_scan_candidate_manifest') {
            const seed = JSON.parse(args!.request!.checkpoint!);
            if (
              seed.schemaVersion !== 3 ||
              args!.request!.expectedCatalogRevision !== state.catalogRevision ||
              args!.request!.expectedCheckpointRevision !== state.checkpointRevision
            )
              throw 'fixture-manifest-cas-refused';
            state.manifestSeed = args!.request!.checkpoint!;
            state.manifestHeader = {
              schemaVersion: 1,
              manifestId: 'fixture-manifest',
              manifestRevision: '0',
              jobId: seed.jobId,
              reviewDigest: seed.reviewDigest,
              candidateCount: seed.review.candidates.length,
              nextIndex: 0,
            };
            return { ...state.manifestHeader };
          }
          if (manifestMode && command === 'append_scan_candidate_manifest_page') {
            const request = args!.request!,
              header = state.manifestHeader!,
              entries = request.entries!;
            if (
              entries.length < 1 ||
              entries.length > 64 ||
              JSON.stringify(request).length > 1048576 ||
              request.expectedManifestRevision !== header.manifestRevision ||
              entries.some((entry, index) => entry.candidateIndex !== header.nextIndex + index)
            )
              throw 'fixture-manifest-page-refused';
            state.manifestPages.push(structuredClone(entries));
            header.nextIndex += entries.length;
            header.manifestRevision = String(BigInt(header.manifestRevision) + 1n);
            return { ...header };
          }
          if (manifestMode && command === 'seal_scan_candidate_manifest') {
            const header = state.manifestHeader!;
            if (
              header.nextIndex !== header.candidateCount ||
              args!.request!.expectedManifestRevision !== header.manifestRevision
            )
              throw 'fixture-manifest-seal-refused';
            await new Promise<void>((resolve) => (state.fixtureRelease = resolve));
            if (manifestMode === 'fail') throw 'fixture-manifest-seal-refused';
            state.checkpoint = state.manifestSeed;
            state.manifestSealed = true;
            state.checkpointRevision = String(BigInt(state.checkpointRevision) + 1n);
            return {
              committed: true,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
              checkpointRevision: state.checkpointRevision,
            };
          }
          if (manifestMode && command === 'advance_scan_checkpoint') {
            state.checkpointRevision = String(BigInt(state.checkpointRevision) + 1n);
            return {
              committed: true,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
              checkpointRevision: state.checkpointRevision,
            };
          }
          if (command === 'read_scan_checkpoint')
            return {
              checkpoint: state.checkpoint,
              checkpointStatus: state.checkpoint === null ? 'absent' : 'valid',
              jobId: state.checkpoint === null ? null : JSON.parse(state.checkpoint).jobId,
              checkpointRevision: state.checkpointRevision,
              catalogRevision: state.catalogRevision,
            };
          if (command === 'write_record_receipt') {
            state.preferences = args!.contents!;
            return {
              committed: true,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
            };
          }
          if (command === 'scan_batch_capabilities') return { schemaVersion: 1, scanBatch: 1 };
          if (command === 'scan_window_capabilities')
            if (windowMode) return { schemaVersion: 1, scanWindow: 1, maxChunks: 4 };
            else throw 'Command scan_window_capabilities not found';
          if (command === 'read_scan_commit_revisions') {
            if (holdRevisionRead)
              await new Promise<void>((resolve) => (state.releaseRevisions = resolve));
            return {
              schemaVersion: 1,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
            };
          }
          if (command === 'commit_scan_batch' || command === 'commit_scan_window') {
            state.packets.push(
              structuredClone(command === 'commit_scan_window' ? args?.window : args?.batch),
            );
            if (rejectStale) throw 'health-revision-stale';
            await new Promise<void>((resolve) => (state.releaseAck = resolve));
            state.catalogRevision = String(BigInt(state.catalogRevision) + 1n);
            state.healthRevision = String(BigInt(state.healthRevision) + 1n);
            const packet = command === 'commit_scan_window' ? args?.window : args?.batch;
            const mutation = (
              packet as
                | {
                    scanCheckpoint?: {
                      kind: string;
                      checkpoint: string;
                      observations: (unknown[] | { channelId: string })[];
                      publishedKeys: string[];
                    };
                  }
                | undefined
            )?.scanCheckpoint;
            if (mutation) {
              if (mutation.kind === 'save') {
                const stored = JSON.parse(mutation.checkpoint);
                stored.catalogRevision = state.catalogRevision;
                state.checkpoint = JSON.stringify(stored);
              } else if (mutation.kind === 'advance' && state.checkpoint) {
                const stored = JSON.parse(state.checkpoint);
                if (stored.schemaVersion === 3) {
                  const observations = new Map<number, unknown[]>(
                    stored.observations.map((o: unknown[]) => [o[0] as number, o]),
                  );
                  for (const o of mutation.observations) {
                    if (!Array.isArray(o) || typeof o[0] !== 'number')
                      throw 'fixture-checkpoint-observation-invalid';
                    observations.set(o[0], o);
                  }
                  stored.observations = [...observations.values()].sort(
                    (a, b) => (a[0] as number) - (b[0] as number),
                  );
                  stored.publishedIndices = [
                    ...new Set<number>([
                      ...stored.publishedIndices,
                      ...mutation.publishedKeys.map(Number),
                    ]),
                  ].sort((a, b) => a - b);
                } else {
                  const observations = new Map<string, unknown>(
                    stored.observations.map((o: { channelId: string }) => [o.channelId, o]),
                  );
                  for (const o of mutation.observations) {
                    if (Array.isArray(o)) throw 'fixture-checkpoint-observation-invalid';
                    observations.set(o.channelId, o);
                  }
                  stored.observations = [...observations.values()];
                  stored.publishedKeys = [
                    ...new Set([...stored.publishedKeys, ...mutation.publishedKeys]),
                  ];
                }
                stored.catalogRevision = state.catalogRevision;
                state.checkpoint = JSON.stringify(stored);
              } else throw 'fixture-checkpoint-mutation-unavailable';
              state.checkpointRevision = String(BigInt(state.checkpointRevision) + 1n);
            }
            return {
              committed: true,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
              ...(mutation ? { checkpointRevision: state.checkpointRevision } : {}),
            };
          }
          if (command === 'write_scan_checkpoint') {
            state.checkpoint = args!.checkpoint!;
            state.checkpointRevision = String(BigInt(state.checkpointRevision) + 1n);
            return {
              committed: true,
              catalogRevision: state.catalogRevision,
              healthRevision: state.healthRevision,
              checkpointRevision: state.checkpointRevision,
            };
          }
          if (command === 'cancel_playlist') return;
          // Optional guide/diagnostic reads remain explicitly unavailable here.
          throw 'fixture-command-unavailable';
        },
      });
    },
    { rejectStale: stale, holdRevisionRead: holdRevisions, manifestMode, windowMode, sizeRefusal },
  );
  await page.locator('#search-programs').click();
  if (manifestMode) {
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, '__BATCH_SEAM__').fixtureRelease))
      .toBe('function');
    return;
  }
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').inspections))
    .toBe(16)
    .catch(async (error) => {
      const detail = await page.evaluate(() => {
        const state = Reflect.get(window, '__BATCH_SEAM__');
        return {
          calls: state.calls,
          workerMessages: state.workerMessages,
          actorErrors: state.actorErrors,
        };
      });
      throw new Error(`${error.message}\n${JSON.stringify(detail)}`);
    });
  await page.evaluate(() => {
    const state = Reflect.get(window, '__BATCH_SEAM__');
    state.autoProbes = true;
    state.probeReleases.splice(0).forEach((release: () => void) => release());
  });
}

test('negotiated main scan window publishes first64 then256 with one final ACK each', async ({
  page,
}) => {
  await prepare(page, false, false, 320, undefined, true);
  for (const [number, count] of [
    [1, 64],
    [2, 256],
  ]) {
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
      .toBe(number);
    const packet = await page.evaluate(
      (index) => Reflect.get(window, '__BATCH_SEAM__').packets[index],
      number - 1,
    );
    expect(
      packet.chunks.flatMap(
        (chunk: { catalogPatch: { channels: unknown[] } }) => chunk.catalogPatch.channels,
      ),
    ).toHaveLength(count);
    expect(
      packet.chunks.every(
        (chunk: { catalogPatch: { channels: unknown[] }; incomingHealth: unknown[] }) =>
          chunk.catalogPatch.channels.length <= 64 && chunk.incomingHealth.length <= 64,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').published)).toBe(
      number === 1 ? 0 : 64,
    );
    await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  }
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  await expect(page.locator('#channel-count')).toContainText('320 channels');
  const state = await page.evaluate(() => {
    const value = Reflect.get(window, '__BATCH_SEAM__');
    return { calls: value.calls, messages: value.workerMessages };
  });
  expect(state.calls.filter((command: string) => command === 'commit_scan_window')).toHaveLength(2);
  expect(state.calls).not.toContain('commit_scan_batch');
  expect(state.calls).not.toContain('write_record_pair');
  expect(
    state.messages.filter((message: { kind: string }) => message.kind === 'bootstrap'),
  ).toHaveLength(1);
  expect(
    state.messages.filter((message: { kind: string }) => message.kind === 'ack-window'),
  ).toHaveLength(2);
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('known worker size refusal releases only uncommitted checkpoint and explicit Continue uses64 without re-probing', async ({
  page,
}) => {
  await prepare(page, false, false, 320, undefined, true, true);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
    .toBe(1);
  await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').phase))
    .toBe('failed');
  const before = await page.evaluate(() => ({
    probes: Reflect.get(window, '__BATCH_SEAM__').inspections,
    packets: Reflect.get(window, '__BATCH_SEAM__').packets.length,
    published: Reflect.get(window, '__GENX_SCAN__').published,
  }));
  expect(before).toEqual({ probes: 320, packets: 1, published: 64 });
  await page.locator('#inline-scan-continue').click();
  for (let packetIndex = 1; packetIndex <= 4; packetIndex++) {
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
      .toBe(packetIndex + 1);
    const count = await page.evaluate(
      (index) =>
        Reflect.get(window, '__BATCH_SEAM__').packets[index].chunks.reduce(
          (sum: number, chunk: { catalogPatch: { channels: unknown[] } }) =>
            sum + chunk.catalogPatch.channels.length,
          0,
        ),
      packetIndex,
    );
    expect(count).toBe(64);
    await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  }
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  expect(await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').inspections)).toBe(320);
  expect(await page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').published)).toBe(320);
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('native progressive publication bootstraps one actor and sends bounded deltas for later batches', async ({
  page,
}) => {
  await prepare(page, false, false, 80);
  for (let i = 1; i <= 2; i++) {
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
      .toBe(i);
    await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  }
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  await expect(page.locator('#channel-count')).toContainText('80 channels');
  const messages = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').workerMessages);
  expect(messages.filter((m: { kind: string }) => m.kind === 'bootstrap')).toHaveLength(1);
  expect(messages.filter((m: { kind: string }) => m.kind === 'prepare')).toHaveLength(2);
  expect(messages.filter((m: { kind: string }) => m.kind === 'ack')).toHaveLength(2);
  expect(messages.filter((m: { kind: string }) => m.kind === 'dispose')).toHaveLength(1);
  expect(messages.filter((m: { hasCatalog: boolean }) => m.hasCatalog)).toHaveLength(1);
  expect(messages.every((m: { candidates: number }) => m.candidates <= 64)).toBe(true);
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('actor failure after native dispatch preserves the actual durable save and published progress', async ({
  page,
}) => {
  await prepare(page, false);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
    .toBe(1);
  await page.evaluate(() => {
    const state = Reflect.get(window, '__BATCH_SEAM__');
    state.actorWorker.dispatchEvent(new Event('error'));
    state.releaseAck();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  await expect(page.locator('#channel-count')).toContainText('16 channels');
  const scan = await page.evaluate(() => Reflect.get(window, '__GENX_SCAN__'));
  expect(scan.published).toBe(16);
  expect(scan.phase).toBe('completed');
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('native batch main path transfers changes only and publishes its mirror after durable ACK', async ({
  page,
}) => {
  await prepare(page, false);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
    .toBe(1);
  await expect(page.locator('.channel')).toHaveCount(0);
  const packet = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets[0]);
  expect(packet.catalogPatch.channels).toHaveLength(16);
  expect(packet.incomingHealth).toHaveLength(16);
  expect(packet.authorizedSources).toHaveLength(1);
  for (const key of ['catalog', 'catalogText', 'healthText', 'previousHealth', 'preferencesText'])
    expect(packet).not.toHaveProperty(key);
  await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  await expect(page.locator('#channel-count')).toContainText('16 channels');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  const calls = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').calls);
  expect(calls.filter((command: string) => command === 'commit_scan_batch')).toHaveLength(1);
  expect(calls).not.toContain('read_scan_health');
  expect(calls).not.toContain('write_record_pair');
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('native batch CAS refusal retains the mirror and never retries through the legacy writer', async ({
  page,
}) => {
  await prepare(page, true);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').phase))
    .toBe('failed');
  await expect(page.locator('.channel')).toHaveCount(0);
  const calls = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').calls);
  expect(calls.filter((command: string) => command === 'commit_scan_batch')).toHaveLength(1);
  expect(calls).not.toContain('read_scan_health');
  expect(calls).not.toContain('write_record_pair');
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('acknowledged mute edit during scan preparation survives the atomic channel save', async ({
  page,
}) => {
  await prepare(page, false, true);
  await expect
    .poll(() => page.evaluate(() => !!Reflect.get(window, '__BATCH_SEAM__').releaseRevisions))
    .toBe(true);
  await page.locator('#mute-button').click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(Reflect.get(window, '__BATCH_SEAM__').preferences).muted),
    )
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseRevisions());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets.length))
    .toBe(1);
  const packet = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').packets[0]);
  // Release even when this assertion fails, so the admitted save settles.
  await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').releaseAck());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
    .toBe(false);
  expect(packet.nextPreferences.muted).toBe(true);
  await expect(page.locator('#mute-button')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => Reflect.set(window, 'isTauri', false));
});

test('initial manifest seal ACK gates probes and Stop joins their actual transport work', async ({
  page,
}, testInfo) => {
  await prepare(page, false, false, 80, 'held');
  try {
    const staged = await page.evaluate(() => {
      const state = Reflect.get(window, '__BATCH_SEAM__');
      return {
        calls: state.calls,
        seed: JSON.parse(state.manifestSeed),
        pages: state.manifestPages,
        inspections: state.inspections,
        checkpoint: state.checkpoint,
        revision: state.checkpointRevision,
        initialRevision: state.initialCheckpointRevision,
      };
    });
    expect(staged.seed.schemaVersion).toBe(3);
    expect(staged.pages.map((rows: unknown[]) => rows.length)).toEqual([64, 16]);
    expect(
      staged.calls.filter((command: string) =>
        /^(begin|append|seal)_scan_candidate_manifest/.test(command),
      ),
    ).toEqual([
      'begin_scan_candidate_manifest',
      'append_scan_candidate_manifest_page',
      'append_scan_candidate_manifest_page',
      'seal_scan_candidate_manifest',
    ]);
    expect(staged.inspections).toBe(0);
    expect(staged.calls).not.toContain('inspect_media_resources');
    expect(staged.checkpoint).toBeNull();
    expect(staged.revision).toBe(staged.initialRevision);
    await expect(page.locator('.channel')).toHaveCount(0);
    await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').fixtureRelease());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').inspections))
      .toBe(16);
    await page.locator('#inline-scan-stop').click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Reflect.get(window, '__BATCH_SEAM__').calls.includes('cancel_playlist'),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').manifestSealed)).toBe(
      true,
    );
    await page.evaluate(() =>
      Reflect.get(window, '__BATCH_SEAM__')
        .probeReleases.splice(0)
        .forEach((release: () => void) => release()),
    );
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
      .toBe(false);
    const terminal = await page.evaluate(() => {
      const state = Reflect.get(window, '__BATCH_SEAM__');
      return {
        calls: state.calls,
        inspections: state.inspections,
        packets: state.packets.length,
        checkpoint: state.checkpoint !== null,
      };
    });
    expect(terminal.inspections).toBe(16);
    expect(terminal.packets).toBe(0);
    expect(terminal.checkpoint).toBe(true);
    expect(terminal.calls.indexOf('seal_scan_candidate_manifest')).toBeLessThan(
      terminal.calls.indexOf('inspect_media_resources'),
    );
    await testInfo.attach('manifest-main-order', {
      body: JSON.stringify(
        {
          scope: 'Mock native transport ordering only; no SQLite/Keystore/decoder proof',
          terminal,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await page.evaluate(() => {
      const state = Reflect.get(window, '__BATCH_SEAM__');
      state.fixtureRelease?.();
      state.probeReleases.splice(0).forEach((release: () => void) => release());
      Reflect.set(window, 'isTauri', false);
    });
  }
});
test('failed initial manifest seal preserves the prior checkpoint revision and catalog without probes', async ({
  page,
}) => {
  await prepare(page, false, false, 16, 'fail');
  try {
    const before = await page.evaluate(() => {
      const state = Reflect.get(window, '__BATCH_SEAM__');
      return {
        checkpoint: state.checkpoint,
        checkpointRevision: state.checkpointRevision,
        catalogRevision: state.catalogRevision,
      };
    });
    expect(await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').inspections)).toBe(0);
    await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').fixtureRelease());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').phase))
      .toBe('failed');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_SCAN__').busy))
      .toBe(false);
    const after = await page.evaluate(() => {
      const state = Reflect.get(window, '__BATCH_SEAM__');
      return {
        checkpoint: state.checkpoint,
        checkpointRevision: state.checkpointRevision,
        catalogRevision: state.catalogRevision,
      };
    });
    expect(after).toEqual(before);
    await expect(page.locator('.channel')).toHaveCount(0);
    const calls = await page.evaluate(() => Reflect.get(window, '__BATCH_SEAM__').calls);
    expect(calls).toContain('seal_scan_candidate_manifest');
    expect(calls).not.toContain('inspect_media_resources');
    expect(calls).not.toContain('commit_scan_batch');
    expect(calls).not.toContain('write_scan_checkpoint');
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, '__BATCH_SEAM__').fixtureRelease?.();
      Reflect.set(window, 'isTauri', false);
    });
  }
});
