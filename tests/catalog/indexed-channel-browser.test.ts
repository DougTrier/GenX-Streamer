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
      lib: { entry: 'src/ui/channel-browser.ts', formats: ['iife'], name: 'IndexedUI' },
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
      '#list{height:360px;width:420px;overflow:auto;position:relative}#channel-rows{position:absolute;top:0;width:100%}.channel{height:72px;width:100%;display:block;padding:4px}.channel-copy{display:block}',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    window.calls=[];window.selections=[];window.hold=${JSON.stringify(held)};window.pending=[];window.outcome='ready';
    window.browseReady=${JSON.stringify(ready)};window.durableRevision="7";
    const row=i=>({id:'c'+i,sourceId:'public',name:'Channel '+i,category:i%2?'Sports':'News',favorite:i%100===0,geography:{country:'US',state:'US-IL'}});
    const oracle=q=>{
      const filtered=q.query==='needle'||q.filter==='favorites';
      const total=filtered?1000:100000;
      const scale=filtered?100:1;
      const rank=q.anchorId?Number(q.anchorId.slice(1))/scale:null;
      const anchor=rank!==null&&Number.isInteger(rank)&&rank>=0&&rank<total?rank:null;
      const start=q.anchorId?anchor===null?0:Math.max(0,anchor-1):q.startIndex??0;
      return {schemaVersion:1,requestId:'fixture',catalogRevision:window.durableRevision,viewRevision:'9',queryVersion:'v1-'+ 'a'.repeat(64),totalCount:total,startIndex:start,anchorIndex:anchor,
        rows:Array.from({length:Math.min(q.pageSize,total-start)},(_,i)=>row((start+i)*scale)),after:null};
    };
    const host={revision:()=> window.durableRevision,ready:()=>window.browseReady,identity:()=> 'fixture',query:async(q,signal)=>{window.calls.push(structuredClone(q));
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
    await browserExpect(page.locator('#list-empty')).toHaveText('Loading channels…');
    await browserExpect(page.locator('[data-channel]')).toHaveCount(0);
    await page.evaluate(() => {
      Reflect.set(window, 'outcome', 'zero');
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('0 channels');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'ready');
    await page.evaluate(() => {
      Reflect.set(window, 'hold', true);
      Reflect.get(window, 'cb').search('another');
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pending').length)).toBe(1);
    await browserExpect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await page.evaluate(() => {
      Reflect.set(window, 'outcome', 'error');
      Reflect.get(window, 'release')();
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('Channels unavailable');
    await browserExpect(page.locator('#list')).toHaveAttribute('aria-busy', 'false');
    await browserExpect(page.locator('#list')).toHaveAttribute('data-catalog-state', 'error');
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
