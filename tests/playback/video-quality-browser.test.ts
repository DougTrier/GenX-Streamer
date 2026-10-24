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

import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';

let browser: Browser, code: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'quality-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:quality')) return '\0quality';
        },
        load(id) {
          if (id === '\0quality')
            return `export {installVideoQuality} from ${JSON.stringify(resolve('src/ui/video-quality.ts'))}; export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))}; export {installFullscreenPresentation} from ${JSON.stringify(resolve('src/ui/fullscreen-presentation.ts'))}; export {installRemoteNavigation,createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/remote-navigation.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:quality', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture output');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  css = (
    await Promise.all(
      ['style', 'management', 'guide', 'responsive'].map((name) =>
        readStylesheet(`src/ui/${name}.css`),
      ),
    )
  ).join('\n');
  for (const item of output.output)
    if (item.type === 'asset' && item.fileName.endsWith('.css')) css += '\n' + String(item.source);
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(width = 960, height = 540, fullscreen = false, controlledClock = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  if (controlledClock) {
    const instant = new Date('2026-10-11T12:00:00Z');
    await page.clock.install({ time: instant });
    await page.clock.pauseAt(instant);
  }
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  // Inject only advertised quality state and command capture, never a decoder or playback claim.
  await page.addScriptTag({
    content: `Fixture.createShell(document.querySelector('#app')); window.video=document.querySelector('#video');window.choices=[];window.state={auto:true,currentLevel:7,availableLevelCount:2,levelsTruncated:false,availableLevels:[{index:7,width:426,height:240,bitrate:500000},{index:11,width:1920,height:1080,bitrate:8048000}]};window.remove=Fixture.installVideoQuality(video,document.querySelector('#video-quality'),{read:()=>window.state,set:(_,index)=>{choices.push(index);state.auto=index===null;if(index!==null)state.currentLevel=index;return true;}});window.removeRemote=Fixture.installRemoteNavigation({editMode:Fixture.createRemoteEditMode()});window.fullscreen=Fixture.installFullscreenPresentation(document.querySelector('#app'));fullscreen.set(${fullscreen});`,
  });
  return page;
}

it('uses actual advertised indices with remote navigation, and Escape closes only the popup', async () => {
  // Quality navigation owns no wall-clock pause; idle-reveal behavior is tested separately.
  const page = await mount(960, 540, true, true);
  try {
    const button = page.getByRole('button', { name: 'Video quality', exact: true });
    expect(await button.textContent()).toBe('Auto · 240p ▴');
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('#video-quality').getAttribute('data-video-quality-open')).toBe(
      'true',
    );
    expect(await page.getByRole('menuitemradio', { name: '1080p · 8.05 Mbps' }).count()).toBe(1);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([11]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([11, null]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await button.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(
      await page.locator('#app').evaluate((node) => node.classList.contains('viewing-fullscreen')),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

for (const [width, height] of [
  [960, 540],
  [320, 640],
]) {
  it(`keeps the upward popup and 44px targets inside ${width}x${height} fullscreen`, async () => {
    const page = await mount(width, height, true);
    try {
      const button = page.getByRole('button', { name: 'Video quality', exact: true });
      await button.click();
      const box = await page.getByRole('menu').boundingBox(),
        trigger = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(trigger).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(trigger!.y);
      expect(trigger!.width).toBeGreaterThanOrEqual(44);
      expect(trigger!.height).toBeGreaterThanOrEqual(44);
      for (const option of await page.getByRole('menuitemradio').all()) {
        const rect = await option.boundingBox();
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(
          await option.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        ).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await page.locator('#video').evaluate((node) => node.getAttribute('src'))).toBeNull();
    } finally {
      await page.close();
    }
  });
}

it('preserves open focus on progress, fences inert/reset/disposal, and does not silently omit excess levels', async () => {
  const page = await mount();
  try {
    const button = page.getByRole('button', { name: 'Video quality', exact: true });
    await button.click();
    await page.keyboard.press('End');
    await page.evaluate(() =>
      Reflect.get(window, 'video').dispatchEvent(new Event('video-quality-change')),
    );
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.quality)).toBe(
      '11',
    );
    expect(await button.getAttribute('aria-expanded')).toBe('true');
    await page.evaluate(() => {
      const container = document.querySelector('#video-quality') as HTMLElement;
      container.inert = true;
    });
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('false');
    await page.evaluate(() => {
      (document.querySelector('#video-quality') as HTMLElement).inert = false;
      Reflect.set(window, 'state', null);
      Reflect.get(window, 'video').dispatchEvent(new Event('video-quality-change'));
    });
    expect(await button.isDisabled()).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'state', {
        auto: true,
        currentLevel: 0,
        availableLevelCount: 65,
        levelsTruncated: true,
        availableLevels: [{ index: 0, height: 720, bitrate: 1000000 }],
      });
      Reflect.get(window, 'video').dispatchEvent(new Event('video-quality-change'));
    });
    expect(await button.isDisabled()).toBe(false);
    expect(await button.getAttribute('title')).toContain('Too many renditions');
    await button.click();
    expect(await page.getByRole('menuitemradio').count()).toBe(1);
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      Reflect.get(window, 'remove')();
      Reflect.get(window, 'remove')();
      Reflect.get(window, 'video').dispatchEvent(new Event('video-quality-change'));
    });
    expect(await page.locator('.video-quality-button,.video-quality-menu').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([null]);
  } finally {
    await page.close();
  }
});

it('offers Auto and the single available rendition, consumes held OK once, and closes on owned Back', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'state', {
        auto: true,
        currentLevel: 7,
        availableLevelCount: 1,
        levelsTruncated: false,
        availableLevels: [{ index: 7, height: 720, bitrate: null }],
      });
      Reflect.get(window, 'video').dispatchEvent(new Event('video-quality-change'));
    });
    const button = page.getByRole('button', { name: 'Video quality', exact: true });
    await button.focus();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await page.getByRole('menuitemradio').count()).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([]);
    await page.keyboard.press('End');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([7]);
    await page.keyboard.press('Enter');
    await page.evaluate(() =>
      document.querySelector('#video-quality')!.dispatchEvent(new Event('video-quality-close')),
    );
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await button.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.locator('#video-quality').getAttribute('data-video-quality-open')).toBeNull();
  } finally {
    await page.close();
  }
});

it('fullscreen idle Enter only reveals before a subsequent quality selection', async () => {
  const page = await mount(960, 540, true, true);
  try {
    const button = page.getByRole('button', { name: 'Video quality', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([11]);
    await page.clock.runFor(3001);
    expect(
      await page
        .locator('#app')
        .evaluate((node) => node.classList.contains('fullscreen-dock-hidden')),
    ).toBe(true);
    await page.keyboard.press('Enter');
    expect(
      await page
        .locator('#app')
        .evaluate((node) => node.classList.contains('fullscreen-dock-hidden')),
    ).toBe(false);
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([11]);
    await page.keyboard.press('Enter');
    expect(await button.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Home');
    expect(
      await page
        .getByRole('menuitemradio', { name: 'Auto', exact: true })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([11, null]);
  } finally {
    await page.close();
  }
});
