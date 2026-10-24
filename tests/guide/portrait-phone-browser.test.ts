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

/** The real shell and stylesheets on upright phones: picture on top, channels below. */
const SHEETS = [
  'style',
  'management',
  'guide',
  'guide-timeline',
  'responsive',
  'in-app-select',
  'modal-viewport',
  'genxtra',
  'media-results',
  'tv-density',
  'guide-panel',
  'account-vod',
  'premium-buttons',
];
let browser: Browser, code: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'portrait-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:shell')) return '\0shell';
        },
        load(id) {
          if (id === '\0shell')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:shell', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  styles = (await Promise.all(SHEETS.map((name) => readFile(`src/ui/${name}.css`, 'utf8'))))
    .join('\n')
    .replaceAll("url('../../assets/genx-synthwave.svg')", 'none');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

for (const size of [
  { width: 360, height: 697, rows: 2 },
  { width: 412, height: 915, rows: 4 },
  { width: 320, height: 640, rows: 2 },
])
  it(`an upright ${size.width}x${size.height} phone shows the picture on top and the channels below`, async () => {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    try {
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: styles });
      await page.addScriptTag({ content: code });
      const g = await page.evaluate(() => {
        const app = document.getElementById('app')!;
        Reflect.get(window, 'Fixture').createShell(app);
        app.dataset.deviceKind = 'personal';
        for (const id of ['pause-button', 'captions-button'])
          (document.getElementById(id) as HTMLButtonElement).disabled = false;
        const box = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector)!;
          const r = node.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            height: r.height,
            width: r.width,
            shown: node.getClientRects().length > 0,
          };
        };
        return {
          screen: box('#screen'),
          browser: box('.browser'),
          pause: box('#pause-button'),
          fullscreen: box('#fullscreen-button'),
          captions: box('#captions-button'),
          favorite: box('#favorite-button'),
          tabs: box('.browse-options .filters'),
          categories: box('#compact-filter'),
          guide: box('#guide-button'),
          list: box('#channel-list'),
          compactView: box('#compact-view'),
        };
      });
      // The picture first, across the width at 16:9 in whole pixels.
      expect(g.screen.bottom).toBeLessThanOrEqual(g.browser.top);
      expect(g.screen.height).toBe(Math.floor(((size.width - 16) * 9) / 16));
      // One control row with CC at its end; Favorite/Remove live on the rows.
      expect(Math.abs(g.captions.top - g.pause.top)).toBeLessThanOrEqual(1);
      expect(g.captions.left).toBeGreaterThanOrEqual(g.fullscreen.right);
      expect(g.favorite.shown).toBe(false);
      // Categories are one dropdown on the line with Favs, Loc & Sort and Guide.
      expect(g.tabs.shown).toBe(false);
      expect(g.categories.shown).toBe(true);
      expect(Math.abs(g.categories.top - g.guide.top)).toBeLessThanOrEqual(6);
      expect(g.guide.right).toBeLessThanOrEqual(size.width);
      // No separate Watch/Channels switch, and room for whole channel rows.
      expect(g.compactView.shown).toBe(false);
      expect(Math.floor(g.list.height / 72)).toBeGreaterThanOrEqual(size.rows);
    } finally {
      await page.close();
    }
  });
