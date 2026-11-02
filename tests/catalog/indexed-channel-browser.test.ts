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
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/channels/channel-browser.ts', formats: ['iife'], name: 'IndexedUI' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(
  selected: string | null = null,
  ready = true,
  logos = false,
  held = false,
): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(
    '<span id="channel-count"></span><p id="list-empty"></p><input id="search"><div id="list" tabindex="0"><div id="channel-spacer"></div><div id="channel-rows"></div></div>',
  );
  await page.addStyleTag({
    content:
      '*{box-sizing:border-box}#list{height:360px;width:420px;overflow:auto;position:relative}#channel-rows{position:absolute;top:0;width:100%}.channel{height:72px;width:100%;display:block;padding:4px}.channel-copy{display:block}',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    window.calls=[];window.selections=[];window.hold=${JSON.stringify(held)};window.pending=[];window.outcome='ready';
    window.browseReady=${JSON.stringify(ready)};window.durableRevision="7";
    window.viewRevision='9';window.ownerIdentity='public';window.dataIdentity='fixture';
    window.inserted=0;window.removed=[];window.reversed=false;
    const row=i=>({id:'c'+i,sourceId:'public',name:'Channel '+i,category:i%2?'Sports':'News',favorite:i%100===0,geography:{country:'US',state:'US-IL'}});
    const oracle=q=>{
      const filtered=q.query==='needle'||q.filter==='favorites';
      const total=Math.min(100000,(filtered?1000:100000)+window.inserted-window.removed.length);
      const scale=filtered?100:1;
      const original=q.anchorId?.startsWith('c')?Number(q.anchorId.slice(1))/scale:null;
      const forwardRank=original===null||window.removed.includes(original)?null:original+window.inserted-window.removed.filter(i=>i<original).length;
      const rank=forwardRank===null?null:window.reversed?total-1-forwardRank:forwardRank;
      const anchor=rank!==null&&Number.isInteger(rank)&&rank>=0&&rank<total?rank:null;
      const start=q.anchorId?anchor===null?0:Math.max(0,anchor-1):q.startIndex??0;
      const at=index=>{
        if(window.reversed)index=total-1-index;
        if(index<window.inserted)return {...row(0),id:'inserted'+index};
        let value=index-window.inserted;
        for(const removed of window.removed)if(removed<=value)value++;
        return row(value*scale);
      };
      return {schemaVersion:1,requestId:'fixture',catalogRevision:window.durableRevision,viewRevision:window.viewRevision,...(q.sports?{guideRevision:'1'}:{}),queryVersion:'v1-'+ 'a'.repeat(64),totalCount:total,startIndex:start,anchorIndex:anchor,
        rows:Array.from({length:Math.min(q.pageSize,total-start)},(_,i)=>at(start+i)),after:null};
    };
    const host={revision:()=> window.durableRevision,ready:()=>window.browseReady,identity:()=>window.dataIdentity,scopeIdentity:()=>window.ownerIdentity,query:async(q,signal)=>{window.calls.push(structuredClone(q));
      if(window.hold)await new Promise(resolve=>window.pending.push(resolve));
      if(window.outcome==='error')throw new Error('private query failed');
      const result=oracle(q);
      return window.outcome==='zero'?{...result,totalCount:0,rows:[],after:null}:result;
    }};
    window.logoVisible=[]; window.logoRejected=[]; window.badArtwork=false;
    const logos={get:c=>window.badArtwork?'data:image/png;base64,AAAA':null,
      visible:channels=>window.logoVisible=channels.map(c=>c.id),rejected:c=>window.logoRejected.push(c.id)};
    window.cb=new IndexedUI.ChannelBrowser(document.querySelector('#list'),id=>window.selections.push(id),undefined,host,${logos ? '{logos}' : '{}'});
    // Supplying no whole catalog proves the indexed path cannot search JS metadata.
    window.cb.update([],[],${JSON.stringify(selected)});
    window.release=()=>{window.hold=false;window.pending.splice(0).forEach(resolve=>resolve())};
  `,
  });
  if (ready && !held) {
    await expect.poll(() => page.locator('#channel-count').textContent()).toBe('100,000 channels');
    await browserExpect(page.locator('[data-channel="c0"]')).toBeVisible();
  }
  return page;
}
async function cleanup(page: Page) {
  await page.evaluate(async () => {
    Reflect.get(window, 'release')();
    await Reflect.get(window, 'cb').dispose();
  });
  await page.close();
}

async function browseAt(page: Page, index: number, focus = true) {
  await page.locator('#list').evaluate(
    (element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    },
    index * 72 + 17,
  );
  await browserExpect(page.locator(`[data-channel="c${index + 2}"]`)).toBeVisible();
  if (focus) await page.locator(`[data-channel="c${index + 2}"]`).focus();
}

it('refreshes indexed sports membership after a committed guide update without changing window, filters or anchor', async () => {
  const page = await fixture();
  try {
    const ordinaryCalls = await page.evaluate(() => Reflect.get(window, 'calls').length);
    await page.evaluate(() => Reflect.get(window, 'cb').refreshProgrammeMembership());
    expect(await page.evaluate(() => Reflect.get(window, 'calls').length)).toBe(ordinaryCalls);
    await page.evaluate(() => {
      const cb = Reflect.get(window, 'cb');
      cb.setFilter('sports');
      cb.setSportsFacet({ sport: 'american-football', league: 'nfl' });
    });
    // A new explicit facet intentionally replaces the old list. Begin deep
    // browsing only after its first owned page has actually painted.
    await browserExpect(page.locator('[data-channel="c0"]')).toBeVisible();
    await browseAt(page, 1000);
    const target = page.locator('[data-channel="c1002"]');
    const before = await target.boundingBox();
    const scope = await page.evaluate(() => Reflect.get(window, 'cb').getSportsScope());
    const calls = await page.evaluate(() => Reflect.get(window, 'calls').length);
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.set(window, 'inserted', 17);
      Reflect.set(window, 'viewRevision', '10');
      Reflect.get(window, 'cb').refreshProgrammeMembership();
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await browserExpect(target).toBeFocused();
    await expect.poll(async () => (await target.boundingBox())?.y).toBe(before?.y);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').length))
      .toBeGreaterThan(calls);
    await browserExpect(target).toBeFocused();
    await expect.poll(async () => (await target.boundingBox())?.y).toBe(before?.y);
    expect(await page.evaluate(() => Reflect.get(window, 'cb').getSportsScope())).toEqual(scope);
    const requests = await page.evaluate(
      (count) => Reflect.get(window, 'calls').slice(count),
      calls,
    );
    expect(requests.some((request: { anchorId?: string }) => request.anchorId === 'c1002')).toBe(
      true,
    );
    for (const request of requests)
      expect(request).toMatchObject({ filter: 'sports', sports: scope });
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('keeps the browsed channel and exact focus offset through scan insertions and repeated health search', async () => {
  const page = await fixture('c0');
  try {
    await browseAt(page, 1000);
    const before = await page.locator('[data-channel="c1002"]').boundingBox();
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.set(window, 'inserted', 17);
      Reflect.set(window, 'durableRevision', '8');
      Reflect.set(window, 'viewRevision', '10');
      Reflect.set(window, 'dataIdentity', 'scan-8');
      Reflect.get(window, 'cb').update([], [], 'c0');
      // Health and catalog publication repeat the existing search, too.
      Reflect.get(window, 'cb').search('  ');
      Reflect.get(window, 'cb').setFilter('all');
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await browserExpect(page.locator('[data-channel="c1002"]')).toBeFocused();
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-empty', 'false');
    await expect
      .poll(async () => (await page.locator('[data-channel="c1002"]').boundingBox())?.y)
      .toBe(before?.y);
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(72017);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await expect.poll(() => page.locator('#channel-count').textContent()).toBe('100,000 channels');
    await browserExpect(page.locator('[data-channel="c1002"]')).toBeFocused();
    await expect
      .poll(async () => (await page.locator('[data-channel="c1002"]').boundingBox())?.y)
      .toBe(before?.y);
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(73241);
    const calls = await page.evaluate(() => Reflect.get(window, 'calls'));
    expect(calls.some((call: { anchorId?: string }) => call.anchorId === 'c1002')).toBe(true);
    expect(calls.every((call: { pageSize: number }) => call.pageSize === 50)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
    expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
    // Health/favorite order may move this row far from its old ordinal, too.
    await page.evaluate(() => {
      Reflect.set(window, 'reversed', true);
      Reflect.set(window, 'viewRevision', '11');
      Reflect.set(window, 'dataIdentity', 'reordered-health-11');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await expect
      .poll(() => page.locator('#list').evaluate((element) => element.scrollTop))
      .toBe(7126433);
    await browserExpect(page.locator('[data-channel="c1002"]')).toBeFocused();
    await expect
      .poll(async () => (await page.locator('[data-channel="c1002"]').boundingBox())?.y)
      .toBe(before?.y);
  } finally {
    await cleanup(page);
  }
});

it('a removed focus anchor uses its nearest surviving row instead of the playing channel', async () => {
  const page = await fixture('c0');
  try {
    await browseAt(page, 1000);
    const before = await page.locator('[data-channel="c1002"]').boundingBox();
    await page.evaluate(() => {
      Reflect.set(window, 'removed', [1002]);
      Reflect.set(window, 'viewRevision', '10');
      Reflect.set(window, 'dataIdentity', 'remove-1');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await browserExpect(page.locator('[data-channel="c1003"]')).toBeFocused();
    await expect
      .poll(async () => (await page.locator('[data-channel="c1003"]').boundingBox())?.y)
      .toBe(before?.y);
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(72017);
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
    // If all retained neighbours disappear, use the same ordinal, not row zero.
    await page.evaluate(() => {
      Reflect.set(window, 'removed', [1001, 1002, 1003, 1004]);
      Reflect.set(window, 'viewRevision', '11');
      Reflect.set(window, 'dataIdentity', 'remove-4');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await browserExpect(page.locator('[data-channel="c1006"]')).toBeFocused();
    await expect
      .poll(async () => (await page.locator('[data-channel="c1006"]').boundingBox())?.y)
      .toBe(before?.y);
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(72017);
  } finally {
    await cleanup(page);
  }
});

it('preserves intervening scroll and lets search retain focus while the anchor page is held', async () => {
  const page = await fixture('c0');
  try {
    await browseAt(page, 8000, false);
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.set(window, 'inserted', 25);
      Reflect.set(window, 'viewRevision', '10');
      Reflect.set(window, 'dataIdentity', 'health-10');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.locator('#search').focus();
    await page.locator('#list').evaluate((element) => {
      element.scrollTop += 144;
      element.dispatchEvent(new Event('scroll'));
    });
    await page.evaluate(() => Reflect.get(window, 'release')());
    await browserExpect(page.locator('#channel-count')).toHaveText('100,000 channels');
    await browserExpect(page.locator('[data-channel="c8002"]')).toBeVisible();
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(577961);
    await browserExpect(page.locator('#search')).toBeFocused();
  } finally {
    await cleanup(page);
  }
});

it('an owner switch cancels pending anchoring, and an explicit changed search resets intentionally', async () => {
  const page = await fixture();
  try {
    await browseAt(page, 1000);
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.set(window, 'dataIdentity', 'background');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.locator('#search').focus();
    await page.evaluate(() => {
      Reflect.set(window, 'ownerIdentity', 'another-root-account-grant');
      Reflect.set(window, 'dataIdentity', 'replacement');
      Reflect.get(window, 'cb').update([], [], null);
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('[data-channel="c0"]')).toBeVisible();
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(0);
    await browserExpect(page.locator('#search')).toBeFocused();
    await browseAt(page, 1000, false);
    await page.evaluate(() => Reflect.get(window, 'cb').search('needle'));
    await browserExpect(page.locator('#channel-count')).toHaveText('1,000 channels');
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(0);
    await browserExpect(page.locator('#search')).toBeFocused();
  } finally {
    await cleanup(page);
  }
});

it('focus leaving after the native acknowledgement but before its animation frame is never reclaimed', async () => {
  const page = await fixture();
  try {
    await browseAt(page, 1000);
    await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      Reflect.set(window, 'originalFrame', window.requestAnimationFrame);
      Reflect.set(window, 'heldFrames', []);
      window.requestAnimationFrame = (callback) => {
        Reflect.get(window, 'heldFrames').push(callback);
        return 100000;
      };
      Reflect.set(window, 'inserted', 1);
      Reflect.set(window, 'dataIdentity', 'ack-before-frame');
      Reflect.get(window, 'cb').update([], [], 'c0');
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'heldFrames').length))
      .toBeGreaterThan(0);
    // The native result relocated the scroll already; its paint is still held.
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(72089);
    await page.locator('#search').focus();
    await page.evaluate(() => {
      window.requestAnimationFrame = Reflect.get(window, 'originalFrame');
      for (const callback of Reflect.get(window, 'heldFrames').splice(0))
        callback(performance.now());
    });
    await browserExpect(page.locator('[data-channel="c1002"]')).toBeVisible();
    await browserExpect(page.locator('#search')).toBeFocused();
  } finally {
    await page.evaluate(() => {
      if (Reflect.get(window, 'originalFrame'))
        window.requestAnimationFrame = Reflect.get(window, 'originalFrame');
    });
    await cleanup(page);
  }
});

it('the JS virtual list retains a favorite action and pixel offset through insertion and favorite reordering', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'cb').dispose();
      const rows = Array.from({ length: 250 }, (_, index) => ({
        id: 'c' + index,
        name: 'Channel ' + index,
        category: 'Sports',
      }));
      Reflect.set(window, 'localRows', rows);
      const BrowserUI = Reflect.get(window, 'IndexedUI');
      Reflect.set(
        window,
        'cb',
        new BrowserUI.ChannelBrowser(
          document.querySelector('#list'),
          () => {},
          undefined,
          undefined,
          { onFavorite: () => {}, onManage: () => {} },
        ),
      );
      Reflect.get(window, 'cb').update(rows, [], 'c0');
    });
    await browseAt(page, 100, false);
    await page.locator('[data-channel-id="c102"][data-channel-action="favorite"]').focus();
    const before = await page.locator('[data-channel="c102"]').boundingBox();
    await page.evaluate(() => {
      const added = Array.from({ length: 20 }, (_, index) => ({
        id: 'new' + index,
        name: 'New ' + index,
        category: 'News',
      }));
      Reflect.get(window, 'cb').update(
        [...added, ...Reflect.get(window, 'localRows')],
        ['c180'],
        'c0',
      );
      Reflect.get(window, 'cb').search('');
    });
    await browserExpect(
      page.locator('[data-channel-id="c102"][data-channel-action="favorite"]'),
    ).toBeFocused();
    await expect
      .poll(async () => (await page.locator('[data-channel="c102"]').boundingBox())?.y)
      .toBe(before?.y);
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(8729);
    await page.keyboard.press('ArrowDown');
    await browserExpect(
      page.locator('[data-channel-id="c103"][data-channel-action="favorite"]'),
    ).toBeFocused();
    expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
    await page.evaluate(() => Reflect.get(window, 'cb').setFilter('news'));
    expect(await page.locator('#list').evaluate((element) => element.scrollTop)).toBe(0);
    await browserExpect(page.locator('#channel-count')).toHaveText('20 channels');
  } finally {
    await cleanup(page);
  }
});

it('renders bounded windows of 100k indexed rows, scrolls across pages and focuses End', async () => {
  const page = await fixture();
  try {
    expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
    await page.locator('#list').evaluate((el) => {
      el.scrollTop = 49 * 72;
      el.dispatchEvent(new Event('scroll'));
    });
    await browserExpect(page.locator('[data-channel="c49"]')).toBeVisible();
    await page.locator('[data-channel="c49"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.channel))
      .toBe('c50');
    await page.keyboard.press('End');
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.channel))
      .toBe('c99999');
    expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'calls').every((q: { pageSize: number }) => q.pageSize === 50),
      ),
    ).toBe(true);
  } finally {
    await cleanup(page);
  }
});

it('held native first query and failed replacement never claim an empty count', async () => {
  const page = await fixture(null, true, false, true);
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await browserExpect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await browserExpect(page.locator('#list')).toHaveAttribute('aria-busy', 'true');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'pending');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-empty', 'false');
    await browserExpect(page.locator('#list-empty')).toHaveText('Loading channels…');
    await browserExpect(page.locator('[data-channel]')).toHaveCount(0);
    await page.evaluate(() => {
      Reflect.set(window, 'outcome', 'zero');
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('0 channels');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'ready');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-empty', 'true');
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.get(window, 'cb').search('another');
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await browserExpect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-empty', 'false');
    await page.evaluate(() => {
      Reflect.set(window, 'outcome', 'error');
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('Channels unavailable');
    await browserExpect(page.locator('#list')).toHaveAttribute('aria-busy', 'false');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'error');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-empty', 'false');
    await browserExpect(page.locator('#list-empty')).toContainText('could not be loaded');
    expect(await page.locator('#list-empty').textContent()).not.toContain('private');
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('an obsolete initial page cannot replace pending search state or steal focus', async () => {
  const page = await fixture(null, true, false, true);
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.locator('#search').focus();
    await page.evaluate(() => {
      Reflect.set(window, 'seenCounts', []);
      const node = document.querySelector('#channel-count')!;
      new MutationObserver(() => Reflect.get(window, 'seenCounts').push(node.textContent)).observe(
        node,
        { childList: true },
      );
      Reflect.get(window, 'cb').search('needle');
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('1,000 channels');
    expect(await page.evaluate(() => Reflect.get(window, 'seenCounts'))).not.toContain(
      '100,000 channels',
    );
    await browserExpect(page.locator('#search')).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('disposing a detached browser cannot overwrite replacement count or throw after shell removal', async () => {
  const page = await fixture(null, true, false, true);
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.evaluate(() => {
      const old = Reflect.get(window, 'cb');
      const list = document.querySelector('#list')!;
      const replacement = list.cloneNode(false) as HTMLElement;
      replacement.innerHTML = '<div id="channel-spacer"></div><div id="channel-rows"></div>';
      list.replaceWith(replacement);
      const ui = Reflect.get(window, 'IndexedUI');
      const next = new ui.ChannelBrowser(replacement, () => {}, undefined, {
        revision: () => '7',
        ready: () => true,
        identity: () => 'replacement',
        query: () =>
          new Promise((resolve) =>
            Reflect.set(window, 'replacementRelease', () =>
              resolve({
                schemaVersion: 1,
                requestId: 'replacement',
                catalogRevision: '7',
                viewRevision: '9',
                queryVersion: 'fixture',
                totalCount: 1,
                startIndex: 0,
                anchorIndex: null,
                after: null,
                rows: [
                  {
                    id: 'replacement-channel',
                    sourceId: 'fixture',
                    name: 'Replacement channel',
                    category: 'News',
                    favorite: false,
                  },
                ],
              }),
            ),
          ),
      });
      next.update([], [], null);
      Reflect.set(window, 'cb', next);
      Reflect.set(window, 'oldBrowserClose', old.dispose());
      Reflect.set(
        window,
        'countAfterOldDispose',
        document.querySelector('#channel-count')!.textContent,
      );
    });
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'replacementRelease')))
      .toBe('function');
    expect(await page.evaluate(() => Reflect.get(window, 'countAfterOldDispose'))).toBe(
      'Loading channels…',
    );
    await browserExpect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'pending');
    await page.evaluate(async () => {
      Reflect.get(window, 'release')();
      await Reflect.get(window, 'oldBrowserClose');
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await page.evaluate(() => Reflect.get(window, 'replacementRelease')());
    await browserExpect(page.locator('[data-channel="replacement-channel"]')).toBeVisible();
    await browserExpect(page.locator('#channel-count')).toHaveText('1 channel');
    await page.evaluate(async () => {
      document.querySelector('#channel-count')!.remove();
      document.querySelector('#list-empty')!.remove();
      document.querySelector('#list')!.remove();
      await Reflect.get(window, 'cb').dispose();
    });
  } finally {
    await cleanup(page);
  }
});

it('routes search and favorites to the authoritative oracle without auto tuning', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.get(window, 'cb').search('needle'));
    await expect.poll(() => page.locator('#channel-count').textContent()).toBe('1,000 channels');
    await page.evaluate(() => Reflect.get(window, 'cb').setFilter('favorites'));
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').at(-1).filter))
      .toBe('favorites');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').at(-1).query)).toBe('needle');
    await page.evaluate(() =>
      Reflect.get(window, 'cb').setGeography(
        { country: 'US', state: null, region: undefined },
        'geography',
        {
          countries: new Map(),
          states: new Map(),
          regions: new Map(),
        },
      ),
    );
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').at(-1).sort))
      .toBe('geography');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').at(-1).geography)).toEqual({
      country: 'US',
      state: null,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('an old adjacency result cannot select after search changes its generation', async () => {
  const page = await fixture('c50000');
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.get(window, 'cb').selectAdjacent(1);
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.evaluate(() => {
      Reflect.get(window, 'cb').search('needle');
      Reflect.get(window, 'release')();
    });
    await expect.poll(() => page.locator('#channel-count').textContent()).toBe('1,000 channels');
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('locates selected off-cache channels by anchor and wraps without a full catalog', async () => {
  const page = await fixture('c99999');
  try {
    await page.evaluate(() => Reflect.get(window, 'cb').selectAdjacent(1));
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'selections'))).toEqual(['c0']);
    await page.evaluate(() => Reflect.get(window, 'cb').selectAdjacent(-1));
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'selections')))
      .toEqual(['c0', 'c99999']);
    const anchors = await page.evaluate(() =>
      Reflect.get(window, 'calls')
        .filter((q: { anchorId?: string }) => q.anchorId)
        .map((q: { anchorId: string }) => q.anchorId),
    );
    expect(anchors).toEqual(['c99999', 'c0']);
  } finally {
    await cleanup(page);
  }
});

it('a late page cannot steal focus after leaving the list or a new search', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.set(window, 'hold', true));
    await page.locator('[data-channel="c0"]').focus();
    await page.keyboard.press('End');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.locator('#search').focus();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      Reflect.get(window, 'cb').search('needle');
      Reflect.get(window, 'release')();
    });
    await expect.poll(() => page.locator('#channel-count').textContent()).toBe('1,000 channels');
    await browserExpect(page.locator('#search')).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('dispose awaits a held query and its late result cannot retarget selection', async () => {
  const page = await fixture('c50000');
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.get(window, 'cb').selectAdjacent(1);
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'disposedDone', false);
      Reflect.set(
        window,
        'disposeWork',
        Reflect.get(window, 'cb')
          .dispose()
          .then(() => Reflect.set(window, 'disposedDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'release')();
      await Reflect.get(window, 'disposeWork');
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('boot waits for durable data before admitting the first indexed query', async () => {
  const page = await fixture(null, false);
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'cb').search('');
      Reflect.get(window, 'cb').update([], [], null);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([]);
    await page.evaluate(() => {
      Reflect.set(window, 'durableRevision', '266');
      Reflect.set(window, 'browseReady', true);
      Reflect.get(window, 'cb').update([], [], null);
    });
    await browserExpect(page.locator('[data-channel="c0"]')).toBeVisible();
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'calls').map(
          (q: { expectedCatalogRevision: string }) => q.expectedCatalogRevision,
        ),
      ),
    ).toEqual(['266']);
    expect(await page.locator('#channel-count').textContent()).toBe('100,000 channels');
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('requests artwork for intersecting rows only and clears visible work when hidden', async () => {
  const page = await fixture(null, true, true);
  try {
    const painted = await page.locator('[data-channel]').count();
    const wanted: string[] = await page.evaluate(() => Reflect.get(window, 'logoVisible'));
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.length).toBeLessThan(painted);
    expect(wanted).not.toContain('c10');
    await page.evaluate(() => Reflect.get(window, 'cb').setGuideForeground(false));
    expect(await page.evaluate(() => Reflect.get(window, 'logoVisible'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('failed image decoding restores initials without adding focus stops or playing a channel', async () => {
  const page = await fixture(null, true, true);
  try {
    await page.locator('[data-channel="c0"]').focus();
    await page.evaluate(() => {
      Reflect.set(window, 'badArtwork', true);
      Reflect.get(window, 'cb').refreshArtwork();
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'logoRejected').length))
      .toBeGreaterThan(0);
    await browserExpect(page.locator('[data-channel="c0"] [data-artwork="fallback"]')).toHaveText(
      'C0',
    );
    expect(await page.locator('[data-channel="c0"] img').count()).toBe(0);
    await page.locator('[data-channel="c0"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.channel))
      .toBe('c1');
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});
