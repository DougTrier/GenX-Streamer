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

/**
 * What the guide screen's browser tests share: the built component, the
 * browser, page fixtures and helpers. Each guide-ui-*browser.test.ts file calls
 * useGuideUiBrowser() once.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import { readStylesheet } from '../support/stylesheet';

export let browser: Browser;

export let bundle: string;

export async function chooseGuide(page: Page, label: string, value: string) {
  const names: Record<string, string> = {
    channel: 'Channel guide',
    choose: 'Choose channel / day',
    search: 'Search programs',
    sources: 'Program guide setup',
    mapping: 'Channel mapping',
    add: 'Add source',
    manage: 'Manage sources',
    preview: 'Review schedule preview',
  };
  if (label === 'Guide view' && ['sources', 'mapping'].includes(value))
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: names[value], exact: true }).click();
  if (value === 'sources')
    await page
      .locator('.guide-manual-source')
      .evaluate((el) => ((el as HTMLDetailsElement).open = true));
}

export async function fixture(manualClock = false, timeline = false, tv = false): Promise<Page> {
  const page = await browser.newPage(
    tv ? { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 } : {},
  );
  page.setDefaultTimeout(3000);
  await page.route('http://127.0.0.1/guide-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main id="guide"></main>' }),
  );
  await page.goto('http://127.0.0.1/guide-fixture');
  await page.addScriptTag({ content: bundle });
  if (timeline) {
    await page.addStyleTag({
      content:
        (await readStylesheet('src/ui/guide.css')) +
        (await readStylesheet('src/ui/guide-timeline.css')),
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
    window.guide=GuideUI.mountGuide(document.getElementById('guide'),host);
  `,
  });
  return page;
}

export async function open(page: Page, query = ''): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as { guide: { open(query?: string): void } }).guide.open(value),
    query,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Guide programs"]')?.children.length ||
      document.querySelector('[role="status"]')?.textContent?.includes('No program guide') ||
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes('No program guide is connected'),
  );
}

export async function dispose(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { guide: { dispose(): Promise<void> } }).guide.dispose(),
  );
  await page.close();
}

/** The hooks every test file of this suite needs; call once at the top of the file. */
export function useGuideUiBrowser(): void {
  beforeAll(async () => {
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'guide-remote-fixture',
          resolveId(id) {
            if (id.endsWith('virtual:guide-remote')) return '\0guide-remote';
          },
          load(id) {
            if (id === '\0guide-remote')
              return `export * from ${JSON.stringify(resolve('src/ui/guide/guide.ts'))}; export {ChannelCoverageCleanupError} from ${JSON.stringify(resolve('src/guide/native.ts'))}; export {createShell} from ${JSON.stringify(resolve('src/ui/shell/shell.ts'))}; export {installRemoteNavigation, createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/shell/remote-navigation.ts'))};`;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: { entry: 'virtual:guide-remote', formats: ['iife'], name: 'GuideUI' },
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
}
