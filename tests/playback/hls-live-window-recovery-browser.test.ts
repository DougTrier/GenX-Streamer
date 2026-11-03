/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface Scenario {
  status: 404 | 410;
  repeated?: boolean;
  finite?: boolean;
  hold?: boolean;
  alternate?: boolean;
  lowPlaylists: number;
  playlists: number;
  expired: number;
  fresh: number;
  freshResponseSent: boolean;
  delayedResponseSettled: boolean;
}
const cases = new Map<string, Scenario>();
let browser: Browser, server: Server, origin: string, code: string;
const timers = new Set<ReturnType<typeof setTimeout>>();
const segments: Buffer[] = [];

beforeAll(async () => {
  for (let n = 0; n < 4; n++)
    segments.push(await readFile(`tests/fixtures/media/segment${String(n).padStart(3, '0')}.ts`));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-hls-live-recovery',
        resolveId(id) {
          if (id.endsWith('virtual:real-hls-recovery')) return '\0real-hls-recovery';
        },
        load(id) {
          if (id !== '\0real-hls-recovery') return;
          return `export {createBrowserEngine,setVideoQuality} from ${JSON.stringify(resolve('src/platform/browser-engine.ts'))}; export {createResourceOwners} from ${JSON.stringify(resolve('src/playback/resource-owners.ts'))}; export {default as Hls} from 'hls.js';`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:real-hls-recovery', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw Error('Missing real HLS fixture');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw Error('Missing real HLS fixture chunk');
  code = chunk.code;
  server = createServer((request, response) => {
    const match = /^\/case\/([^/]+)\/(.+)$/.exec(
      new URL(request.url!, 'http://localhost').pathname,
    );
    if (!match) {
      response.end('<!doctype html><video id="video" muted playsinline></video>');
      return;
    }
    const scenario = cases.get(match[1]);
    if (!scenario) {
      response.writeHead(404).end();
      return;
    }
    if (match[2] === 'master.m3u8') {
      response
        .writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        .end(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180,CODECS="avc1.42e01e,mp4a.40.2"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"\nindex.m3u8\n',
        );
    } else if (match[2] === 'index.m3u8' || match[2] === 'low.m3u8') {
      const low = match[2] === 'low.m3u8';
      if (low) scenario.lowPlaylists++;
      const fresh = low || ++scenario.playlists > 1;
      const body =
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:2',
          `#EXT-X-MEDIA-SEQUENCE:${fresh ? 104 : 100}`,
          ...(fresh ? ['#EXT-X-DISCONTINUITY-SEQUENCE:1'] : []),
          ...segments.flatMap((_, n) => ['#EXTINF:2.0,', `${fresh ? 'fresh' : 'expired'}-${n}.ts`]),
          ...(scenario.finite ? ['#EXT-X-ENDLIST'] : []),
        ].join('\n') + '\n';
      const send = () => {
        if (response.destroyed) return;
        scenario.freshResponseSent ||= fresh;
        response
          .writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
          })
          .end(body);
      };
      if (fresh && !low) {
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            scenario.delayedResponseSettled = true;
            send();
          },
          scenario.hold ? 2000 : 150,
        );
        timers.add(timer);
      } else send();
    } else if (match[2].startsWith('expired-')) {
      scenario.expired++;
      response.writeHead(scenario.status).end();
    } else {
      scenario.fresh++;
      if (scenario.repeated) response.writeHead(scenario.status).end();
      else
        response
          .writeHead(200, { 'Content-Type': 'video/mp2t' })
          .end(segments[Number(/fresh-(\d)/.exec(match[2])![1])]);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});
afterAll(async () => {
  await browser?.close();
  for (const timer of timers) clearTimeout(timer);
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

async function mount(key: string, options: Partial<Scenario> = {}, onDemand = false) {
  const scenario: Scenario = {
    status: 404,
    playlists: 0,
    expired: 0,
    fresh: 0,
    freshResponseSent: false,
    lowPlaylists: 0,
    delayedResponseSettled: false,
    ...options,
  };
  cases.set(key, scenario);
  const page = await browser.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: code });
  await page.evaluate(
    ({ url, onDemand, alternate }) => {
      const api = Reflect.get(window, 'Fixture');
      const state = {
        errors: [] as unknown[],
        events: [] as unknown[],
        startLoad: 0,
        attach: 0,
        detach: 0,
        source: 0,
        destroy: 0,
      };
      class ObservedHls extends api.Hls {
        constructor(config: Record<string, unknown>) {
          // Keep Auto's fallback above the lower rendition for this ownership
          // case; the actual app quality setter can still select it manually.
          super({ ...config, ...(alternate ? { minAutoBitrate: 200000 } : {}) });
        }
        startLoad(...args: unknown[]) {
          state.startLoad++;
          return super.startLoad(...args);
        }
        attachMedia(...args: unknown[]) {
          state.attach++;
          return super.attachMedia(...args);
        }
        detachMedia(...args: unknown[]) {
          state.detach++;
          return super.detachMedia(...args);
        }
        loadSource(...args: unknown[]) {
          state.source++;
          return super.loadSource(...args);
        }
        destroy() {
          state.destroy++;
          return super.destroy();
        }
      }
      const owners = api.createResourceOwners();
      const video = document.querySelector<HTMLVideoElement>('#video')!;
      const abort = new AbortController();
      const engine = api.createBrowserEngine(
        video,
        (event: { type: string }) => {
          state.events.push(event);
          if (event.type === 'error') state.errors.push(event);
        },
        async () => ({ kind: 'hls' }),
        { allowHttp: () => true, preferNativeHls: false, loadHls: async () => ObservedHls, owners },
      );
      Reflect.set(window, 'realRecovery', { state, engine, abort, owners });
      void engine.start(
        {
          id: 'owned-live',
          name: 'Owned live fixture',
          url,
          ...(onDemand ? { playMode: 'on-demand' } : {}),
        },
        abort.signal,
      );
    },
    {
      url: `${origin}/case/${key}/${scenario.alternate ? 'master' : 'index'}.m3u8`,
      onDemand,
      alternate: scenario.alternate === true,
    },
  );
  return { page, scenario };
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const s = Reflect.get(window, 'realRecovery');
    const v = document.querySelector<HTMLVideoElement>('#video')!;
    return {
      ...s.state,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      time: v.currentTime,
      owners: s.owners.snapshot(),
    };
  });
}
async function dispose(page: Page) {
  await page.evaluate(async () => {
    const r = Reflect.get(window, 'realRecovery');
    r.abort.abort();
    await r.engine.dispose();
  });
  await page.close();
}

for (const status of [404, 410] as const) {
  it(`refreshes one expired live fragment ${status} into a decoded fresh window without replacing the player`, async () => {
    const { page, scenario } = await mount(`recover-${status}`, { status });
    try {
      await expect
        .poll(
          async () => {
            const current = await snapshot(page);
            return current.frames > 2 || current.errors.length > 0;
          },
          { timeout: 8000 },
        )
        .toBe(true);
      const observed = await snapshot(page);
      expect(observed.frames, JSON.stringify({ observed, scenario })).toBeGreaterThan(2);
      expect(scenario.expired).toBe(1);
      expect(scenario.playlists).toBeGreaterThanOrEqual(2);
      expect(scenario.freshResponseSent).toBe(true);
      expect(scenario.fresh).toBeGreaterThan(0);
      expect(observed.errors).toEqual([]);
      expect(observed).toMatchObject({ attach: 1, detach: 0, source: 1, destroy: 0 });
    } finally {
      await dispose(page);
    }
  });
}
it('stops after the one live resync when the fresh window also returns404', async () => {
  const { page, scenario } = await mount('repeat', { repeated: true });
  try {
    await expect
      .poll(async () => (await snapshot(page)).errors.length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(scenario.playlists).toBe(2);
    expect(scenario.expired).toBe(1);
    expect((await snapshot(page)).errors[0]).toMatchObject({
      failure: {
        code: 'missing',
        httpStatus: 404,
        message:
          'A media segment for this live stream was unavailable. Retry or choose another channel.',
      },
    });
  } finally {
    await dispose(page);
  }
});
it('cancels a held fresh playlist without late media, error or resource resurrection', async () => {
  const { page, scenario } = await mount('cancel', { hold: true });
  try {
    await expect.poll(() => scenario.playlists, { timeout: 5000 }).toBe(2);
    await page.evaluate(async () => {
      const r = Reflect.get(window, 'realRecovery');
      r.abort.abort();
      await r.engine.dispose();
    });
    await expect.poll(() => scenario.delayedResponseSettled, { timeout: 3000 }).toBe(true);
    expect(scenario.fresh).toBe(0);
    const observed = await snapshot(page);
    expect(observed.errors).toEqual([]);
    expect(observed.destroy).toBe(1);
    expect(Object.values(observed.owners.counts).every((value) => value === 0)).toBe(true);
  } finally {
    await page.close();
  }
}, 10000);
for (const [key, finite, onDemand] of [
  ['on-demand', false, true],
  ['finite-playlist', true, false],
] as const) {
  it(`preserves terminal404 for ${key} instead of applying live recovery`, async () => {
    const { page, scenario } = await mount(key, { finite }, onDemand);
    try {
      await expect.poll(async () => (await snapshot(page)).errors.length).toBeGreaterThanOrEqual(1);
      expect(scenario.playlists).toBe(1);
      expect((await snapshot(page)).errors[0]).toMatchObject({
        failure: { code: 'missing', httpStatus: 404 },
      });
    } finally {
      await dispose(page);
    }
  });
}
it('lets the real in-place quality owner replace a held recovery without an old timeout or seek', async () => {
  const { page, scenario } = await mount('quality-switch', { alternate: true, hold: true });
  try {
    await expect.poll(() => scenario.playlists, { timeout: 5000 }).toBe(2);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'Fixture').setVideoQuality(document.querySelector('#video'), 0),
      ),
    ).toBe(true);
    await expect
      .poll(
        async () => {
          const current = await snapshot(page);
          return current.frames > 2 || current.errors.length > 0;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await expect.poll(() => scenario.delayedResponseSettled, { timeout: 3000 }).toBe(true);
    const observed = await snapshot(page);
    expect(observed.frames, JSON.stringify({ observed, scenario })).toBeGreaterThan(2);
    expect(observed.errors).toEqual([]);
    expect(scenario.lowPlaylists).toBeGreaterThan(0);
    expect(observed).toMatchObject({ attach: 1, detach: 0, source: 1, destroy: 0 });
    expect(observed.owners.counts.loaderTimers).toBe(0);
  } finally {
    await dispose(page);
  }
}, 10000);
