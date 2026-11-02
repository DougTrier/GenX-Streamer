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

import { beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { readStylesheet } from '../support/stylesheet';
import type { ProgramQuery } from '../../src/guide/native';
import type { TimelineChannel } from '../../src/ui/guide/guide-timeline-model';
import {
  useTimelineBrowser,
  fixture,
  browser,
  shellBundle,
  fullCss,
} from './timeline-browser.fixture';

useTimelineBrowser();
let categoryBundle = '';
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/channels/category-menu.ts', formats: ['iife'], name: 'Categories' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing category bundle.');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing category entry.');
  categoryBundle = chunk.code;
});

it('Guide keeps ordinary search separate from PPV events and binds listing/program caches to the explicit scope', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const saved = Reflect.get(window, 'channels') as TimelineChannel[];
      saved.splice(2);
      Object.assign(saved[0]!, { name: 'ESPN Finals', category: 'Sports', favorite: true });
      Object.assign(saved[1]!, {
        name: 'Event 1',
        category: 'Sports',
        originalCategory: 'Pay Per View',
      });
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'ppvQueries', []);
      host.listedChannels = async (
        _start: number,
        _end: number,
        _signal: AbortSignal,
        search?: string,
        ppv = false,
      ) => ({
        catalogRevision: '1',
        databaseRevision: 1,
        viewRevision: '11',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
        channels: (search && !ppv ? [] : ppv ? saved : saved.slice(0, 1)).map((channel) => ({
          catalogSourceId: 's',
          appChannelId: channel.id,
          guideSourceId: 'g',
          xmltvChannelId: channel.xmltvChannelId,
          sourceRevision: 1,
          filterMask: (channel.favorite ? 1 : 0) | 4 | (ppv ? 8 : 0),
        })),
      });
      host.query = async (query: ProgramQuery) => {
        Reflect.get(window, 'ppvQueries').push(query.ppv === true);
        const channel = saved.find((c) => c.id === query.appChannelIds[0])!;
        return {
          sourceRevision: 1,
          databaseRevision: 1,
          nextCursor: null,
          programs: [
            {
              catalogSourceId: 's',
              appChannelId: channel.id,
              guideSourceId: 'g',
              xmltvChannelId: channel.xmltvChannelId,
              startMs: query.windowStartMs,
              stopMs: query.windowEndMs,
              ordinal: 0,
              title: query.ppv ? 'PPV Championship' : 'Sports roundup',
              description: null,
            },
          ],
        };
      };
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    const titles = page.locator('.gx-timeline-channel .media-result-title');
    await expect.poll(() => titles.allTextContents()).toEqual(['ESPN Finals']);
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect.poll(() => titles.allTextContents()).toEqual(['ESPN Finals']);
    const search = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
    await search.fill('Championship');
    await expect.poll(() => titles.count()).toBe(0);
    await page.getByRole('button', { name: 'PPV', exact: true }).click();
    await expect.poll(() => titles.allTextContents()).toEqual(['ESPN Finals', 'Event 1']);
    await expect.poll(() => page.locator('.gx-timeline-cell').count()).toBe(2);
    expect(await page.locator('.gx-timeline-cell').allTextContents()).toEqual([
      'PPV Championship PPV',
      'PPV Championship PPV',
    ]);
    expect(await page.locator('.gx-timeline-cell .ppv-badge').count()).toBe(2);
    await page.locator('.gx-timeline-channel').nth(1).click();
    expect(
      await page.getByRole('button', { name: 'PPV', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true');
    await search.fill('');
    await expect.poll(() => titles.count()).toBe(2);
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect.poll(() => titles.allTextContents()).toEqual(['ESPN Finals']);
    expect(await page.locator('.gx-timeline-cell').allTextContents()).toEqual(['Sports roundup']);
    expect(await page.evaluate(() => Reflect.get(window, 'ppvQueries'))).toContain(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

for (const size of [
  { width: 960, height: 540, device: 'tv' },
  { width: 832, height: 397, device: 'personal' },
])
  it(`keeps PPV keyboard selection contained in the actual ${size.device} category controls`, async () => {
    const page = await browser.newPage();
    try {
      await page.setViewportSize(size);
      await page.setContent('<main id="app"></main>');
      await page.addStyleTag({
        content: fullCss + (await readStylesheet('src/ui/category-menu.css')),
      });
      await page.addScriptTag({ content: shellBundle });
      await page.addScriptTag({ content: categoryBundle });
      await page.evaluate((device) => {
        const root = document.getElementById('app')!;
        root.dataset.deviceKind = device;
        Reflect.get(window, 'Shell').createShell(root);
        Reflect.set(window, 'picked', []);
        for (const button of root.querySelectorAll<HTMLButtonElement>('.filters button'))
          button.addEventListener('click', () => {
            Reflect.get(window, 'picked').push(button.dataset.filter);
            for (const other of root.querySelectorAll('.filters button'))
              other.setAttribute('aria-pressed', String(other === button));
          });
        Reflect.set(
          window,
          'categories',
          Reflect.get(window, 'Categories').installCategoryMenu(root),
        );
      }, size.device);
      if (size.device === 'tv') {
        const trigger = page.locator('#category-button');
        await trigger.focus();
        await page.keyboard.press('Enter');
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
        const ppv = page.locator('.filters').getByRole('button', { name: 'PPV', exact: true });
        expect(await ppv.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(
          await ppv.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= 34 &&
              r.width >= 34 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => Reflect.get(window, 'picked'))).toEqual(['ppv']);
        expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        expect(await trigger.getAttribute('aria-expanded')).toBe('false');
        expect(await page.evaluate(() => Reflect.get(window, 'picked'))).toEqual(['ppv']);
      } else {
        const category = page.locator('#compact-filter');
        await category.focus();
        await category.press('p');
        await category.press('Enter');
        expect(await category.inputValue()).toBe('ppv');
        expect(
          await category.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight
            );
          }),
        ).toBe(true);
      }
    } finally {
      await page.evaluate(() => Reflect.get(window, 'categories')?.dispose());
      await page.close();
    }
  });
