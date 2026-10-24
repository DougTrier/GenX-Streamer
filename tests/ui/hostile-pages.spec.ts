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

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Hostile-page fixtures (docs/web-viewer-invariants.md): each page attacks one
 * invariant against GenX's real page scripts. Native enforcement (permissions,
 * schemes, dialogs, renderer isolation) is verified on the devices.
 */
const script = (name: string) => readFileSync(`src-tauri/page-scripts/${name}.js`, 'utf8');
const agent = script('frame-agent').replaceAll('__GENX_TOKEN__', 'fixture-token');

const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  });
async function hostile(page: Page, body: string) {
  await page.route('**/hostile-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>${body}</body></html>`,
    }),
  );
  await page.goto('/hostile-fixture');
}

test('W03: a page cannot take the screen with its own full-screen request', async ({ page }) => {
  await hostile(page, '<video id="v"></video>');
  await page.evaluate(script('no-site-fullscreen'));
  const outcome = await page.evaluate(async () => {
    const results: string[] = [];
    for (const target of [document.documentElement, document.getElementById('v')!]) {
      try {
        await target.requestFullscreen();
        results.push('granted');
      } catch {
        results.push('refused');
      }
    }
    return { results, enabled: document.fullscreenEnabled, element: !!document.fullscreenElement };
  });
  expect(outcome).toEqual({ results: ['refused', 'refused'], enabled: false, element: false });
});

test('W06: no right-click menu or save/print/view-source shortcuts', async ({ page }) => {
  await hostile(page, '<p>page</p>');
  await page.evaluate(script('page-guard'));
  const blocked = await page.evaluate(() => {
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(menu);
    const keys = ['s', 'p', 'o', 'u'].map((key) => {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    const typing = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    document.body.dispatchEvent(typing);
    return { menu: menu.defaultPrevented, keys, typing: typing.defaultPrevented };
  });
  // Ordinary typing on the page still works.
  expect(blocked).toEqual({ menu: true, keys: [true, true, true, true], typing: false });
});

test('W08: remote commands without the page token are ignored', async ({ page }) => {
  await hostile(page, '<video id="v" width="320" height="180"></video>');
  await page.evaluate(agent);
  const muted = await page.evaluate(async () => {
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'readyState', { get: () => 4 });
    const settle = () => new Promise((r) => setTimeout(r, 50));
    window.postMessage({ genxRemote: 'guessed-token', cmd: 'mute' }, '*');
    await settle();
    const forged = video.muted;
    window.postMessage({ genxRemote: 'fixture-token', cmd: 'mute' }, '*');
    await settle();
    return { forged, real: video.muted };
  });
  expect(muted).toEqual({ forged: false, real: true });
});

test('W08: a forged "playing" report from a page only marks that page’s own frame', async ({
  page,
}) => {
  await hostile(page, '<iframe id="a" srcdoc="<p>a</p>"></iframe>');
  await page.evaluate(agent);
  // The top page posts a fake report to itself: no frame is its source, nothing is marked.
  await page.evaluate(() => window.postMessage({ genxPlaying: 'fixture-token' }, '*'));
  await page.waitForTimeout(50);
  expect(
    await page.locator('#a').evaluate((e) => (e as HTMLElement).dataset.genxPlaying ?? ''),
  ).toBe('');
});

test('W02: a page that keeps rebuilding its player cannot break Full screen or its exit', async ({
  page,
}) => {
  await hostile(page, '<div id="wrap"><video width="320" height="180"></video></div>');
  // The page swaps its player every 100 ms for a second.
  await page.evaluate(() => {
    const churn = setInterval(() => {
      document.getElementById('wrap')!.innerHTML = '<video width="320" height="180"></video>';
    }, 100);
    setTimeout(() => clearInterval(churn), 1000);
  });
  expect(await page.evaluate(script('show-video'))).toBe('video');
  // Never more than one backdrop, however often the page changes.
  for (let i = 0; i < 8; i++) {
    expect(await page.locator('#genx-backdrop').count()).toBeLessThanOrEqual(1);
    await page.waitForTimeout(125);
  }
  // Once the churn stops, the page's current player is the one shown full size.
  await page.waitForTimeout(600);
  const held = await page.evaluate(() => {
    const v = (window as unknown as { __genxHeld?: Element }).__genxHeld;
    if (!v?.isConnected) return null;
    const r = v.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height), v === document.querySelector('#wrap video')];
  });
  expect(held).toEqual([1280, 720, true]);
  expect(await page.evaluate(script('show-page'))).toBe('page');
  await page.waitForTimeout(500);
  expect(await page.locator('#genx-backdrop').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
});

test('W02: a player that rewrites its own position cannot push the picture off screen', async ({
  page,
}) => {
  // Like YouTube: on every resize (and here every 150 ms) the player writes its own size and place.
  await hostile(
    page,
    '<div id="player" style="position:relative"><video id="v" width="364" height="205"></video></div>',
  );
  await page.evaluate(() => {
    const v = document.getElementById('v') as HTMLVideoElement;
    const layout = () => {
      v.style.width = '704px';
      v.style.height = '396px';
      v.style.left = '0px';
      v.style.top = '-396px';
    };
    addEventListener('resize', layout);
    setInterval(layout, 150);
  });
  expect(await page.evaluate(script('show-video'))).toBe('video');
  await page.waitForTimeout(700);
  expect(await box(page, '#v')).toEqual([0, 0, 1280, 720]);
  expect(await page.evaluate(script('show-page'))).toBe('page');
});

test('Full screen asks a YouTube player for the quality the screen shows, then gives it back', async ({
  page,
}) => {
  await hostile(page, '<div id="movie_player"><video id="v" width="364" height="205"></video></div>');
  await page.evaluate(() => {
    const calls: string[] = [];
    Reflect.set(window, 'qualityCalls', calls);
    let current = 'medium';
    Object.assign(document.getElementById('movie_player')!, {
      getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'hd720', 'large', 'medium', 'auto'],
      getPlaybackQuality: () => current,
      setPlaybackQualityRange: (low: string, high: string) => {
        calls.push(`${low}-${high}`);
        current = low;
      },
    });
  });
  const tall = await page.evaluate(() => Math.round(screen.height * devicePixelRatio));
  const expected = tall >= 2160 ? 'hd2160' : tall >= 1080 ? 'hd1080' : 'hd720';
  expect(await page.evaluate(script('show-video'))).toBe('video');
  // Once set, later checks leave it alone.
  await page.evaluate(script('show-video'));
  expect(await page.evaluate(() => Reflect.get(window, 'qualityCalls'))).toEqual([
    `${expected}-${expected}`,
  ]);
  expect(await page.evaluate(script('show-page'))).toBe('page');
  expect(await page.evaluate(() => Reflect.get(window, 'qualityCalls'))).toEqual([
    `${expected}-${expected}`,
    'auto-auto',
  ]);
});

test('a site player that throws cannot break Full screen', async ({ page }) => {
  await hostile(page, '<div id="movie_player"><video id="v" width="364" height="205"></video></div>');
  await page.evaluate(() =>
    Object.assign(document.getElementById('movie_player')!, {
      getAvailableQualityLevels: () => {
        throw new Error('hostile');
      },
      setPlaybackQualityRange: () => {
        throw new Error('hostile');
      },
    }),
  );
  expect(await page.evaluate(script('show-video'))).toBe('video');
  expect(await page.evaluate(script('show-page'))).toBe('page');
});

test('low-memory TVs: sites are offered H.264 only', async ({ page }) => {
  await hostile(page, '<video id="v"></video>');
  await page.evaluate(script('prefer-h264'));
  const result = await page.evaluate(async () => {
    const v = document.getElementById('v') as HTMLVideoElement;
    const decode = (contentType: string) =>
      navigator.mediaCapabilities
        .decodingInfo({
          type: 'media-source',
          video: { contentType, width: 1920, height: 1080, bitrate: 4e6, framerate: 30 },
        })
        .then((info) => info.supported);
    return {
      vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'),
      vp09: MediaSource.isTypeSupported('video/webm; codecs="vp09.00.40.08"'),
      av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"'),
      h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'),
      canPlayVp9: v.canPlayType('video/webm; codecs="vp9"'),
      canPlayH264: v.canPlayType('video/mp4; codecs="avc1.640028"'),
      decodeAv1: await decode('video/mp4; codecs="av01.0.08M.08"'),
      decodeH264: await decode('video/mp4; codecs="avc1.640028"'),
    };
  });
  expect(result).toMatchObject({ vp9: false, vp09: false, av1: false, canPlayVp9: '', decodeAv1: false });
  // Whatever H.264 support the browser has is left exactly as it was.
  const plain = await page.evaluate(() => MediaSource.isTypeSupported.toString().includes('native'));
  expect(plain).toBe(false);
  expect(typeof result.h264).toBe('boolean');
});
