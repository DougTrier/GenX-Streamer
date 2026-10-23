import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/guide.ts', formats: ['iife'], name: 'GuideUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
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
  presentation: boolean = true,
  manualClock = false,
  timeline = false,
): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('http://127.0.0.1/guide-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main id="guide"></main>' }),
  );
  await page.goto('http://127.0.0.1/guide-fixture');
  await page.addScriptTag({ content: bundle });
  if (timeline) {
    await page.addStyleTag({
      content:
        (await readFile('src/ui/guide.css', 'utf8')) +
        (await readFile('src/ui/guide-timeline.css', 'utf8')),
    });
  }
  await page.addScriptTag({
    content: `
    const instant=1700000000000;
    window.calls={sources:0,queries:[],commits:[],discard:[],watch:[],mapping:[]};
    window.mode='normal';window.previewMode='normal';window.commitMode='normal';window.stale=false;
    const channel={id:'fox',sourceId:'catalog',name:'FOX Chicago'};
    const source={id:'guide',name:'Regional guide',location:'https://fixture.invalid/guide',kind:'url',allowHttp:false,revision:1,updatedMs:instant};
    const mapping={catalogSourceId:'catalog',appChannelId:'fox',guideSourceId:'guide',xmltvChannelId:'wfld'};
    const program=(title,startMs,stopMs,ordinal)=>({...mapping,startMs,stopMs,title,description:'Description '+title,ordinal});
    const preview={ticket:'ticket',sourceId:'guide',sourceRevision:1,channels:2,programs:20,firstStartMs:instant,lastStartMs:instant+300000,lastKnownStopMs:instant+600000};
    const host={discover:async(signal)=>{window.discoveryCalls=(window.discoveryCalls||0)+1;if(window.blockDiscovery)await new Promise(resolve=>window.resolveDiscovery=resolve);return window.discoveryResult||{candidates:[],outcomes:[]}},selectedChannel:()=>channel,channels:()=>[channel],now:()=>instant,formatTime:ms=>String(ms),
      sources:async()=>{window.calls.sources++;return window.mode==='missing'?[]:[source]},mappings:async()=>window.mode==='unmapped'?[]:[mapping],
      query:async(query,signal)=>{window.calls.queries.push(query);if(window.mode==='blocked')await new Promise(resolve=>window.resolveQuery=resolve);return {programs:window.mode==='unknown'?[program('Unknown',instant-1000,null,0)]:[program('Current <img src=x>',instant-1000,instant+100000,0),program('Chicago Bears',instant+200000,instant+300000,1)],nextCursor:null,sourceRevision:1,databaseRevision:1}},
      coverage:async()=>({publishedRevision:1,updatedMs:window.stale?instant-90000000:instant,startMs:instant-100000,endMs:instant+604800000}),
      guideChannels:async()=>({channels:[{id:'wfld',names:['Chicago <img src=x>']}],nextCursor:null,sourceRevision:1}),
      preview:async(input,signal)=>{if(window.previewMode==='blocked')await new Promise(resolve=>{window.resolvePreview=resolve;window.previewSignal=signal});return preview},
      commitPreview:async(ticket)=>{window.calls.commits.push(ticket);if(window.commitMode==='fail')throw new Error('private');if(window.commitMode==='blocked')await new Promise(resolve=>window.resolveCommit=resolve);return {committed:true}},
      discardPreview:async(ticket)=>{window.calls.discard.push(ticket);if(window.discardMode==='fail')throw new Error('private');if(window.discardMode==='blocked')await new Promise(resolve=>window.resolveDiscard=resolve)},removeSource:async()=>{},setMapping:async(value)=>window.calls.mapping.push(value),watch:async(value)=>window.calls.watch.push(value)};
    window.host=host;
    window.summaryCalls=[];window.summaryMode='normal';window.catalogRevision='1';
    host.catalogRevision=()=>window.catalogRevision;
    window.cancelCalls=[];window.cancelFail=false;host.cancelSummary=async id=>{window.cancelCalls.push(id);if(window.cancelFail)throw new Error('Fixture cancel acknowledgment failed');};
    host.summary=async(query,signal)=>{
      window.summaryCalls.push(query);
      if(window.summaryMode==='blocked') await new Promise(resolve=>{window.resolveSummary=resolve;window.summarySignal=signal});
      const now=query.atMs;
      const current=window.summaryMode==='overlap'||window.mode==='unknown'?null:now<instant+100000?{title:'Current <img src=x>',startMs:instant-1000,stopMs:instant+100000}:now>=instant+200000&&now<instant+300000?{title:'Chicago Bears',startMs:instant+200000,stopMs:instant+300000}:null;
      const next=now<instant+200000?{title:'Chicago Bears',startMs:instant+200000,stopMs:instant+300000}:null;
      return {...query,catalogRevision:window.catalogRevision,databaseRevision:1,mappingStatus:'mapped',mapping:{...mapping,catalogSourceId:query.catalogSourceId,appChannelId:query.appChannelId},sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-1000,endMs:instant+300000},cacheStatus:window.stale?'stale':'current',currentStatus:window.summaryMode==='overlap'?'overlap':window.mode==='unknown'?'unknown-end':current?'current':'gap',nextStatus:next?'next':'none',current,next};
    };
    if(${manualClock}) {
      window.clock=instant;window.clockTimers=new Map();window.clockTimerId=0;
      host.now=()=>window.clock;
      host.summaryClock={now:()=>window.clock,setTimeout:(callback,delay)=>{const id=++window.clockTimerId;window.clockTimers.set(id,{callback,at:window.clock+delay});return id;},clearTimeout:id=>window.clockTimers.delete(id)};
      window.advanceClock=ms=>{window.clock+=ms;for(const [id,timer] of [...window.clockTimers])if(timer.at<=window.clock){window.clockTimers.delete(id);timer.callback();}};
    }
    host.enableTimeline=${timeline};
    window.events=[];host.presentation=${presentation}?'page':undefined;
    host.opened=async()=>{window.events.push('opened');if(window.blockOpen)await new Promise(resolve=>window.releaseOpen=resolve)};
    host.closed=async()=>{window.events.push('closed');if(window.failClose)throw new Error('fixture');if(window.blockClose)await new Promise(resolve=>window.releaseClose=resolve)};
    window.guide=GuideUI.mountGuide(document.getElementById('guide'),host);
  `,
  });
  return page;
}

it('page keeps outside navigation interactive; advanced and mapping remain modal', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => {
      const nav = document.createElement('button');
      nav.id = 'nav';
      nav.textContent = 'Watch navigation';
      document.body.prepend(nav);
      await Reflect.get(window, 'guide').open();
    });
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(false);
    expect(await page.locator('.guide-dialog').getAttribute('data-primary-page')).toBe('guide');
    await page.locator('#nav').click();
    expect(await page.locator('#nav').evaluate((n) => n === document.activeElement)).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(true);
    expect(await page.locator('.guide-dialog').getAttribute('data-primary-page')).toBeNull();
    expect(await page.evaluate(() => Reflect.get(window, 'events'))).toEqual(['opened', 'closed']);
    await page.evaluate(() => Reflect.get(window, 'guide').close());
    await page.evaluate(() => Reflect.get(window, 'guide').openMapping());
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'events'))).toEqual(['opened', 'closed']);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});
it('close joins actual pending open callback and fences late query publication', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'blockOpen', true);
      void Reflect.get(window, 'guide').open();
    });
    await page.waitForFunction(() => Reflect.get(window, 'events').length === 1);
    await page.evaluate(() => {
      Reflect.set(window, 'closedDone', false);
      void Reflect.get(window, 'guide')
        .close()
        .then(() => Reflect.set(window, 'closedDone', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'closedDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').sources)).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'releaseOpen')());
    await page.waitForFunction(() => Reflect.get(window, 'closedDone') === true);
    expect(await page.locator('.guide-dialog').evaluate((n) => (n as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').sources)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'events'))).toEqual(['opened', 'closed']);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});
it('coalesced close retains pending hook and subsequent reopen waits its actual settlement', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.evaluate(() => {
      Reflect.set(window, 'blockClose', true);
      const guide = Reflect.get(window, 'guide');
      const first = guide.close();
      Reflect.set(window, 'coalesced', first === guide.close());
      Reflect.set(window, 'reopened', false);
      void guide.open().then(() => Reflect.set(window, 'reopened', true));
    });
    await page.waitForFunction(() => Reflect.get(window, 'events').includes('closed'));
    expect(await page.evaluate(() => Reflect.get(window, 'coalesced'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'reopened'))).toBe(false);
    await page.evaluate(() => {
      Reflect.set(window, 'blockClose', false);
      Reflect.get(window, 'releaseClose')();
    });
    await page.waitForFunction(() => Reflect.get(window, 'reopened') === true);
    expect(await page.evaluate(() => Reflect.get(window, 'events'))).toEqual([
      'opened',
      'closed',
      'opened',
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});
it('failed close hook is not confirmed and disposal joins a retried hook', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    const failed = await page.evaluate(async () => {
      Reflect.set(window, 'failClose', true);
      try {
        await Reflect.get(window, 'guide').close();
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'failClose', false);
      Reflect.set(window, 'blockClose', true);
      Reflect.set(window, 'disposedDone', false);
      void Reflect.get(window, 'guide')
        .dispose()
        .then(() => Reflect.set(window, 'disposedDone', true));
    });
    await page.waitForFunction(() => Reflect.get(window, 'events').length === 3);
    expect(await page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseClose')());
    await page.waitForFunction(() => Reflect.get(window, 'disposedDone') === true);
    expect(await page.locator('.guide-dialog').count()).toBe(0);
  } finally {
    await page.close();
  }
});
it('default presentation remains modal without invoking page hooks', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'guide').close());
    expect(await page.evaluate(() => Reflect.get(window, 'events'))).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});

it('primary page fits below an interactive header without covering navigation', async () => {
  const page = await fixture(true, false, true);
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addStyleTag({
      content:
        '*{box-sizing:border-box}body{margin:0;font:16px system-ui}#brand{height:64px;padding:8px}#guide{height:calc(100dvh - 64px)}',
    });
    await page.evaluate(async () => {
      const header = document.createElement('header');
      header.id = 'brand';
      header.innerHTML = '<button id="watch-nav">Watch navigation</button>';
      document.body.prepend(header);
      await Reflect.get(window, 'guide').open();
    });
    const header = await page.locator('#brand').boundingBox(),
      dialog = await page.locator('.guide-dialog').boundingBox();
    expect(dialog!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(720);
    expect(dialog!.width).toBe(1280);
    await page.locator('#watch-nav').click();
    expect(await page.locator('#watch-nav').evaluate((n) => n === document.activeElement)).toBe(
      true,
    );
    expect(await page.locator('.gx-timeline').count()).toBe(1);
    expect(await page.locator('video').count()).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});

it('advanced modal escapes a hidden primary host and the same owned dialog returns for page mode', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => {
      const container = document.getElementById('guide')!;
      const host = Reflect.get(window, 'host');
      host.opened = async () => {
        container.hidden = false;
      };
      host.closed = async () => {
        container.hidden = true;
      };
      await Reflect.get(window, 'guide').open();
      await Reflect.get(window, 'guide').close();
    });
    expect(await page.locator('#guide').isVisible()).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    expect(await page.locator('body > .guide-dialog').isVisible()).toBe(true);
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'guide').close());
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    expect(await page.locator('#guide > .guide-dialog').isVisible()).toBe(true);
    expect(await page.locator('.guide-dialog').count()).toBe(1);
    expect(await page.locator('.guide-dialog').evaluate((n) => n.matches(':modal'))).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'guide').dispose());
    await page.close();
  }
});
