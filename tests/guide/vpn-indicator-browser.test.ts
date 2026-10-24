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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { validateVpnStatus } from '../../src/platform/vpn-status';
import { readStylesheet } from '../support/stylesheet';

/** The real header and stylesheets with the VPN shield and a controlled status source. */
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
  'vpn-indicator',
];
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
let browser: Browser, code: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vpn-indicator-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:shell')) return '\0shell';
        },
        load(id) {
          if (id === '\0shell')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell/shell.ts'))};
export {mountVpnIndicator} from ${JSON.stringify(resolve('src/ui/shell/vpn-indicator.ts'))};`;
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
  styles = (await Promise.all(SHEETS.map((name) => readStylesheet(`src/ui/${name}.css`))))
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

async function mount(layout: { width: number; height: number; tv: boolean }): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: code });
  await page.evaluate(
    ({ tv, png }) => {
      const app = document.getElementById('app')!;
      const fixture = Reflect.get(window, 'Fixture');
      fixture.createShell(app);
      app.dataset.deviceKind = tv ? 'tv' : 'desktop';
      // The fixture cannot serve the wordmark file: show it as a loaded image.
      const mark = app.querySelector<HTMLImageElement>('.brand-wordmark')!;
      mark.src = png;
      mark.hidden = false;
      app.querySelector<HTMLElement>('.brand-copy')!.hidden = true;
      const pending: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
      const ticks: (() => void)[] = [];
      Reflect.set(window, 'answer', (value: unknown) => pending.shift()?.resolve(value));
      Reflect.set(window, 'fail', () => pending.shift()?.reject(new Error('unavailable')));
      Reflect.set(window, 'tick', () => ticks.forEach((tick) => tick()));
      const dispose = fixture.mountVpnIndicator(
        app.querySelector('.topbar'),
        {
          read: () =>
            new Promise((resolve, reject) => {
              pending.push({ resolve, reject });
            }),
        },
        {
          setInterval: (callback: () => void) => ticks.push(callback),
          clearInterval: () => ticks.splice(0),
        },
      );
      Reflect.set(window, 'dispose', dispose);
    },
    { tv: layout.tv, png: PNG },
  );
  return page;
}
const read = (page: Page) =>
  page.evaluate(() => {
    const shield = document.getElementById('vpn-status');
    if (!shield) return null;
    const box = shield.getBoundingClientRect();
    const mark = document.querySelector('.brand-wordmark')!.getBoundingClientRect();
    const free = document.getElementById('live-tv-button')!.getBoundingClientRect();
    const bar = document.querySelector('.topbar')!.getBoundingClientRect();
    const style = getComputedStyle(shield);
    return {
      hidden: shield.hidden,
      state: shield.dataset.state ?? null,
      label: shield.getAttribute('aria-label'),
      title: shield.title,
      stroke: getComputedStyle(shield.querySelector('.vpn-shield')!).stroke,
      display: style.display,
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width },
      taglineEnd: mark.left + mark.width * 0.751,
      scriptEnd: mark.left + mark.width * 0.78,
      markTop: mark.top,
      markBottom: mark.bottom,
      freeLeft: free.left,
      barTop: bar.top,
      barBottom: bar.bottom,
    };
  });
// Past the 0.3s colour fade.
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

describe('VPN shield', () => {
  for (const layout of [
    { width: 960, height: 540, tv: true },
    { width: 1274, height: 815, tv: false },
    { width: 1920, height: 1080, tv: false },
  ])
    it(`sits below Streamer, between the tagline and Free TV, at ${layout.width}x${layout.height}${layout.tv ? ' TV' : ''}`, async () => {
      const page = await mount(layout);
      try {
        // Nothing shows until the system has answered.
        expect((await read(page))!.hidden).toBe(true);
        await page.evaluate(() =>
          Reflect.get(window, 'answer')({ connected: true, name: 'NordLynx Tunnel' }),
        );
        await settle(page);
        const on = (await read(page))!;
        expect(on).toMatchObject({
          hidden: false,
          state: 'connected',
          label: 'VPN connected · NordLynx Tunnel',
          title: 'VPN connected · NordLynx Tunnel',
        });
        expect(on.stroke).toBe('rgb(70, 245, 166)');
        // Centred in the gap after the tagline, clear of "Streamer" and Free TV.
        const centre = (on.box.left + on.box.right) / 2;
        expect(
          Math.abs(
            centre -
              Math.max((on.taglineEnd + on.freeLeft) / 2, on.scriptEnd + on.box.width / 2 + 2),
          ),
        ).toBeLessThanOrEqual(1);
        expect(on.box.left).toBeGreaterThanOrEqual(on.scriptEnd);
        expect(on.box.right).toBeLessThanOrEqual(on.freeLeft - 4);
        // On the wordmark's lower (tagline) half, inside the header.
        expect(on.box.top).toBeGreaterThan(on.markTop + (on.markBottom - on.markTop) / 3);
        expect(on.box.top).toBeGreaterThanOrEqual(on.barTop);
        expect(on.box.bottom).toBeLessThanOrEqual(on.barBottom);
        await page.evaluate(() => Reflect.get(window, 'dispose')());
      } finally {
        await page.close();
      }
    });

  it('red when no VPN is connected, grey when the device cannot tell', async () => {
    const page = await mount({ width: 1274, height: 815, tv: false });
    try {
      await page.evaluate(() => Reflect.get(window, 'answer')({ connected: false }));
      await settle(page);
      expect(await read(page)).toMatchObject({
        state: 'off',
        label: 'No VPN connected',
        stroke: 'rgb(255, 92, 122)',
      });
      await page.evaluate(() => {
        Reflect.get(window, 'tick')();
        Reflect.get(window, 'fail')();
      });
      await settle(page);
      expect(await read(page)).toMatchObject({
        state: 'error',
        label: 'VPN status could not be checked',
        stroke: 'rgb(142, 163, 189)',
      });
    } finally {
      await page.close();
    }
  });

  it('an older answer never overwrites a newer one; disposal removes the shield', async () => {
    const page = await mount({ width: 1274, height: 815, tv: false });
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'tick')(); // a second read starts before the first answers
        Reflect.get(window, 'answer')({ connected: true });
        Reflect.get(window, 'answer')({ connected: false });
      });
      await settle(page);
      expect((await read(page))!.state).toBe('off');
      await page.evaluate(() => Reflect.get(window, 'dispose')());
      expect(await read(page)).toBeNull();
    } finally {
      await page.close();
    }
  });

  it('steps aside on phones, where the header has no wordmark', async () => {
    const page = await mount({ width: 412, height: 915, tv: false });
    try {
      await page.evaluate(() => Reflect.get(window, 'answer')({ connected: true }));
      await settle(page);
      expect(await read(page)).toMatchObject({ hidden: true, state: 'connected' });
    } finally {
      await page.close();
    }
  });
});

describe('VPN status replies', () => {
  it('admit only a yes/no and a short printable name', () => {
    expect(validateVpnStatus({ connected: true, name: 'NordLynx Tunnel' })).toEqual({
      connected: true,
      name: 'NordLynx Tunnel',
    });
    expect(validateVpnStatus({ connected: false })).toEqual({ connected: false });
    for (const bad of [
      null,
      [],
      { connected: 'yes' },
      { connected: true, name: '' },
      { connected: true, name: 'x'.repeat(65) },
      { connected: true, name: 'bad\u0007name' },
      { connected: true, server: 'nl1.example' },
    ])
      expect(() => validateVpnStatus(bad)).toThrow();
  });
});
