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
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
let browser: Browser, code: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'fullscreen-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:fullscreen')) return '\0fullscreen';
        },
        load(id) {
          if (id === '\0fullscreen')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))}; export {installFullscreenPresentation} from ${JSON.stringify(resolve('src/ui/fullscreen-presentation.ts'))}; export {installRemoteNavigation,createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/remote-navigation.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:fullscreen', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((x) => x.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  css = (
    await Promise.all(
      ['style', 'management', 'guide', 'responsive'].map((name) =>
        readFile(`src/ui/${name}.css`, 'utf8'),
      ),
    )
  ).join('\n');
  for (const asset of output.output)
    if (asset.type === 'asset' && asset.fileName.endsWith('.css'))
      css += '\n' + String(asset.source);
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
for (const size of [
  { width: 320, height: 480 },
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  it(`fullscreen fills ${size.width}x${size.height}, retains video identity and accessible exit`, async () => {
    const page = await browser.newPage({ viewport: size });
    try {
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      await page.addScriptTag({
        content: `const root=document.querySelector('#app');Fixture.createShell(root);root.classList.add('compact-content');root.dataset.compactView='channels';const channel=document.createElement('button');channel.className='channel';channel.textContent='Original channel';document.querySelector('#channel-rows').append(channel);document.querySelector('#pause-button').disabled=false;document.querySelector('#player-overlay').hidden=true;window.originalVideo=document.querySelector('#video');window.presentation=Fixture.installFullscreenPresentation(root);window.removeRemote=Fixture.installRemoteNavigation({editMode:Fixture.createRemoteEditMode()});channel.focus();window.presentation.set(true);root.classList.add('expanded');document.querySelector('#fullscreen-button').addEventListener('click',()=>{root.classList.remove('expanded');window.presentation.set(false)});`,
      });
      expect(
        await page.locator('#fullscreen-button').evaluate((el) => el === document.activeElement),
      ).toBe(true);
      const geometry = await page.evaluate(() => {
        const screen = document.querySelector('#screen')!.getBoundingClientRect(),
          video = document.querySelector('#video')!.getBoundingClientRect();
        return {
          screen: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
          video: { x: video.x, y: video.y, width: video.width, height: video.height },
          same: document.querySelector('#video') === Reflect.get(window, 'originalVideo'),
          fit: getComputedStyle(document.querySelector('#video')!).objectFit,
          overflow: document.body.scrollWidth > innerWidth,
        };
      });
      expect(geometry.screen).toEqual({ x: 0, y: 0, ...size });
      expect(geometry.video).toEqual(geometry.screen);
      expect(geometry.same).toBe(true);
      expect(geometry.fit).toBe('contain');
      expect(geometry.overflow).toBe(false);
      for (const id of ['pause-button', 'mute-button', 'fullscreen-button']) {
        const rect = await page.locator('#' + id).boundingBox();
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.y).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(size.width);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(size.height);
        expect(
          await page.locator('#' + id).evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(
              document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
            );
          }),
        ).toBe(true);
      }
      await page.keyboard.press('ArrowLeft');
      expect(
        await page.locator('#fullscreen-button').evaluate((el) => el === document.activeElement),
      ).toBe(false);
      for (
        let step = 0;
        step < 6 &&
        !(await page.locator('#fullscreen-button').evaluate((el) => el === document.activeElement));
        step++
      )
        await page.keyboard.press('Tab');
      expect(
        await page.locator('#fullscreen-button').evaluate((el) => el === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Enter');
      expect(
        await page.locator('#app').evaluate((el) => el.classList.contains('viewing-fullscreen')),
      ).toBe(false);
      expect(await page.locator('.channel').evaluate((el) => el === document.activeElement)).toBe(
        true,
      );
      // Prior channel becomes eligible again when exiting; expanded is separately owned.
      await page.evaluate(() => document.querySelector('#app')!.classList.remove('expanded'));
      expect(
        await page.locator('#video').evaluate((el) => el === Reflect.get(window, 'originalVideo')),
      ).toBe(true);
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'presentation')?.dispose();
        Reflect.get(window, 'removeRemote')?.();
      });
      await page.close();
    }
  });
}

it('idle dock is inert; first remote press only reveals, held OK cannot activate, exit restores controls', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.addScriptTag({
      content: `Fixture.createShell(document.querySelector('#app'));const root=document.querySelector('#app');document.querySelector('#pause-button').disabled=false;window.video=document.querySelector('#video');window.clicks=0;document.querySelector('#pause-button').addEventListener('click',()=>window.clicks++);window.presentation=Fixture.installFullscreenPresentation(root);window.removeRemote=Fixture.installRemoteNavigation({editMode:Fixture.createRemoteEditMode()});document.querySelector('#fullscreen-button').focus();window.presentation.set(true);document.querySelector('#pause-button').focus();window.addEventListener('keydown',e=>{if(e.key==='Escape')window.presentation.set(false)});`,
    });
    expect(await page.locator('#expand-button').isVisible()).toBe(false);
    await page.locator('#video-quality').evaluate((node) => {
      (node as HTMLElement).dataset.videoQualityOpen = 'true';
    });
    await page.clock.runFor(6000);
    expect(await page.locator('.dock').isVisible()).toBe(true);
    expect(await page.locator('.dock').evaluate((node) => (node as HTMLElement).inert)).toBe(false);
    await page.locator('#video-quality').evaluate((node) => {
      delete (node as HTMLElement).dataset.videoQualityOpen;
    });
    await page.clock.runFor(2999);
    expect(await page.locator('.dock').isVisible()).toBe(true);
    await page.clock.runFor(1);
    expect(await page.locator('.dock').isVisible()).toBe(false);
    expect(await page.locator('.dock').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    expect(
      await page.locator('#pause-button').evaluate((el) => el === document.activeElement),
    ).toBe(false);
    await page.keyboard.down('Enter');
    expect(await page.locator('.dock').isVisible()).toBe(true);
    expect(
      await page.locator('#pause-button').evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'clicks'))).toBe(0);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'clicks'))).toBe(1);
    await page.clock.runFor(3000);
    await page.keyboard.press('ArrowRight');
    expect(
      await page.locator('#pause-button').evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('#mute-button').evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.clock.runFor(3000);
    await page.keyboard.press('Escape');
    expect(await page.locator('.dock').isVisible()).toBe(true);
    expect(await page.locator('.dock').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    expect(await page.locator('#expand-button').isVisible()).toBe(true);
    expect(await page.locator('#video').evaluate((el) => el === Reflect.get(window, 'video'))).toBe(
      true,
    );
    expect(await page.locator('#video').evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
      true,
    );
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'presentation')?.dispose();
      Reflect.get(window, 'removeRemote')?.();
    });
    await page.close();
  }
});
it('pointer, wheel and Tab reveal; disposal owns the timer and no future wakeups', async () => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  try {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.addScriptTag({
      content: `Fixture.createShell(document.querySelector('#app'));window.presentation=Fixture.installFullscreenPresentation(document.querySelector('#app'));window.presentation.set(true);`,
    });
    await page.clock.runFor(3000);
    await page.locator('#app').dispatchEvent('pointermove');
    expect(await page.locator('.dock').isVisible()).toBe(true);
    await page.clock.runFor(2500);
    await page.locator('#app').dispatchEvent('wheel');
    await page.clock.runFor(2999);
    expect(await page.locator('.dock').isVisible()).toBe(true);
    await page.clock.runFor(1);
    await page.keyboard.press('Tab');
    expect(await page.locator('.dock').isVisible()).toBe(true);
    // A finger tap moves no pointer; pressing alone brings the dock back.
    await page.clock.runFor(3000);
    expect(await page.locator('.dock').isVisible()).toBe(false);
    await page.locator('#app').dispatchEvent('pointerdown', { pointerType: 'touch' });
    expect(await page.locator('.dock').isVisible()).toBe(true);
    await page.evaluate(() => {
      Reflect.get(window, 'presentation').dispose();
      Reflect.get(window, 'presentation').dispose();
      Reflect.get(window, 'presentation').set(true);
    });
    await page.clock.runFor(6000);
    await page.locator('#app').dispatchEvent('pointermove');
    await page.keyboard.press('ArrowRight');
    expect(
      await page
        .locator('#app')
        .evaluate(
          (el) =>
            el.classList.contains('viewing-fullscreen') ||
            el.classList.contains('fullscreen-dock-hidden'),
        ),
    ).toBe(false);
    expect(await page.locator('.dock').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    expect(await page.locator('#expand-button').isVisible()).toBe(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'presentation')?.dispose());
    await page.close();
  }
});
