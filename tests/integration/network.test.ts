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

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLivePlaylist,
  startFixtureServer,
  type FixtureServer,
} from '../../scripts/fixture-server.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PlaybackController } from '../../src/playback/controller';
import { classifyHttpFailure, readRetryAfter } from '../../src/platform/browser-engine';

let fixture: FixtureServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
describe('loopback HTTP faults (real fetch, deterministic resources)', () => {
  it('slides live window with stable cycle discontinuity numbering', async () => {
    let now = 1000;
    fixture = await startFixtureServer({ now: () => now });
    const initial = await (await fetch(`${fixture.url}/hls/live.m3u8`)).text();
    expect(initial).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(initial).not.toContain('#EXT-X-ENDLIST');
    now += 8000;
    const rotated = await (await fetch(`${fixture.url}/hls/live.m3u8`)).text();
    expect(rotated).toContain('#EXT-X-MEDIA-SEQUENCE:4');
    expect(rotated).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
    expect(rotated).toContain(
      '#EXT-X-DISCONTINUITY\n#EXTINF:2.000000,\n/media/segment000.ts?sequence=4',
    );
    expect(buildLivePlaylist(10_000)).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(buildLivePlaylist(16_000)).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(fixture.stats().liveManifests).toBe(2);
  });
  it('exposes access refusal, missing source and bounded Retry-After', async () => {
    fixture = await startFixtureServer();
    expect((await fetch(`${fixture.url}/fault/403`)).status).toBe(403);
    expect((await fetch(`${fixture.url}/missing`)).status).toBe(404);
    const busy = await fetch(`${fixture.url}/fault/429`);
    expect(busy.status).toBe(429);
    expect(busy.headers.get('Retry-After')).toBe('30');
  });
  it('honors real HTTP refusal and Retry-After without creating another episode owner', async () => {
    fixture = await startFixtureServer();
    for (const route of ['/fault/429', '/fault/403']) {
      let owners = 0;
      const player = new PlaybackController((emit) => {
        owners++;
        return {
          start: async (selection, signal) => {
            const response = await fetch(selection.url, { signal });
            emit({
              type: 'error',
              failure: classifyHttpFailure(response.status, readRetryAfter(response)),
            });
          },
          pause: () => {},
          resume: async () => {},
          setMuted: () => {},
          setVolume: () => {},
          dispose: () => {},
        };
      });
      await player.select({ id: route, name: 'Controlled fault', url: `${fixture.url}${route}` });
      await expect.poll(() => player.snapshot.state).toBe('failed');
      expect(owners).toBe(1);
      expect(player.snapshot.error).toContain(route.endsWith('429') ? 'busy' : 'refused');
      await player.dispose();
    }
  });
  it('cancels stalled headers and body and releases response ownership', async () => {
    fixture = await startFixtureServer();
    await expect(
      fetch(`${fixture.url}/fault/headers-stall`, { signal: AbortSignal.timeout(80) }),
    ).rejects.toThrow();
    const response = await fetch(`${fixture.url}/fault/body-stall`, {
      signal: AbortSignal.timeout(80),
    });
    await expect(response.text()).rejects.toThrow();
    await fixture.close();
    expect(fixture.stats()).toMatchObject({ activeResponses: 0, activeSockets: 0, timers: 0 });
  });
  it('closes delayed requests, timers and sockets idempotently', async () => {
    fixture = await startFixtureServer({ delayMs: 1000 });
    const request = fetch(`${fixture.url}/fault/delayed.m3u8`).catch(() => null);
    // Receive a separate completed response to ensure the delayed request reached the server.
    await fetch(`${fixture.url}/missing`);
    const first = fixture.close();
    expect(fixture.close()).toBe(first);
    await first;
    await request;
    expect(fixture.stats()).toMatchObject({ activeResponses: 0, activeSockets: 0, timers: 0 });
  });
  it('serves key/map URI cases separately from media-decoder acceptance', async () => {
    fixture = await startFixtureServer();
    const manifest = await (await fetch(`${fixture.url}/hls/key-map.m3u8`)).text();
    expect(manifest).toContain('#EXT-X-KEY:METHOD=AES-128,URI="/hls/key"');
    expect(manifest).toContain('#EXT-X-MAP:URI="/hls/map"');
    expect((await (await fetch(`${fixture.url}/hls/key`)).arrayBuffer()).byteLength).toBe(16);
  });
  it('serves owned HLS bytes and byte ranges with a matching generated manifest', async () => {
    fixture = await startFixtureServer();
    const index = await (await fetch(`${fixture.url}/hls/extensionless`)).text();
    expect(index).toContain('segment000.ts');
    const full = Buffer.from(
      await (await fetch(`${fixture.url}/media/segment000.ts`)).arrayBuffer(),
    );
    expect(full[0]).toBe(0x47); // MPEG-TS sync byte; decoder proof belongs to actual player tests.
    const partial = await fetch(`${fixture.url}/media/segment000.ts`, {
      headers: { Range: 'bytes=0-187' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe(`bytes 0-187/${full.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(full.subarray(0, 188));
    expect(
      (
        await fetch(`${fixture.url}/media/segment000.ts`, {
          headers: { Range: 'bytes=999999999-' },
        })
      ).status,
    ).toBe(416);
    const fmp4 = await (await fetch(`${fixture.url}/media/fmp4.m3u8`)).text();
    expect(fmp4).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect((await fetch(`${fixture.url}/media/no-such-file.ts`)).status).toBe(404);
  });
  it('verifies every generated binary against its exact encoder receipt', async () => {
    const base = new URL('../fixtures/media/', import.meta.url);
    const record = JSON.parse(await readFile(new URL('generation.json', base), 'utf8')) as {
      version: string;
      files: Array<{ name: string; bytes: number; sha256: string }>;
    };
    expect(record.version).toMatch(/^ffmpeg version /);
    expect(record.files).toHaveLength(11);
    for (const file of record.files) {
      const bytes = await readFile(new URL(file.name, base));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
  });
});
