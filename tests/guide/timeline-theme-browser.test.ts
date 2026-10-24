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

import { beforeAll, afterAll, it, expect } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

import { readStylesheet } from '../support/stylesheet';
let browser: Browser, bundle: string, css: string, fullCss: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/guide/guide-timeline.ts', formats: ['iife'], name: 'Timeline' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Timeline bundle missing.');
  const chunk = result.output.find((e) => e.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Timeline entry missing.');
  bundle = chunk.code;
  css = await readStylesheet('src/ui/guide-timeline.css');
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
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
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
async function fixture(initiallyForeground = true, controlledClock = false): Promise<Page> {
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
    const host={initiallyForeground:${initiallyForeground},channels:()=>channels,catalogRevision:()=>revision,now:()=>time,formatTime:ms=>new Date(ms).toISOString(),formatAxisTime:ms=>new Date(ms).toISOString().slice(11,16),
      query:async(q,signal)=>{calls++; if(mode==='blocked')await new Promise(resolve=>window.release=()=>{released=true;resolve()});const c=channels.find(c=>c.id===q.appChannelIds[0]);return {programs:mode==='dense'?Array.from({length:50},(_,i)=>({...program(c,0,i),title:'Overlap '+i})): [program(c),program(c,1800000,1)],nextCursor:null,sourceRevision:1,databaseRevision:1};},
      summary:async(c,atMs,signal)=>{summaryCalls++; if(mode==='summaryBlocked')await new Promise(resolve=>window.release=resolve); return {catalogSourceId:c.sourceId,appChannelId:c.id,atMs,requestId:'fixture',catalogRevision:revision,databaseRevision:1,mappingStatus:'mapped',mapping:{catalogSourceId:'s',appChannelId:c.id,guideSourceId:'g',xmltvChannelId:c.xmltvChannelId},sourceRevision:1,publishedRevision:1,updatedMs:base,coverage:{startMs:base,endMs:base+3600000},cacheStatus:mode==='stale'?'stale':'current',currentStatus:'current',nextStatus:'next',current:program(c),next:program(c,1800000,1)};},
      watch:async()=>{watches++;}};
    window.owner=Timeline.mountGuideTimeline(document.getElementById('app'),host);
  `,
  });
  if (initiallyForeground) await page.locator('.gx-timeline-row').nth(7).waitFor();
  return page;
}

it('wide selected details remain beside bounded rows without creating a player', async () => {
  const page = await fixture();
  try {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.addStyleTag({ content: fullCss });
    await page.evaluate(async () => {
      const dialog = document.createElement('dialog');
      dialog.className = 'guide-dialog guide-with-timeline';
      dialog.innerHTML =
        '<header class="guide-header"><h2>Program guide</h2><button aria-label="Close guide">Close</button></header><div class="guide-dropdown"><button aria-label="Guide view">Channel guide</button></div><div class="guide-feedback"><p>No program guide connected yet.</p><p></p></div><button>Find program guides</button><div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
      document.querySelector('#app')!.append(dialog);
      dialog
        .querySelector('.guide-timeline-panel')!
        .append(document.querySelector('.gx-timeline')!);
      dialog.showModal();
      await Reflect.get(window, 'owner').refresh();
    });
    const cell = page.getByRole('button', { name: 'Current listing', exact: true }).first();
    await cell.click();
    const detail = await page.locator('.gx-timeline-details').boundingBox(),
      grid = await page.locator('.gx-timeline-viewport').boundingBox();
    expect(detail!.x + detail!.width).toBeLessThan(grid!.x);
    expect(await cell.getAttribute('aria-pressed')).toBe('true');
    expect(await cell.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe('rgb(81, 32, 68)');
    await page.screenshot({
      path: 'Screenshot/0.1.0/browser-guide-theme/selected-controlled-960x540.png',
    });
    expect(await page.locator('video').count()).toBe(0);
    await page.getByRole('button', { name: 'Back to timeline' }).click();
    expect(await cell.evaluate((n) => n === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
});

it('category and day navigation use real metadata and bounded queries without tuning', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => {
      const channels = Reflect.get(window, 'channels');
      channels[0].category = 'Sports';
      channels[1].category = 'News';
      channels[2].name = 'Sports named channel';
      await Reflect.get(window, 'owner').refresh();
    });
    await page.getByRole('button', { name: 'Sports', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(1);
    expect(await page.locator('.gx-timeline-channel .media-result-title').textContent()).toBe(
      'Channel 0',
    );
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await expect.poll(() => page.getByLabel('Guide date').textContent()).toContain('12');
    expect(await page.getByRole('button', { name: 'Previous day', exact: true }).isEnabled()).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Previous day', exact: true }).isDisabled())
      .toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    const capacity = await page.locator('.gx-timeline-viewport').evaluate((viewport) => {
      const pitch = parseFloat(
        getComputedStyle(viewport.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
      );
      // The viewport plus eight overscan rows each side, capped at 32.
      return Math.min(32, Math.max(1, Math.ceil(viewport.clientHeight / pitch) + 1) + 16);
    });
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(capacity);
  } finally {
    await page.close();
  }
});
for (const size of [
  { width: 390, height: 640 },
  { width: 640, height: 360 },
])
  it(`compact details replace grid accessibly at ${size.width}x${size.height}`, async () => {
    const page = await fixture();
    try {
      await page.setViewportSize(size);
      await page.screenshot({
        path: `Screenshot/0.1.0/browser-guide-theme/grid-controlled-${size.width}x${size.height}.png`,
      });
      const cell = page.getByRole('button', { name: 'Current listing', exact: true }).first();
      await cell.click();
      expect(await page.locator('.gx-timeline-viewport').isVisible()).toBe(false);
      for (const name of ['Watch current channel', 'Back to timeline']) {
        const button = page.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const r = await button.boundingBox();
        expect(r!.height).toBeGreaterThanOrEqual(44);
        expect(r!.x).toBeGreaterThanOrEqual(0);
        expect(r!.x + r!.width).toBeLessThanOrEqual(size.width);
        expect(r!.y + r!.height).toBeLessThanOrEqual(size.height);
      }
      await page.screenshot({
        path: `Screenshot/0.1.0/browser-guide-theme/details-controlled-${size.width}x${size.height}.png`,
      });
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      expect(await page.locator('.gx-timeline-viewport').isVisible()).toBe(true);
      expect(await cell.evaluate((n) => n === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
