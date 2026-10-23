import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compile only; this neither executes application code nor seeds browser state. */
export async function prepareAndListen(vite, listener, urls) {
  // Playwright's existing 30s webServer deadline owns termination if compilation
  // stalls. Do not race and abandon a live Vite transform with a local timeout.
  try {
    // A bounded fixed pool avoids serializing independent transforms. Every
    // admitted transform settles before readiness or error cleanup.
    let next = 0;
    let failed = false;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(16, urls.length) }, async () => {
        while (!failed && next < urls.length) {
          const url = urls[next++];
          try {
            const result = await vite.transformRequest(url);
            if (!result || typeof result.code !== 'string')
              throw new Error('Source test preparation returned no compiled module.');
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }),
    );
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    await vite.environments.client.waitForRequestsIdle();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(1421, '127.0.0.1', () => {
        listener.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await vite.close();
    throw error;
  }
}

export async function sourceModuleUrls(root) {
  const sourceRoot = path.resolve(root, 'src');
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source test preparation refuses symlinks.');
      if (entry.isDirectory()) await visit(file);
      else if (/\.(ts|css)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(file);
        if (files.length > 512) throw new Error('Source test preparation module bound exceeded.');
      }
    }
  }
  await visit(sourceRoot);
  const urls = new Set(['/@vite/client']);
  for (const file of files) {
    urls.add('/' + path.relative(root, file).split(path.sep).join('/'));
    if (!file.endsWith('.ts')) continue;
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(
      /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url/g,
    )) {
      const target = path.resolve(path.dirname(file), match[2]);
      if (!target.startsWith(sourceRoot + path.sep) || !files.includes(target))
        throw new Error('Source test preparation worker target was invalid.');
      urls.add(
        '/' + path.relative(root, target).split(path.sep).join('/') + '?worker_file&type=module',
      );
    }
  }
  return [...urls];
}

/** Keep dependency discovery scoped to the exact admitted source tree. */
export function sourceServerOptions(root, urls) {
  const entries = urls.filter((url) => /^\/src\/.+\.ts$/.test(url)).map((url) => url.slice(1));
  if (!entries.length) throw new Error('Source test preparation has no dependency entries.');
  return {
    root,
    plugins: [
      {
        name: 'source-test-disable-watching',
        config(config) {
          // Vite's config merge skips null inline overrides. Apply this after
          // merging the repository config so preparation cannot watch evidence.
          config.server ??= {};
          config.server.watch = null;
        },
      },
    ],
    // Vite defaults to crawling every HTML file under root, including accumulated
    // evidence. These exact entries retain source dependencies without that crawl.
    optimizeDeps: {
      entries,
      noDiscovery: true,
      include: ['@tauri-apps/api/app', '@tauri-apps/api/core', '@tauri-apps/api/event', 'hls.js'],
    },
    server: { middlewareMode: true, hmr: false, watch: null },
  };
}

async function run() {
  const root = process.cwd();
  // Enumerate before Vite starts dependency discovery to avoid competing crawls.
  const urls = await sourceModuleUrls(root);
  // Middleware mode initializes Vite's dependency optimizer without opening the
  // HTTP readiness port. No HMR listener is needed in a frozen test source run.
  const vite = await createServer(sourceServerOptions(root, urls));
  const listener = createHttpServer(vite.middlewares);
  const close = async () => {
    if (listener.listening)
      await new Promise((resolve) => {
        listener.closeAllConnections();
        listener.close(resolve);
      });
    await vite.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(
      signal,
      () =>
        void close().catch(() => {
          process.exitCode = 1;
        }),
    );
  try {
    await prepareAndListen(vite, listener, urls);
    console.log(`Source test server ready after compiling ${urls.length} module entries.`);
  } catch {
    await close();
    console.error('Source test server preparation failed.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await run();
