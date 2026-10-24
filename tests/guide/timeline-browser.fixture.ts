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
 * What the timeline guide's browser tests share: the built component, the
 * browser, page fixtures and helpers. Each timeline-*-browser.test.ts file
 * calls useTimelineBrowser() once.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect } from 'vitest';
import { build } from 'vite';
import { readStylesheet } from '../support/stylesheet';
import { type TimelineChannel } from '../../src/ui/guide-timeline-model';

export const captureDirectory = `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-narrow-agenda`;

export let browser: Browser,
  bundle: string,
  listedBridgeBundle: string,
  remoteBundle: string,
  archiveBundle: string,
  shellBundle: string,
  css: string,
  fullCss: string;

export async function fixture(
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

export async function rowCapacity(page: Page): Promise<number> {
  return page.locator('.gx-timeline-viewport').evaluate((viewport) => {
    const pitch = parseFloat(
      getComputedStyle(viewport.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
    );
    // Rendered rows: the viewport plus eight overscan rows each side, capped at 32.
    return Math.min(32, Math.max(1, Math.ceil(viewport.clientHeight / pitch) + 1) + 16);
  });
}

export async function emptyFixture(unmapped = false) {
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

export async function coverageFixture(): Promise<Page> {
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

export async function narrowAgenda(
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

/** The hooks every test file of this suite needs; call once at the top of the file. */
export function useTimelineBrowser(): void {
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
    if (!listedChunk || listedChunk.type !== 'chunk')
      throw new Error('Listed bridge entry missing.');
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
          'guide-panel',
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
}
