// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fixture as scanFixture } from '../application/bounded-scan-resume.fixture';
import { browser as guideBrowser, fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';

const pendingNativeCalls = new Map<number, string>();
let nativeCallSequence = 0;
useGuideUiBrowser({ assertDrained: () => expect([...pendingNativeCalls.values()]).toEqual([]) });
afterEach(() => {
  // Every owned read/dispose/page close must finish before browser teardown.
  expect(guideBrowser.contexts()).toHaveLength(0);
  expect([...pendingNativeCalls.values()]).toEqual([]);
});
let publicationBundle: string;
beforeAll(async () => {
  const stubs = new Map([
    [
      '/platform/bounded-scan-resume',
      'export const createBoundedNativeScanResumeTransport=()=>({capabilities:async()=>true,host:window.nativeScanHost});',
    ],
    [
      '/platform/scan-checkpoint-summary',
      'export const nativeScanCheckpointSummary={read:async()=>({checkpointStatus:"valid",storedVersion:3,catalogRevision:"1",checkpointRevision:"1",jobId:"job"})};export const validateScanCheckpointSummary=()=>{throw new Error("Unexpected fixture checkpoint validation")};',
    ],
    [
      'bounded-scan-resume-service',
      'export const createBoundedScanResumeService=host=>{window.admittedScanHost=host;return {}};',
    ],
    ['scan-controller', 'export class BoundedScanEntryRefusal extends Error {}'],
    [
      '/platform/scan-resume-publication-projection',
      'export const createScanPublicationProjectionReader=()=>async receipt=>window.scanProjection(receipt);',
    ],
  ]);
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'actual-scan-publication-guide-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('virtual:guide-scan-publication')) return '\0guide-scan-publication';
          const normalized = id.replaceAll('\\', '/').replace(/\.ts$/, '');
          for (const key of stubs.keys()) if (normalized.endsWith(key)) return '\0fixture' + key;
        },
        load(id) {
          if (id === '\0guide-scan-publication')
            return `export {createScanResumeWiring} from ${JSON.stringify(resolve('src/application/discovery/scan-resume-wiring.ts'))};`;
          if (id.startsWith('\0fixture')) return stubs.get(id.slice('\0fixture'.length));
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:guide-scan-publication', formats: ['iife'], name: 'ScanPublication' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing publication bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing publication entry');
  publicationBundle = chunk.code;
});

for (const mode of ['channel', 'programme', 'empty', 'tune'] as const) {
  const programmeFocus = mode === 'programme',
    empty = mode === 'empty',
    tune = mode === 'tune';
  it(`real scan publication keeps ${mode} controls usable and catches up without reopening or rebuilding`, async () => {
    const native = scanFixture(empty ? 5 : 4, false, true);
    const page = await fixture(false, true);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const allowed = new Set(['admit', 'take', 'probe', 'commit', 'release', 'close']);
    await page.exposeFunction('nativeScanCall', async (method: string, args: unknown[]) => {
      if (!allowed.has(method)) throw new Error('Unexpected native fixture method');
      const operation = Reflect.get(native.host, method) as (
        ...values: unknown[]
      ) => Promise<unknown>;
      const call = ++nativeCallSequence;
      pendingNativeCalls.set(call, method);
      try {
        return await operation(...args);
      } finally {
        pendingNativeCalls.delete(call);
      }
    });
    await page.addScriptTag({ content: publicationBundle });
    await page.addStyleTag({
      content:
        'html,body{margin:0;height:100%}*{box-sizing:border-box}#guide{height:100%;width:100%}.guide-dialog{font-size:16px}.gx-timeline-viewport{height:460px;min-height:460px;max-height:460px}',
    });
    try {
      await page.addScriptTag({
        type: 'module',
        content: `
      await window.guide.dispose();
      window.integrationCalls={opened:0,closed:0,sources:0,mappings:0,guideChanged:0,render:0,browser:0,build:0,inspections:0,watch:[],membership:[],programmes:[]};
      window.emptyRows=${empty};window.holdFinalProgramme=${empty};
      window.isTauri=true;
      const source={id:'source',name:'Fixture',kind:'url',location:'https://fixture.invalid/index.m3u'};
      const saved=Array.from({length:40},(_,i)=>({id:'base-'+i,sourceId:'source',name:'Saved sports '+i,category:'Sports',urls:['https://fixture.invalid/live/'+i]}));
      const env={catalog:{schemaVersion:1,sources:[source],channels:saved},settings:{sources:[source]},persistedCatalogRevision:'1',catalogRevision:0,catalogBrowseViewRevision:0,catalogWrites:Promise.resolve(),
        applicationClosing:false,importRunning:false,transferBusy:false,scanPlaybackBusy:()=>true,
        preferences:{settledSources:async()=>env.settings.sources,adoptAcknowledgedSources:async sources=>[...new Map([...env.settings.sources,...sources].map(s=>[s.id,s])).values()]},
        renderCatalog:()=>{integrationCalls.render++;guide.catalogChanged()},browser:{search:()=>integrationCalls.browser++},
        geographyControls:{update(){}},updateVisibleGuide(){},automaticGuides:{request:async()=>integrationCalls.build++},notice(){},diagnostics:{emit:async()=>{}}};
      window.scanEnv=env;window.guideDbRevision=1;
      window.scanProjection=receipt=>{
        const i=receipt.publicationIndices[0];
        // Simultaneous schedule changes exercise the distinct native guide DB fence.
        window.guideDbRevision++;
        return {sources:i===0?[source]:[],channels:[{id:'added-'+i,sourceId:'source',name:'Scanned '+i,category:'Sports',urls:['https://fixture.invalid/added/'+i]}]};
      };
      window.nativeScanHost={admit:()=>nativeScanCall('admit',[]),take:(id,request)=>nativeScanCall('take',[id,request]),probe:channel=>nativeScanCall('probe',[channel]),commit:(id,request)=>nativeScanCall('commit',[id,request]),release:(id,ids)=>nativeScanCall('release',[id,ids]),close:id=>nativeScanCall('close',[id])};
      const shared={automaticScanActive:true,SCAN_LIST_BATCH:300,scanStorageRevision:'1',scanBatchThrottle:{listed:40,guidePending:false,startedMs:0,listPending:false,catalogRenderPending:false},scanProbeGate:{run:work=>work()}};
      window.scanShared=shared;
      const wiring=ScanPublication.createScanResumeWiring(env,shared),signal=new AbortController().signal;
      await wiring.createApplicationBoundedResume({jobId:null},signal);
      const admitted=window.admittedScanHost,plan=await admitted.admit(signal);
      let revisions=plan.revisions;
      window.commitBatch=async()=>{
        const page=await admitted.take(plan.planId,{limit:1,blockedOrigins:[]},signal),row=page.rows[0];
        const observation=await admitted.probe(row.candidate,signal,plan.budgetMs,plan.sourcePolicies[0]);
        const receipt=await admitted.commit(plan.planId,{expectedRevisions:revisions,observations:[{candidateIndex:row.candidateIndex,observation}],publicationIndices:[row.candidateIndex]},signal);
        revisions={catalogRevision:receipt.catalogRevision,healthRevision:receipt.healthRevision,checkpointRevision:receipt.checkpointRevision};
        await admitted.release(plan.planId,[row.reservationId],signal);
      };
      const map=c=>({catalogSourceId:c.sourceId,appChannelId:c.id,guideSourceId:'guide',xmltvChannelId:'xml-'+c.id});
      host.presentation='page';host.opened=async()=>integrationCalls.opened++;host.closed=async()=>integrationCalls.closed++;
      let selected=saved[1];
      host.channels=()=>env.catalog.channels;host.selectedChannel=()=>selected;host.catalogRevision=()=>String(env.catalogRevision);
      host.sources=async()=>{integrationCalls.sources++;return [{id:'guide',name:'Saved guide',location:'https://fixture.invalid/guide',kind:'url',allowHttp:false,revision:1,updatedMs:instant}]};
      host.mappings=async()=>{integrationCalls.mappings++;return saved.map(map)};
      host.summary=async query=>{if(query.appChannelId==='base-2')integrationCalls.inspections++;return {...query,catalogRevision:String(env.catalogRevision),databaseRevision:window.guideDbRevision,mappingStatus:'mapped',mapping:map(saved.find(c=>c.id===query.appChannelId)),sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-100000,endMs:instant+10800000},cacheStatus:'current',currentStatus:'gap',nextStatus:'none',current:null,next:null}};
      host.coverage=undefined;host.channelCoverage=undefined;
      window.holdMembership=true;window.pendingMembership=[];window.holdFirstProgramme=true;
      host.listedChannels=async()=>{
        const catalogRevision=String(env.catalogRevision),databaseRevision=window.guideDbRevision;
        integrationCalls.membership.push({catalogRevision,databaseRevision});
        if(catalogRevision!=='0'&&window.holdMembership)await new Promise(resolve=>window.pendingMembership.push(resolve));
        return {catalogRevision,databaseRevision,channels:saved.map(c=>({...map(c),sourceRevision:1}))};
      };
      host.query=async(q,signal)=>{
        const databaseRevision=window.guideDbRevision,catalogRevision=String(env.catalogRevision),id=q.appChannelIds[0];
        integrationCalls.programmes.push({id,catalogRevision,databaseRevision});
        if(id==='base-0'&&window.holdFirstProgramme){window.holdFirstProgramme=false;await new Promise(resolve=>window.releaseFirstProgramme=resolve)}
        if(id==='base-0'&&databaseRevision===5&&window.holdFinalProgramme){window.holdFinalProgramme=false;await new Promise(resolve=>window.releaseFinalProgramme=resolve)}
        const channel=saved.find(c=>c.id===id);
        return {sourceRevision:1,databaseRevision,nextCursor:null,programs:window.emptyRows&&id==='base-2'?[]:[{...map(channel),title:'Schedule '+databaseRevision+' for '+id,description:'Fixture live sports',startMs:q.windowStartMs,stopMs:q.windowEndMs,ordinal:0}]};
      };
      host.watch=async(channel,signal)=>{signal.throwIfAborted();integrationCalls.watch.push({id:channel.id,sourceId:channel.sourceId,catalogRevision:env.catalogRevision});if(${tune}){selected=channel;guide.selectedChannelChanged()}};
      window.guide=GuideUI.mountGuide(document.getElementById('guide'),host);
      env.guide={...guide,catalogChanged:(...args)=>{integrationCalls.guideChanged++;guide.catalogChanged(...args)}};
      await guide.open();
      window.releaseMembership=()=>{window.holdMembership=false;window.pendingMembership.splice(0).forEach(resolve=>resolve())};
    `,
      });
      const later = page.locator('.gx-timeline-channel[title="Saved sports 2"]');
      if (empty)
        await browserExpect(
          later.locator('..').getByText('No listings for this time', { exact: true }),
        ).toBeVisible();
      else
        await browserExpect(
          page.getByRole('button', { name: 'Schedule 1 for base-2', exact: true }),
        ).toBeVisible();
      await later.focus();
      await page.locator('.gx-timeline-viewport').evaluate((element) => {
        element.scrollTop = 15;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.evaluate(() => {
        Reflect.set(window, 'retainedGuideLabel', document.activeElement);
        Reflect.set(
          window,
          'retainedGuideRow',
          (document.activeElement as HTMLElement).closest('.gx-timeline-row'),
        );
        Reflect.set(
          window,
          'guideScroll',
          document.querySelector('.gx-timeline-viewport')!.scrollTop,
        );
        Reflect.set(
          window,
          'guideLabelTop',
          (document.activeElement as HTMLElement).getBoundingClientRect().top,
        );
      });
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) await Reflect.get(window, 'commitBatch')();
      });
      expect(native.batches).toHaveLength(3);
      expect(await page.evaluate(() => Reflect.get(window, 'scanEnv').catalogRevision)).toBe(3);
      await page.evaluate(() => Reflect.get(window, 'releaseFirstProgramme')());
      await page.waitForFunction(() => Reflect.get(window, 'pendingMembership').length === 1);
      const assertRetained = async () => {
        expect(
          await page.evaluate(() => {
            const label = Reflect.get(window, 'retainedGuideLabel'),
              row = Reflect.get(window, 'retainedGuideRow');
            return {
              connected: label.isConnected,
              rowConnected: row.isConnected,
              focused: document.activeElement === label,
              sameRow: label.closest('.gx-timeline-row') === row,
              scroll: document.querySelector('.gx-timeline-viewport')!.scrollTop,
              beforeScroll: Reflect.get(window, 'guideScroll'),
              top: label.getBoundingClientRect().top,
              beforeTop: Reflect.get(window, 'guideLabelTop'),
            };
          }),
        ).toMatchObject({
          connected: true,
          rowConnected: true,
          focused: true,
          sameRow: true,
          scroll: 15,
          beforeScroll: 15,
        });
        expect(
          await page.evaluate(
            () => Reflect.get(window, 'retainedGuideLabel').getBoundingClientRect().top,
          ),
        ).toBe(await page.evaluate(() => Reflect.get(window, 'guideLabelTop')));
        if (empty)
          await browserExpect(
            later.locator('..').getByText('No listings for this time', { exact: true }),
          ).toBeVisible();
        else
          await browserExpect(
            page.getByRole('button', { name: 'Schedule 1 for base-2', exact: true }),
          ).toBeVisible();
      };
      await assertRetained();
      // The retained direct Watch resolves current canonical identity at activation.
      await later.click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'integrationCalls').watch))
        .toEqual([{ id: 'base-2', sourceId: 'source', catalogRevision: 3 }]);
      await assertRetained();
      await page.evaluate(() => Reflect.get(window, 'commitBatch')());
      await assertRetained();
      if (programmeFocus)
        await page.getByRole('button', { name: 'Schedule 1 for base-2', exact: true }).focus();
      await page.evaluate(() => Reflect.get(window, 'releaseMembership')());
      if (empty) {
        await page.waitForFunction(
          () => typeof Reflect.get(window, 'releaseFinalProgramme') === 'function',
        );
        await page.waitForFunction(() =>
          Reflect.get(window, 'integrationCalls').programmes.some(
            (entry: { id: string; databaseRevision: number }) =>
              entry.id === 'base-2' && entry.databaseRevision === 5,
          ),
        );
        await browserExpect(later.locator('..').locator('.gx-timeline-track')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await later.dispatchEvent('contextmenu');
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'integrationCalls').inspections))
          .toBe(1);
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        await later.focus();
        await page.keyboard.press('Shift+F10');
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'integrationCalls').inspections))
          .toBe(2);
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        await page.evaluate(async () => {
          await Reflect.get(window, 'commitBatch')();
          Reflect.set(window, 'emptyRows', false);
          Reflect.get(window, 'releaseFinalProgramme')();
        });
      }
      const finalSchedule = empty ? 6 : 5,
        finalRevision = empty ? '5' : '4';
      await browserExpect(
        page.getByRole('button', {
          name: 'Schedule ' + finalSchedule + ' for base-2',
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(page.locator('.gx-timeline-status')).toHaveAttribute(
        'data-state',
        'ready',
      );
      if (programmeFocus)
        await browserExpect(
          page.getByRole('button', { name: 'Schedule 5 for base-2', exact: true }),
        ).toBeFocused();
      expect(
        await page.evaluate(() => ({
          same: document.activeElement === Reflect.get(window, 'retainedGuideLabel'),
          connected: Reflect.get(window, 'retainedGuideRow').isConnected,
          scroll: document.querySelector('.gx-timeline-viewport')!.scrollTop,
        })),
      ).toEqual({ same: !programmeFocus, connected: true, scroll: 15 });
      const calls = await page.evaluate(() => Reflect.get(window, 'integrationCalls'));
      expect(calls).toMatchObject({
        opened: 1,
        closed: 0,
        sources: 1,
        mappings: 1,
        guideChanged: 0,
        render: 0,
        browser: 0,
        build: 0,
      });
      expect(calls.membership.at(-1)).toMatchObject({
        catalogRevision: finalRevision,
        databaseRevision: finalSchedule,
      });
      expect(
        calls.programmes.some(
          (entry: { catalogRevision: string; databaseRevision: number }) =>
            entry.catalogRevision === finalRevision && entry.databaseRevision === finalSchedule,
        ),
      ).toBe(true);
      expect(native.batches).toHaveLength(empty ? 5 : 4);
      expect(
        await page.evaluate(() => Reflect.get(window, 'scanShared').scanBatchThrottle),
      ).toMatchObject({ guidePending: true, listPending: true, catalogRenderPending: true });
      expect(
        await page.evaluate(() => Reflect.get(window, 'scanEnv').catalog.channels.length),
      ).toBe(empty ? 45 : 44);
      if (empty) {
        await later.dispatchEvent('contextmenu');
        await later.focus();
        await page.keyboard.press('Shift+F10');
        expect(await page.evaluate(() => Reflect.get(window, 'integrationCalls').inspections)).toBe(
          2,
        );
      }
      if (tune) {
        // Tune once more after the last publication. Reusing its presentation
        // must not acknowledge a model that has not adopted the added channels.
        await later.click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'integrationCalls').watch))
          .toEqual([
            { id: 'base-2', sourceId: 'source', catalogRevision: 3 },
            { id: 'base-2', sourceId: 'source', catalogRevision: 4 },
          ]);
        await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged());
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'integrationCalls').sources))
          .toBe(2);
        expect(await page.evaluate(() => Reflect.get(window, 'integrationCalls').mappings)).toBe(2);
        await browserExpect(
          page.getByRole('button', { name: 'Schedule 5 for base-2', exact: true }),
        ).toBeVisible();
      }
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseFirstProgramme')?.();
        Reflect.get(window, 'releaseFinalProgramme')?.();
        Reflect.get(window, 'releaseMembership')?.();
        await Reflect.get(window, 'guide').dispose();
      });
      await native.host.close('plan');
      expect([...pendingNativeCalls.values()]).toEqual([]);
      await page.close();
    }
  });
}
