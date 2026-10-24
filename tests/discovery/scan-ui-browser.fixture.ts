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
 * What the scan screen's browser tests share: the built component, the
 * browser, page fixtures and helpers. Each scan-ui-*browser.test.ts file calls
 * useScanUiBrowser() once.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect } from 'vitest';
import { build } from 'vite';
import { readStylesheet } from '../support/stylesheet';

export let browser: Browser;

export let bundle: string;

export async function fixture(
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

export async function installMutationSeam(page: Page) {
  await page.evaluate(() => {
    const host = Reflect.get(window, 'scanHost');
    Reflect.set(window, 'mutationAcks', []);
    Reflect.set(window, 'submittedMutations', []);
    Reflect.set(window, 'mutationSaves', []);
    Reflect.set(window, 'mutationPrepareRevisions', []);
    const initialMutations = new WeakSet<object>();
    Reflect.set(window, 'initialMutationAcks', []);
    const originalPrepare = host.checkpoint.prepare;
    host.checkpoint.prepare = () => {
      throw new Error('Legacy preparation must not run');
    };
    host.checkpoint.prepareMutation = async (
      snapshot: unknown,
      signal: AbortSignal,
      expectedRevision: string,
    ) => {
      const initial = Reflect.get(window, 'persisted') === null;
      if (!initial) Reflect.get(window, 'mutationPrepareRevisions').push(expectedRevision);
      const mutation = { kind: 'save', checkpoint: await originalPrepare(snapshot, signal) };
      if (initial) initialMutations.add(mutation);
      else Reflect.get(window, 'submittedMutations').push(mutation);
      return mutation;
    };
    host.checkpoint.saveMutation = async (
      mutation: { checkpoint: string },
      revision: string,
      checkpointRevision: string,
    ) => {
      // Existing Stop/paired assertions measure after the newly required initial durable ACK.
      if (initialMutations.has(mutation)) {
        Reflect.set(window, 'persisted', JSON.parse(mutation.checkpoint));
        Reflect.set(window, 'checkpointRevision', '1');
        return { committed: true, checkpointRevision: '1' };
      }
      Reflect.get(window, 'mutationSaves').push({ mutation, revision, checkpointRevision });
      await new Promise<void>((resolve) => Reflect.set(window, 'releaseMutationSave', resolve));
      if (Reflect.get(window, 'rejectMutationSave'))
        throw new Error('Controlled settled save failure');
      Reflect.set(window, 'persisted', JSON.parse(mutation.checkpoint));
      Reflect.set(window, 'checkpointRevision', '47');
      return { committed: true, checkpointRevision: '47' };
    };
    host.checkpoint.acknowledgeMutation = (mutation: unknown, revision: string) => {
      if (initialMutations.has(mutation as object)) {
        Reflect.get(window, 'initialMutationAcks').push({ revision });
        return;
      }
      Reflect.get(window, 'mutationAcks').push({
        revision,
        exactSubmitted: Reflect.get(window, 'submittedMutations').includes(mutation),
      });
    };
  });
}

export async function scan(page: Page, retainAutomatic = false): Promise<void> {
  await page.getByRole('button', { name: 'Scan configured sources' }).click();
  await page.getByLabel('Candidate channels').locator('li').first().waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('button')?.disabled &&
      [...document.querySelectorAll('button')].some(
        (button) =>
          button.getAttribute('aria-label') === 'Scan configured sources' && !button.disabled,
      ),
  );
  await advanced(page);
  if (
    !retainAutomatic &&
    (await page.evaluate(() => Array.isArray(Reflect.get(window, 'probes'))))
  ) {
    await selectAction(page, 'clear');
    await page.getByRole('button', { name: 'Run action', exact: true }).click();
    await page.evaluate(() => {
      Reflect.set(window, 'automaticProbes', [...Reflect.get(window, 'probes')]);
      Reflect.set(window, 'probes', []);
      Reflect.set(window, 'probeBudgets', []);
    });
  }
}

export async function advanced(page: Page): Promise<void> {
  await page.locator('.scan-options').evaluate((el) => ((el as HTMLDetailsElement).open = true));
}

export async function selectAction(page: Page, value: string): Promise<void> {
  await advanced(page);
  await page.getByLabel('Scan review action').selectOption(value);
}

export async function applicationStyles(): Promise<string> {
  const files = ['style', 'management', 'guide', 'responsive', 'in-app-select', 'modal-viewport'];
  return (await Promise.all(files.map((file) => readStylesheet(`src/ui/${file}.css`)))).join('\n');
}

export async function assertScanActionsReachable(page: Page, visualHeight: number): Promise<void> {
  for (const label of ['Close scan review', 'Scan configured sources']) {
    const action = page.getByRole('button', { name: label, exact: true });
    expect(await action.isVisible()).toBe(true);
    const geometry = await action.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        height: rect.height,
        bottom: rect.bottom,
        hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node,
      };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.bottom).toBeLessThanOrEqual(visualHeight);
    expect(geometry.hit).toBe(true);
  }
}

export async function installSelectionEpisode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = Reflect.get(window, 'scanHost');
    Reflect.set(window, 'selectionEpisodes', []);
    Reflect.set(window, 'selectionDisposals', []);
    Reflect.set(window, 'commitEpisodes', []);
    host.beginSelectionEpisode = async (context: {
      generation: number;
      revision: string;
      capturedSources: unknown[];
      reconciliationScopes: Map<string, unknown>;
    }) => {
      const episodes = Reflect.get(window, 'selectionEpisodes');
      const episodeId = `episode-${episodes.length + 1}`;
      episodes.push({
        episodeId,
        generation: context.generation,
        revision: context.revision,
        sources: context.capturedSources.length,
        scopes: context.reconciliationScopes.size,
        initialAcknowledged: Reflect.get(window, 'persisted') !== null,
      });
      return {
        episodeId,
        dispose: async () => {
          Reflect.get(window, 'selectionDisposals').push(episodeId);
        },
      };
    };
    const commit = host.commit;
    host.commit = async (...args: unknown[]) => {
      Reflect.get(window, 'commitEpisodes').push(args[5]);
      return commit(...args);
    };
  });
}

export async function continueFixture(
  declaredFormat = false,
  ramOnly = false,
  count = 2,
): Promise<Page> {
  const page = await fixture(true, true, false, true);
  await page.evaluate(
    ({ format, memoryOnly, candidateCount }) => {
      Reflect.set(window, 'candidateCount', candidateCount);
      Reflect.set(window, 'commitAdvances', true);
      const host = Reflect.get(window, 'scanHost'),
        probe = host.probe;
      if (memoryOnly) host.checkpoint.prepare = async () => null;
      if (format) {
        const capture = host.capture;
        host.capture = (...args: unknown[]) => {
          const value = capture(...args);
          return {
            ...value,
            sources: value.sources.map((entry: { source: object }) => ({
              ...entry,
              source: { ...entry.source, contentKind: 'catalog' },
            })),
          };
        };
      }
      host.probe = async (...args: unknown[]) => {
        const reply = await probe(...args);
        return Reflect.get(window, 'badContinueReply') !== false &&
          (args[0] as { channel: { name: string } }).channel.name === `Alpha ${candidateCount - 1}`
          ? { ...reply, fingerprint: 'foreign' }
          : reply;
      };
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    },
    { format: declaredFormat, memoryOnly: ramOnly, candidateCount: count },
  );
  await page.waitForFunction(
    (candidateCount) =>
      !Reflect.get(window, 'scan').snapshot().busy &&
      Reflect.get(window, 'scan').snapshot().published === candidateCount - 1,
    count,
  );
  return page;
}

/** The hooks every test file of this suite needs; call once at the top of the file. */
export function useScanUiBrowser(): void {
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
}
