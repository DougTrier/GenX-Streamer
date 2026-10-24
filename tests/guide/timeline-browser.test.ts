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

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const captureDirectory = `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-narrow-agenda`;
import type { TimelineChannel } from '../../src/ui/guide-timeline';
import type { ProgramQuery } from '../../src/guide/native';
let browser: Browser,
  bundle: string,
  listedBridgeBundle: string,
  remoteBundle: string,
  archiveBundle: string,
  shellBundle: string,
  css: string,
  fullCss: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/guide-timeline.ts', formats: ['iife'], name: 'Timeline' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Timeline bundle missing.');
  const chunk = result.output.find((e) => e.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Timeline entry missing.');
  bundle = chunk.code;
  const listedOutput = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/guide/listed-channels.ts', formats: ['iife'], name: 'ListedBridge' },
    },
  });
  const listedResult = Array.isArray(listedOutput) ? listedOutput[0] : listedOutput;
  if (!listedResult || !('output' in listedResult)) throw new Error('Listed bridge missing.');
  const listedChunk = listedResult.output.find((entry) => entry.type === 'chunk');
  if (!listedChunk || listedChunk.type !== 'chunk') throw new Error('Listed bridge entry missing.');
  listedBridgeBundle = listedChunk.code;
  const remoteOutput = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/remote-navigation.ts', formats: ['iife'], name: 'Remote' },
    },
  });
  const remoteResult = Array.isArray(remoteOutput) ? remoteOutput[0] : remoteOutput;
  if (!remoteResult || !('output' in remoteResult)) throw new Error('Remote bundle missing.');
  const remoteChunk = remoteResult.output.find((item) => item.type === 'chunk');
  if (!remoteChunk || remoteChunk.type !== 'chunk') throw new Error('Remote entry missing.');
  remoteBundle = remoteChunk.code;
  const archiveOutput = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/archive-search.ts', formats: ['iife'], name: 'ArchiveFixture' },
    },
  });
  const archiveResult = Array.isArray(archiveOutput) ? archiveOutput[0] : archiveOutput;
  if (!archiveResult || !('output' in archiveResult))
    throw new Error('Archive fixture bundle missing');
  const archiveChunk = archiveResult.output.find((item) => item.type === 'chunk');
  if (!archiveChunk || archiveChunk.type !== 'chunk')
    throw new Error('Archive fixture entry missing');
  archiveBundle = archiveChunk.code;

  const shellOutput = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/shell.ts', formats: ['iife'], name: 'Shell' },
    },
  });
  const shellResult = Array.isArray(shellOutput) ? shellOutput[0] : shellOutput;
  if (!shellResult || !('output' in shellResult)) throw new Error('Shell bundle missing.');
  const shellChunk = shellResult.output.find((item) => item.type === 'chunk');
  if (!shellChunk || shellChunk.type !== 'chunk') throw new Error('Shell entry missing.');
  shellBundle = shellChunk.code;
  css = await readFile('src/ui/guide-timeline.css', 'utf8');
  fullCss = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
        'guide-panel',
      ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});

for (const size of [
  { width: 960, height: 540, font: 16 },
  { width: 1280, height: 720, font: 16 },
  { width: 320, height: 640, font: 32 },
  { width: 640, height: 360, font: 32 },
])
  it(`full production Guide layout ${size.width}x${size.height} text ${size.font}`, async () => {
    const page = await fixture();
    try {
      await page.setViewportSize(size);
      await page.addStyleTag({ content: fullCss });
      await page.evaluate((font) => {
        document.body.style.fontSize = `${font}px`;
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline';
        dialog.innerHTML =
          '<header class="guide-header"><h2>Program guide</h2><button aria-label="Close guide">Close</button></header><div class="guide-dropdown"><button aria-label="Guide view">Channel guide</button></div><div class="guide-feedback"><p>No program guide connected yet.</p><p></p></div><button>Find program guides</button><div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        document.querySelector('#app')!.append(dialog);
        dialog
          .querySelector('.guide-timeline-panel')!
          .append(document.querySelector('.gx-timeline')!);
        dialog.showModal();
      }, size.font);
      await page.evaluate(async () => {
        Reflect.get(window, 'channels').forEach((c: TimelineChannel) => {
          c.guideSourceId = null;
          c.xmltvChannelId = null;
        });
        await Reflect.get(window, 'owner').refresh();
      });
      const completeRows = await page.locator('.gx-timeline-viewport').evaluate((node) => {
        const viewport = node.getBoundingClientRect();
        return [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
          const r = row.getBoundingClientRect();
          return r.top >= viewport.top && r.bottom <= viewport.bottom && r.height >= 44;
        }).length;
      });
      if (size.font === 16) expect(completeRows).toBeGreaterThanOrEqual(4);
      if (size.width === 960)
        await page.screenshot({ path: `${captureDirectory}/compact-960x540-unmapped.png` });
      if (await page.getByRole('button', { name: 'Guide controls', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Guide controls', exact: true }).click();
      for (const name of [
        'Close guide',
        'Guide view',
        'Find program guides',
        'Previous 3 hours',
        'Now',
        'Next 3 hours',
      ]) {
        const control = page.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.x >= 0 &&
              r.right <= innerWidth &&
              r.y >= 0 &&
              r.bottom <= innerHeight &&
              node.scrollHeight <= node.clientHeight + 1 &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
          `${name}: ${JSON.stringify(
            await control.evaluate((n) => {
              const r = n.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                client: n.clientHeight,
                scroll: n.scrollHeight,
                bodyHeight: document.querySelector('.guide-body')!.clientHeight,
                bodyScroll: document.querySelector('.guide-body')!.scrollTop,
              };
            }),
          )}`,
        ).toBe(true);
      }
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(async () => {
        Reflect.get(window, 'channels').forEach((c: TimelineChannel, i: number) => {
          c.guideSourceId = 'g';
          c.xmltvChannelId = 'x' + i;
        });
        document.querySelector('.guide-feedback')!.replaceChildren();
        [...document.querySelectorAll('dialog>button')].forEach(
          (n) => ((n as HTMLElement).hidden = true),
        );
        await Reflect.get(window, 'owner').refresh();
      });
      if (size.width === 960)
        await page.screenshot({ path: `${captureDirectory}/compact-960x540-mapped.png` });
      let current = page.getByRole('button', { name: 'Current listing', exact: true }).first();
      const cluster = page
        .getByRole('button', { name: 'Current listing and 1 more listing', exact: true })
        .first();
      const focusReturn = (await cluster.count()) ? cluster : current;
      if (await cluster.count()) {
        await cluster.click();
        current = page
          .locator('.gx-timeline-choices button')
          .filter({ hasText: 'Current listing' })
          .first();
      }
      await current.scrollIntoViewIfNeeded();
      await current.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Watch current channel' }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      expect(await focusReturn.evaluate((n) => n === document.activeElement)).toBe(true);
      expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
        await rowCapacity(page),
      );
    } finally {
      await page.close();
    }
  });
afterAll(async () => {
  await browser?.close();
});
async function fixture(
  initiallyForeground = true,
  controlledClock = false,
  agendaWidth?: number,
): Promise<Page> {
  const page = await browser.newPage();
  if (controlledClock) await page.clock.install();
  page.setDefaultTimeout(3000);
  await page.setContent(
    '<style>html,body{margin:0;height:100%;font:16px system-ui}#app{height:100%;display:flex;min-height:0}</style><main id="app"></main>',
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    if(${controlledClock}) {const pending=new Set();const set=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window);window.timelineTimers=pending;window.setTimeout=(callback,delay,...args)=>{const id=set(()=>{pending.delete(id);callback(...args)},delay);pending.add(id);return id};window.clearTimeout=id=>{pending.delete(id);clear(id)}}
    window.base=Date.UTC(2026,9,11,12);window.time=base;window.revision='1';window.calls=0;window.watches=0;window.summaryCalls=0;window.mode='normal';window.released=false;
    window.channels=Array.from({length:100},(_,i)=>({id:'c'+i,sourceId:'s',name:'Channel '+i,guideSourceId:'g',xmltvChannelId:'x'+i,guideRevision:1}));
    const program=(c,delta=0,ordinal=0)=>({catalogSourceId:'s',appChannelId:c.id,guideSourceId:'g',xmltvChannelId:c.xmltvChannelId,startMs:base+delta,stopMs:base+delta+1800000,ordinal,title:delta?'Future listing':(window.longTitle||'Current listing'),description:'Fixture description',categories:[{text:'Sports',language:'en'}]});
    const host={initiallyForeground:${initiallyForeground},agendaWidth:${agendaWidth ?? 'undefined'},channels:()=>channels,catalogRevision:()=>revision,now:()=>time,formatTime:ms=>new Date(ms).toISOString(),formatAxisTime:ms=>new Date(ms).toISOString().slice(11,16),
      query:async(q,signal)=>{calls++; if(mode==='blocked')await new Promise(resolve=>{(window.blockedQueries??=[]).push(resolve);window.release=()=>{released=true;for(const waiting of window.blockedQueries.splice(0))waiting()}});const c=channels.find(c=>c.id===q.appChannelIds[0]);return {programs:mode==='dense'?Array.from({length:50},(_,i)=>({...program(c,0,i),title:'Overlap '+i})): [program(c),program(c,1800000,1)],nextCursor:null,sourceRevision:1,databaseRevision:1};},
      summary:async(c,atMs,signal)=>{summaryCalls++; if(mode==='summaryBlocked')await new Promise(resolve=>window.release=resolve); return {catalogSourceId:c.sourceId,appChannelId:c.id,atMs,requestId:'fixture',catalogRevision:revision,databaseRevision:1,mappingStatus:'mapped',mapping:{catalogSourceId:'s',appChannelId:c.id,guideSourceId:'g',xmltvChannelId:c.xmltvChannelId},sourceRevision:1,publishedRevision:1,updatedMs:base,coverage:{startMs:base,endMs:base+3600000},cacheStatus:mode==='stale'?'stale':'current',currentStatus:'current',nextStatus:'next',current:program(c),next:program(c,1800000,1)};},
      watch:async()=>{watches++;}};
    window.host=host;
    window.owner=Timeline.mountGuideTimeline(document.getElementById('app'),host);
  `,
  });
  if (initiallyForeground) await page.locator('.gx-timeline-row').nth(7).waitFor();
  return page;
}
async function rowCapacity(page: Page): Promise<number> {
  return page.locator('.gx-timeline-viewport').evaluate((viewport) => {
    const pitch = parseFloat(
      getComputedStyle(viewport.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
    );
    // Rendered rows: the viewport plus eight overscan rows each side, capped at 32.
    return Math.min(32, Math.max(1, Math.ceil(viewport.clientHeight / pitch) + 1) + 16);
  });
}
async function emptyFixture(unmapped = false) {
  const page = await fixture();
  await page.evaluate(async (unmapped) => {
    const host = Reflect.get(window, 'host');
    const summary = host.summary;
    host.query = async () => ({
      programs: [],
      nextCursor: null,
      sourceRevision: 1,
      databaseRevision: 1,
    });
    host.summary = async (c: TimelineChannel, atMs: number, signal: AbortSignal) => {
      const value = await summary(c, atMs, signal);
      return {
        ...value,
        mappingStatus: unmapped ? 'unmapped' : 'mapped',
        mapping: unmapped ? null : value.mapping,
        sourceRevision: unmapped ? null : 1,
        publishedRevision: unmapped ? null : 1,
        cacheStatus: unmapped ? 'unavailable' : 'current',
        current: null,
        next: null,
        currentStatus: unmapped ? null : 'empty',
        nextStatus: unmapped ? null : 'none',
      };
    };
    host.channelActivate = () => Reflect.set(window, 'watches', Reflect.get(window, 'watches') + 1);
    host.mapChannel = (channel: TimelineChannel) =>
      Reflect.set(window, 'mappedChannel', { id: channel.id, sourceId: channel.sourceId });
    Reflect.set(window, 'coverageQueries', []);
    host.channelCoverage = async (q: { startMs: number; endMs: number }, signal: AbortSignal) => {
      Reflect.get(window, 'coverageQueries').push(q);
      Reflect.set(window, 'coverageSignal', signal);
      if (Reflect.get(window, 'holdEmptyCoverage'))
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseEmptyCoverage', resolve));
      return {
        schemaVersion: 1,
        startMs: q.startMs,
        endMs: q.endMs,
        status: 'assessed',
        reason: null,
        sourceRevision: 1,
        publishedRevision: 1,
        coveredMs: 0,
        gapCount: 1,
        unknownEndCount: 0,
        gaps: [{ startMs: q.startMs, endMs: q.endMs }],
        gapsComplete: true,
      };
    };
    if (unmapped)
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
          ...c,
          guideSourceId: null,
          xmltvChannelId: null,
          guideRevision: undefined,
        })),
      );
    await Reflect.get(window, 'owner').refresh();
  }, unmapped);
  return page;
}
describe('actual timeline component', () => {
  it('listings already read are reused when scrolling back, and rows read four at a time', async () => {
    // Owner report, October 19, 2026: holding Down in the Sansui TV's guide
    // outran one-at-a-time reads that started over at every jump.
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        host.listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: saved.map((c: TimelineChannel) => ({
            catalogSourceId: c.sourceId,
            appChannelId: c.id,
            guideSourceId: c.guideSourceId,
            xmltvChannelId: c.xmltvChannelId,
            sourceRevision: 1,
          })),
        });
        // Counts reads in flight at once.
        const query = host.query;
        Reflect.set(window, 'inFlight', 0);
        Reflect.set(window, 'mostInFlight', 0);
        host.query = async (...args: unknown[]) => {
          Reflect.set(window, 'inFlight', Reflect.get(window, 'inFlight') + 1);
          Reflect.set(
            window,
            'mostInFlight',
            Math.max(Reflect.get(window, 'mostInFlight'), Reflect.get(window, 'inFlight')),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          try {
            return await query(...args);
          } finally {
            Reflect.set(window, 'inFlight', Reflect.get(window, 'inFlight') - 1);
          }
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      await page
        .getByRole('status')
        .getByText('Loading visible listings…')
        .waitFor({ state: 'detached' })
        .catch(() => undefined);
      await expect.poll(() => page.locator('.gx-timeline-cell').count()).toBeGreaterThan(0);
      const atTop = await page.evaluate(() => Reflect.get(window, 'calls'));
      const drawn = (first: string) =>
        expect
          .poll(() =>
            page.evaluate(
              (name) =>
                [...document.querySelectorAll('.gx-timeline-channel')].some(
                  (row) =>
                    row.textContent?.includes(name) &&
                    row.closest('.gx-timeline-row')?.querySelector('.gx-timeline-cell'),
                ),
              first,
            ),
          )
          .toBe(true);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await drawn('Channel 99');
      const atBottom = await page.evaluate(() => Reflect.get(window, 'calls'));
      expect(atBottom).toBeGreaterThan(atTop);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = 0;
      });
      await drawn('Channel 0');
      // Back at the top: every row there was read before, so nothing is asked again.
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(atBottom);
      expect(await page.evaluate(() => Reflect.get(window, 'mostInFlight'))).toBe(4);
    } finally {
      await page.close();
    }
  });
  it('listed membership hides unlinked and mapped-empty channels before virtualization and caches scroll/category work', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        saved[0].guideSourceId = null;
        saved[0].xmltvChannelId = null;
        saved[20].favorite = true;
        saved[20].category = 'Sports';
        Reflect.set(window, 'listedCalls', []);
        host.listedChannels = async (start: number, end: number) => {
          Reflect.get(window, 'listedCalls').push([start, end]);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: saved
              .slice(20, 40)
              .reverse()
              .map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(
        Array.from(
          { length: Math.min(20, await rowCapacity(page)) },
          (_, i) => `Channel ${20 + i}`,
        ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = 600;
      });
      // The scrolled-to row is drawn (from overscan or a redraw) without a membership query.
      await expect
        .poll(() =>
          page.locator('.gx-timeline-viewport').evaluate((node) => {
            const v = node.getBoundingClientRect();
            return [...node.querySelectorAll('.gx-timeline-row')].some((row) => {
              const r = row.getBoundingClientRect();
              return r.top <= v.top + 1 && r.bottom > v.top + 1;
            });
          }),
        )
        .toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.getByRole('button', { name: 'Favorites', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20']);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.getByRole('button', { name: 'All channels', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel').count())
        .toBe(Math.min(20, await rowCapacity(page)));
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
      for (let i = 1; i <= 12; i++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.querySelector('.media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${20 + i}`);
      }
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('Guide search filters listed channels as you type, looking a week ahead, and Clear restores the window', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        Reflect.set(window, 'listedCalls', []);
        // Stands in for the native query, which also matches program text.
        host.listedChannels = async (
          start: number,
          end: number,
          _signal: AbortSignal,
          search?: string,
        ) => {
          Reflect.get(window, 'listedCalls').push([end - start, search ?? null]);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: saved
              .slice(0, 40)
              .filter(
                (c: TimelineChannel) =>
                  !search ||
                  search === 'current listing' ||
                  c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      const box = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
      expect(await box.isVisible()).toBe(true);
      await box.fill('channel 3');
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 3', ...Array.from({ length: 10 }, (_, i) => `Channel ${30 + i}`)]);
      const calls = await page.evaluate(() => Reflect.get(window, 'listedCalls'));
      expect(calls.at(-1)).toEqual([7 * 86_400_000, 'channel 3']);
      // Typing pauses are coalesced: one query for the final text.
      expect(calls.filter((call: unknown[]) => call[1] !== null)).toHaveLength(1);
      // Matching listings are highlighted in the grid.
      await box.fill('current listing');
      await expect
        .poll(() => page.locator('.gx-timeline-cell.gx-timeline-match').count())
        .toBeGreaterThan(0);
      expect(await page.locator('.gx-timeline-cell.gx-timeline-match').allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining('Current listing')]),
      );
      expect(
        (await page.locator('.gx-timeline-cell.gx-timeline-match').allTextContents()).every((t) =>
          t.includes('Current listing'),
        ),
      ).toBe(true);
      await box.fill('nothing like this');
      await expect
        .poll(() => page.locator('.gx-timeline-status').textContent())
        .toContain('Nothing matches “nothing like this” in the next 7 days.');
      await box.fill('');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls').at(-1)))
        .toEqual([3 * 3_600_000, null]);
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').first().textContent())
        .toBe('Channel 0');
      // A remote leaves the empty field with Left/Right like any toolbar control.
      await box.focus();
      await page.keyboard.press('ArrowRight');
      // The first enabled time control (earlier times are disabled at the current time).
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Now');
      await page.keyboard.press('ArrowLeft');
      expect(await box.evaluate((node) => node === document.activeElement)).toBe(true);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('compact TV listed membership settles final ready geometry without rebuilding rows or losing D-pad focus', async () => {
    // The right-panel Guide keeps its grid down to PANEL_AGENDA_WIDTH.
    const page = await fixture(false, false, 480);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.addScriptTag({ content: shellBundle });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => {
        const timeline = document.querySelector('.gx-timeline')!;
        Reflect.get(window, 'Shell').createShell(document.querySelector('#app'));
        document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
        // The Guide opens in the right panel beside the channel list.
        document.getElementById('app')!.dataset.guidePanel = 'open';
        document.querySelector<HTMLElement>('#compact-view')!.hidden = true;
        const primary = document.querySelector<HTMLElement>('#primary-view-host')!;
        primary.hidden = false;
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline guide-compact-page';
        dialog.dataset.primaryPage = 'guide';
        dialog.innerHTML =
          '<div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        primary.append(dialog);
        dialog.querySelector('.guide-timeline-panel')!.append(timeline);
        dialog.show();
        const channels = Reflect.get(window, 'channels').slice(20, 26);
        Reflect.set(window, 'channels', channels);
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'queryPendingStates', []);
        const host = Reflect.get(window, 'host');
        host.listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: channels.map((c: TimelineChannel) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: c.guideSourceId,
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            })),
          };
        };
        const query = host.query;
        host.query = async (request: ProgramQuery, signal: AbortSignal) => {
          // Real IPC settles in a later task, allowing layout/ResizeObserver between row replies.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          signal.throwIfAborted();
          const status = document.querySelector<HTMLElement>('.gx-timeline-status')!;
          Reflect.get(window, 'queryPendingStates').push({
            state: status.dataset.state ?? null,
            text: status.textContent,
          });
          return query(request, signal);
        };
        Reflect.get(window, 'Remote').installRemoteNavigation();
        Reflect.set(window, 'readyWork', Reflect.get(window, 'owner').setForeground(true));
      });
      await page
        .locator('.gx-timeline-status[data-state="ready"]')
        .waitFor({ state: 'attached' })
        .catch(async (error) => {
          console.log(
            'compact-ready-state',
            await page.evaluate(() => ({
              queries: Reflect.get(window, 'calls'),
              membership: Reflect.get(window, 'listedCalls'),
              status: document.querySelector('.gx-timeline-status')?.textContent,
              rows: document.querySelectorAll('.gx-timeline-row').length,
              viewport: document.querySelector('.gx-timeline-viewport')?.clientHeight,
            })),
          );
          throw error;
        });
      await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      expect(
        await page
          .getByRole('button', { name: 'Channel 21', exact: true })
          .evaluate((n) => n === document.activeElement),
      ).toBe(true);
      const settled = await page.evaluate(async () => {
        const focused = document.activeElement;
        const before = Reflect.get(window, 'calls');
        for (let frame = 0; frame < 24; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const viewport = document.querySelector('.gx-timeline-viewport')!;
        const rect = focused!.getBoundingClientRect(),
          clip = viewport.getBoundingClientRect();
        return {
          before,
          after: Reflect.get(window, 'calls'),
          membership: Reflect.get(window, 'listedCalls'),
          state: document.querySelector<HTMLElement>('.gx-timeline-status')!.dataset.state ?? null,
          focusRetained: focused === document.activeElement && focused!.isConnected,
          visible: rect.top >= clip.top && rect.bottom <= clip.bottom,
          rows: document.querySelectorAll('.gx-timeline-row').length,
          watches: Reflect.get(window, 'watches'),
        };
      });
      expect(settled).toEqual({
        before: 6,
        after: 6,
        membership: 1,
        state: 'ready',
        focusRetained: true,
        visible: true,
        rows: 6,
        watches: 0,
      });
      expect(await page.evaluate(() => Reflect.get(window, 'queryPendingStates'))).toEqual(
        Array.from({ length: 6 }, () => ({ state: null, text: 'Loading visible listings…' })),
      );
      await page.keyboard.press('ArrowDown');
      expect(
        await page
          .getByRole('button', { name: 'Channel 22', exact: true })
          .evaluate((n) => n === document.activeElement),
      ).toBe(true);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership empty result shows a truthful zero state without querying dead rows', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [],
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-channel').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'No saved listings for this time. Find program guides or choose another time.',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each([6, 12])(
    'listed membership uses viewport-sized rows through tall-window D-pad navigation and a shorter resize (%s channels)',
    async (count) => {
      const page = await fixture(false);
      try {
        await page.setViewportSize({ width: 1280, height: 960 });
        await page.addStyleTag({ content: fullCss });
        await page.evaluate((count) => {
          const saved = Reflect.get(window, 'channels').slice(20, 20 + count);
          Reflect.set(window, 'channels', saved);
          Reflect.set(window, 'listedCalls', 0);
          Reflect.get(window, 'host').listedChannels = async () => {
            Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
            return {
              catalogRevision: '1',
              databaseRevision: 1,
              channels: saved.map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
            };
          };
        }, count);
        await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
        expect(await page.locator('.gx-timeline-channel').count()).toBe(count);
        await page.addScriptTag({ content: remoteBundle });
        await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
        await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
        const last = 19 + count;
        for (let index = 21; index <= last; index++) {
          await page.keyboard.press('ArrowDown');
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.querySelector('.media-result-title')?.textContent,
              ),
            )
            .toBe(`Channel ${index}`);
        }
        await page.setViewportSize({ width: 960, height: 540 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const active = document.activeElement,
                clip = document.querySelector('.gx-timeline-viewport')!;
              if (!(active instanceof HTMLElement)) return { label: null, visible: false };
              const a = active.getBoundingClientRect(),
                v = clip.getBoundingClientRect();
              return {
                label: active.querySelector('.media-result-title')?.textContent ?? null,
                visible: a.top >= v.top && a.bottom <= v.bottom,
              };
            }),
          )
          .toEqual({ label: `Channel ${last}`, visible: true })
          .catch(async (error) => {
            console.log(
              'tall-resize-geometry',
              await page.evaluate(() => {
                const active = document.activeElement as HTMLElement,
                  clip = document.querySelector('.gx-timeline-viewport') as HTMLElement;
                const a = active.getBoundingClientRect(),
                  v = clip.getBoundingClientRect();
                return {
                  activeTop: a.top,
                  activeBottom: a.bottom,
                  viewportTop: v.top,
                  viewportBottom: v.bottom,
                  scrollTop: clip.scrollTop,
                  clientHeight: clip.clientHeight,
                  rowHeight: document
                    .querySelector<HTMLElement>('.gx-timeline')
                    ?.style.getPropertyValue('--gx-row-height'),
                };
              }),
            );
            throw error;
          });
        for (let index = last - 1; index >= 20; index--) {
          await page.keyboard.press('ArrowUp');
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.querySelector('.media-result-title')?.textContent,
              ),
            )
            .toBe(`Channel ${index}`);
        }
        expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('listed membership bounds a very tall viewport to 32 intersecting rows and 1600 complete listing choices', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 1280, height: 3000 });
      await page.addStyleTag({ content: fullCss });
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'dense');
        Reflect.set(window, 'listedCalls', 0);
        Reflect.get(window, 'host').listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: c.guideSourceId,
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-row').count()).toBe(32);
      expect(await page.locator('.gx-timeline-cell').count()).toBe(32);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        const pitch = parseFloat(
          getComputedStyle(node.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
        );
        node.scrollTop = pitch / 2;
      });
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((node) => {
          const v = node.getBoundingClientRect(),
            pitch = parseFloat(
              getComputedStyle(node.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
            );
          return {
            bounded: node.clientHeight <= 31 * pitch,
            intersections: [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
              const r = row.getBoundingClientRect();
              return r.top < v.bottom && r.bottom > v.top;
            }).length,
          };
        }),
      ).toEqual({ bounded: true, intersections: 32 });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page
        .getByRole('button', { name: 'Channel 31', exact: true })
        .evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.querySelector('.media-result-title')?.textContent,
          ),
        )
        .toBe('Channel 32');
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      expect(await page.locator('.gx-timeline-choices button').count()).toBe(50);
      await page.getByRole('button', { name: /Overlap 49/ }).click();
      expect(await page.locator('.gx-timeline-details strong').textContent()).toBe('Overlap 49');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership grid queries drawable-only programmes instead of paging historical unknown-end context ahead of them', async () => {
    const page = await fixture(false);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        host.listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
            },
          ],
        });
        host.query = async (q: ProgramQuery) => {
          Reflect.set(window, 'listedQuery', q);
          const identity = {
            catalogSourceId: 's',
            appChannelId: 'c20',
            guideSourceId: 'g',
            xmltvChannelId: 'x20',
            description: null,
          };
          const programmes =
            q.contextAtMs === undefined
              ? [
                  {
                    ...identity,
                    startMs: q.windowStartMs + 1000,
                    stopMs: null,
                    title: 'Actual in-window unknown end',
                    ordinal: 100,
                  },
                ]
              : Array.from({ length: 50 }, (_, ordinal) => ({
                  ...identity,
                  startMs: q.windowStartMs - 1000,
                  stopMs: null,
                  title: 'Historical unknown ' + ordinal,
                  ordinal,
                }));
          return { programs: programmes, nextCursor: null, sourceRevision: 1, databaseRevision: 1 };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page
          .getByRole('button', { name: 'Actual in-window unknown end · end unknown', exact: true })
          .count(),
      ).toBe(1);
      expect(
        await page.evaluate(() => Reflect.get(window, 'listedQuery').contextAtMs),
      ).toBeUndefined();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership scopes the narrow chooser to real listings and preserves channel order without tuning', async () => {
    const page = await fixture(false, true);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [9, 4].map((i) => ({
            catalogSourceId: 's',
            appChannelId: 'c' + i,
            guideSourceId: 'g',
            xmltvChannelId: 'x' + i,
            sourceRevision: 1,
          })),
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      await page
        .getByRole('button', { name: 'Browse guide channel: Channel 4', exact: true })
        .click();
      expect(await page.locator('.gx-agenda-channel-option').allTextContents()).toEqual([
        'Channel 4',
        'Channel 9',
      ]);
      await page.getByRole('button', { name: 'Channel 9', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-agenda-channel').getAttribute('aria-label'))
        .toBe('Browse guide channel: Channel 9');
      expect(
        await page.getByRole('button', { name: 'Next guide channel', exact: true }).isDisabled(),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership hides old-window rows, joins an obsolete request and cannot steal later navigation focus', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'listedCalls', []);
        Reflect.set(window, 'listedSignals', []);
        host.listedChannels = async (start: number, end: number, signal: AbortSignal) => {
          const calls = Reflect.get(window, 'listedCalls');
          calls.push([start, end]);
          Reflect.get(window, 'listedSignals').push(signal);
          const n = calls.length;
          if (n === 2)
            await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: [
              {
                catalogSourceId: 's',
                appChannelId: n === 3 ? 'c21' : 'c20',
                guideSourceId: 'g',
                xmltvChannelId: n === 3 ? 'x21' : 'x20',
                sourceRevision: 1,
              },
            ],
          };
        };
        host.query = async (q: ProgramQuery) => ({
          programs: [
            {
              catalogSourceId: 's',
              appChannelId: q.appChannelIds[0],
              guideSourceId: 'g',
              xmltvChannelId: 'x' + q.appChannelIds[0].slice(1),
              startMs: q.windowStartMs,
              stopMs: q.windowEndMs,
              title: 'Window listing',
              description: null,
              ordinal: 0,
            },
          ],
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(['Channel 20']);
      await page.getByRole('button', { name: 'Next 3 hours', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls').length))
        .toBe(2);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'Checking saved listings…',
      );
      const later = page.getByRole('button', { name: 'Next day', exact: true });
      await later.click();
      expect(await page.evaluate(() => Reflect.get(window, 'listedSignals')[1].aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(2);
      await page.evaluate(() => Reflect.get(window, 'releaseListed')());
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 21']);
      expect(await later.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'listedCalls').map(
            (q: number[]) => q[0] - Reflect.get(window, 'base'),
          ),
        ),
      ).toEqual([0, 10800000, 97200000]);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership suspension joins the original held request and suppresses its late publication', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'listedStopped', false);
        Reflect.get(window, 'host').listedChannels = async (
          _start: number,
          _end: number,
          signal: AbortSignal,
        ) => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          Reflect.set(window, 'listedSignal', signal);
          if (Reflect.get(window, 'listedCalls') === 1)
            await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: [
              {
                catalogSourceId: 's',
                appChannelId: 'c20',
                guideSourceId: 'g',
                xmltvChannelId: 'x20',
                sourceRevision: 1,
              },
            ],
          };
        };
        Reflect.set(window, 'listedStart', Reflect.get(window, 'owner').setForeground(true));
      });
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
      await page.evaluate(() => {
        Reflect.set(
          window,
          'listedStop',
          Reflect.get(window, 'owner')
            .suspend()
            .then(() => Reflect.set(window, 'listedStopped', true)),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'listedSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedStopped'))).toBe(false);
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseListed')();
        await Reflect.get(window, 'listedStop');
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(2);
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(['Channel 20']);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['canceled', 'guide-cancelled', 'application-closing', 'database-busy', 'ack-failed'])(
    'real listed bridge cancellation joins producer and acknowledgement before Timeline reopen (%s)',
    async (outcome) => {
      const page = await fixture(false, true);
      try {
        await page.addScriptTag({ content: listedBridgeBundle });
        await page.evaluate(() => {
          // setContent uses an opaque origin; supply the secure-context UUID primitive used by IPC.
          if (!crypto.randomUUID)
            crypto.randomUUID = () =>
              '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) =>
                (
                  Number(digit) ^
                  (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(digit) / 4)))
                ).toString(16),
              ) as `${string}-${string}-${string}-${string}-${string}`;
          Reflect.set(window, 'isTauri', true);
          Reflect.set(window, 'nativeMembershipCalls', 0);
          Reflect.set(window, 'nativeRequestIds', []);
          Reflect.set(window, 'nativeCancelIds', []);
          Reflect.set(window, 'suspendSettled', false);
          Reflect.set(window, '__TAURI_INTERNALS__', {
            invoke: async (
              command: string,
              args: { requestId: string; query?: { startMs: number; endMs: number } },
            ) => {
              if (command === 'cancel_playlist') {
                Reflect.get(window, 'nativeCancelIds').push(args.requestId);
                return new Promise<void>((resolve, reject) => {
                  Reflect.set(window, 'finishNativeCancel', resolve);
                  Reflect.set(window, 'failNativeCancel', reject);
                });
              }
              if (command !== 'guide_listed_channels') throw new Error('Unexpected native command');
              const count = Reflect.get(window, 'nativeMembershipCalls') + 1;
              Reflect.set(window, 'nativeMembershipCalls', count);
              Reflect.get(window, 'nativeRequestIds').push(args.requestId);
              if (count === 1)
                return new Promise<never>((_resolve, reject) =>
                  Reflect.set(window, 'rejectNativeMembership', reject),
                );
              return {
                startMs: args.query!.startMs,
                endMs: args.query!.endMs,
                rootGeneration: 1,
                catalogRevision: '1',
                databaseRevision: 1,
                viewRevision: '11',
                groupingPolicy: 'exact-ordered-endpoints-policy-v2',
                channels: [
                  {
                    catalogSourceId: 's',
                    appChannelId: 'c20',
                    guideSourceId: 'g',
                    xmltvChannelId: 'x20',
                    sourceRevision: 1,
                    filterMask: 0,
                  },
                ],
                nextCursor: null,
              };
            },
          });
          Reflect.get(window, 'host').listedChannels = Reflect.get(
            window,
            'ListedBridge',
          ).readListedGuideChannels;
          Reflect.set(
            window,
            'initialMembership',
            Reflect.get(window, 'owner')
              .setForeground(true)
              .catch(() => {}),
          );
        });
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls')))
          .toBe(1);
        await page.evaluate(() => {
          Reflect.set(
            window,
            'suspendReceipt',
            Reflect.get(window, 'owner')
              .suspend()
              .then(
                () => {
                  Reflect.set(window, 'suspendSettled', true);
                  return null;
                },
                (error: unknown) => {
                  Reflect.set(window, 'suspendSettled', true);
                  return String(error);
                },
              ),
          );
        });
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'nativeCancelIds').length))
          .toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'nativeCancelIds')[0])).toBe(
          await page.evaluate(() => Reflect.get(window, 'nativeRequestIds')[0]),
        );
        expect(await page.evaluate(() => Reflect.get(window, 'suspendSettled'))).toBe(false);
        await page.evaluate(
          (code) =>
            Reflect.get(
              window,
              'rejectNativeMembership',
            )(code === 'ack-failed' ? 'canceled' : code),
          outcome,
        );
        // The original command has settled; the separately held matching ACK still owns cleanup.
        expect(await page.evaluate(() => Reflect.get(window, 'suspendSettled'))).toBe(false);
        expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
        const failure = await page.evaluate(async (code) => {
          if (code === 'ack-failed')
            Reflect.get(window, 'failNativeCancel')(new Error('ACK refused'));
          else Reflect.get(window, 'finishNativeCancel')();
          return Reflect.get(window, 'suspendReceipt');
        }, outcome);
        if (outcome === 'database-busy' || outcome === 'ack-failed') {
          expect(failure).toContain('cancellation could not finish');
          expect(
            await page.evaluate(async () => {
              try {
                await Reflect.get(window, 'owner').setForeground(true);
                return null;
              } catch (error) {
                return String(error);
              }
            }),
          ).toContain('cancellation could not finish');
          expect(await page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls'))).toBe(1);
          expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        } else {
          expect(failure).toBeNull();
          await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
          expect(await page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls'))).toBe(2);
          expect(
            await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
          ).toEqual(['Channel 20']);
          expect(
            await page.getByRole('button', { name: 'Current listing', exact: true }).count(),
          ).toBe(1);
        }
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        // Explicit cleanup failures remain errors in the assertions above; close the isolated browser fixture.
        await page.evaluate(() =>
          Reflect.get(window, 'owner')
            .dispose()
            .catch(() => {}),
        );
        await page.close();
      }
    },
  );
  for (const malformed of [
    'catalog',
    'mapping',
    'source-revision',
    'duplicate',
    'malformed',
  ] as const)
    it(`listed membership rejects ${malformed} scope without publishing partial channels or a false empty state`, async () => {
      const page = await fixture(false, true);
      try {
        await page.evaluate((malformed) => {
          Reflect.get(window, 'host').listedChannels = async () => {
            const member = {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: malformed === 'mapping' ? 'wrong' : 'g',
              xmltvChannelId: malformed === 'malformed' ? '' : 'x20',
              sourceRevision: malformed === 'source-revision' ? 2 : 1,
            };
            return {
              catalogRevision: malformed === 'catalog' ? '2' : '1',
              databaseRevision: 1,
              channels: malformed === 'duplicate' ? [member, member] : [member],
            };
          };
        }, malformed);
        await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
        expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        expect(await page.locator('.gx-timeline-status').textContent()).toBe(
          'Guide could not refresh. Choose Now to retry.',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    });
  it('listed membership keeps source identity exact instead of joining by app channel ID alone', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [
            {
              catalogSourceId: 'other',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
            },
          ],
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership invalidates on a changed programme revision and clears already rendered partial rows before retry', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'listedQueries', 0);
        Reflect.set(window, 'listedStable', false);
        const oldQuery = host.query;
        host.listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: Reflect.get(window, 'listedStable') ? 2 : 1,
            channels: [20, 21].map((i) => ({
              catalogSourceId: 's',
              appChannelId: 'c' + i,
              guideSourceId: 'g',
              xmltvChannelId: 'x' + i,
              sourceRevision: 1,
            })),
          };
        };
        host.query = async (q: ProgramQuery, signal: AbortSignal) => {
          Reflect.set(window, 'listedQueries', Reflect.get(window, 'listedQueries') + 1);
          const result = await oldQuery(q, signal);
          return {
            ...result,
            databaseRevision:
              Reflect.get(window, 'listedStable') || Reflect.get(window, 'listedQueries') === 2
                ? 2
                : 1,
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'listedQueries'))).toBe(2);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'Guide could not refresh. Choose Now to retry.',
      );
      await page.evaluate(() => Reflect.set(window, 'listedStable', true));
      await page.getByRole('button', { name: 'Now', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20', 'Channel 21']);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(2);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('channel cards reuse admitted artwork with safe fallback and no extra focus or query work', async () => {
    const page = await fixture();
    try {
      await page.evaluate(async () => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'logoMode', 'safe');
        Reflect.set(window, 'logoVisible', []);
        Reflect.set(window, 'logoRejected', []);
        host.logos = {
          get: () =>
            Reflect.get(window, 'logoMode') === 'remote'
              ? 'https://private.fixture.invalid/logo.png'
              : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          visible: (rows: TimelineChannel[]) =>
            Reflect.set(
              window,
              'logoVisible',
              rows.map((c) => c.id),
            ),
          rejected: (c: TimelineChannel) => Reflect.get(window, 'logoRejected').push(c.id),
          suspend: async () => {
            Reflect.set(window, 'logoVisible', []);
          },
        };
        await Reflect.get(window, 'owner').refresh();
      });
      const card = page.locator('.gx-timeline-channel').first();
      expect(await card.locator('.media-result-title').textContent()).toBe('Channel 0');
      expect(await card.getAttribute('aria-label')).toBe('Channel 0');
      expect(await card.locator('.channel-logo-image').count()).toBe(1);
      expect(
        await card.evaluate((node) => {
          const outer = node.getBoundingClientRect();
          return ['.media-result-artwork', '.media-result-title', '.media-result-subtitle'].every(
            (selector) => {
              const r = node.querySelector(selector)!.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.height > 0 &&
                r.left >= outer.left &&
                r.right <= outer.right &&
                r.top >= outer.top &&
                r.bottom <= outer.bottom
              );
            },
          );
        }),
      ).toBe(true);
      expect(await page.locator('.gx-timeline-row').first().locator('button').count()).toBe(3);
      await card.focus();
      const before = await page.evaluate(() => ({
        queries: Reflect.get(window, 'calls'),
        watches: Reflect.get(window, 'watches'),
      }));
      const obsoleteImage = await card.locator('img').elementHandle();
      await page.evaluate(() => Reflect.get(window, 'owner').refreshArtwork());
      await obsoleteImage!.evaluate((image) => image.dispatchEvent(new Event('error')));
      expect(await page.evaluate(() => Reflect.get(window, 'logoRejected'))).toEqual([]);
      expect(await card.evaluate((n) => n === document.activeElement)).toBe(true);
      expect(
        await page.evaluate(() => ({
          queries: Reflect.get(window, 'calls'),
          watches: Reflect.get(window, 'watches'),
        })),
      ).toEqual(before);
      await card.locator('img').dispatchEvent('error');
      expect(await card.locator('.media-result-artwork').textContent()).toBe('C0');
      expect(await page.evaluate(() => Reflect.get(window, 'logoRejected'))).toContain('c0');
      await page.evaluate(() => {
        Reflect.set(window, 'logoMode', 'remote');
        Reflect.get(window, 'owner').refreshArtwork();
      });
      expect(await card.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'logoVisible').length)).toBeGreaterThan(
        0,
      );
      await page.evaluate(() => Reflect.get(window, 'owner').suspend());
      expect(await page.evaluate(() => Reflect.get(window, 'logoVisible'))).toEqual([]);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('Guide artwork suspension joins its original owner and propagates unconfirmed cleanup', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').logos = {
          get: () => null,
          visible: () => {},
          rejected: () => {},
          suspend: () =>
            new Promise((_resolve, reject) => Reflect.set(window, 'rejectArtwork', reject)),
        };
        Reflect.set(window, 'artworkSettled', false);
        Reflect.set(
          window,
          'artworkStop',
          Reflect.get(window, 'owner')
            .suspend()
            .then(
              () => Reflect.set(window, 'artworkSettled', true),
              () => Reflect.set(window, 'artworkSettled', 'refused'),
            ),
        );
      });
      await page.waitForFunction(() => typeof Reflect.get(window, 'rejectArtwork') === 'function');
      expect(await page.evaluate(() => Reflect.get(window, 'artworkSettled'))).toBe(false);
      await page.evaluate(async () => {
        Reflect.get(window, 'rejectArtwork')(new Error('owned artwork cancellation unconfirmed'));
        await Reflect.get(window, 'artworkStop');
      });
      expect(await page.evaluate(() => Reflect.get(window, 'artworkSettled'))).toBe('refused');
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'host').logos.suspend = async () => {};
        return Reflect.get(window, 'owner').dispose();
      });
      await page.close();
    }
  });
  for (const width of [1280, 360]) {
    it.each([false, true])(
      `row schedule reason uses exact link metadata at ${width}px, unlinked=%s`,
      async (unmapped) => {
        const page = await emptyFixture(unmapped);
        try {
          await page.setViewportSize({ width, height: 640 });
          await page.evaluate(() => Reflect.get(window, 'owner').refresh());
          const note = page.locator('.gx-timeline-note').first();
          expect(await note.textContent()).toBe(
            unmapped ? 'Guide not linked' : 'No listings for this time',
          );
          const before = await page.evaluate(() => Reflect.get(window, 'calls'));
          await page.evaluate(() => {
            const host = Reflect.get(window, 'host');
            host.query = async () => {
              Reflect.set(window, 'calls', Reflect.get(window, 'calls') + 1);
              throw new Error('private fixture query failure');
            };
          });
          await page.evaluate(() => Reflect.get(window, 'owner').refresh());
          if (unmapped) {
            expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(before);
            expect(await note.textContent()).toBe('Guide not linked');
          } else {
            expect(await page.locator('.gx-timeline-status').textContent()).toBe(
              'Guide could not refresh. Choose Now to retry.',
            );
            expect(await page.locator('.gx-timeline-note').count()).toBe(0);
            expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).not.toBe(
              'ready',
            );
            expect(await page.getByRole('button', { name: 'Now', exact: true }).isEnabled()).toBe(
              true,
            );
          }
          expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        } finally {
          await page.evaluate(() => Reflect.get(window, 'owner').dispose());
          await page.close();
        }
      },
    );
  }
  it.each([false, true])(
    'empty schedule details preserve channel Watch and explicit contextual mapping, unmapped=%s',
    async (unmapped) => {
      const page = await emptyFixture(unmapped);
      try {
        const empty = page.locator('.gx-timeline-channel').first();
        expect(await page.locator('button.gx-timeline-note').count()).toBe(0);
        expect(await page.locator('.gx-timeline-note').first().textContent()).toBe(
          unmapped ? 'Guide not linked' : 'No listings for this time',
        );
        await empty.dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        const text = await page.locator('.gx-timeline-details').textContent();
        expect(text).toContain(
          unmapped ? 'This channel has not been matched to a saved guide' : 'No listings available',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(
          unmapped ? 0 : 1,
        );
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
        await page.keyboard.press('Escape');
        expect(await empty.evaluate((n) => n === document.activeElement)).toBe(true);
        await empty.dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'mappedChannel')))
          .toEqual({ id: 'c0', sourceId: 's' });
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('empty schedule details in narrow agenda preserve contextual actions without a new toolbar', async () => {
    const page = await emptyFixture(true);
    try {
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByRole('button', { name: 'Schedule details', exact: true }).click();
      await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
      expect(await page.locator('.gx-timeline-details').textContent()).toContain(
        'This channel has not been matched to a saved guide',
      );
      await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('empty schedule details join held coverage on background and suppress stale remapping', async () => {
    const page = await emptyFixture();
    try {
      await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
      await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
      await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
      await page.evaluate(() => {
        Reflect.set(window, 'emptyDrained', false);
        void Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'emptyDrained', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'emptyDrained'))).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'emptyDrained'))).toBe(true);
      expect(await page.getByRole('button', { name: 'Map guide', exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'releaseEmptyCoverage')?.();
        return Reflect.get(window, 'owner').dispose();
      });
      await page.close();
    }
  });
  it.each(['expired', 'changed', 'failure'])(
    'empty schedule details report %s without inventing coverage or blocking live Watch',
    async (mode) => {
      const page = await emptyFixture();
      try {
        await page.evaluate((mode) => {
          const host = Reflect.get(window, 'host');
          if (mode === 'expired') {
            const read = host.summary;
            host.summary = async (...args: unknown[]) => ({
              ...(await read(...args)),
              cacheStatus: 'stale',
            });
          }
          if (mode === 'changed')
            host.channelCoverage = async (q: { startMs: number; endMs: number }) => ({
              schemaVersion: 1,
              startMs: q.startMs,
              endMs: q.endMs,
              status: 'not-assessed',
              reason: 'source-stale',
              sourceRevision: 2,
              publishedRevision: 1,
              coveredMs: null,
              gapCount: null,
              unknownEndCount: null,
              gaps: [],
              gapsComplete: false,
            });
          if (mode === 'failure')
            host.channelCoverage = async () => {
              throw new Error('private source URL diagnostic');
            };
        }, mode);
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        const text = await page.locator('.gx-timeline-details').textContent();
        expect(text).toContain(
          mode === 'expired'
            ? 'out of date'
            : mode === 'changed'
              ? 'Guide changed'
              : 'could not be checked',
        );
        expect(text).not.toContain('private source');
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it.each(['remap', 'remove'])(
    'empty schedule details refuse stale channel actions after %s while retaining actual query ownership',
    async (action) => {
      const page = await emptyFixture();
      try {
        await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
        await page.evaluate((action) => {
          const channels = Reflect.get(window, 'channels') as TimelineChannel[];
          Reflect.set(
            window,
            'channels',
            action === 'remove'
              ? channels.filter((c) => c.id !== 'c0')
              : channels.map((c) => (c.id === 'c0' ? { ...c, xmltvChannelId: 'replacement' } : c)),
          );
        }, action);
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
        expect(await page.getByRole('button', { name: 'Map guide', exact: true }).count()).toBe(0);
      } finally {
        await page.evaluate(() => {
          Reflect.get(window, 'releaseEmptyCoverage')?.();
          return Reflect.get(window, 'owner').dispose();
        });
        await page.close();
      }
    },
  );
  async function coverageFixture(): Promise<Page> {
    const page = await fixture();
    await page.addScriptTag({
      content: `
      window.coverageQueries=[];window.coverageMode='normal';
      host.channelCoverage=async(q,signal)=>{
        window.coverageQueries.push(q);window.coverageSignal=signal;
        if(coverageMode==='held')await new Promise(resolve=>window.releaseCoverage=resolve);
        if(coverageMode==='failure')throw new Error('private source diagnostic');
        if(coverageMode==='stale')return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'not-assessed',reason:'source-stale',sourceRevision:2,publishedRevision:1,coveredMs:null,gapCount:null,unknownEndCount:null,gaps:[],gapsComplete:false};
        const gaps=q.xmltvChannelId==='x0'?[]:[{startMs:q.startMs+3600000,endMs:q.endMs}];
        return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'assessed',reason:null,
          sourceRevision:1,publishedRevision:1,coveredMs:q.endMs-q.startMs-gaps.reduce((sum,g)=>sum+g.endMs-g.startMs,0),gapCount:gaps.length,unknownEndCount:q.xmltvChannelId==='x2'?1:0,gaps,gapsComplete:true};
      };`,
    });
    return page;
  }
  it('explicit next-week check measures exact channel intervals without downloading or claiming feed-wide coverage', async () => {
    const page = await emptyFixture();
    try {
      await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
      await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(1);
      await page.evaluate(() => {
        Reflect.get(window, 'host').channelCoverage = async (q: {
          startMs: number;
          endMs: number;
        }) => {
          Reflect.get(window, 'coverageQueries').push(q);
          const through = q.startMs + 86400000;
          return {
            schemaVersion: 1,
            startMs: q.startMs,
            endMs: q.endMs,
            status: 'assessed',
            reason: null,
            sourceRevision: 1,
            publishedRevision: 1,
            coveredMs: 86400000,
            gapCount: 1,
            unknownEndCount: 0,
            gaps: [{ startMs: through, endMs: q.endMs }],
            gapsComplete: true,
          };
        };
      });
      // Details initially focuses Back; the new disclosure and check remain
      // reachable with ordinary keyboard navigation and native activation.
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ??
            document.activeElement?.textContent,
        ),
      ).toBe('Next seven days');
      expect(
        await page
          .locator('.gx-timeline-details summary')
          .evaluate((node) => node.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ??
            document.activeElement?.textContent,
        ),
      ).toBe('Check next seven days');
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.locator('.gx-timeline-week-coverage').textContent())
        .toContain('Schedule available through');
      const queries = await page.evaluate(() => Reflect.get(window, 'coverageQueries'));
      expect(queries).toHaveLength(2);
      expect(queries[1]).toMatchObject({
        sourceId: 'g',
        xmltvChannelId: 'x0',
        expectedSourceRevision: 1,
        expectedPublishedRevision: 1,
      });
      expect(queries[1].endMs - queries[1].startMs).toBe(7 * 86400000);
      expect(await page.locator('.gx-timeline-week-coverage').textContent()).toContain(
        '1 gap in the next seven days',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Map guide', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'mappedChannel')))
        .toEqual({ id: 'c0', sourceId: 's' });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['back', 'remap', 'suspend'])(
    'held next-week assessment retains ownership and suppresses stale results after %s',
    async (action) => {
      const page = await emptyFixture();
      try {
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
        await page.locator('.gx-timeline-details summary').click();
        await page.getByRole('button', { name: 'Check next seven days', exact: true }).click();
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
        if (action === 'back')
          await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        if (action === 'remap')
          await page.evaluate(() => {
            Reflect.get(window, 'channels')[0].xmltvChannelId = 'changed';
          });
        if (action === 'suspend') {
          await page.evaluate(() => {
            Reflect.set(window, 'weekDrained', false);
            void Reflect.get(window, 'owner')
              .suspend()
              .then(() => Reflect.set(window, 'weekDrained', true));
          });
          expect(await page.evaluate(() => Reflect.get(window, 'weekDrained'))).toBe(false);
        }
        if (action !== 'remap')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(
            true,
          );
        await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
        if (action === 'suspend')
          await page.waitForFunction(() => Reflect.get(window, 'weekDrained'));
        expect(
          (await page.locator('.gx-timeline-week-coverage').allTextContents()).join(''),
        ).not.toContain('No listings available');
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => {
          Reflect.get(window, 'releaseEmptyCoverage')?.();
          return Reflect.get(window, 'owner').dispose();
        });
        await page.close();
      }
    },
  );
  it('assesses only explicitly selected channels in the actual three-hour window, not shared feed extrema', async () => {
    const page = await coverageFixture();
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(0);
      for (const [index, label] of [
        [0, 'No schedule gaps in this window'],
        [1, 'Schedule has 1 gap in this window'],
        [2, '1 program end time unknown'],
      ] as const) {
        await page
          .locator('.gx-timeline-row')
          .nth(index)
          .getByRole('button', { name: 'Current listing', exact: true })
          .click();
        await expect
          .poll(() => page.locator('.gx-timeline-channel-coverage').textContent())
          .toContain(label);
        expect(await page.locator('.gx-timeline-channel-coverage').textContent()).not.toContain(
          'programme accuracy',
        );
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      }
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries'))).toEqual(
        [0, 1, 2].map((i) => ({
          schemaVersion: 1,
          sourceId: 'g',
          xmltvChannelId: 'x' + i,
          startMs: Date.UTC(2026, 9, 11, 12),
          endMs: Date.UTC(2026, 9, 11, 15),
          expectedSourceRevision: 1,
          expectedPublishedRevision: 1,
        })),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['failure', 'stale', 'absent'])(
    'keeps listing details truthful when coverage is %s',
    async (mode) => {
      const page = await coverageFixture();
      try {
        await page.evaluate((mode) => {
          Reflect.set(window, 'coverageMode', mode);
          if (mode === 'absent') Reflect.get(window, 'host').channelCoverage = undefined;
        }, mode);
        await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
        await page.getByRole('button', { name: 'Watch current channel', exact: true }).waitFor();
        expect(await page.locator('.gx-timeline-channel-coverage').textContent()).toContain(
          mode === 'stale' ? 'Guide changed' : 'Channel schedule coverage not assessed',
        );
        expect(await page.locator('.gx-timeline-details').textContent()).toContain(
          'Fixture description',
        );
        expect(await page.locator('.gx-timeline-details').textContent()).not.toContain(
          'private source diagnostic',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it.each(['back', 'window', 'remap', 'suspend'])(
    'joins held coverage and suppresses obsolete results after %s',
    async (action) => {
      const page = await coverageFixture();
      try {
        await page.evaluate(() => Reflect.set(window, 'coverageMode', 'held'));
        await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseCoverage'));
        if (action === 'back')
          await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        if (action === 'window')
          await page.getByRole('button', { name: 'Next 3 hours', exact: true }).click();
        if (action === 'remap')
          await page.evaluate(() => {
            Reflect.get(window, 'channels')[0].xmltvChannelId = 'changed';
          });
        if (action === 'suspend')
          await page.evaluate(() => {
            Reflect.set(window, 'coverageDrained', false);
            void Reflect.get(window, 'owner')
              .suspend()
              .then(() => Reflect.set(window, 'coverageDrained', true));
          });
        if (action !== 'remap')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(
            true,
          );
        if (action === 'suspend')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageDrained'))).toBe(false);
        await page.evaluate(() => Reflect.get(window, 'releaseCoverage')());
        if (action === 'suspend')
          await page.waitForFunction(() => Reflect.get(window, 'coverageDrained'));
        await expect
          .poll(() =>
            page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
          )
          .toBe(0);
        expect(await page.locator('.gx-timeline-channel-coverage').allTextContents()).not.toContain(
          'No schedule gaps in this window. Listings do not confirm stream availability.',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls'))).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('long titles use two readable lines with complete accessible details and four TV rows', async () => {
    const page = await fixture();
    const title =
      'A very long live championship listing with complete teams, venue and programme details available after opening this listing';
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.evaluate(async (text) => {
        Reflect.set(window, 'longTitle', text);
        Reflect.set(
          window,
          'channels',
          Reflect.get(window, 'channels')
            .slice(0, 30)
            .map((c: TimelineChannel, i: number) => ({
              ...c,
              guideSourceId: i < 3 ? 'g' : null,
              xmltvChannelId: i < 3 ? 'x' + i : null,
            })),
        );
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline';
        dialog.innerHTML =
          '<header class="guide-header"><h2>Program guide</h2><button aria-label="Close guide">Close</button></header><div class="guide-dropdown"><button aria-label="Guide view">Channel guide</button></div><div class="guide-feedback"><p>3 of 30 channels connected to program guides.</p><p></p></div><button>Find program guides</button><div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        document.querySelector('#app')!.append(dialog);
        dialog
          .querySelector('.guide-timeline-panel')!
          .append(document.querySelector('.gx-timeline')!);
        dialog.showModal();
        await Reflect.get(window, 'owner').refresh();
      }, title);
      const cell = page.getByRole('button', { name: title, exact: true }).first();
      const metrics = await cell.locator('.gx-timeline-cell-label').evaluate((n) => {
        const style = getComputedStyle(n),
          r = n.getBoundingClientRect();
        return {
          clamp: style.webkitLineClamp,
          font: parseFloat(style.fontSize),
          height: r.height,
          line: parseFloat(style.lineHeight),
          fullText: n.textContent,
        };
      });
      expect(metrics.clamp).toBe('2');
      expect(metrics.font).toBeGreaterThanOrEqual(16);
      expect(metrics.height).toBeLessThanOrEqual(metrics.line * 2 + 1);
      expect(metrics.fullText).toBe(title);
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => {
          const v = n.getBoundingClientRect();
          return [...n.querySelectorAll('.gx-timeline-row')].filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= v.top && b.bottom <= v.bottom && b.height === 64;
          }).length;
        }),
      ).toBeGreaterThanOrEqual(4);
      expect(await cell.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
        44,
      );
      await page.screenshot({ path: `${captureDirectory}/long-title-960x540.png` });
      await cell.click();
      await expect
        .poll(() => page.locator('.gx-timeline-details strong').first().textContent())
        .toBe(title);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.keyboard.press('Escape');
      expect(await cell.evaluate((n) => n === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('rapid D-pad repeats remain owned while a row query is pending', async () => {
    const page = await fixture();
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page.getByRole('button', { name: 'Channel 0', exact: true }).focus();
      for (let index = 1; index <= 7; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
      }
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'blocked');
        Reflect.set(window, 'release', null);
      });
      // Overscan rows need no query; keep moving until a row beyond them does.
      let reached = 7;
      for (let press = 0; press < 40; press++) {
        await page.keyboard.press('ArrowDown');
        reached++;
        if ((await page.evaluate(() => typeof Reflect.get(window, 'release'))) === 'function')
          break;
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.querySelector('.media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${reached}`);
      }
      await expect
        .poll(() => page.evaluate(() => typeof Reflect.get(window, 'release')))
        .toBe('function');
      const pendingCalls = await page.evaluate(() => Reflect.get(window, 'calls'));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => n === document.activeElement),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(pendingCalls);
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'normal');
        Reflect.get(window, 'release')();
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.activeElement?.querySelector('.media-result-title')?.textContent ??
              document.activeElement?.textContent,
          ),
        )
        .toBe(`Channel ${reached + 1}`);
      expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
        await rowCapacity(page),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'normal');
        Reflect.get(window, 'release')?.();
      });
      await page.close();
    }
  });
  it('D-pad preserves channel identity through more than eight rendered rows and details Back', async () => {
    const page = await fixture();
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(async () => {
        Reflect.set(window, 'channels', Reflect.get(window, 'channels').slice(0, 40));
        await Reflect.get(window, 'owner').refresh();
        Reflect.get(window, 'Remote').installRemoteNavigation();
      });
      await page.getByRole('button', { name: 'Channel 0', exact: true }).focus();
      for (let index = 1; index <= 39; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
          await rowCapacity(page),
        );
      }
      await page.keyboard.press('ArrowRight');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 39');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Back to timeline' }).waitFor();
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 39');
      await page.keyboard.press('ArrowLeft');
      for (let index = 38; index >= 0; index--) {
        await page.keyboard.press('ArrowUp');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
          await rowCapacity(page),
        );
      }
      await page.keyboard.press('ArrowRight');
      for (let index = 1; index <= 12; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement
                  ?.closest('.gx-timeline-row')
                  ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(
          await page.evaluate(() => document.activeElement?.classList.contains('gx-timeline-cell')),
        ).toBe(true);
      }
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Back to timeline' }).waitFor();
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 12');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('closed-modal startup has no query; explicit foreground loads once and disposal refuses new work', async () => {
    const page = await fixture(false);
    try {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      const loaded = await page.evaluate(() => Reflect.get(window, 'calls'));
      expect(loaded).toBe(await rowCapacity(page));
      await page.evaluate(async () => {
        await Reflect.get(window, 'owner').dispose();
        await Reflect.get(window, 'owner').setForeground(true);
        await Reflect.get(window, 'owner').refresh();
      });
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(loaded);
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('future details never tune; explicit Watch requires a fresh summary and Back restores the listing', async () => {
    const page = await fixture();
    try {
      const future = page.getByRole('button', { name: 'Future listing', exact: true }).first();
      await future.click();
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      expect(await future.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
      await page.getByRole('button', { name: 'Watch current channel' }).waitFor();
      await page.evaluate(() => Reflect.set(window, 'mode', 'stale'));
      await page.getByRole('button', { name: 'Watch current channel' }).click();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls'))).toBe(3);
    } finally {
      await page.close();
    }
  });
  it('future schedule countdown crosses UTC boundaries without tuning and suspends its timer', async () => {
    const page = await fixture(true, true);
    try {
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      const countdown = page.locator('.gx-timeline-countdown');
      await expect.poll(() => countdown.textContent()).toBe('Starts in 30m');
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(1);
      expect(await page.locator('.gx-timeline-details p').first().textContent()).toContain(
        '2026-10-11T12:30:00.000Z',
      );
      const calls = await page.evaluate(() => Reflect.get(window, 'calls'));
      for (const [delta, label] of [
        [1799000, 'Starts in 1s'],
        [1800000, 'Scheduled now'],
        [3600000, 'Ended'],
        [0, 'Starts in 30m'],
      ] as const) {
        await page.evaluate(
          (value) => Reflect.set(window, 'time', Reflect.get(window, 'base') + value),
          delta,
        );
        await page.clock.runFor(1000);
        expect(await countdown.textContent()).toBe(label);
      }
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(calls);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').suspend());
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(0);
      await page.clock.runFor(60000);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(calls);
      expect(await countdown.count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(0);
      await page.clock.runFor(60000);
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('stale or changed schedule identity never publishes a confirmed countdown', async () => {
    const page = await fixture(true, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'mode', 'stale'));
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      await expect
        .poll(() => page.locator('.gx-timeline-countdown').textContent())
        .toContain('Schedule may have changed');
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      await page.evaluate(() => Reflect.set(window, 'mode', 'summaryBlocked'));
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      await page.waitForFunction(() => Reflect.get(window, 'summaryCalls') === 2);
      await page.evaluate(() => {
        Reflect.set(window, 'revision', '2');
        Reflect.get(window, 'channels')[0].xmltvChannelId = 'replacement';
        Reflect.get(window, 'release')();
      });
      await page.clock.runFor(1000);
      expect(await page.locator('.gx-timeline-countdown').textContent()).not.toContain('Starts in');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('overlap chooser preserves all bounded visible listing choices without covered sibling cells', async () => {
    const page = await fixture();
    try {
      await page.evaluate(async () => {
        Reflect.set(window, 'mode', 'dense');
        await Reflect.get(window, 'owner').refresh();
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(await rowCapacity(page));
      expect(await page.locator('.gx-timeline-cell').count()).toBe(await rowCapacity(page));
      // Overlaps show the first title and how many more, never a bare count.
      const overlap = page
        .getByRole('button', { name: 'Overlap 0 and 49 more listings', exact: true })
        .first();
      expect(await overlap.textContent()).toBe('Overlap 0 +49');
      await overlap.click();
      expect(await page.locator('.gx-timeline-choices button').count()).toBe(50);
      await page.getByRole('button', { name: /Overlap 49/ }).click();
      expect(await page.locator('.gx-timeline-details strong').textContent()).toBe('Overlap 49');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('suspension joins a real pending query and fences its late rows; explicit resume is reusable', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'blocked');
        void Reflect.get(window, 'owner').refresh();
      });
      await page.getByRole('status').getByText('Loading visible listings…').waitFor();
      await page.evaluate(() => {
        Reflect.set(window, 'drained', false);
        void Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'drained', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'drained'))).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'release')());
      await page.waitForFunction(() => Reflect.get(window, 'drained') === true);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      await page.evaluate(async () => {
        Reflect.set(window, 'mode', 'normal');
        await Reflect.get(window, 'owner').setForeground(true);
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(await rowCapacity(page));
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('catalog/mapping changes during summary acquisition cannot admit Watch', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => Reflect.set(window, 'mode', 'summaryBlocked'));
      await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
      await page.waitForFunction(() => Reflect.get(window, 'summaryCalls') === 1);
      await page.evaluate(() => {
        Reflect.set(window, 'revision', '2');
        Reflect.get(window, 'channels')[0].xmltvChannelId = 'different';
        Reflect.get(window, 'release')();
      });
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  for (const size of [
    { width: 960, height: 540 },
    { width: 320, height: 640 },
  ])
    it(`bounded timeline geometry ${size.width}x${size.height} enlarged text`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize(size);
        await page.locator('.gx-timeline').evaluate((node) => {
          (node as HTMLElement).style.fontSize = '32px';
        });
        for (const name of ['Previous 3 hours', 'Now', 'Next 3 hours']) {
          const rect = await page.getByRole('button', { name, exact: true }).boundingBox();
          expect(rect!.height).toBeGreaterThanOrEqual(44);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(size.width);
          expect(rect!.y + rect!.height).toBeLessThan(size.height);
        }
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
        expect(
          await page.locator('.gx-timeline-viewport').evaluate((node) => node.clientHeight),
        ).toBeGreaterThan(80);
        expect(await page.locator('video').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
});

async function narrowAgenda(
  size: { width: number; height: number; font: number },
  realShell = false,
) {
  const page = await fixture();
  await page.setViewportSize(size);
  if (realShell) {
    await page.addStyleTag({ content: fullCss });
    await page.addScriptTag({ content: shellBundle });
    await page.evaluate(() => {
      const timeline = document.querySelector('.gx-timeline')!;
      Reflect.get(window, 'Shell').createShell(document.querySelector('#app'));
      document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'personal';
      // The Guide opens in the right panel beside the channel list.
      document.getElementById('app')!.dataset.guidePanel = 'open';
      document.querySelector<HTMLElement>('#compact-view')!.hidden = true;
      const host = document.querySelector<HTMLElement>('#primary-view-host')!;
      host.hidden = false;
      const dialog = document.createElement('dialog');
      dialog.className = 'guide-dialog guide-with-timeline guide-compact-page';
      dialog.dataset.primaryPage = 'guide';
      dialog.innerHTML =
        '<div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
      host.append(dialog);
      dialog.querySelector('.guide-timeline-panel')!.append(timeline);
      dialog.show();
    });
  }
  await page.evaluate(async (font) => {
    document.body.style.fontSize = `${font}px`;
    document.querySelector<HTMLElement>('.gx-timeline')!.style.fontSize = `${font}px`;
    Reflect.get(window, 'channels')[0].name = 'Sports channel with its full regional identity';
    Reflect.set(
      window,
      'longTitle',
      'Live championship: complete teams, venue and match information',
    );
    await Reflect.get(window, 'owner').refresh();
  }, size.font);
  await expect.poll(() => page.locator('.gx-timeline').getAttribute('data-layout')).toBe('agenda');
  return page;
}
for (const size of [
  { width: 320, height: 640, font: 16 },
  { width: 360, height: 640, font: 16 },
  { width: 640, height: 360, font: 16 },
  { width: 320, height: 640, font: 32 },
  { width: 360, height: 640, font: 32 },
  { width: 640, height: 360, font: 32 },
])
  it(`real shell readable agenda ${size.width}x${size.height} font${size.font}`, async () => {
    const page = await narrowAgenda(size, true);
    try {
      const listing = page.getByRole('button', {
        name: 'Live championship: complete teams, venue and match information',
        exact: true,
      });
      await listing.scrollIntoViewIfNeeded();
      expect(await listing.getAttribute('aria-label')).toBe(
        'Live championship: complete teams, venue and match information',
      );
      expect(
        await page
          .getByRole('button', {
            name: 'Browse guide channel: Sports channel with its full regional identity',
            exact: true,
          })
          .getAttribute('title'),
      ).toBe('Sports channel with its full regional identity');
      expect(await page.locator('.gx-timeline-axis').isVisible()).toBe(false);
      expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => n.clientHeight),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await listing.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
          return (
            r.height >= 44 &&
            r.width >= 44 &&
            r.left >= v.left &&
            r.right <= v.right &&
            Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) >= 44 &&
            n.scrollWidth <= n.clientWidth
          );
        }),
      ).toBe(true);
      const toggle = page.getByRole('button', { name: 'Guide controls', exact: true });
      if (await toggle.isVisible()) {
        const geometry = await listing.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
          return {
            listing: r.height,
            viewport: v.height,
            root: document.querySelector('.gx-timeline')!.getBoundingClientRect().height,
            toolbar: document.querySelector('.gx-timeline-toolbar')!.getBoundingClientRect().height,
            header: document.querySelector('.gx-agenda-header')!.getBoundingClientRect().height,
            statusParent: document.querySelector('.gx-timeline-status')!.parentElement!.className,
            time: getComputedStyle(n.querySelector('.gx-agenda-time')!).fontSize,
          };
        });
        await page.screenshot({
          path: `${captureDirectory}/short-agenda-before-controls-font${size.font}.png`,
        });
        expect(geometry.listing <= geometry.viewport, JSON.stringify(geometry)).toBe(true);
        await toggle.click();
      }
      for (const name of ['Previous 3 hours', 'Now', 'Next 3 hours', 'Previous day', 'Next day']) {
        const control = page.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((n) => {
            const r = n.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.width >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight
            );
          }),
        ).toBe(true);
      }
      if (await toggle.isVisible()) await toggle.click();
      await listing.click();
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      expect(await listing.evaluate((n) => document.activeElement === n)).toBe(true);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${captureDirectory}/agenda-${size.width}x${size.height}-font${size.font}.png`,
      });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
it('continuous agenda channel chooser stays bounded through31 keys and browses without tuning', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() =>
      Reflect.set(window, 'remote', Reflect.get(window, 'Remote').installRemoteNavigation()),
    );
    await page
      .getByRole('button', {
        name: 'Browse guide channel: Sports channel with its full regional identity',
        exact: true,
      })
      .click();
    expect(await page.getByRole('button', { name: 'More channels', exact: true }).count()).toBe(0);
    for (let i = 0; i < 31; i++) {
      await page.keyboard.press('ArrowDown');
      expect(await page.locator('.gx-agenda-channel-option').count()).toBeLessThanOrEqual(8);
    }
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-channel-index')),
    ).toBe('31');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.locator('.gx-agenda-channel .media-result-title').textContent())
      .toBe('Channel 31');
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    const listing = page.getByRole('button', {
      name: 'Live championship: complete teams, venue and match information',
      exact: true,
    });
    await listing.focus();
    await page.keyboard.press('ArrowDown');
    expect(
      await page
        .getByRole('button', { name: 'Future listing', exact: true })
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
    ).toBe(0);
    await page.keyboard.press('Escape');
    expect(
      await page
        .getByRole('button', { name: 'Future listing', exact: true })
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await listing.click();
    await page.getByRole('button', { name: 'Watch current channel', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'remote')();
      return Reflect.get(window, 'owner').dispose();
    });
    await page.close();
  }
});
it('agenda pages are bounded, use exact channel scope and never report loaded rows as total coverage', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      const base = Reflect.get(window, 'base');
      Reflect.set(window, 'agendaQueries', []);
      host.query = async (q: Record<string, unknown>) => {
        Reflect.get(window, 'agendaQueries').push(q);
        const start = q.cursor ? 50 : 0;
        return {
          sourceRevision: 1,
          databaseRevision: 1,
          programs: Array.from({ length: 50 }, (_, j) => ({
            catalogSourceId: 's',
            appChannelId: q.appChannelIds instanceof Array ? q.appChannelIds[0] : '',
            guideSourceId: 'g',
            xmltvChannelId: 'x0',
            startMs: base + (start + j) * 1000,
            stopMs: base + (start + j + 1) * 1000,
            ordinal: start + j,
            title: 'Listing ' + (start + j),
            description: 'Full detail',
            categories: [],
          })),
          nextCursor: q.cursor ? null : { startMs: base + 49000, ordinal: 49, appChannelId: 'c0' },
        };
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(50);
    expect(await page.locator('.gx-timeline-status').textContent()).toContain('50 listings shown');
    expect(await page.locator('.gx-timeline-status').textContent()).toContain(
      'More listings available',
    );
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Listing 99', exact: true }).waitFor();
    expect(await page.locator('.gx-agenda-listing').count()).toBe(50);
    expect(await page.getByRole('button', { name: 'More listings', exact: true }).count()).toBe(0);
    const queries = await page.evaluate(() => Reflect.get(window, 'agendaQueries'));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      guideSourceId: 'g',
      appChannelIds: ['c0'],
      search: '',
      pageSize: 50,
      cursor: null,
    });
    expect(queries[1].contextAtMs).toBe(queries[0].contextAtMs);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.getByRole('button', { name: 'First listings', exact: true }).click();
    await page.getByRole('button', { name: 'Listing 0', exact: true }).waitFor();
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda native cursor scope survives paging and resets cache scope without switching saved channels', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'cursorQueries', []);
      Reflect.set(window, 'dbRevision', 1);
      Reflect.set(window, 'rejectContinued', false);
      host.query = async (q: ProgramQuery) => {
        Reflect.get(window, 'cursorQueries').push(structuredClone(q));
        const channel = Reflect.get(window, 'channels').find(
          (c: TimelineChannel) => c.id === q.appChannelIds[0],
        );
        const sourceRevision = channel.guideRevision ?? 1;
        const databaseRevision = Reflect.get(window, 'dbRevision');
        const key = JSON.stringify([
          q.guideSourceId,
          q.appChannelIds,
          q.windowStartMs,
          q.windowEndMs,
          q.contextAtMs ?? null,
          q.search,
        ]);
        if (
          q.cursor &&
          (q.cursor.queryKey !== key ||
            q.cursor.sourceRevision !== sourceRevision ||
            q.cursor.databaseRevision !== databaseRevision ||
            Reflect.get(window, 'rejectContinued'))
        )
          throw new Error('guide-stale-cursor');
        if (Reflect.get(window, 'holdCursorRead')) {
          Reflect.set(window, 'holdCursorRead', false);
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseCursorRead', resolve));
        }
        return {
          sourceRevision,
          databaseRevision,
          programs: [
            {
              catalogSourceId: channel.sourceId,
              appChannelId: channel.id,
              guideSourceId: channel.guideSourceId,
              xmltvChannelId: channel.xmltvChannelId,
              startMs: q.windowStartMs,
              stopMs: q.windowStartMs + 60000,
              ordinal: q.cursor ? 1 : 0,
              title: q.cursor ? 'Continued fresh listing' : 'First fresh listing',
              description: null,
              categories: [],
            },
          ],
          nextCursor: q.cursor
            ? null
            : {
                queryKey: key,
                guideSourceId: channel.guideSourceId,
                sourceRevision,
                databaseRevision,
                startMs: q.windowStartMs,
                ordinal: 0,
                appChannelId: channel.id,
              },
        };
      };
      await Reflect.get(window, 'owner').refresh();
    });
    await page.getByRole('button', { name: 'Next guide channel', exact: true }).click();
    await expect
      .poll(() => page.locator('.gx-agenda-channel .media-result-title').textContent())
      .toBe('Channel 1');
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).waitFor();
    await page.evaluate(() => {
      Reflect.set(window, 'holdCursorRead', true);
      Reflect.set(window, 'heldCursorWork', Reflect.get(window, 'owner').refresh());
    });
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseCursorRead')))
      .toBe('function');
    await page.evaluate(() => {
      const channels = Reflect.get(window, 'channels');
      Reflect.set(
        window,
        'channels',
        channels.map((c: TimelineChannel) =>
          c.id === 'c1' ? { ...c, guideRevision: 2, xmltvChannelId: 'fresh-x1' } : c,
        ),
      );
      Reflect.set(window, 'dbRevision', 2);
      Reflect.set(window, 'cacheReloadDone', false);
      Reflect.set(
        window,
        'cacheReload',
        Reflect.get(window, 'owner')
          .setForeground(true)
          .then(() => Reflect.set(window, 'cacheReloadDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'cacheReloadDone'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseCursorRead')();
      await Reflect.get(window, 'heldCursorWork');
      await Reflect.get(window, 'cacheReload');
    });
    expect(await page.locator('.gx-agenda-channel .media-result-title').textContent()).toBe(
      'Channel 1',
    );
    expect(
      await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).count(),
    ).toBe(0);
    await page.getByRole('button', { name: 'First fresh listing', exact: true }).waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'cursorQueries').at(-1))).toMatchObject({
      appChannelIds: ['c1'],
      cursor: null,
    });
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).waitFor();
    await page.evaluate(async () => {
      Reflect.set(window, 'dbRevision', 3); // Another feed changed, selected source stays revision 2.
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-channel .media-result-title').textContent()).toBe(
      'Channel 1',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'cursorQueries').at(-1))).toMatchObject({
      appChannelIds: ['c1'],
      cursor: null,
    });
    await page.evaluate(() => Reflect.set(window, 'rejectContinued', true));
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'First listings', exact: true }).waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).toContain('could not refresh');
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    await page.getByRole('button', { name: 'First listings', exact: true }).click();
    await page.getByRole('button', { name: 'First fresh listing', exact: true }).waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda Favorites excludes nonfavorites, resets paged scope after metadata changes and recovers empty through All', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const channels = Reflect.get(window, 'channels');
      Reflect.set(
        window,
        'channels',
        channels.slice(0, 3).map((c: TimelineChannel, i: number) => ({
          ...c,
          name: 'Duplicate name',
          favorite: i === 1,
        })),
      );
      const host = Reflect.get(window, 'host');
      const original = host.query;
      Reflect.set(window, 'favoriteQueries', []);
      host.query = async (q: ProgramQuery, signal: AbortSignal) => {
        Reflect.get(window, 'favoriteQueries').push(structuredClone(q));
        return {
          ...(await original(q, signal)),
          nextCursor: q.cursor
            ? null
            : {
                queryKey: 'fixture',
                guideSourceId: 'g',
                sourceRevision: 1,
                databaseRevision: 1,
                startMs: q.windowStartMs,
                ordinal: 1,
                appChannelId: q.appChannelIds[0],
              },
        };
      };
      await Reflect.get(window, 'owner').setForeground(true);
    });
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('button', { name: 'More listings', exact: true }).waitFor();
    expect(
      await page.evaluate(() => Reflect.get(window, 'favoriteQueries').at(-1).appChannelIds),
    ).toEqual(['c1']);
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'First listings', exact: true }).waitFor();
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
          ...c,
          favorite: c.id === 'c2',
        })),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').at(-1))).toMatchObject({
      appChannelIds: ['c2'],
      cursor: null,
    });
    const beforeEmptyQueries = await page.evaluate(
      () => Reflect.get(window, 'favoriteQueries').length,
    );
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').filter((c: TimelineChannel) => c.id !== 'c2'),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'No favorite channels. Choose All to browse saved channels.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').length)).toBe(
      beforeEmptyQueries,
    );
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Live championship: complete teams, venue and match information',
        exact: true,
      })
      .waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).not.toContain(
      'No favorite channels',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').length)).toBe(
      beforeEmptyQueries + 1,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda held refresh joins suspension and cannot append stale programmes or escape focus', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 }, false);
  try {
    await page.getByRole('button', { name: 'Future listing', exact: true }).focus();
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'blocked');
      Reflect.set(window, 'pendingAgenda', Reflect.get(window, 'owner').refresh());
    });
    await page.keyboard.press('ArrowDown');
    expect(
      await page.locator('.gx-timeline-viewport').evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'agendaSuspended', false);
      Reflect.set(
        window,
        'suspendAgenda',
        Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'agendaSuspended', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'agendaSuspended'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'release')();
      await Reflect.get(window, 'pendingAgenda');
      await Reflect.get(window, 'suspendAgenda');
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.evaluate(async () => {
      Reflect.set(window, 'mode', 'normal');
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda unknown ends never imply current Watch and invalid programme times are refused', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host'),
        query = host.query;
      Reflect.set(window, 'agendaOriginalQuery', query);
      host.query = async (q: unknown, signal: AbortSignal) => {
        const reply = await query(q, signal);
        reply.programs = [{ ...reply.programs[0], title: 'End is unknown', stopMs: null }];
        return reply;
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-time').textContent()).toContain('End time unknown');
    await page.getByRole('button', { name: 'End is unknown', exact: true }).click();
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
    ).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host'),
        query = Reflect.get(window, 'agendaOriginalQuery');
      host.query = async (q: unknown, signal: AbortSignal) => {
        const reply = await query(q, signal);
        reply.programs[0].startMs = NaN;
        return reply;
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toContain(
      'Guide could not refresh',
    );
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('empty Guide rows stay quiet and D-pad stays on the intended channel', async () => {
  const page = await emptyFixture(true);
  try {
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
    expect(await page.locator('button.gx-timeline-note').count()).toBe(0);
    const first = page.locator('.gx-timeline-channel').first();
    await page.locator('.gx-timeline-viewport').focus();
    await page.keyboard.press('ArrowDown');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowDown');
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.querySelector('.media-result-title')?.textContent ??
          document.activeElement?.textContent,
      ),
    ).toBe('Channel 1');
    await page.keyboard.press('ArrowLeft');
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.querySelector('.media-result-title')?.textContent ??
          document.activeElement?.textContent,
      ),
    ).toBe('Channel 1');
    await page.keyboard.press('ArrowUp');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('Settings header routes select the visible section before lower destructive or export actions', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog{width:600px}button{min-height:44px}#settings-section{width:100%}.dialog-head{text-align:right}[data-settings-panel] button{display:block;margin:16px}</style><button id="opener">Settings</button><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources"><button id="import">Import</button><button id="export" style="margin-left:480px">Export</button></section><section data-settings-panel="other" hidden><button id="remove">Remove</button></section></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => {
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLButtonElement>('#opener')!.focus();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    await page.locator('[data-close]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('import');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('[data-close]').evaluate((n) => n === document.activeElement)).toBe(
      true,
    );
  } finally {
    await page.close();
  }
});
it('first arrow from BODY in an open primary Guide enters its channel instead of hidden Live', async () => {
  const page = await emptyFixture(true);
  try {
    await page.addStyleTag({ content: fullCss });
    await page.evaluate(() => {
      const root = document.querySelector('#app')!;
      const dialog = document.createElement('dialog');
      dialog.className = 'guide-dialog';
      dialog.dataset.primaryPage = 'guide';
      root.before(dialog);
      dialog.append(root);
      dialog.show();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() =>
      Reflect.get(window, 'Remote').installRemoteNavigation({
        initialFocus: () => document.querySelector('#irrelevant-live'),
      }),
    );
    await page.keyboard.press('ArrowDown');
    expect(
      await page
        .locator('.gx-timeline-channel')
        .first()
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it.each(['live', 'genxtra'])(
  'TV Search Up reaches the %s header without activating same-row actions',
  async (library) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>button,input{position:absolute}#live-tv-button{left:16px;top:12px;width:120px;height:44px}#genxtra-button{left:150px;top:12px;width:120px;height:44px}#search-programs{left:16px;top:93px;width:34px;height:34px}#search{left:60px;top:93px;width:300px;height:48px}</style><main id="app" data-device-kind="tv"><nav class="top-actions"><button id="live-tv-button" aria-pressed="${library === 'live'}">Live TV</button><button id="genxtra-button" aria-pressed="${library === 'genxtra'}">GenXtra</button></nav><button id="search-programs">Find online</button><input id="search" type="search" aria-label="Search"></main>`,
      );
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => {
        Reflect.set(window, 'activations', 0);
        document.addEventListener('click', () =>
          Reflect.set(window, 'activations', Reflect.get(window, 'activations') + 1),
        );
        const remote = Reflect.get(window, 'Remote'),
          mode = remote.createRemoteEditMode();
        remote.installRemoteNavigation({ editMode: mode });
        const search = document.getElementById('search')!;
        mode.navigate(search);
        search.focus();
      });
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        library === 'live' ? 'live-tv-button' : 'genxtra-button',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'activations'))).toBe(0);
    } finally {
      await page.close();
    }
  },
);

it('Settings scrolling panel and fixed footer have stable vertical boundaries and remembered return', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog[open]{position:fixed;top:20px;left:20px;width:600px;height:320px;margin:0;display:grid;grid-template-rows:44px 44px minmax(0,1fr) 44px}button{min-height:44px}.dialog-head{text-align:right}[data-settings-panel]{overflow:auto;min-height:0}[data-settings-panel] button{display:block;width:220px;margin:12px}.settings-footer{display:flex;justify-content:flex-end;gap:16px}</style><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources">${['Import', 'Refresh', 'Restore', 'Country', 'Region', 'Save region', 'Voice'].map((name, i) => `<button id="section-${i}">${name}</button>`).join('')}</section><footer class="settings-footer"><button id="about-button">About</button><button id="exit-button">Exit</button></footer></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => {
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    await page.locator('#settings-section').focus();
    for (let index = 0; index < 7; index++) {
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`section-${index}`);
    }
    expect(
      await page.locator('[data-settings-panel]').evaluate((n) => n.scrollTop),
    ).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('exit-button');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('section-6');
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => document.getElementById('section-6')!.setAttribute('disabled', ''));
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('section-5');
    for (let index = 4; index >= 0; index--) {
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`section-${index}`);
    }
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
  } finally {
    await page.close();
  }
});

it('real closed GenXtra management yields Down to Settings footer and returns without activating hidden Clear', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog[open]{position:fixed;top:20px;left:20px;width:600px;height:320px;margin:0;display:grid;grid-template-rows:44px 44px minmax(0,1fr) 44px}button,summary{min-height:34px}.dialog-head{text-align:right}[data-settings-panel]{overflow:auto;min-height:0}#panel-padding{height:400px}.settings-footer{display:flex;justify-content:flex-end;gap:16px}</style><input id="fixture-search" hidden><div id="archive-host" hidden></div><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources"><button id="source-first">Import</button><div id="panel-padding"></div></section><footer class="settings-footer"><button id="about-button">About</button><button id="exit-button">Exit</button></footer></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle + '\n' + archiveBundle });
    await page.evaluate(async () => {
      Reflect.set(window, 'removeCalls', 0);
      const ui = Reflect.get(window, 'ArchiveFixture').mountArchiveSearch(
        document.getElementById('archive-host'),
        {
          input: document.getElementById('fixture-search'),
          readyScope: () => 'controlled',
          managementContainer: document.querySelector('[data-settings-panel]'),
          catalog: {
            query: async () => ({
              schemaVersion: 1,
              revision: '1',
              offset: 0,
              totalCount: 0,
              items: [],
              more: false,
            }),
            files: async () => {
              throw Error('unexpected files');
            },
          },
          onSelect: async () => {
            throw Error('unexpected playback');
          },
          onRemove: async () => {
            Reflect.set(window, 'removeCalls', Reflect.get(window, 'removeCalls') + 1);
            throw Error('unexpected removal');
          },
        },
      );
      Reflect.set(window, 'archiveManagementOwner', ui);
      await ui.resume('');
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    const summary = page.locator('.gx-archive-management > summary');
    await summary.focus();
    expect(
      await page.locator('.gx-archive-management').evaluate((n) => n.hasAttribute('open')),
    ).toBe(false);
    expect(await page.locator('.gx-archive-management button').count()).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowUp');
    expect(await summary.evaluate((n) => n === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'removeCalls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'archiveManagementOwner')?.dispose());
    await page.close();
  }
});

it('native grouped inventory retains News and Sports aliases while showing one representative and keeping navigation scoped', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const all = Reflect.get(window, 'channels');
      all[20].category = 'General';
      all[21].category = 'Sports';
      Reflect.set(window, 'channels', all.slice(20, 22));
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        Reflect.set(
          window,
          'groupedMembershipCalls',
          Reflect.get(window, 'groupedMembershipCalls') + 1,
        );
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '11',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
              filterMask: 6,
            },
          ],
        };
      };
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['Channel 20']);
    for (const category of ['Sports', 'News']) {
      await page.getByRole('button', { name: category, exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20']);
    }
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('native grouped inventory reacquires after favorite facts change on unchanged mapping identities', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'channels', Reflect.get(window, 'channels').slice(20, 22));
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        Reflect.set(
          window,
          'groupedMembershipCalls',
          Reflect.get(window, 'groupedMembershipCalls') + 1,
        );
        const saved = Reflect.get(window, 'channels');
        const split = saved[1].favorite === true;
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: split ? '12' : '11',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: (split ? saved : [saved[0]]).map((c: TimelineChannel) => ({
            catalogSourceId: c.sourceId,
            appChannelId: c.id,
            guideSourceId: c.guideSourceId,
            xmltvChannelId: c.xmltvChannelId,
            sourceRevision: 1,
            filterMask: c.favorite ? 1 : 0,
          })),
        };
      };
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['Channel 20']);
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
          ...c,
          favorite: c.id === 'c21',
        })),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(2);
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['Channel 21']);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('declared native grouped inventory refuses missing or unknown filter bits without publishing rows', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').listedChannels = async () => ({
        catalogRevision: '1',
        databaseRevision: 1,
        viewRevision: '11',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
        channels: [
          {
            catalogSourceId: 's',
            appChannelId: 'c20',
            guideSourceId: 'g',
            xmltvChannelId: 'x20',
            sourceRevision: 1,
            filterMask: 8,
          },
        ],
      });
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'Guide could not refresh. Choose Now to retry.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('held native grouped favorite snapshot refuses old host preferences then retries after the host commit', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels')
          .slice(20, 21)
          .map((c: TimelineChannel) => ({ ...c, favorite: false })),
      );
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        const call = Reflect.get(window, 'groupedMembershipCalls') + 1;
        Reflect.set(window, 'groupedMembershipCalls', call);
        if (call === 1)
          await new Promise<void>((resolve) =>
            Reflect.set(window, 'finishGroupedMembership', resolve),
          );
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '12',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
              filterMask: 1,
            },
          ],
        };
      };
      Reflect.set(window, 'groupedPending', Reflect.get(window, 'owner').setForeground(true));
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls')))
      .toBe(1);
    await page.evaluate(async () => {
      Reflect.get(window, 'finishGroupedMembership')();
      await Reflect.get(window, 'groupedPending');
    });
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'Guide could not refresh. Choose Now to retry.',
    );
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({ ...c, favorite: true })),
      );
      await Reflect.get(window, 'owner').refresh();
    });
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['Channel 20']);
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
