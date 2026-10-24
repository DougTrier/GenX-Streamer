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
import { chromium, type Browser, type Page } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';

/** The real shell and stylesheets: nothing GenX paints may cover the native picture. */
let browser: Browser, code: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'native-hole-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:shell')) return '\0shell';
        },
        load(id) {
          if (id === '\0shell')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell/shell.ts'))};`;
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
  styles = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
        'fullscreen',
        'tv-density',
        'account-vod',
        'guide-panel',
        'native-video',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  )
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

async function shell(layout: { width: number; height: number; tv: boolean; mode?: string }) {
  const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: code });
  await page.evaluate((layout) => {
    const app = document.getElementById('app')!;
    Reflect.get(window, 'Fixture').createShell(app);
    app.dataset.deviceKind = layout.tv ? 'tv' : 'desktop';
    app.dataset.playerIdle = 'false';
    document.getElementById('player-overlay')!.hidden = true;
    if (layout.mode === 'fullscreen') app.classList.add('viewing-fullscreen');
    if (layout.mode === 'guide') {
      app.dataset.guidePanel = 'open';
      document.getElementById('primary-view-host')!.hidden = false;
    }
    const screen = document.getElementById('screen')!.getBoundingClientRect();
    const root = document.documentElement;
    root.style.setProperty('--gx-hole-x', `${screen.left}px`);
    root.style.setProperty('--gx-hole-y', `${screen.top}px`);
    root.style.setProperty('--gx-hole-w', `${screen.width}px`);
    root.style.setProperty('--gx-hole-h', `${screen.height}px`);
    // As native-picture.ts: the channel panel's position, for its own hole.
    const panel = app.querySelector('.browser')!.getBoundingClientRect();
    root.style.setProperty('--gx-panel-x', `${panel.left}px`);
    root.style.setProperty('--gx-panel-y', `${panel.top}px`);
    root.dataset.nativeVideo = 'on';
  }, layout);
  return page;
}
/** Every element (and its pseudo-elements) that paints over the picture's centre. */
const painted = (page: Page) =>
  page.evaluate(() => {
    const screen = document.getElementById('screen')!;
    const box = screen.getBoundingClientRect();
    const x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    const opaque = (style: CSSStyleDeclaration) => {
      const color = style.backgroundColor;
      const alpha = color.startsWith('rgba')
        ? Number(color.split(',')[3]!.replace(')', ''))
        : color === 'transparent'
          ? 0
          : 1;
      return alpha > 0 || (style.backgroundImage !== 'none' && style.backgroundImage !== '');
    };
    const out: string[] = [];
    for (let node: Element | null = screen; node; node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const style = getComputedStyle(node);
      if (opaque(style)) out.push(`${node.tagName.toLowerCase()}#${node.id}.${node.className}`);
      for (const pseudo of ['::before', '::after']) {
        const p = getComputedStyle(node, pseudo);
        if (p.content === 'none' || p.content === '') continue;
        const masked =
          (p.getPropertyValue('-webkit-mask-composite') || p.getPropertyValue('mask-composite')) !==
          '';
        const masks = p.getPropertyValue('-webkit-mask-image') || p.getPropertyValue('mask-image');
        if (opaque(p) && !(masked && masks && masks !== 'none'))
          out.push(`${node.tagName.toLowerCase()}#${node.id}${pseudo}`);
      }
    }
    // Anything else under the picture paints too: in the Guide the picture
    // sits over the channel panel, whose own background covered the native
    // picture on the Sansui TV (October 19, 2026). A masked layer passes.
    for (const node of document.querySelectorAll('#app *')) {
      if (node.contains(screen) || screen.contains(node)) continue;
      const r = node.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const mask =
        style.getPropertyValue('-webkit-mask-image') || style.getPropertyValue('mask-image');
      if (opaque(style) && !(mask && mask !== 'none'))
        out.push(`${node.tagName.toLowerCase()}#${node.id}.${node.className}`);
    }
    const video = document.getElementById('video')!;
    if (getComputedStyle(video).visibility !== 'hidden') out.push('video visible');
    return out;
  });

for (const layout of [
  { width: 960, height: 540, tv: true },
  { width: 1280, height: 720, tv: false },
  { width: 960, height: 540, tv: true, mode: 'fullscreen' },
  { width: 1280, height: 720, tv: false, mode: 'guide' },
  { width: 960, height: 540, tv: true, mode: 'guide' },
])
  it(`nothing GenX paints covers the native picture: ${layout.width}x${layout.height} ${layout.tv ? 'TV' : 'desktop'} ${layout.mode ?? 'normal'}`, async () => {
    const page = await shell(layout);
    try {
      expect(await painted(page)).toEqual([]);
      // The app's background stays everywhere else, on a layer with a hole.
      const layer = await page.evaluate(() => {
        const style = getComputedStyle(document.getElementById('app')!, '::before');
        return { content: style.content, position: style.position };
      });
      expect(layer).toEqual({ content: '""', position: 'fixed' });
    } finally {
      await page.close();
    }
  });

it('without native video the page paints normally', async () => {
  const page = await shell({ width: 1280, height: 720, tv: false });
  try {
    await page.evaluate(() => delete document.documentElement.dataset.nativeVideo);
    expect(await painted(page)).not.toEqual([]);
  } finally {
    await page.close();
  }
});
