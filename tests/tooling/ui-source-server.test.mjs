import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import {
  prepareAndListen,
  sourceModuleUrls,
  sourceServerOptions,
} from '../../scripts/ui-source-server.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
test('HTTP readiness waits for actual compilation and import-graph settlement', async () => {
  const compiled = deferred(),
    idle = deferred(),
    events = [];
  const vite = {
    transformRequest: async (url) => {
      events.push(url);
      await compiled.promise;
      return { code: 'compiled' };
    },
    environments: { client: { waitForRequestsIdle: () => idle.promise } },
    close: async () => {
      events.push('closed');
    },
  };
  const listener = new EventEmitter();
  listener.listen = (_port, _host, callback) => {
    events.push('listening');
    callback();
  };
  const pending = prepareAndListen(vite, listener, [
    '/src/main.ts',
    '/src/catalog/parser-worker.ts?worker_file&type=module',
  ]);
  await Promise.resolve();
  assert.deepEqual(events, [
    '/src/main.ts',
    '/src/catalog/parser-worker.ts?worker_file&type=module',
  ]);
  compiled.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('listening'), false);
  idle.resolve();
  await pending;
  assert.equal(events.at(-1), 'listening');
});
test('failed/null module compilation closes Vite and never admits HTTP readiness', async () => {
  for (const result of [null, { code: undefined }]) {
    let closed = 0,
      listened = 0;
    const vite = {
      transformRequest: async () => result,
      environments: { client: { waitForRequestsIdle: async () => {} } },
      close: async () => {
        closed++;
      },
    };
    const listener = new EventEmitter();
    listener.listen = () => {
      listened++;
    };
    await assert.rejects(prepareAndListen(vite, listener, ['/src/main.ts']), /no compiled module/);
    assert.equal(closed, 1);
    assert.equal(listened, 0);
  }
});
test('owned source discovery includes every real worker query variant', async () => {
  const urls = await sourceModuleUrls(process.cwd());
  for (const worker of [
    'catalog/parser-worker.ts',
    'application/health-history-worker.ts',
    'data-transfer/transfer-worker.ts',
    'discovery/selection-worker.ts',
    'discovery/page-worker.ts',
    'application/decoded-health-worker.ts',
    'platform/record-transaction.ts',
  ])
    assert.ok(urls.includes('/src/' + worker + '?worker_file&type=module'), worker);
  assert.equal(new Set(urls).size, urls.length);
});
test('source discovery refuses oversized source trees instead of silently skipping modules', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'genx-source-preparation-'));
  try {
    const source = path.join(root, 'src');
    await mkdir(source);
    for (let index = 0; index < 513; index++)
      await writeFile(path.join(source, `module-${index}.ts`), 'export {};');
    await assert.rejects(sourceModuleUrls(root), /module bound exceeded/);
  } finally {
    // This exact directory was issued by mkdtemp above; no computed user path.
    await rm(root, { recursive: true });
  }
});

test('dependency discovery uses exact admitted source entries, not all repository HTML', () => {
  const options = sourceServerOptions('owned-root', [
    '/@vite/client',
    '/src/main.ts',
    '/src/catalog/parser-worker.ts',
    '/src/catalog/parser-worker.ts?worker_file&type=module',
    '/src/ui/style.css',
  ]);
  assert.deepEqual(options.optimizeDeps.entries, ['src/main.ts', 'src/catalog/parser-worker.ts']);
  assert.equal(options.optimizeDeps.noDiscovery, true);
  assert.deepEqual(options.optimizeDeps.include, [
    '@tauri-apps/api/app',
    '@tauri-apps/api/core',
    '@tauri-apps/api/event',
    'hls.js',
  ]);
  assert.equal(options.root, 'owned-root');
  assert.deepEqual(options.server, { middlewareMode: true, hmr: false, watch: null });
  assert.throws(
    () => sourceServerOptions('owned-root', ['/@vite/client']),
    /no dependency entries/,
  );
});

test('actual merged Vite configuration disables watchers while compiling every admitted module', async () => {
  const urls = await sourceModuleUrls(process.cwd());
  const vite = await createServer(sourceServerOptions(process.cwd(), urls));
  const listener = new EventEmitter();
  let listened = false;
  listener.listen = (_port, _host, callback) => {
    listened = true;
    callback();
  };
  try {
    assert.equal(vite.config.server.watch, null);
    assert.deepEqual(vite.watcher.getWatched(), {});
    await prepareAndListen(vite, listener, urls);
    assert.equal(listened, true);
    for (const url of urls) {
      const module = await vite.environments.client.moduleGraph.getModuleByUrl(url);
      assert.equal(typeof module?.transformResult?.code, 'string', url);
    }
    assert.deepEqual(vite.watcher.getWatched(), {});
  } finally {
    await vite.close();
  }
});

test('failed preparation drains other admitted transforms before closing', async () => {
  const held = deferred();
  let closed = false;
  let listened = false;
  const pending = prepareAndListen(
    {
      transformRequest: async (url) => {
        if (url === '/src/fail.ts') return null;
        await held.promise;
        return { code: 'compiled' };
      },
      environments: { client: { waitForRequestsIdle: async () => {} } },
      close: async () => {
        closed = true;
      },
    },
    {
      listen: () => {
        listened = true;
      },
    },
    ['/src/fail.ts', '/src/held.ts'],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(listened, false);
  held.resolve();
  await assert.rejects(pending, /no compiled module/);
  assert.equal(closed, true);
  assert.equal(listened, false);
});

test('compilation admits at most sixteen workers and compiles every URL exactly once', async () => {
  const urls = Array.from({ length: 41 }, (_, i) => `/src/module-${i}.ts`);
  const gates = new Map(urls.map((url) => [url, deferred()]));
  const admitted = [];
  let active = 0,
    peak = 0,
    listened = false;
  const pending = prepareAndListen(
    {
      transformRequest: async (url) => {
        admitted.push(url);
        active++;
        peak = Math.max(peak, active);
        await gates.get(url).promise;
        active--;
        return { code: 'compiled' };
      },
      environments: { client: { waitForRequestsIdle: async () => {} } },
      close: async () => {},
    },
    {
      listen: (_port, _host, callback) => {
        listened = true;
        callback();
      },
      once: () => {},
      removeListener: () => {},
    },
    urls,
  );
  assert.equal(admitted.length, 16);
  assert.equal(active, 16);
  assert.equal(listened, false);
  for (let offset = 0; offset < urls.length; offset += 16) {
    for (const url of urls.slice(offset, offset + 16)) gates.get(url).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(active <= 16);
  }
  await pending;
  assert.equal(peak, 16);
  assert.equal(active, 0);
  assert.equal(listened, true);
  assert.deepEqual(admitted, urls);
  assert.equal(new Set(admitted).size, urls.length);
});

test('a failed worker stops further admission and joins all fifteen accepted siblings', async () => {
  const held = deferred();
  const urls = Array.from({ length: 35 }, (_, i) => `/src/module-${i}.ts`);
  const admitted = [];
  let settled = 0,
    closed = false,
    idle = false;
  const pending = prepareAndListen(
    {
      transformRequest: async (url) => {
        admitted.push(url);
        if (url === urls[0]) return null;
        await held.promise;
        settled++;
        return { code: 'compiled' };
      },
      environments: {
        client: {
          waitForRequestsIdle: async () => {
            idle = true;
          },
        },
      },
      close: async () => {
        closed = true;
      },
    },
    { listen: () => assert.fail('failed preparation cannot listen') },
    urls,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(admitted, urls.slice(0, 16));
  assert.equal(closed, false);
  assert.equal(settled, 0);
  held.resolve();
  await assert.rejects(pending, /no compiled module/);
  assert.equal(settled, 15);
  assert.equal(closed, true);
  assert.equal(idle, false);
  assert.deepEqual(admitted, urls.slice(0, 16));
});
