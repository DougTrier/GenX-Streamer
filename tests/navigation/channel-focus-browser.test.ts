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

import { chromium, type Browser } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';
let browser: Browser, code: string, css: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'src/ui/channels/channel-browser.ts', name: 'ChannelUI', formats: ['iife'] },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing fixture bundle');
  const chunk = result.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  css = await readStylesheet('src/ui/style.css');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
for (const width of [320, 1280])
  it(`visible remote focus is distinct from playing and stays inside scrolled list at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 640 } });
    try {
      await page.setContent(
        '<span id="channel-count"></span><p id="list-empty"></p><div class="channel-list" id="channel-list" tabindex="0" style="height:216px;flex:none;width:280px"><div id="channel-spacer"></div><div id="channel-rows"></div></div>',
      );
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      await page.addScriptTag({
        content: `window.selected=[]; window.channelBrowser=new ChannelUI.ChannelBrowser(document.querySelector('#channel-list'),id=>window.selected.push(id)); window.channelBrowser.update(Array.from({length:50},(_,i)=>({id:String(i),sourceId:'owned',name:'Owned channel '+i,category:'Fixture',urls:['https://fixture.invalid']})),[],'0');`,
      });
      const first = page.locator('.channel').first();
      await expect.poll(() => first.isVisible()).toBe(true);
      await first.focus();
      // Initial ResizeObserver rendering can replace the first row between
      // locator resolution and evaluation. Measure the connected rendered row.
      let height = 0;
      await expect
        .poll(async () => {
          height = await first.evaluate((node) =>
            node.isConnected ? node.getBoundingClientRect().height : 0,
          );
          return height;
        })
        .toBeGreaterThanOrEqual(44);
      await page.keyboard.press('ArrowDown');
      const distinct = await page.evaluate(() => {
        const focused = document.activeElement as HTMLElement;
        const playing = document.querySelector('.channel[aria-current="true"]') as HTMLElement;
        return {
          focusOutline: getComputedStyle(focused).outlineColor,
          focusBackground: getComputedStyle(focused).backgroundColor,
          playingBackground: getComputedStyle(playing).backgroundColor,
          playingMarker: getComputedStyle(playing).boxShadow,
          focusedId: focused.dataset.channel,
          playingId: playing.dataset.channel,
        };
      });
      expect(distinct.focusOutline).toBe(
        width >= 851 ? 'rgb(245, 141, 202)' : 'rgb(240, 217, 134)',
      );
      expect(distinct.focusBackground).not.toBe(distinct.playingBackground);
      expect(distinct.playingMarker).not.toBe('none');
      expect(distinct.focusedId).toBe('1');
      expect(distinct.playingId).toBe('0');
      for (let index = 0; index < 20; index++) await page.keyboard.press('ArrowDown');
      const scrolled = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement,
          list = document.querySelector('#channel-list') as HTMLElement;
        const row = active.getBoundingClientRect(),
          bounds = list.getBoundingClientRect();
        return {
          id: active.dataset.channel,
          height: row.height,
          inside: row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1,
          offset: getComputedStyle(active).outlineOffset,
          selected: Reflect.get(window, 'selected'),
          scroll: list.scrollTop,
        };
      });
      expect(scrolled.id).toBe('21');
      expect(scrolled.inside).toBe(true);
      expect(scrolled.height).toBe(height);
      expect(height).toBeGreaterThanOrEqual(44);
      expect(scrolled.offset).toBe('-3px');
      expect(scrolled.scroll).toBeGreaterThan(0);
      expect(scrolled.selected).toEqual([]);
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual(['21']);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'channelBrowser')?.dispose());
      await page.close();
    }
  });
