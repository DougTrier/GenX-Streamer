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
async function mount(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(
    '<div id="channel-count"></div><div id="list-empty" hidden></div><div class="channel-list" id="list" style="height:300px;width:360px"><div id="channel-spacer"></div><div id="channel-rows"></div></div>',
  );
  await page.addStyleTag({ content: await readStylesheet('src/ui/style.css') });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    window.scopes=[];window.tunes=[];
    window.channels=Array.from({length:1000},(_,i)=>({id:'c'+i,sourceId:i%2?'s1':'s0',name:'Channel '+i,category:i%2?'Sports':'News'}));
    window.component=new ChannelUI.ChannelBrowser(document.getElementById('list'),id=>window.tunes.push(id),{onVisibleGuideRows:rows=>window.scopes.push(rows)});
    window.component.update(window.channels,[],null);
    window.visible=()=>window.scopes.at(-1);
    window.ready=(id,source)=>({catalogSourceId:source,appChannelId:id,status:'ready',summary:{requestId:'r',catalogSourceId:source,appChannelId:id,atMs:1000,catalogRevision:'1',databaseRevision:1,mappingStatus:'mapped',mapping:{catalogSourceId:source,appChannelId:id,guideSourceId:'g',xmltvChannelId:'x'},sourceRevision:1,publishedRevision:1,updatedMs:900,coverage:{startMs:0,endMs:3000},cacheStatus:'stale',currentStatus:'current',nextStatus:'next',current:{title:'<img src=x> Current',startMs:0,stopMs:2000},next:{title:'Upcoming',startMs:2000,stopMs:3000}}});
  `,
  });
  await page.waitForFunction(() =>
    (Reflect.get(window, 'scopes') as unknown[][]).some((rows) => rows.length > 0),
  );
  return page;
}
async function close(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.get(window, 'component').dispose());
  await page.close();
}
it('reports exact intersecting scoped rows, never overscan or whole catalog, and follows scroll/filter/resize/hidden ownership', async () => {
  const page = await mount();
  try {
    const actual = async () =>
      page.evaluate(() => {
        const bounds = document.getElementById('list')!.getBoundingClientRect();
        const ids = [...document.querySelectorAll<HTMLElement>('[data-channel]')]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.bottom > bounds.top && box.top < bounds.bottom;
          })
          .map((el) => el.dataset.channel);
        return {
          ids,
          reported: Reflect.get(window, 'visible')().map(
            (row: { appChannelId: string }) => row.appChannelId,
          ),
          rendered: document.querySelectorAll('[data-channel]').length,
        };
      });
    let state = await actual();
    expect(state.reported).toEqual(state.ids);
    expect(state.rendered).toBeGreaterThan(state.reported.length);
    expect(state.rendered).toBeLessThan(30);
    await page.locator('#list').evaluate((el) => {
      el.scrollTop = 10000;
    });
    await expect.poll(async () => (await actual()).reported[0]).not.toBe('c0');
    state = await actual();
    expect(state.reported).toEqual(state.ids);
    await page.evaluate(() => Reflect.get(window, 'component').setFilter('sports'));
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Reflect.get(window, 'visible')().every(
            (r: { catalogSourceId: string }) => r.catalogSourceId === 's1',
          ),
        ),
      )
      .toBe(true);
    const before = (await actual()).reported.length;
    await page.locator('#list').evaluate((el) => {
      el.style.height = '100px';
    });
    await expect.poll(async () => (await actual()).reported.length).toBeLessThan(before);
    await page.evaluate(() => Reflect.get(window, 'component').setGuideForeground(false));
    expect(await page.evaluate(() => Reflect.get(window, 'visible')())).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'component').setGuideForeground(true));
    await expect.poll(async () => (await actual()).reported.length).toBeGreaterThan(0);
    await page.locator('#list').evaluate((el) => {
      el.style.display = 'none';
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'visible')())).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'tunes'))).toEqual([]);
  } finally {
    await close(page);
  }
});
it('safe literal row summaries preserve focus and uniform virtual height at 200% text without tuning', async () => {
  const page = await mount();
  try {
    await page.locator('[data-channel="c0"]').focus();
    await page.evaluate(() =>
      Reflect.get(window, 'component').setGuideRows([Reflect.get(window, 'ready')('c0', 's0')]),
    );
    await expect
      .poll(() => page.locator('[data-channel="c0"] .channel-guide-current').textContent())
      .toBe('Cached · Now: <img src=x> Current');
    expect(await page.locator('[data-channel="c0"] .media-result-subtitle').textContent()).toBe(
      'Cached · <img src=x> Current',
    );
    expect(await page.locator('[data-channel="c0"] .channel-program-time').isVisible()).toBe(false);
    expect(await page.locator('[data-channel="c0"] .channel-program-time').textContent()).toMatch(
      /.+ – .+/,
    );
    expect(
      await page
        .locator('[data-channel="c0"] .channel-program-progress')
        .evaluate((element) => (element as HTMLProgressElement).value),
    ).toBe(0.5);
    // A neighboring identity without a summary must never borrow the selected header's data.
    expect(await page.locator('[data-channel="c1"] .channel-program-progress').count()).toBe(0);
    expect(await page.locator('[data-channel="c0"] img').count()).toBe(0);
    expect(await page.locator('[data-channel="c0"]').getAttribute('aria-label')).toContain(
      '<img src=x> Current',
    );
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-channel'))).toBe(
      'c0',
    );
    // Persistent scaled rules also apply to new rows after virtual rerender.
    await page.addStyleTag({
      content:
        '#list .channel-copy strong{font-size:26px} #list .channel-copy small{font-size:22px} #list .monogram{font-size:22px}',
    });
    await expect
      .poll(() =>
        page
          .locator('[data-channel="c0"]')
          .evaluate((button) => button.getBoundingClientRect().height),
      )
      .toBeGreaterThan(72);
    const layout = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.channel')].map((button) => ({
        height: button.getBoundingClientRect().height,
        copy: button.querySelector('.channel-copy')!.getBoundingClientRect().height,
        padding:
          parseFloat(getComputedStyle(button).paddingTop) +
          parseFloat(getComputedStyle(button).paddingBottom),
      })),
    );
    expect(new Set(layout.map((row) => row.height)).size).toBe(1);
    expect(layout.every((row) => row.copy + row.padding <= row.height)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'tunes'))).toEqual([]);
    const rejected = await page.evaluate(() => {
      try {
        Reflect.get(window, 'component').setGuideRows([
          { ...Reflect.get(window, 'ready')('c0', 's0'), catalogSourceId: 'other' },
        ]);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
  } finally {
    await close(page);
  }
});

it('missing mappings and explicit capacity stay readable without borrowed titles or offscreen acquisition', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const value = Reflect.get(window, 'ready')('c0', 's0');
      value.summary.mappingStatus = 'unmapped';
      value.summary.current = null;
      value.summary.next = null;
      Reflect.get(window, 'component').setGuideRows([value]);
    });
    await expect
      .poll(() => page.locator('[data-channel="c0"] .channel-guide-current').textContent())
      .toBe('No program guide connected yet');
    expect(await page.locator('[data-channel="c0"] .channel-guide-next').textContent()).toBe('');
    expect(await page.locator('[data-channel="c0"] .media-result-subtitle').textContent()).toBe(
      'News',
    );
    expect(await page.locator('[data-channel="c0"] .channel-program-time').count()).toBe(0);
    expect(await page.locator('[data-channel="c0"] .channel-program-progress').count()).toBe(0);
    await page.evaluate(() =>
      Reflect.get(window, 'component').setGuideRows(
        Array.from({ length: 65 }, (_, i) => ({
          catalogSourceId: i % 2 ? 's1' : 's0',
          appChannelId: 'c' + i,
          status: 'capacity',
          summary: null,
        })),
      ),
    );
    await expect
      .poll(() => page.locator('[data-channel="c0"] .channel-guide-current').textContent())
      .toBe('Guide view too large; reduce window height.');
    await page.locator('#list').evaluate((element) => {
      element.style.marginTop = '600px';
    });
    await page.evaluate(() => Reflect.get(window, 'component').search('Channel'));
    expect(await page.evaluate(() => Reflect.get(window, 'visible')())).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'tunes'))).toEqual([]);
  } finally {
    await close(page);
  }
});
