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
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'src/ui/channel-browser.ts', name: 'LiveRows', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing row fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing row fixture code');
  bundle = chunk.code;
  css = (
    await Promise.all(
      ['style', 'responsive', 'genxtra', 'media-results'].map((name) =>
        readFile(`src/ui/${name}.css`, 'utf8'),
      ),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(width = 1280, height = 825, baseRowHeight = 72): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<div id="app" data-device-kind="${width === 1280 ? 'desktop' : 'handheld'}" data-content-library="live" style="display:block;width:100%;height:100vh"><span id="channel-count"></span><p id="list-empty" hidden></p><div id="list" class="channel-list" tabindex="0" style="height:${height - 60}px;width:${Math.min(width - 24, 430)}px;flex:none;position:relative"><div id="channel-spacer"></div><div id="channel-rows"></div></div></div>`,
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
      window.channels=Array.from({length:1000},(_,i)=>({id:'c'+i,sourceId:'s',name:i===0?'<img src=x> A very long actual channel title that must not collide with its actions':i===1?'Other station':'Channel '+i,category:i===1?'':'News'}));
      window.selected=[];window.favorited=[];window.managed=[];window.playing='c0';
      const favorites=new Set(['c1']);
      window.component=new LiveRows.ChannelBrowser(document.getElementById('list'),id=>{window.selected.push(id);window.playing=id;window.component.update(window.channels,[...favorites],id);},{onVisibleGuideRows:()=>{}},undefined,{
        baseRowHeight:${baseRowHeight},
        onFavorite:id=>{window.favorited.push(id);favorites.has(id)?favorites.delete(id):favorites.add(id);window.component.update(window.channels,[...favorites],window.playing);},
        onManage:id=>window.managed.push(id)
      });
      window.component.update(window.channels,[...favorites],window.playing);
    `,
  });

  await browserExpect(page.locator('[data-channel="c0"]')).toBeVisible();
  return page;
}
async function close(page: Page) {
  await page.evaluate(() => Reflect.get(window, 'component').dispose());
  await page.close();
}

it('keeps row playback, favorite and overflow independent across mouse and remote button activation', async () => {
  const page = await mount();
  try {
    const row = page
      .locator('.media-result-row')
      .filter({ has: page.locator('[data-channel="c0"]') });
    await row.locator('[data-channel-action="manage"]').click();
    await row.locator('[data-channel-action="favorite"]').click();
    expect(await page.evaluate(() => Reflect.get(window, 'managed'))).toEqual(['c0']);
    expect(await page.evaluate(() => Reflect.get(window, 'favorited'))).toEqual(['c0']);
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
    await browserExpect(row.locator('[data-channel-action="favorite"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.locator('[data-channel="c0"]').focus();
    await page.keyboard.press('ArrowRight');
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.channelAction),
    ).toBe('manage');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await browserExpect(row.locator('[data-channel-action="favorite"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
    await page.locator('[data-channel="c1"] .media-result-title').click();
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual(['c1']);
    await browserExpect(page.locator('[data-channel="c1"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await browserExpect(page.locator('[data-channel="c0"]')).toHaveAttribute(
      'aria-current',
      'false',
    );
  } finally {
    await close(page);
  }
});

it('uses literal titles and local artwork; only the exact admitted current programme replaces category', async () => {
  const page = await mount();
  try {
    const current = page.locator('[data-channel="c0"]');
    expect(await current.locator('img').count()).toBe(0);
    expect(await current.locator('.media-result-artwork').getAttribute('data-artwork')).toBe(
      'fallback',
    );
    expect(await current.locator('.media-result-subtitle').textContent()).toBe('News');
    expect(await page.locator('[data-channel="c1"] .media-result-subtitle').textContent()).toBe(
      'Live channel',
    );
    await page.evaluate(() => {
      Reflect.get(window, 'component').setGuideRows([
        {
          catalogSourceId: 's',
          appChannelId: 'c0',
          status: 'ready',
          summary: {
            requestId: 'r',
            catalogSourceId: 's',
            appChannelId: 'c0',
            atMs: 1000,
            catalogRevision: '1',
            databaseRevision: 1,
            mappingStatus: 'mapped',
            mapping: {
              catalogSourceId: 's',
              appChannelId: 'c0',
              guideSourceId: 'g',
              xmltvChannelId: 'x',
            },
            sourceRevision: 1,
            publishedRevision: 1,
            updatedMs: 900,
            coverage: { startMs: 0, endMs: 3000 },
            cacheStatus: 'stale',
            currentStatus: 'current',
            nextStatus: 'next',
            current: { title: '<b>Real programme</b>', startMs: 0, stopMs: 2000 },
            next: { title: 'Actual next', startMs: 2000, stopMs: 3000 },
          },
        },
      ]);
    });
    await browserExpect(current.locator('.media-result-subtitle')).toHaveText(
      'Cached · <b>Real programme</b>',
    );
    expect(await current.locator('.media-result-subtitle b').count()).toBe(0);
    expect(await current.getAttribute('aria-label')).toContain('Actual next');
    expect(await current.locator('.channel-guide-next').isVisible()).toBe(false);
    expect(await current.locator('.channel-program-progress').isVisible()).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'component').setGuideRows([]));
    await browserExpect(current.locator('.media-result-subtitle')).toHaveText('News');
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await close(page);
  }
});

for (const [width, height] of [
  [1280, 825],
  [854, 432],
  [320, 640],
])
  it(`keeps compact rows and 44px actions aligned without artwork or long-title overflow at ${width}x${height}`, async () => {
    const page = await mount(width, height);
    try {
      const layout = await page.locator('[data-channel="c0"]').evaluate((button) => {
        const row = button.closest('.media-result-row')!,
          title = button.querySelector('.media-result-title')!,
          subtitle = button.querySelector('.media-result-subtitle')!,
          artwork = button.querySelector('.media-result-artwork')!;
        const rect = row.getBoundingClientRect(),
          main = button.getBoundingClientRect(),
          copy = title.getBoundingClientRect(),
          sub = subtitle.getBoundingClientRect(),
          art = artwork.getBoundingClientRect();
        const actions = [...row.querySelectorAll<HTMLButtonElement>('[data-channel-action]')].map(
          (n) => {
            const b = n.getBoundingClientRect();
            return { width: b.width, height: b.height, right: b.right, left: b.left };
          },
        );
        return {
          row: { left: rect.left, right: rect.right, height: rect.height },
          mainHeight: main.height,
          mainRight: main.right,
          title: { left: copy.left, right: copy.right, bottom: copy.bottom },
          subtitleBottom: sub.bottom,
          subtitleTop: sub.top,
          titleHeight: copy.height,
          subtitleHeight: sub.height,
          titleFont: parseFloat(getComputedStyle(title).fontSize),
          subtitleFont: parseFloat(getComputedStyle(subtitle).fontSize),
          titleLineHeight: parseFloat(getComputedStyle(title).lineHeight),
          subtitleLineHeight: parseFloat(getComputedStyle(subtitle).lineHeight),
          visibleCopyLines: [...button.querySelector('.media-result-copy')!.children].filter(
            (n) => n.getClientRects().length > 0,
          ).length,
          spacerHeight: parseFloat(
            (document.getElementById('channel-spacer') as HTMLElement).style.height,
          ),
          artworkRight: art.right,
          actions,
          bodyOverflow: document.documentElement.scrollWidth > innerWidth,
          rows: document.querySelectorAll('[data-channel]').length,
        };
      });
      expect(layout.row.height).toBe(72);
      expect(layout.mainHeight).toBe(70);
      expect(layout.spacerHeight).toBe(1000 * 72);
      expect(layout.visibleCopyLines).toBe(2);
      expect(layout.titleFont).toBeGreaterThanOrEqual(16);
      expect(layout.titleFont).toBeLessThanOrEqual(18);
      expect(layout.subtitleFont).toBeGreaterThanOrEqual(13);
      expect(layout.subtitleFont).toBeLessThanOrEqual(14);
      expect(layout.titleHeight).toBeCloseTo(layout.titleLineHeight, 0);
      expect(layout.subtitleHeight).toBeCloseTo(layout.subtitleLineHeight, 0);
      expect(layout.title.bottom).toBeLessThanOrEqual(layout.subtitleTop);
      expect(layout.artworkRight).toBeLessThanOrEqual(layout.title.left);
      expect(layout.title.right).toBeLessThanOrEqual(layout.mainRight);
      expect(
        layout.actions.every(
          (a) => a.width >= 44 && a.height >= 44 && a.right <= layout.row.right + 1,
        ),
      ).toBe(true);
      expect(layout.actions[1]!.left).toBeGreaterThanOrEqual(layout.actions[0]!.right - 1);
      expect(layout.bodyOverflow).toBe(false);
      expect(layout.rows).toBeLessThan(25);
      await page.locator('[data-channel="c0"]').focus();
      await page.keyboard.press('End');
      await browserExpect(page.locator('[data-channel="c999"]')).toBeFocused();
      expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
    } finally {
      await close(page);
    }
  });

it('keeps virtual offsets synchronized when handheld rows expand for readable text', async () => {
  const page = await mount(854, 432, 60);
  try {
    await expect
      .poll(() =>
        page.locator('[data-channel="c0"]').evaluate((button) => {
          const copy = button.querySelector('.media-result-copy')!.getBoundingClientRect();
          const row = button.closest('.media-result-row')!.getBoundingClientRect();
          const style = getComputedStyle(button);
          return (
            copy.height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) <=
              button.getBoundingClientRect().height + 0.5 &&
            parseFloat((document.getElementById('channel-spacer') as HTMLElement).style.height) ===
              row.height * 1000
          );
        }),
      )
      .toBe(true);
    await page.locator('[data-channel="c0"]').focus();
    await page.keyboard.press('End');
    await browserExpect(page.locator('[data-channel="c999"]')).toBeFocused();
    // A scheduled virtual render can retire a locator's resolved node before
    // its evaluation reaches the browser. Inspect the current row and focus in
    // the same task, so a detached zero rectangle cannot masquerade as clipping.
    const visible = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-channel="c999"]')!;
      const row = button.closest('.media-result-row')!.getBoundingClientRect(),
        list = document.getElementById('list')!.getBoundingClientRect();
      const host = document.getElementById('list')!;
      return {
        fullyVisible: row.height > 0 && row.top >= list.top - 1 && row.bottom <= list.bottom + 1,
        focused: document.activeElement === button,
        spacerSynchronized:
          parseFloat((document.getElementById('channel-spacer') as HTMLElement).style.height) ===
          row.height * 1000,
        rowTop: row.top,
        rowBottom: row.bottom,
        rowHeight: row.height,
        listTop: list.top,
        listBottom: list.bottom,
        scrollTop: host.scrollTop,
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        transform: (document.getElementById('channel-rows') as HTMLElement).style.transform,
        spacerHeight: (document.getElementById('channel-spacer') as HTMLElement).style.height,
      };
    });
    expect(visible, JSON.stringify(visible)).toMatchObject({
      fullyVisible: true,
      focused: true,
      spacerSynchronized: true,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await close(page);
  }
});

it('keeps the focused last row visible when real text metrics grow after navigation', async () => {
  const page = await mount(854, 432, 60);
  try {
    await page.locator('[data-channel="c0"]').focus();
    await page.keyboard.press('End');
    await browserExpect(page.locator('[data-channel="c999"]')).toBeFocused();
    await page.addStyleTag({
      content:
        '#app #channel-rows .media-result-copy {gap:16px} #app #channel-rows .media-result-title {font-size:26px;line-height:1.4} #app #channel-rows .media-result-subtitle {font-size:18px;line-height:1.4}',
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const button = document.querySelector('[data-channel="c999"]');
          const row = button?.closest('.media-result-row')?.getBoundingClientRect();
          const list = document.getElementById('list')!;
          const bounds = list.getBoundingClientRect();
          return {
            focused: (document.activeElement as HTMLElement)?.dataset.channel,
            expanded: !!row && row.height > 90,
            fullyVisible: !!row && row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1,
            spacerSynchronized:
              !!row &&
              parseFloat(
                (document.getElementById('channel-spacer') as HTMLElement).style.height,
              ) ===
                row.height * 1000,
          };
        }),
      )
      .toMatchObject({
        focused: 'c999',
        expanded: true,
        fullyVisible: true,
        spacerSynchronized: true,
      });
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await close(page);
  }
});

it('NV03: Up and Down keep the row column, so the star stays on stars and the menu on menus', async () => {
  const page = await mount();
  try {
    const at = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        return `${active.closest('.channel-row')?.querySelector<HTMLElement>('[data-channel]')?.dataset.channel}:${active.dataset.channelAction ?? 'main'}`;
      });
    const ids = await page
      .locator('[data-channel]')
      .evaluateAll((nodes) =>
        nodes.slice(0, 3).map((node) => (node as HTMLElement).dataset.channel),
      );
    await page.locator('[data-channel-action="favorite"]').first().focus();
    expect(await at()).toBe(`${ids[0]}:favorite`);
    await page.keyboard.press('ArrowDown');
    expect(await at()).toBe(`${ids[1]}:favorite`);
    await page.keyboard.press('ArrowDown');
    expect(await at()).toBe(`${ids[2]}:favorite`);
    await page.keyboard.press('ArrowLeft');
    expect(await at()).toBe(`${ids[2]}:manage`);
    await page.keyboard.press('ArrowUp');
    expect(await at()).toBe(`${ids[1]}:manage`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    expect(await at()).toBe(`${ids[0]}:main`);
    // Moving never plays or toggles anything.
    expect(await page.evaluate(() => Reflect.get(window, 'favorited'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await close(page);
  }
});
