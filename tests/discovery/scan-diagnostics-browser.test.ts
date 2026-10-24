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
import { chromium, type Browser, type Page } from '@playwright/test';
import type { SourceScanHost } from '../../src/ui/scan/source-scan-model';
import type { StagedScanSelection } from '../../src/discovery/scan';
import type { HealthObservation } from '../../src/discovery/health';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/scan/source-scan.ts', formats: ['iife'], name: 'ScanUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing UI bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing UI entry');
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
  pipeline = false,
  healthMetadata = false,
  savedHistory = false,
  durable = false,
): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<main id="scan"></main>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    window.revision='review-1';window.collectMode='normal';window.commitMode='normal';window.commits=[];window.closedReaders=0;window.collectCalls=0;
    const sources=['a','b'].map(id=>({source:{id,name:id==='a'?'<img src=x onerror=alert(1)>':'Unavailable source',kind:'url',location:'https://fixture.invalid/'+id},fingerprint:'fingerprint-'+id}));
    const host={capture:(draft)=>({revision:window.revision,sources:draft??sources}),revision:()=>window.revision,
      collect:async(source,signal)=>{window.collectCalls++;
        if(window.collectMode==='blocked'){await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{window.closedReaders++;resolve();},40),{once:true}));return {channels:[],warnings:[]};}
        if(source.id==='b')throw new Error('https://private.invalid/secret');
        return {channels:Array.from({length:window.candidateCount||101},(_,index)=>({sourceId:source.id,name:'Alpha '+index,category:'News',urls:[window.parallelOrigins?'https://fixture-'+index+'.invalid/live':window.fairOrigins&&index>=16?'https://other.invalid/live':'https://fixture.invalid/'+index]})),warnings:[]};
      },
      commit:async(staged,revision,signal,health)=>{window.commits.push({staged,revision,health});if(window.commitMode==='fail')throw new Error('private');if(window.commitMode==='blocked')await new Promise(resolve=>window.resolveCommit=resolve);if(window.commitAdvances)window.revision='saved-'+window.commits.length;return {committed:true,revision:window.commitAdvances?window.revision:'saved-revision'};}
    };
    if(${pipeline}) {
      window.probes=[];window.probeBudgets=[];window.guideReviews=[];window.closedProbes=0;window.probeMode='normal';
      host.guides=async()=>[{id:'guide',fingerprint:'guide-revision'}];host.platform=()=> 'Fixture';host.now=()=>1700000000000;
      host.probe=async(candidate,signal,budgetMs)=>{window.probes.push(candidate.key);window.probeBudgets.push(budgetMs);if(window.probeMode==='blocked'||window.probeMode==='partial'&&candidate.channel.name!=='Alpha 0'||window.probeMode==='batch'&&Number(candidate.channel.name.split(' ')[1])>=16)await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{window.closedProbes++;resolve()},40),{once:true}));return {channelId:candidate.key,sourceId:candidate.sourceId,fingerprint:candidate.sourceFingerprint,platform:'Fixture',observedAt:1700000000000,verdict:'PlayedHere',evidence:window.probeFailName===candidate.channel.name?{kind:'timeout'}:{kind:'http',status:200,contentRecognized:true}}};
      host.enrich=async(candidate,guides)=>[{candidateKey:candidate.key,guideSourceId:guides[0].id,guideChannelId:'regional-channel',status:'suggested'}];
      host.openGuide=candidate=>window.guideReviews.push(candidate.key);
      const collect=host.collect;host.collect=async(source,signal)=>{const parsed=await collect(source,signal);if(window.collectMode==='shift'&&parsed.channels.length)parsed.channels[0].name='Moved candidate';return parsed};
    }
    if(${healthMetadata}) {window.profile='inspection-v1';window.budgetProfile=false;host.observerProfile=(budget)=>window.profile+(window.budgetProfile?'@'+budget:'');}
    if(${savedHistory}) {
      window.historyCalls=[];window.historyBudgets=[];window.historyMode='normal';window.historySettled=0;window.historyFreshness='stale';
      host.savedHealth=async(query)=>{window.historyBudgets.push(query.budgetMs);window.historyCalls.push({offset:query.offset,query:query.query,revision:query.revision});
        if(window.historyMode==='blocked')await new Promise(resolve=>query.signal.addEventListener('abort',()=>setTimeout(()=>{window.historySettled++;resolve()},40),{once:true}));
        if(window.historyMode==='changed')throw new Error('Saved checks changed. Start from the first page.');
        const rows=Array.from({length:query.query?1:101},(_,index)=>({name:query.query||'Saved '+index,category:'News',sourceName:'<img src=x onerror=alert(1)>',checkedUrlOrdinal:index===0?1:0,verdict:'Reachable',observedAt:1700000000000,platform:'windows',observerProfile:'reachability-v1/native-http-v1',freshness:window.historyFreshness,origin:'imported',evidence:{kind:'http',status:200,contentRecognized:true}}));
        return {rows:rows.slice(query.offset,query.offset+50),total:rows.length,revision:'2:3'};
      };
    }
    if(${durable}) {
      window.persisted=null;window.checkpointRevision='0';window.checkpointLoads=0;window.checkpointWrites=[];window.checkpointDiscards=[];
      const commit=host.commit;host.commit=async(staged,revision,signal,health,context)=>{
        const receipt=await commit(staged,revision,signal,health);
        if(context){window.persisted=JSON.parse(context.mutation.checkpoint);window.persisted.catalogRevision=receipt.revision;window.checkpointRevision=String(Number(window.checkpointRevision)+1);receipt.checkpointRevision=window.checkpointRevision;}
        return receipt;
      };
      host.checkpoint={
        load:async(signal)=>{window.checkpointLoads++;if(window.checkpointLoadMode==='blocked')await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{window.closedCheckpointLoads=(window.closedCheckpointLoads||0)+1;resolve()},40),{once:true}));return {checkpointStatus:window.invalidCheckpoint?'invalid':window.persisted?'valid':'absent',checkpoint:null,parsed:window.invalidCheckpoint?undefined:window.persisted,jobId:window.invalidCheckpoint?'known-invalid':window.persisted?.jobId??null,checkpointRevision:window.checkpointRevision,catalogRevision:window.revision}},
        prepare:async(snapshot,signal)=>JSON.stringify({...snapshot,schemaVersion:1,sourceDefinitions:snapshot.capturedSources.map(entry=>({source:entry.source,definitionFingerprint:'fixture'}))}),
        save:async(text,revision,checkpointRevision,signal)=>{if(window.checkpointSaveMode==='fail')throw new Error('private-sentinel');window.checkpointWrites.push({revision,checkpointRevision});window.persisted=JSON.parse(text);window.checkpointRevision=String(Number(window.checkpointRevision)+1);return {committed:true,checkpointRevision:window.checkpointRevision}},
        discard:async(jobId,revision,checkpointRevision,signal)=>{window.checkpointDiscards.push({jobId,revision,checkpointRevision});window.persisted=null;window.invalidCheckpoint=false;window.checkpointRevision=String(Number(window.checkpointRevision)+1);return {committed:true,checkpointRevision:window.checkpointRevision}}
      };
      window.activity=[];host.activity=active=>window.activity.push(active);
    }
    window.scanHost=host;
    window.scan=ScanUI.mountSourceScan(document.getElementById('scan'),host);window.scan.open();
  `,
  });
  return page;
}

it('private snapshot counts actual pending publication and acknowledged entries without payloads', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () => Reflect.get(window, 'scan').snapshot().pendingPublications === 1,
    );
    const snapshot = await page.evaluate(() => Reflect.get(window, 'scan').snapshot());
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      phase: 'publishing',
      total: 20,
      published: 0,
      busy: true,
      pendingPublications: 1,
      lastFailure: 'none',
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/fixture|Alpha|https|fingerprint|sourceId|jobId/);
    expect(await page.evaluate(() => Object.isFrozen(Reflect.get(window, 'scan').snapshot()))).toBe(
      true,
    );
    await page.evaluate(() => {
      Reflect.set(window, 'commitMode', 'normal');
      Reflect.get(window, 'resolveCommit')();
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    const done = await page.evaluate(() => Reflect.get(window, 'scan').snapshot());
    expect(done).toMatchObject({
      phase: 'completed',
      total: 20,
      checked: 20,
      responded: 20,
      published: 20,
      pendingPublications: 0,
      lastFailure: 'none',
    });
    expect(snapshot.published).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it.each([
  'catalog-revision-stale',
  'https://private.invalid/token',
  'prepare-health-ownership',
  'prepare-runtime-unsupported',
])('failed publication is retained with static category %s', async (failure) => {
  const page = await fixture(true);
  try {
    await page.evaluate((failure) => {
      Reflect.set(window, 'candidateCount', 16);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.get(window, 'scanHost').commit = async () => {
        throw new Error(failure);
      };
      Reflect.get(window, 'scan').startAutomatic();
    }, failure);
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'failed');
    const snapshot = await page.evaluate(() => Reflect.get(window, 'scan').snapshot());
    expect(snapshot).toMatchObject({
      lastFailure: failure === 'catalog-revision-stale' ? 'catalog-cas' : 'publish-failed',
      published: 0,
      pendingPublications: 0,
      busy: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain('private.invalid');
    if (failure.startsWith('prepare-')) {
      expect(snapshot.preparationFailure).toBe(failure);
      expect(await page.getByRole('alert').textContent()).toContain('Channels could not be saved');
      expect(await page.getByRole('alert').textContent()).not.toContain('Scan canceled');
      await page.evaluate(() => {
        Reflect.get(window, 'scanHost').commit = async () => ({
          committed: true,
          revision: Reflect.get(window, 'revision'),
        });
        Reflect.get(window, 'scan').startAutomatic();
      });
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).not.toHaveProperty(
        'preparationFailure',
      );
    } else expect(snapshot).not.toHaveProperty('preparationFailure');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('terminal failure diagnostic is immutable, fires once and a throwing sink cannot change ownership', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 16);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'diagnosticCalls', 0);
      const host = Reflect.get(window, 'scanHost') as SourceScanHost;
      host.onDiagnostic = (snapshot) => {
        Reflect.set(window, 'diagnosticCalls', Reflect.get(window, 'diagnosticCalls') + 1);
        Reflect.set(window, 'terminalDiagnostic', snapshot);
        throw new Error('private sink failure');
      };
      host.commit = async () => {
        throw new Error('catalog-revision-stale');
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'diagnosticCalls') === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'terminalDiagnostic'))).toMatchObject({
      phase: 'failed',
      busy: false,
      pendingPublications: 0,
      lastFailure: 'catalog-cas',
      published: 0,
    });
    expect(
      await page.evaluate(() => Object.isFrozen(Reflect.get(window, 'terminalDiagnostic'))),
    ).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'scan').open());
    expect(await page.evaluate(() => Reflect.get(window, 'diagnosticCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('one malformed channel probe cannot stop or publish over healthy siblings', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 10);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'diagnosticCalls', 0);
      const host = Reflect.get(window, 'scanHost') as SourceScanHost,
        probe = host.probe;
      if (!probe) throw new Error('Missing controlled probe');
      host.onDiagnostic = () =>
        Reflect.set(window, 'diagnosticCalls', Reflect.get(window, 'diagnosticCalls') + 1);
      host.probe = async (candidate, signal, budget) => {
        const observation = await probe(candidate, signal, budget);
        return candidate.channel.name === 'Alpha 3'
          ? ({ ...observation, evidence: { kind: 'decoded' } } as unknown as HealthObservation)
          : observation;
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().phase === 'paused',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      total: 10,
      checked: 9,
      responded: 9,
      published: 9,
      pendingPublications: 0,
      lastFailure: 'none',
    });
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(10);
    expect(await page.evaluate(() => Reflect.get(window, 'diagnosticCalls'))).toBe(0);
    expect(await page.getByRole('alert').textContent()).not.toContain('Scan could not finish');
    const publishedNames = await page.evaluate(() =>
      (Reflect.get(window, 'commits') as Array<{ staged: StagedScanSelection }>).flatMap((c) =>
        c.staged.sources.flatMap((source) => source.candidates.map((channel) => channel.name)),
      ),
    );
    expect(publishedNames).toHaveLength(9);
    expect(publishedNames).not.toContain('Alpha 3');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('held publisher permits probe overlap only to the64-entry mailbox plus16 already admitted probes', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 160);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 80 &&
        Reflect.get(window, 'scan').snapshot().pendingPublications === 1,
    );
    expect(
      await page.evaluate(
        () => Reflect.get(window, 'commits')[0].staged.sources[0].candidates.length,
      ),
    ).toBe(64);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(80);
    await page.evaluate(() => {
      Reflect.set(window, 'commitMode', 'normal');
      Reflect.get(window, 'resolveCommit')();
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'completed',
      checked: 160,
      responded: 160,
      published: 160,
      pendingPublications: 0,
    });
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'commits').map((c: { staged: StagedScanSelection }) =>
          c.staged.sources.reduce((n, s) => n + s.candidates.length, 0),
        ),
      ),
    ).toEqual([64, 64, 32]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('Cancel joins a late committed batch and Resume publishes retained unacknowledged observations without reprobing them', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 100);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 80 &&
        Reflect.get(window, 'scan').snapshot().pendingPublications === 1,
    );
    await page.getByRole('button', { name: 'Cancel operation' }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'commitMode', 'normal');
      Reflect.get(window, 'resolveCommit')();
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(64);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'completed',
      checked: 100,
      responded: 100,
      published: 100,
      pendingPublications: 0,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(100);
    expect(
      await page.evaluate(
        () =>
          Reflect.get(window, 'commits').flatMap((c: { staged: StagedScanSelection }) =>
            c.staged.sources.flatMap((s) => s.candidates),
          ).length,
      ),
    ).toBe(100);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
