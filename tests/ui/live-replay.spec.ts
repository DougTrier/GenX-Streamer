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
import { readFile } from 'node:fs/promises';

// Instant replay on live TV (docs/instant-replay.md, REPLAY01) with the real
// controller, web engine, hls.js and Chrome's decoder. The live channel is a
// controlled fixture: the four 2 s segments of tests/fixtures/media (testsrc2,
// 24 fps, H.264/AAC) repeated as a sliding live playlist, never a public stream.
const SEGMENT_SECONDS = 2;
const WINDOW_SEGMENTS = 6;

async function serveLiveFixture(page: Page): Promise<void> {
  const segments = await Promise.all(
    [0, 1, 2, 3].map((index) => readFile(`tests/fixtures/media/segment00${index}.ts`)),
  );
  const startedAt = Date.now();
  await page.route('https://live.invalid/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/live.m3u8') {
      const first = Math.floor((Date.now() - startedAt) / 1000 / SEGMENT_SECONDS);
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
        `#EXT-X-MEDIA-SEQUENCE:${first}`,
        `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / 4)}`,
      ];
      for (let n = first; n < first + WINDOW_SEGMENTS; n++) {
        // Each repeat of the four-segment clip restarts its timestamps.
        if (n % 4 === 0 && n !== first) lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXTINF:${SEGMENT_SECONDS}.000000,`, `seg/${n}.ts`);
      }
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: lines.join('\n') + '\n',
      });
    }
    const match = /^\/seg\/(\d+)\.ts$/u.exec(url.pathname);
    if (!match) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      contentType: 'video/mp2t',
      headers: { 'access-control-allow-origin': '*' },
      body: segments[Number(match[1]) % 4]!,
    });
  });
}

async function mountReplay(page: Page): Promise<void> {
  await page.route('**/live-replay-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
        ['style', 'responsive', 'genxtra', 'tv-density', 'live-replay']
          .map((name) => `<link rel="stylesheet" href="/src/ui/${name}.css">`)
          .join('') +
        '</head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/live-replay-fixture');
  await page.evaluate(async () => {
    const shell = '/src/ui/shell/shell.ts',
      controller = '/src/playback/controller.ts',
      engine = '/src/platform/browser-engine.ts',
      replay = '/src/ui/player/live-replay.ts';
    const { createShell } = await import(shell);
    const { PlaybackController } = await import(controller);
    const { createBrowserEngineFactory } = await import(engine);
    const { installLiveReplay } = await import(replay);
    const app = document.getElementById('app')!;
    createShell(app);
    app.dataset.deviceKind = 'handheld';
    app.dataset.contentLibrary = 'live';
    document.getElementById('player-overlay')!.hidden = true;
    const video = document.getElementById('video') as HTMLVideoElement;
    // As the application: hls.js even where Chrome offers its own HLS player.
    const player = new PlaybackController(
      createBrowserEngineFactory(video, undefined, { preferNativeHls: false }),
    );
    const notices: string[] = [];
    const controls = installLiveReplay(document, {
      replay: () => player.liveReplay(),
      usable: () =>
        !!player.snapshot.selection && ['playing', 'buffering'].includes(player.snapshot.state),
      notice: (message: string) => notices.push(message),
      focusFallback: () => document.getElementById('pause-button')!.focus(),
    });
    player.subscribe(() => controls.render());
    document.getElementById('pause-button')!.addEventListener('click', () => {
      if (controls.active()) controls.togglePause();
    });
    Object.assign(window, { replayTest: { player, controls, notices, video } });
    await player.select({
      id: 'live-fixture',
      name: 'Live fixture',
      url: 'https://live.invalid/live.m3u8',
    });
  });
}

/** How far Replay's first jump goes: 10 s, or all that is kept behind. */
const jumpedBack = (before: ReplayProbe) =>
  Math.min(10, before.window!.position - before.window!.start);
type ReplayProbe = {
  state: string;
  currentTime: number;
  rate: number;
  muted: boolean;
  paused: boolean;
  window: { start: number; end: number; position: number; frameSeconds: number } | null;
  active: boolean;
  notices: string[];
};
const probe = (page: Page) =>
  page.evaluate((): ReplayProbe => {
    const { player, controls, notices, video } = (
      window as never as {
        replayTest: {
          player: {
            snapshot: { state: string };
            liveReplay(): { window(): ReplayProbe['window'] } | null;
          };
          controls: { active(): boolean };
          notices: string[];
          video: HTMLVideoElement;
        };
      }
    ).replayTest;
    return {
      state: player.snapshot.state,
      currentTime: video.currentTime,
      rate: video.playbackRate,
      muted: video.muted,
      paused: video.paused,
      window: player.liveReplay()?.window() ?? null,
      active: controls.active(),
      notices: [...notices],
    };
  });

test.describe('instant replay on live TV (controlled fixture, real decoder)', () => {
  test.setTimeout(120_000);
  test('replays at a quarter speed, steps one picture, and returns to live', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveLiveFixture(page);
    await mountReplay(page);
    const replay = page.locator('#replay-button');
    // RP03: offered once a few seconds lie behind the playing position.
    await expect(replay).toBeVisible({ timeout: 30_000 });
    await expect(replay).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(6_000);
    const before = await probe(page);
    expect(before.state).toBe('playing');
    expect(before.rate).toBe(1);
    expect(before.muted).toBe(false);
    expect(before.window!.position - before.window!.start).toBeGreaterThanOrEqual(2);
    // RP01: hls.js keeps at most 30 s behind what it plays (one 2 s segment
    // of rounding).
    expect(before.window!.position - before.window!.start).toBeLessThanOrEqual(32);

    await replay.click();
    await expect(page.locator('#replay-transport')).toBeVisible();
    await expect(page.locator('#playback-status')).toBeHidden();
    await expect(page.locator('#replay-pause')).toBeFocused();
    await expect.poll(async () => (await probe(page)).rate).toBe(0.25);
    const replaying = await probe(page);
    expect(replaying.active).toBe(true);
    // RP05: muted below 1x.
    expect(replaying.muted).toBe(true);
    // Measured from the live picture, not the newest download.
    const behind = Number(
      (await page.locator('#replay-position').textContent())!.replace(/[^\d.]/g, ''),
    );
    expect(behind).toBeGreaterThan(jumpedBack(before) - 1.5);
    expect(behind).toBeLessThan(jumpedBack(before) + 2.5);
    // Back up to 10 s, never past what is kept.
    const jumped = before.currentTime - replaying.currentTime;
    expect(jumped).toBeGreaterThan(
      Math.min(10, before.window!.position - before.window!.start) - 1.5,
    );
    expect(replaying.currentTime).toBeGreaterThanOrEqual(before.window!.start - 0.1);
    // RP08: slow playback is playing, not buffering.
    await page.waitForTimeout(1_000);
    const slow = await probe(page);
    expect(slow.state).toBe('playing');
    expect(slow.currentTime).toBeGreaterThan(replaying.currentTime);
    expect(slow.currentTime - replaying.currentTime).toBeLessThan(0.6);

    // RP04: one picture back, paused; then one forward. Pressed with the
    // keyboard as a remote does: the focus stays on the step button (RP07).
    const beforeStep = await probe(page);
    await page.locator('#replay-frame-back').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#replay-pause')).toHaveText('Play');
    await expect.poll(async () => (await probe(page)).paused).toBe(true);
    await expect(page.locator('#replay-frame-back')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#replay-frame-back')).toBeFocused();
    const stepped = await probe(page);
    expect(stepped.window!.frameSeconds).toBeCloseTo(1 / 24, 2);
    // Never a step forward, whatever the speed left behind.
    expect(stepped.currentTime).toBeLessThan(beforeStep.currentTime + 0.3);
    await page.locator('#replay-frame-forward').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#replay-frame-forward')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#replay-frame-forward')).toBeFocused();
    const forward = await probe(page);
    expect(forward.currentTime - stepped.currentTime).toBeCloseTo(1 / 24, 2);
    // A paused replay stays paused and is not a stall.
    await page.waitForTimeout(3_000);
    const held = await probe(page);
    expect(held.paused).toBe(true);
    expect(held.state).toBe('playing');
    expect(held.currentTime).toBeCloseTo(forward.currentTime, 3);

    // Speeds cycle ¼ → ½ → 1 → ⅛.
    await page.locator('#replay-pause').click();
    await page.locator('#replay-speed').click();
    await expect(page.locator('#replay-speed')).toHaveText('½×');
    await page.locator('#replay-speed').click();
    await expect(page.locator('#replay-speed')).toHaveText('1×');
    // RP05: normal speed plays the viewer's sound again.
    await expect.poll(async () => (await probe(page)).muted).toBe(false);

    // RP06: Live returns at normal speed.
    await page.locator('#replay-live').click();
    await expect(page.locator('#replay-transport')).toBeHidden();
    await expect(page.locator('#playback-status')).toBeVisible();
    const back = await probe(page);
    expect(back.active).toBe(false);
    expect(back.rate).toBe(1);
    expect(back.muted).toBe(false);
    expect(back.currentTime).toBeGreaterThan(forward.currentTime + 1);
    await expect(replay).toBeFocused();
  });

  test('returns to live once the replay reaches the moment it was pressed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveLiveFixture(page);
    await mountReplay(page);
    await expect(page.locator('#replay-button')).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
    await page.locator('#replay-button').click();
    await expect.poll(async () => (await probe(page)).active).toBe(true);
    // 1x makes the catch-up quick: the jump back is replayed in real time.
    await page.locator('#replay-speed').click();
    await page.locator('#replay-speed').click();
    await expect(page.locator('#replay-speed')).toHaveText('1×');
    await expect.poll(async () => (await probe(page)).active, { timeout: 20_000 }).toBe(false);
    const after = await probe(page);
    expect(after.rate).toBe(1);
    expect(after.notices).toContain('Back to live.');
  });

  test('a stopped channel ends its replay and its old controls do nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await serveLiveFixture(page);
    await mountReplay(page);
    await expect(page.locator('#replay-button')).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
    // RP02: a handle taken before Stop is inert afterwards.
    const outcome = await page.evaluate(async () => {
      const { player, controls } = (
        window as never as {
          replayTest: {
            player: {
              liveReplay(): {
                window(): unknown;
                setRate(rate: number): void;
                seek(seconds: number, signal: AbortSignal): Promise<boolean>;
              } | null;
              stop(): Promise<void>;
            };
            controls: { rewind(): Promise<void>; active(): boolean; render(): void };
            video: HTMLVideoElement;
          };
        }
      ).replayTest;
      const video = document.getElementById('video') as HTMLVideoElement;
      await controls.rewind();
      const handle = player.liveReplay()!;
      const activeBefore = controls.active();
      await player.stop();
      controls.render();
      handle.setRate(0.125);
      return {
        activeBefore,
        activeAfter: controls.active(),
        window: handle.window(),
        seek: await handle.seek(1, new AbortController().signal),
        rate: video.playbackRate,
        hidden: document.getElementById('replay-button')!.hidden,
        transportHidden: document.getElementById('replay-transport')!.hidden,
      };
    });
    expect(outcome).toEqual({
      activeBefore: true,
      activeAfter: false,
      window: null,
      seek: false,
      rate: 1,
      hidden: true,
      transportHidden: true,
    });
  });
});

// RP07: the Replay button and the replay controls fit the dock, unclipped and
// reachable, at the phone, handheld, desktop and TV sizes of the layout matrix.
// Phones show Replay as an icon at the picture's bottom right (owner, October
// 21, 2026); wider docks keep the Replay button.
const LAYOUTS = [
  { name: 'phone portrait', width: 390, height: 844, tv: false, phone: true },
  { name: 'phone landscape', width: 844, height: 390, tv: false, phone: true },
  // Galaxy S25 in landscape, as GenX measured it there (dpr 3).
  { name: 'S25 landscape', width: 780, height: 360, tv: false, phone: true },
  { name: 'handheld', width: 1280, height: 720, tv: false, phone: false },
  { name: 'desktop', width: 1600, height: 900, tv: false, phone: false },
  { name: 'TV 1080p', width: 1920, height: 1080, tv: true, phone: false },
  { name: 'TV 540p', width: 960, height: 540, tv: true, phone: false },
];
for (const layout of LAYOUTS)
  for (const fullscreen of [false, true])
    for (const running of [false, true])
      test(`replay ${running ? 'controls' : 'button'} fit the dock: ${layout.name}${fullscreen ? ', full screen' : ''}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.route('**/live-replay-layout', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body:
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
              [
                'style',
                'management',
                'guide',
                'responsive',
                'fullscreen',
                'video-quality',
                'genxtra',
                'media-results',
                'tv-density',
                'live-replay',
              ]
                .map((name) => `<link rel="stylesheet" href="/src/ui/${name}.css">`)
                .join('') +
              '</head><body><div id="app"></div></body></html>',
          }),
        );
        await page.goto('/live-replay-layout');
        await page.evaluate(
          async ({ tv, running, fullscreen, phone }) => {
            const shell = '/src/ui/shell/shell.ts',
              viewport = '/src/ui/shell/viewport.ts';
            const { createShell } = await import(shell);
            const { installViewport } = await import(viewport);
            const app = document.getElementById('app')!;
            createShell(app);
            app.dataset.deviceKind = tv ? 'tv' : 'personal';
            app.dataset.compactView = 'watch';
            app.dataset.contentLibrary = 'live';
            app.dataset.playMode = 'live';
            // The channel panel as wide as the app draws it beside the picture
            // (the Sansui's was about 760 px at 1920; a narrower one hid an
            // overflow, October 21, 2026).
            app.style.setProperty(
              '--sidebar',
              phone ? '360px' : `${Math.round(innerWidth * 0.4)}px`,
            );
            if (fullscreen) app.classList.add('viewing-fullscreen');
            installViewport(app);
            document.getElementById('player-overlay')!.hidden = true;
            document.getElementById('watch-title')!.textContent = 'Controlled channel';
            for (const id of [
              'pause-button',
              'favorite-button',
              'remove-channel',
              'replay-button',
              'replay-overlay',
            ])
              (document.getElementById(id) as HTMLButtonElement).disabled = false;
            for (const id of ['replay-button', 'replay-overlay'])
              document.getElementById(id)!.hidden = false;
            document.getElementById('playback-status')!.textContent = 'Playing';
            if (running) {
              for (const id of ['replay-button', 'replay-overlay'])
                document.getElementById(id)!.setAttribute('aria-pressed', 'true');
              document.getElementById('replay-transport')!.hidden = false;
              document.getElementById('playback-status')!.hidden = true;
              document.getElementById('replay-position')!.textContent = '−29.9 s';
            }
          },
          { tv: layout.tv, running, fullscreen, phone: layout.phone },
        );
        // Phones show the icon on the picture; in full screen the dock (a grid of
        // buttons over the picture) carries Replay, as everywhere else.
        const icon = layout.phone && !fullscreen;
        const start = icon ? 'replay-overlay' : 'replay-button';
        const ids = running
          ? [
              ...(icon ? [start] : []),
              'replay-back',
              'replay-frame-back',
              'replay-pause',
              'replay-frame-forward',
              'replay-speed',
              'replay-live',
            ]
          : ['pause-button', start, 'mute-button'];
        // During a replay its controls replace the dock's.
        if (running)
          for (const hidden of ['#pause-button', '#mute-button', '#replay-button'])
            await expect(page.locator(hidden)).toBeHidden();
        // One Replay control per layout: the icon on phones, the button elsewhere.
        if (!running || icon)
          await expect(page.locator(icon ? '#replay-button' : '#replay-overlay')).toBeHidden();
        if (icon) {
          const [overlay, screen] = await Promise.all(
            ['#replay-overlay', '#screen'].map((selector) => page.locator(selector).boundingBox()),
          );
          // Inside the picture, in its bottom-right corner.
          expect(overlay!.x + overlay!.width).toBeLessThanOrEqual(screen!.x + screen!.width);
          expect(overlay!.y + overlay!.height).toBeLessThanOrEqual(screen!.y + screen!.height);
          // Close to the corner, whatever the picture's size.
          expect(screen!.x + screen!.width - (overlay!.x + overlay!.width)).toBeLessThanOrEqual(16);
          expect(screen!.y + screen!.height - (overlay!.y + overlay!.height)).toBeLessThanOrEqual(
            16,
          );
        }
        const boxes = await page.evaluate((ids) => {
          return ids.map((id) => {
            const element = document.getElementById(id)!;
            const box = element.getBoundingClientRect();
            // The picture's card holds the dock, outside full screen.
            const card = document.querySelector('#app:not(.viewing-fullscreen) .watch-card');
            const holder = card?.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return {
              id,
              left: box.left,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
              reachable: !!hit && (hit === element || element.contains(hit)),
              clipped: element.scrollWidth > element.clientWidth + 1,
              insideCard:
                !holder ||
                (box.left >= holder.left - 0.5 &&
                  box.right <= holder.right + 0.5 &&
                  box.bottom <= holder.bottom + 0.5),
            };
          });
        }, ids);
        for (const box of boxes) {
          expect(box.width, box.id).toBeGreaterThanOrEqual(30);
          expect(box.height, box.id).toBeGreaterThanOrEqual(30);
          expect(box.left, box.id).toBeGreaterThanOrEqual(0);
          expect(box.top, box.id).toBeGreaterThanOrEqual(0);
          expect(box.right, box.id).toBeLessThanOrEqual(layout.width + 0.5);
          expect(box.bottom, box.id).toBeLessThanOrEqual(layout.height + 0.5);
          expect(box.reachable, `${box.id} is covered or off screen`).toBe(true);
          expect(box.clipped, `${box.id} text is clipped`).toBe(false);
          expect(box.insideCard, `${box.id} lies outside the picture's card`).toBe(true);
        }
        // No two controls overlap.
        for (const [index, a] of boxes.entries())
          for (const b of boxes.slice(index + 1))
            expect(
              a.right <= b.left + 0.5 ||
                b.right <= a.left + 0.5 ||
                a.bottom <= b.top + 0.5 ||
                b.bottom <= a.top + 0.5,
              `${a.id} overlaps ${b.id}`,
            ).toBe(true);
        // No sideways page scroll.
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `artifacts/tests/ui/live-replay-layout/${layout.name.replace(/\s+/g, '-')}-${fullscreen ? 'fullscreen-' : ''}${running ? 'running' : 'offered'}.png`,
        });
      });
