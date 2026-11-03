/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let browser: Browser, server: Server, origin: string, code: string;
const segments: Buffer[] = [];
interface Stream {
  gap: boolean;
  lateGap: boolean;
  released: boolean;
  pending: Array<[ServerResponse, number]>;
  requests: number[];
}
const streams = new Map<string, Stream>();
beforeAll(async () => {
  for (let n = 0; n < 4; n++)
    segments.push(await readFile(`tests/fixtures/media/segment${String(n).padStart(3, '0')}.ts`));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'actual-hls-buffer-gap',
        resolveId(id) {
          if (id.endsWith('virtual:actual-hls-gap')) return '\0actual-hls-gap';
        },
        load(id) {
          if (id === '\0actual-hls-gap')
            return `export {createBrowserEngine} from ${JSON.stringify(resolve('src/platform/browser-engine.ts'))}; export {createResourceOwners} from ${JSON.stringify(resolve('src/playback/resource-owners.ts'))}; export {learnedLiveBuffer,liveBufferIdentity} from ${JSON.stringify(resolve('src/playback/adaptive-buffer.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:actual-hls-gap', formats: ['iife'], name: 'Fixture' },
    },
  });
  const out = Array.isArray(result) ? result[0] : result;
  if (!out || !('output' in out)) throw Error('Missing gap fixture');
  const chunk = out.output.find((x) => x.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw Error('Missing gap fixture code');
  code = chunk.code;
  server = createServer((request, response) => {
    const m = /^\/stream\/([^/]+)\/(.+)$/.exec(new URL(request.url!, 'http://localhost').pathname);
    if (!m) {
      response.end('<!doctype html><video id="video" muted playsinline></video>');
      return;
    }
    const stream = streams.get(m[1]);
    if (!stream) {
      response.writeHead(404).end();
      return;
    }
    if (m[2] === 'index.m3u8') {
      // The public live selection has a finite delivered window. A declared
      // missing segment produces a real buffered hole after playback begins.
      response
        .writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        .end(
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:2',
            '#EXT-X-MEDIA-SEQUENCE:0',
            ...segments.flatMap((_, n) => [
              ...(stream.gap && n === 1 ? ['#EXT-X-GAP'] : []),
              '#EXTINF:2.0,',
              `${n}.ts`,
            ]),
            '#EXT-X-ENDLIST',
          ].join('\n') + '\n',
        );
    } else {
      const n = Number(/^(\d)\.ts$/.exec(m[2])?.[1]);
      if (!Number.isInteger(n) || n > 3) {
        response.writeHead(404).end();
        return;
      }
      stream.requests.push(n);
      if ((!stream.gap || stream.lateGap) && n === (stream.gap ? 2 : 1) && !stream.released)
        stream.pending.push([response, n]);
      else response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(segments[n]);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing gap fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});
async function mount(key: string, gap: boolean, manual = false, lateGap = false) {
  const stream: Stream = { gap, lateGap, released: false, pending: [], requests: [] };
  streams.set(key, stream);
  const page = await browser.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: code });
  await page.evaluate(
    ({ url, key, manual }) => {
      const api = Reflect.get(window, 'Fixture'),
        video = document.querySelector<HTMLVideoElement>('#video')!,
        owners = api.createResourceOwners(),
        abort = new AbortController();
      const selection = {
        id: key,
        name: 'Owned live gap fixture',
        url,
        buffer: 'balanced',
        ...(manual ? { liveBuffer: { mode: 'manual', targetSeconds: 2 } } : {}),
      };
      const events: unknown[] = [];
      const engine = api.createBrowserEngine(
        video,
        (e: unknown) => events.push(e),
        async () => ({ kind: 'hls' }),
        { allowHttp: () => true, preferNativeHls: false, owners },
      );
      Reflect.set(window, 'actualGap', { engine, abort, owners, selection, events });
      void engine.start(selection, abort.signal);
    },
    { url: `${origin}/stream/${key}/index.m3u8`, key, manual },
  );
  return { page, stream };
}
async function state(page: Page) {
  return page.evaluate(() => {
    const r = Reflect.get(window, 'actualGap'),
      v = document.querySelector<HTMLVideoElement>('#video')!;
    return {
      paused: v.paused,
      seeking: v.seeking,
      time: v.currentTime,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      ranges: Array.from({ length: v.buffered.length }, (_, n) => [
        v.buffered.start(n),
        v.buffered.end(n),
      ]),
      policy: r.engine.readLiveBuffer(),
      learned: Reflect.get(window, 'Fixture').learnedLiveBuffer.get(
        Reflect.get(window, 'Fixture').liveBufferIdentity(r.selection),
      ),
      events: r.events,
      resources: r.owners.snapshot().counts,
    };
  });
}
async function dispose(page: Page) {
  await page.evaluate(async () => {
    const r = Reflect.get(window, 'actualGap');
    r.abort.abort();
    await r.engine.dispose();
  });
  await page.close();
}
function release(stream: Stream) {
  stream.released = true;
  for (const [response, n] of stream.pending.splice(0))
    if (!response.destroyed)
      response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(segments[n]);
}
for (const manual of [false, true]) {
  it(`lets real HLS repair a delivered buffer hole without a twelve-second hold (${manual ? 'manual' : 'Auto'})`, async () => {
    const { page, stream } = await mount(`gap-${manual}`, true, manual);
    try {
      await expect.poll(async () => (await state(page)).time, { timeout: 7000 }).toBeGreaterThan(4);
      const observed = await state(page);
      expect(observed.frames).toBeGreaterThan(20);
      expect(observed.policy).toMatchObject({
        mode: manual ? 'manual' : 'auto',
        targetSeconds: manual ? 2 : 3,
      });
      expect(observed.learned).toBe(0);
      expect(stream.requests).not.toContain(1);
    } finally {
      await dispose(page);
    }
  }, 10000);
}
it('retains genuine contiguous starvation holding, Auto learning and release when media arrives', async () => {
  const { page, stream } = await mount('starvation', false);
  try {
    await expect
      .poll(
        async () => {
          const s = await state(page);
          return s.paused && s.policy?.targetSeconds === 5;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const held = await state(page);
    expect(held.ranges.length).toBe(1);
    expect(held.learned).toBe(5);
    release(stream);
    await expect.poll(async () => (await state(page)).time, { timeout: 5000 }).toBeGreaterThan(4);
    expect((await state(page)).learned).toBe(5);
  } finally {
    await dispose(page);
  }
}, 10000);
it('never resumes an explicit user Pause when pending media becomes available', async () => {
  const { page, stream } = await mount('user-pause', false);
  try {
    await expect
      .poll(async () => (await state(page)).policy?.targetSeconds, { timeout: 5000 })
      .toBe(5);
    await page.evaluate(() => Reflect.get(window, 'actualGap').engine.pause());
    const paused = await state(page);
    release(stream);
    await new Promise((r) => setTimeout(r, 500));
    const after = await state(page);
    expect(after.paused).toBe(true);
    expect(after.frames).toBe(paused.frames);
    expect(after.resources.loaderTimers).toBe(0);
  } finally {
    await dispose(page);
  }
}, 10000);
it('reclassifies a gap that becomes buffered during a hold without retaining its speculative Auto raise', async () => {
  const { page, stream } = await mount('late-gap', true, false, true);
  try {
    await expect
      .poll(
        async () => {
          const current = await state(page);
          return current.paused && current.policy?.targetSeconds === 5;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect((await state(page)).ranges.length).toBe(1);
    release(stream);
    await expect.poll(async () => (await state(page)).time, { timeout: 5000 }).toBeGreaterThan(4);
    const observed = await state(page);
    expect(observed.policy).toMatchObject({ mode: 'auto', targetSeconds: 3 });
    expect(observed.learned).toBe(0);
  } finally {
    await dispose(page);
  }
}, 10000);
it('cancels an active hold before a late delivery without resuming or leaking its timer', async () => {
  const { page, stream } = await mount('abort-hold', false);
  try {
    await expect
      .poll(async () => (await state(page)).policy?.targetSeconds, { timeout: 5000 })
      .toBe(5);
    await page.evaluate(async () => {
      const r = Reflect.get(window, 'actualGap');
      r.abort.abort();
      await r.engine.dispose();
    });
    const stopped = await state(page);
    release(stream);
    await new Promise((r) => setTimeout(r, 300));
    const after = await state(page);
    expect(after.policy).toBeNull();
    expect(after.events.length).toBe(stopped.events.length);
    expect(Object.values(after.resources).every((value) => value === 0)).toBe(true);
    expect(after.paused).toBe(true);
  } finally {
    await page.close();
  }
}, 10000);
