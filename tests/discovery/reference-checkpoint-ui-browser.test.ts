import { scanConfiguredSources } from '../../src/discovery/scan';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import { checkpointFixture, checkpointProviders } from './helpers/scan-checkpoint';
import { defaultPreferences } from '../../src/preferences';
import { captureStoredScanCheckpoint } from '../../src/application/scan-checkpoint-capture';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let browser: Browser, outputDir: string;
beforeAll(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'genx-reference-ui-'));
  const entry = join(outputDir, 'entry.ts');
  const source = (p: string) => JSON.stringify(resolve(p).replaceAll('\\', '/'));
  await writeFile(
    entry,
    `export {mountSourceScan} from ${source('src/ui/source-scan.ts')}; export {scanConfiguredSources} from ${source('src/discovery/scan.ts')}; export {parseStoredCapture,restoreReferencedCapture} from ${source('src/application/scan-checkpoint-capture-service.ts')}; export {readIndexedDbScanCheckpoint,writeIndexedDbRecordPair} from ${source('src/platform/record-transaction.ts')};`,
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: join(outputDir, 'dist'),
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ['es'], fileName: 'fixture' },
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
}, 30000);
afterAll(async () => {
  await browser?.close();
  if (outputDir.startsWith(join(tmpdir(), 'genx-reference-ui-')))
    await rm(outputDir, { recursive: true, force: true });
});
it.each([false, true])(
  'cold reference UI reacquires exact source and refuses changed upstream=%s',
  async (changed) => {
    const checkpoint = await checkpointFixture();
    checkpoint.createdAtMs = Date.now();
    const original = checkpoint.review.candidates[0]!;
    checkpoint.review.candidates = Array.from({ length: 20 }, (_, i) => ({
      ...original,
      key: 'candidate-' + i,
      channel: {
        ...original.channel,
        name: 'Channel ' + i,
        urls: ['https://public-' + i + '.fixture.invalid/live/test-user/test-pass/' + i + '.ts'],
      },
    }));
    const channels = checkpoint.review.candidates.map((c) => c.channel);
    checkpoint.review = await scanConfiguredSources(
      [{ source: checkpoint.sourceDefinitions[0]!.source, fingerprint: 'captured-fingerprint' }],
      async () => ({ channels, warnings: [] }),
      { sessionRevision: 'runtime-capture', query: '', signal: new AbortController().signal },
    );
    checkpoint.review.counts.inspected = checkpoint.review.counts.matched = 20;
    checkpoint.review.sources[0]!.inspected = checkpoint.review.sources[0]!.matched = 20;
    checkpoint.observations = checkpoint.review.candidates.slice(0, 16).map((c) => ({
      ...checkpoint.observations[0]!,
      channelId: c.key,
      observedAt: checkpoint.createdAtMs,
    }));
    checkpoint.publishedKeys = checkpoint.review.candidates.slice(0, 16).map((c) => c.key);
    const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = checkpoint;
    const wire = await captureStoredScanCheckpoint({
      ...state,
      sources: sourceDefinitions.map((d) => d.source),
      providers: checkpointProviders,
    });
    expect(wire).not.toBeNull();
    expect(wire).not.toContain('test-pass');
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.route('https://reference.fixture.invalid/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<main id="scan"></main><script type="module">import * as ui from "/fixture.js";window.ReferenceUI=ui;</script>',
          });
        if (!/^\/(?:assets\/)?[a-zA-Z0-9._-]+\.js$/u.test(path)) return route.abort();
        await route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(join(outputDir, 'dist', path.slice(1))),
        });
      });
      await page.goto('https://reference.fixture.invalid/');
      await page.waitForFunction(() => Reflect.has(window, 'ReferenceUI'));
      await page.evaluate(
        async ({ wire, review, changed, providers, preferences }) => {
          const ui = Reflect.get(window, 'ReferenceUI');
          const state = {
            collects: 0,
            probes: [] as string[],
            commits: [] as string[][],
            revision: '0',
          };
          Reflect.set(window, 'evidence', state);
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('cold-reference', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('records');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const prefs = { ...preferences, reviewedChannelProviders: providers };
          const parsedBefore = await ui.parseStoredCapture(wire, new AbortController().signal);
          const catalog = {
            schemaVersion: 1,
            sources: parsedBefore.sourceDefinitions.map((d: { source: unknown }) => d.source),
            channels: review.candidates.slice(0, 16).map((c: { channel: unknown }, i: number) => ({
              ...(c.channel as object),
              id: 'saved-' + i,
            })),
          };
          await ui.writeIndexedDbRecordPair(db, {
            catalog: JSON.stringify(catalog),
            preferences: JSON.stringify(prefs),
            expectedCatalogRevision: '0',
            expectedCheckpointRevision: '0',
            scanCheckpoint: { kind: 'save', checkpoint: wire },
          });
          const saved = await ui.readIndexedDbScanCheckpoint(db);
          state.revision = saved.catalogRevision;
          const parsed = await ui.parseStoredCapture(
            saved.checkpoint,
            new AbortController().signal,
          );
          const scope = parsed.sourceDefinitions.map((d: { source: { id: string } }) => ({
            source: d.source,
            fingerprint: parsed.review.sources.find(
              (s: { sourceId: string }) => s.sourceId === d.source.id,
            ).fingerprint,
          }));
          const collect = async () => {
            state.collects++;
            return {
              channels: review.candidates.map(
                (c: { channel: { name: string; urls: string[] } }) => ({
                  ...c.channel,
                  urls: c.channel.urls.map((url) => (changed ? url + 'changed' : url)),
                }),
              ),
              warnings: [],
            };
          };
          const host = {
            revision: () => state.revision,
            capture: () => ({ revision: state.revision, sources: scope }),
            collect,
            platform: () => parsed.platform,
            observerProfile: () => parsed.observerProfile,
            now: () => Date.now(),
            probe: async (c: { key: string; sourceId: string; sourceFingerprint: string }) => {
              state.probes.push(c.key);
              return {
                channelId: c.key,
                sourceId: c.sourceId,
                fingerprint: c.sourceFingerprint,
                platform: parsed.platform,
                observedAt: Date.now(),
                verdict: 'Reachable',
                evidence: { kind: 'recognized-media-response' },
              };
            },
            commit: async (staged: { sources: { candidates: { key: string }[] }[] }) => {
              state.commits.push(staged.sources.flatMap((s) => s.candidates.map((c) => c.key)));
              state.revision = '1';
              return { committed: true, revision: '1' };
            },
            checkpoint: {
              load: async (signal: AbortSignal) => {
                try {
                  const fresh = await ui.scanConfiguredSources(scope, collect, {
                    sessionRevision: parsed.review.sessionRevision,
                    query: parsed.review.query,
                    signal,
                  });
                  const runtime = await ui.restoreReferencedCapture(parsed, fresh, signal);
                  return {
                    checkpointStatus: 'valid',
                    checkpoint: saved.checkpoint,
                    parsed: runtime,
                    jobId: parsed.jobId,
                    checkpointRevision: '1',
                    catalogRevision: saved.catalogRevision,
                  };
                } catch {
                  return {
                    checkpointStatus: 'invalid',
                    checkpoint: null,
                    jobId: parsed.jobId,
                    checkpointRevision: '1',
                    catalogRevision: saved.catalogRevision,
                  };
                }
              },
              prepare: async () => null,
              save: async () => ({ committed: true, checkpointRevision: '2' }),
              discard: async () => ({ committed: true, checkpointRevision: '2' }),
            },
          };
          Reflect.set(window, 'scan', ui.mountSourceScan(document.getElementById('scan'), host));
        },
        {
          wire: wire!,
          review: checkpoint.review,
          changed,
          providers: checkpointProviders,
          preferences: { ...defaultPreferences(), reviewedChannelProviders: checkpointProviders },
        },
      );
      const admission = await page.evaluate(() =>
        Reflect.get(window, 'scan').prepareAutomaticEntry(),
      );
      if (changed) {
        expect(admission).toBe('unavailable');
        expect(await page.evaluate(() => Reflect.get(window, 'evidence'))).toMatchObject({
          collects: 1,
          probes: [],
          commits: [],
        });
      } else {
        expect(admission).toBe('unfinished');
        expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
          checked: 16,
          published: 16,
          total: 20,
          busy: false,
        });
        await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
        await page.waitForFunction(
          () =>
            Reflect.get(window, 'evidence').probes.length === 4 &&
            !Reflect.get(window, 'scan').snapshot().busy,
        );
        const evidence = await page.evaluate(() => Reflect.get(window, 'evidence'));
        expect(evidence.collects).toBe(1);
        expect(evidence.probes).toHaveLength(4);
        expect(
          evidence.probes.every((key: string) => !checkpoint.publishedKeys.includes(key)),
        ).toBe(true);
        expect(new Set(evidence.probes).size).toBe(4);
        expect(evidence.commits).toHaveLength(1);
      }
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan')?.dispose?.());
      await page.close();
    }
  },
  15000,
);
