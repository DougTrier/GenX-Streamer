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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { build, createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const started = performance.now();
const timing = (stage: string) =>
  process.stdout.write(
    `bounded-worker-timing: ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) })}\n`,
  );
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let fixtureDirectory: string | undefined;
let browserJoined = false;
let page: Page;
let workerPath: string;
const workerPaths: string[] = [];
const errors: string[] = [];

// The fixture setup and its joined disposal each retain the original30s budget.
// The actual256-candidate episode below still has its independent12s deadline.
beforeAll(async () => {
  timing('bundle-start');
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'bounded-proof-entry',
        resolveId: (id) => (id === 'virtual:bounded-proof' ? '\0bounded-proof' : null),
        load: (id) =>
          id === '\0bounded-proof'
            ? `export {createBoundedScanResumeService} from '${process.cwd().replaceAll('\\', '/')}/src/application/bounded-scan-resume-service.ts'; export {createHealthObservation} from '${process.cwd().replaceAll('\\', '/')}/src/discovery/health.ts';`
            : null,
      },
    ],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        input: 'virtual:bounded-proof',
        output: {
          entryFileNames: 'proof.js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
  timing('bundle-done');
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing worker fixture output');
  const assets = new Map(
    output.output.map((item) => [
      '/' + item.fileName,
      item.type === 'chunk' ? item.code : item.source,
    ]),
  );
  const workerAsset = output.output.find((item) =>
    item.fileName.includes('bounded-scan-resume-worker'),
  );
  if (!workerAsset || !assets.has('/proof.js')) throw new Error('Missing production worker assets');
  timing('server-create-start');
  workerPath = '/' + workerAsset.fileName;
  server = await createServer({
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'bounded-worker-proof',
        configureServer(instance) {
          instance.middlewares.use((request, response, next) => {
            const asset = assets.get(request.url?.split('?')[0] ?? '');
            if (asset === undefined) return next();
            response.setHeader('Content-Type', 'text/javascript');
            response.end(asset);
          });
          instance.middlewares.use('/__bounded-proof', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><title>Owned Worker proof</title>');
          });
        },
      },
    ],
  });

  timing('server-create-done');
  await server.listen();
  timing('server-listening');
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing ephemeral address');
  // Explicit fixture-only profile is retained as evidence. Automatic profile
  // deletion must not consume the browser process ownership deadline.
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'genx-bounded-worker-'));
  process.stdout.write(
    `bounded-worker-profile: ${JSON.stringify({ id: basename(fixtureDirectory), retained: true })}\n`,
  );
  context = await chromium.launchPersistentContext(join(fixtureDirectory, 'profile'), {
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  browser = context.browser() ?? undefined;
  if (!browser) throw new Error('Missing owned browser');
  timing('browser-launched');
  browser.on('disconnected', () => timing('browser-disconnected'));
  page = context.pages()[0] ?? (await context.newPage());
  page.on('worker', (worker) => {
    if (workerPaths.length < 2) workerPaths.push(new URL(worker.url()).pathname);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      process.stdout.write(
        `bounded-worker: HTTP ${response.status()} ${new URL(response.url()).pathname}\n`,
      );
  });
  page.on('pageerror', (error) => {
    if (errors.length < 4) errors.push(error.message.slice(0, 300));
  });
  page.on('console', (message) => {
    if (message.type() === 'log' && message.text().startsWith('bounded-worker:'))
      process.stdout.write(message.text() + '\n');
    if (message.type() === 'error' && errors.length < 4) errors.push(message.text().slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${address.port}/__bounded-proof`);
  timing('page-ready');
}, 30000);

it('actual module Worker prepares once and joins a one-origin256candidate episode', async () => {
  try {
    const work = page.evaluate(async () => {
      // Vite serves only these modules: no application bootstrap or native invocation.
      const load = new Function('path', 'return import(path)') as <T>(path: string) => Promise<T>;
      const { createBoundedScanResumeService, createHealthObservation } = await load<
        typeof import('../../src/application/bounded-scan-resume-service') &
          typeof import('../../src/discovery/health')
      >('/proof.js');
      const counts = { total: 256, checked: 0, responded: 0, published: 0 };
      const revisions = { catalogRevision: '1', healthRevision: '0', checkpointRevision: '1' };
      let admitted = 0,
        taken = 0,
        probed = 0,
        closed = 0,
        maximumCommit = 0,
        cursor = 0;
      const reservations = new Map<string, number>();
      const service = createBoundedScanResumeService({
        async admit() {
          admitted++;
          return {
            schemaVersion: 1,
            planId: 'plan',
            jobId: 'job',
            reviewDigest: 'a'.repeat(64),
            sessionRevision: 'session',
            query: 'News',
            createdAtMs: Date.now(),
            platform: 'native',
            observerProfile: 'native-v1',
            budgetMs: 20000,
            sourcePolicies: [{ sourceId: 'source', fingerprint: 'captured', allowHttp: false }],
            counts: { ...counts },
            revisions: { ...revisions },
          };
        },
        async take(_id: string, request: { blockedOrigins: readonly string[] }) {
          taken++;
          const rows = [];
          if (cursor < counts.total && !request.blockedOrigins.includes('only')) {
            const index = cursor++;
            reservations.set(String(index), index);
            rows.push({
              candidateIndex: index,
              reservationId: String(index),
              originToken: 'only',
              work: 'probe' as const,
              candidate: {
                key: `c-${index}`,
                sourceId: 'source',
                sourceFingerprint: 'captured',
                sessionRevision: 'session',
                channel: {
                  sourceId: 'source',
                  name: `Channel ${index}`,
                  category: 'News',
                  urls: [`https://fixture.invalid/${index}`],
                },
              },
            });
          }
          return { schemaVersion: 1, planId: 'plan', rows, exhausted: cursor === counts.total };
        },
        async probe(
          candidate: { key: string; sourceId: string; sourceFingerprint: string },
          _signal: AbortSignal,
          _budget: number,
          policy: { allowHttp: boolean },
        ) {
          if (policy.allowHttp !== false) throw new Error('Unexpected grant');
          probed++;
          return createHealthObservation(
            {
              channelId: candidate.key,
              sourceId: candidate.sourceId,
              fingerprint: candidate.sourceFingerprint,
            },
            { platform: 'native', observedAt: Date.now() },
            { kind: 'recognized-media-response' },
          );
        },
        async commit(
          _id: string,
          request: import('../../src/application/bounded-scan-resume').BoundedScanCommit,
        ) {
          if (JSON.stringify(request.expectedRevisions) !== JSON.stringify(revisions))
            throw new Error('Stale revision');
          maximumCommit = Math.max(maximumCommit, request.observations.length);
          counts.checked += request.observations.length;
          counts.responded += request.observations.length;
          counts.published += request.publicationIndices.length;
          for (const key of Object.keys(revisions) as (keyof typeof revisions)[])
            revisions[key] = String(BigInt(revisions[key]) + 1n);
          return {
            committed: true as const,
            planId: 'plan',
            ...revisions,
            counts: { ...counts },
            acknowledgedIndices: request.observations.map((row) => row.candidateIndex),
            publicationIndices: [...request.publicationIndices],
          };
        },
        async defer() {
          throw new Error('Unexpected deferral');
        },
        async release(_id: string, ids: string[]) {
          for (const id of ids) reservations.delete(id);
        },
        async close() {
          closed++;
          reservations.clear();
        },
      });
      Reflect.set(window, '__boundedState', () => ({
        admitted,
        taken,
        probed,
        closed,
        snapshot: service.snapshot(),
      }));
      try {
        const header = await service.prepare();
        const before = { admitted, taken, probed, query: header.query };
        await service.start();
        const final = service.snapshot();
        await service.dispose();
        return {
          before,
          final,
          admitted,
          probed,
          closed,
          maximumCommit,
          resident: reservations.size,
          stopped: service.snapshot().workerStopped,
        };
      } finally {
        await service.dispose();
      }
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          void page
            .evaluate(() => Reflect.get(window, '__boundedState')?.())
            .then((state) => reject(new Error(JSON.stringify({ state, errors }))), reject);
        }, 12000);
      }),
    ]).finally(() => clearTimeout(deadline));
    timing('episode-done');
    expect(result.before).toEqual({ admitted: 1, taken: 0, probed: 0, query: 'News' });
    expect(result.final).toMatchObject({
      phase: 'completed',
      counts: { total: 256, checked: 256, responded: 256, published: 256 },
      ownedReservations: 0,
    });
    expect(result.final.maxOwnedReservations).toBeLessThanOrEqual(80);
    expect(result.final.maxActiveCallbacks).toBeLessThanOrEqual(19);
    expect(result).toMatchObject({
      admitted: 1,
      probed: 256,
      closed: 1,
      maximumCommit: 64,
      resident: 0,
      stopped: true,
    });
    expect(workerPaths).toEqual([workerPath]);
  } catch (error) {
    process.stdout.write(`bounded-worker: failure ${String(error)}\n`);
    throw error;
  }
}, 30000);

afterAll(async () => {
  try {
    timing('page-close-start');
    await page?.close();
    timing('page-close-done');
  } finally {
    try {
      timing('browser-close-start');
      try {
        await context?.close();
      } finally {
        await browser?.close();
        expect(browser?.isConnected() ?? false).toBe(false);
        browserJoined = true;
        timing('browser-close-done');
      }
    } finally {
      await server?.close();
      timing('server-close-done');
      if (fixtureDirectory)
        await writeFile(
          join(fixtureDirectory, 'fixture-receipt.json'),
          JSON.stringify({
            schemaVersion: 1,
            fixture: 'bounded-module-worker',
            retainedProfile: true,
            browserJoined,
            reason:
              'Fixture-only profile cleanup is separate from process ownership; no user data.',
          }) + '\n',
        );
    }
  }
}, 30000);
