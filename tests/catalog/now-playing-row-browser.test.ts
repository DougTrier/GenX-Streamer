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

import { chromium, type Browser, type Page } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';

/** The real channel list: rows with a logo show what is on now instead of the name. */
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/channel-browser.ts', formats: ['iife'], name: 'ChannelUI' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture chunk');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const START = Date.UTC(2026, 9, 18, 20, 0);
const STOP = START + 3_600_000;

async function mount(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 640, height: 600 } });
  await page.setContent(
    '<div id="channel-count"></div><div id="list-empty" hidden></div><div class="channel-list" id="list" style="height:520px;width:360px"><div id="channel-spacer"></div><div id="channel-rows"></div></div>',
  );
  await page.addStyleTag({ content: await readStylesheet('src/ui/style.css') });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ png }) => {
      // c0-c2 and c4 have logos (c2's artwork is broken); c3 has none.
      const channels = Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        sourceId: i === 0 ? 'free' : 'account-a1',
        name: `Channel ${i}`,
        category: 'News',
      }));
      const logos = {
        get: (channel: { id: string }) =>
          channel.id === 'c3' ? null : channel.id === 'c2' ? 'data:image/png;base64,AAAA' : png,
        visible: () => undefined,
        rejected: () => undefined,
      };
      const ui = Reflect.get(window, 'ChannelUI');
      const component = new ui.ChannelBrowser(
        document.getElementById('list'),
        () => undefined,
        { onVisibleGuideRows: () => undefined },
        undefined,
        { logos },
      );
      component.update(channels, [], null);
      Reflect.set(window, 'component', component);
    },
    { png: PNG },
  );
  await page.waitForSelector('[data-channel="c5"]');
  return page;
}
const row = (page: Page, id: string) =>
  page.evaluate((id) => {
    const button = document.querySelector<HTMLElement>(`[data-channel="${id}"]`)!;
    return {
      title: button.querySelector('.media-result-title')!.textContent,
      subtitle: button.querySelector('.media-result-subtitle')!.textContent,
      label: button.getAttribute('aria-label'),
      mode: button.querySelector<HTMLElement>('.channel-copy')!.dataset.nowPlaying ?? null,
    };
  }, id);

it('a row with a logo shows the programme on now and its time; the name stays in its label', async () => {
  const page = await mount();
  try {
    await page.evaluate(
      ({ start, stop }) => {
        const playing = (id: string, title: string) => ({
          catalogSourceId: 'account-a1',
          appChannelId: id,
          title,
          startMs: start,
          stopMs: stop,
        });
        Reflect.get(window, 'component').setNowPlaying([
          playing('c1', '<b>Late</b> News'),
          playing('c2', 'Evening Film'),
          playing('c3', 'Morning Show'),
        ]);
      },
      { start: START, stop: STOP },
    );
    await expect.poll(() => row(page, 'c1').then((r) => r.title)).toBe('<b>Late</b> News');
    const logoRow = await row(page, 'c1');
    expect(logoRow.mode).toBe('title');
    expect(logoRow.subtitle).toMatch(/^.+ – .+$/);
    expect(logoRow.label).toContain('Channel 1');
    expect(logoRow.label).toContain('Now: <b>Late</b> News');
    // Rendered as text, never markup.
    expect(await page.locator('[data-channel="c1"] b').count()).toBe(0);
    // Broken artwork falls back to initials, so the name returns above the programme.
    await expect
      .poll(() => row(page, 'c2'))
      .toMatchObject({
        title: 'Channel 2',
        subtitle: 'Evening Film',
        mode: 'subtitle',
      });
    // Without a logo the name stays, with the programme beneath it.
    expect(await row(page, 'c3')).toMatchObject({
      title: 'Channel 3',
      subtitle: 'Morning Show',
      mode: 'subtitle',
    });
    // Nothing known on now: the name and category, as before.
    expect(await row(page, 'c4')).toMatchObject({
      title: 'Channel 4',
      subtitle: 'News',
      mode: null,
    });
    // Clearing the set brings the names back.
    await page.evaluate(() => Reflect.get(window, 'component').setNowPlaying([]));
    await expect.poll(() => row(page, 'c1').then((r) => r.title)).toBe('Channel 1');
  } finally {
    await page.close();
  }
});

it('the Free TV guide current programme takes the title the same way, cached ones marked', async () => {
  const page = await mount();
  try {
    await page.evaluate(
      ({ start, stop }) => {
        const summary = {
          requestId: 'r',
          catalogSourceId: 'free',
          appChannelId: 'c0',
          atMs: start + 60_000,
          catalogRevision: '1',
          databaseRevision: 1,
          mappingStatus: 'mapped',
          mapping: {
            catalogSourceId: 'free',
            appChannelId: 'c0',
            guideSourceId: 'g',
            xmltvChannelId: 'x',
          },
          sourceRevision: 1,
          publishedRevision: 1,
          updatedMs: start,
          coverage: { startMs: start, endMs: stop },
          cacheStatus: 'stale',
          currentStatus: 'current',
          nextStatus: 'none',
          current: { title: 'World Report', startMs: start, stopMs: stop },
          next: null,
        };
        Reflect.get(window, 'component').setGuideRows([
          { catalogSourceId: 'free', appChannelId: 'c0', status: 'ready', summary },
        ]);
      },
      { start: START, stop: STOP },
    );
    await expect.poll(() => row(page, 'c0').then((r) => r.title)).toBe('Cached · World Report');
    expect((await row(page, 'c0')).label).toContain('Channel 0');
  } finally {
    await page.close();
  }
});

it('refuses malformed or oversized now-playing sets', async () => {
  const page = await mount();
  try {
    const refused = await page.evaluate(
      ({ start, stop }) => {
        const component = Reflect.get(window, 'component');
        const base = {
          catalogSourceId: 'account-a1',
          appChannelId: 'c1',
          startMs: start,
          stopMs: stop,
        };
        const out: boolean[] = [];
        for (const rows of [
          [{ ...base, title: '' }],
          [{ ...base, title: 'x', stopMs: start }],
          [{ ...base, title: 'x'.repeat(1025) }],
          Array.from({ length: 65 }, (_, i) => ({ ...base, appChannelId: `c${i}`, title: 'x' })),
        ])
          try {
            component.setNowPlaying(rows);
            out.push(false);
          } catch {
            out.push(true);
          }
        return out;
      },
      { start: START, stop: STOP },
    );
    expect(refused).toEqual([true, true, true, true]);
  } finally {
    await page.close();
  }
});
