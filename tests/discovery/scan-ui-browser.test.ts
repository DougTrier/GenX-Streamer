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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/source-scan.ts', formats: ['iife'], name: 'ScanUI' },
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
for (const action of ['stop', 'dispose', 'catalog', 'profile'] as const)
  it(`Continue comparison yields to ${action} and rechecks ownership before retaining RAM`, async () => {
    const page = await continueFixture(false, false, 130);
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
      }));
      await page.evaluate(() => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.onProgress = (progress: unknown) => Reflect.set(window, 'yieldedProgress', progress);
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal);
          const realTimeout = window.setTimeout;
          // Hold only the first zero-delay comparison slice. The timer itself executes;
          // its continuation remains owned until the test explicitly releases it.
          window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (delay !== 0) return realTimeout(callback, delay, ...args);
            window.setTimeout = realTimeout;
            return realTimeout(
              () =>
                Reflect.set(window, 'releaseComparisonSlice', () => {
                  if (typeof callback !== 'function')
                    throw new Error('Expected owned comparison callback');
                  callback(...args);
                }),
              0,
            );
          }) as typeof window.setTimeout;
          return { ...saved, parsed: JSON.parse(JSON.stringify(saved.parsed)) };
        };
        Reflect.set(window, 'badContinueReply', false);
        Reflect.set(
          window,
          'yieldedContinue',
          Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' }),
        );
      });
      await page.waitForFunction(
        () => typeof Reflect.get(window, 'releaseComparisonSlice') === 'function',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      await page.evaluate((kind) => {
        if (kind === 'catalog') Reflect.set(window, 'revision', 'changed-during-comparison');
        else if (kind === 'profile') Reflect.set(window, 'profile', 'changed-during-comparison');
        else {
          const scan = Reflect.get(window, 'scan');
          Reflect.set(window, 'comparisonActionDone', false);
          Reflect.set(
            window,
            'comparisonAction',
            (kind === 'stop' ? scan.stopAutomatic() : scan.dispose()).then(() =>
              Reflect.set(window, 'comparisonActionDone', true),
            ),
          );
        }
      }, action);
      if (action === 'stop' || action === 'dispose') {
        expect(await page.evaluate(() => Reflect.get(window, 'comparisonActionDone'))).toBe(false);
        expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      }
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseComparisonSlice')();
        await Reflect.get(window, 'yieldedContinue');
        await Reflect.get(window, 'comparisonAction');
      });
      expect(
        await page.evaluate(() => ({
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          collects: Reflect.get(window, 'collectCalls'),
        })),
      ).toEqual(before);
      if (action === 'catalog' || action === 'profile')
        expect(
          await page.evaluate(() => Reflect.get(window, 'yieldedProgress').resumeRefusal),
        ).toBe('changed');
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
async function installMutationSeam(page: Page) {
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

for (const fails of [false, true])
  it(`owned Stop joins one held checkpoint ${fails ? 'failure' : 'ACK'} and blocks repeated Stop/Continue/Rescan admission`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((rejects) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'probeMode', 'blocked');
        Reflect.set(window, 'rejectMutationSave', rejects);
        Reflect.get(window, 'scan').startAutomatic();
      }, fails);
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan'),
          first = scan.stopAutomatic(),
          second = scan.stopAutomatic();
        Reflect.set(window, 'sameStopPromise', first === second);
        Reflect.set(
          window,
          'stopOutcome',
          first.then(
            () => 'ACK',
            () => 'failed',
          ),
        );
      });
      await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
      expect(await page.evaluate(() => Reflect.get(window, 'sameStopPromise'))).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Scan configured sources', exact: true })
          .isVisible(),
      ).toBe(false);
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan');
        scan.startAutomatic(undefined, { query: 'Different' });
        scan.rescanAutomatic(undefined, { query: 'Different' });
        Reflect.set(window, 'entrySettled', false);
        Reflect.set(
          window,
          'stopEntry',
          scan.prepareAutomaticEntry().then(
            (state: unknown) => {
              Reflect.set(window, 'entrySettled', true);
              return state;
            },
            () => {
              Reflect.set(window, 'entrySettled', true);
              return 'failed';
            },
          ),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'entrySettled'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
      await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
      expect(await page.evaluate(() => Reflect.get(window, 'stopOutcome'))).toBe(
        fails ? 'failed' : 'ACK',
      );
      await page.evaluate(() => Reflect.get(window, 'stopEntry'));
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual(
        fails ? [] : [{ revision: '47', exactSubmitted: true }],
      );
      if (fails)
        expect(await page.getByRole('alert').textContent()).toContain(
          'Saved scan could not be updated',
        );
    } finally {
      await page.close();
    }
  });

it('paired checkpoint mutation ACK waits for actual catalog publication and uses its exact revision', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.set(window, 'commitAdvances', true);
      const host = Reflect.get(window, 'scanHost'),
        original = host.commit;
      host.commit = async (...args: unknown[]) => {
        const receipt = await original(...args);
        Reflect.set(window, 'checkpointRevision', '42');
        return { ...receipt, checkpointRevision: '42' };
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'resolveCommit')());
    await page.waitForFunction(() => Reflect.get(window, 'mutationAcks').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([
      { revision: '42', exactSubmitted: true },
    ]);
  } finally {
    await page.close();
  }
});

it('dispose and suspend join an already-admitted held Stop save without deadlock or new writes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() =>
      Reflect.set(window, 'heldStop', Reflect.get(window, 'scan').stopAutomatic()),
    );
    await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
    await page.evaluate(() => {
      Reflect.set(window, 'disposeSettled', false);
      const scan = Reflect.get(window, 'scan');
      Reflect.set(
        window,
        'heldDispose',
        Promise.all([scan.suspend(), scan.dispose()]).then(() => {
          Reflect.set(window, 'disposeSettled', true);
        }),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposeSettled'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationPrepareRevisions'))).toEqual([
      '1', // Initial checkpoint is already durably acknowledged.
    ]);
    await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
    await page.evaluate(() => Reflect.get(window, 'heldDispose'));
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([
      { revision: '47', exactSubmitted: true },
    ]);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});

it('close waits for held checkpoint preparation rejection without saving, ACKing or changing the prior checkpoint', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const previous = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
    await installMutationSeam(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      host.checkpoint.prepareMutation = () =>
        new Promise((_resolve, reject) => {
          Reflect.set(window, 'rejectHeldPreparation', reject);
        });
      Reflect.set(window, 'heldStop', Reflect.get(window, 'scan').stopAutomatic());
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'rejectHeldPreparation') === 'function',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'disposeSettled', false);
      Reflect.set(
        window,
        'heldDispose',
        Reflect.get(window, 'scan')
          .dispose()
          .then(() => {
            Reflect.set(window, 'disposeSettled', true);
          }),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposeSettled'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    await page.evaluate(() =>
      Reflect.get(window, 'rejectHeldPreparation')(new Error('application-closing')),
    );
    await page.evaluate(() =>
      Promise.all([Reflect.get(window, 'heldStop'), Reflect.get(window, 'heldDispose')]),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(
      previous,
    );
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});

it('close does not swallow a rejected already-dispatched Stop save', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.set(window, 'rejectMutationSave', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() =>
      Reflect.set(
        window,
        'heldStopOutcome',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(
            () => 'resolved',
            () => 'rejected',
          ),
      ),
    );
    await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
    await page.evaluate(() =>
      Reflect.set(
        window,
        'heldDisposeOutcome',
        Reflect.get(window, 'scan')
          .dispose()
          .then(
            () => 'resolved',
            () => 'rejected',
          ),
      ),
    );
    await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
    expect(await page.evaluate(() => Reflect.get(window, 'heldStopOutcome'))).toBe('rejected');
    expect(await page.evaluate(() => Reflect.get(window, 'heldDisposeOutcome'))).toBe('rejected');
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(1);
  } finally {
    await page.close();
  }
});

for (const mode of ['rejected', 'malformed'] as const)
  it(`paired ${mode} catalog publication never acknowledges prepared checkpoint mutation`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((failureMode) => {
        Reflect.set(window, 'candidateCount', 1);
        const host = Reflect.get(window, 'scanHost');
        host.commit = async () => {
          if (failureMode === 'rejected') throw new Error('Controlled publication failure');
          return { committed: false, revision: '', checkpointRevision: '42' };
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, mode);
      await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'failed');
      expect(await page.evaluate(() => Reflect.get(window, 'submittedMutations').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    } finally {
      await page.close();
    }
  });

for (const fails of [false, true])
  it(`standalone mutation save ${fails ? 'failure never ACKs' : 'ACKs only after its durable receipt'}`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((rejects) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'probeMode', 'blocked');
        Reflect.set(window, 'rejectMutationSave', rejects);
        Reflect.get(window, 'scan').startAutomatic();
      }, fails);
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
      await page.evaluate(() => {
        Reflect.set(
          window,
          'mutationStop',
          Reflect.get(window, 'scan')
            .stopAutomatic()
            .then(
              () => 'settled',
              () => 'refused',
            ),
        );
      });
      await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
      expect(
        await page.evaluate(() => {
          const save = Reflect.get(window, 'mutationSaves')[0];
          return { revision: save.revision, checkpointRevision: save.checkpointRevision };
        }),
      ).toEqual({ revision: 'review-1', checkpointRevision: '1' });
      await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
      await page.evaluate(() => Reflect.get(window, 'mutationStop'));
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual(
        fails ? [] : [{ revision: '47', exactSubmitted: true }],
      );
    } finally {
      await page.close();
    }
  });
async function scan(page: Page, retainAutomatic = false): Promise<void> {
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
async function advanced(page: Page): Promise<void> {
  await page.locator('.scan-options').evaluate((el) => ((el as HTMLDetailsElement).open = true));
}
async function selectAction(page: Page, value: string): Promise<void> {
  await advanced(page);
  await page.getByLabel('Scan review action').selectOption(value);
}

describe('actual Chromium scan review component', () => {
  for (const keyboard of [false, true])
    it(`initial Scan is content sized with the full application cascade, keyboard owner ${keyboard}`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize({ width: 960, height: 540 });
        await page.addStyleTag({ content: await applicationStyles() });
        if (keyboard)
          await page.evaluate(() => {
            document.documentElement.classList.add('viewport-keyboard-open');
            document.documentElement.style.setProperty('--visible-viewport-height', '540px');
          });
        const geometry = await page.locator('.source-scan-dialog').evaluate((node) => {
          const rect = node.getBoundingClientRect(),
            body = node.querySelector('.scan-body')!,
            setup = node.querySelector('.scan-setup')!;
          return {
            state: (node as HTMLElement).dataset.scanState,
            height: rect.height,
            width: rect.width,
            body: body.getBoundingClientRect().height,
            setup: setup.getBoundingClientRect().height,
            insets: [getComputedStyle(node).top, getComputedStyle(node).bottom],
            bodyFlex: getComputedStyle(body).flex,
          };
        });
        expect(geometry.state).toBe('start');
        expect(geometry.width).toBeLessThanOrEqual(560);
        expect(geometry.height).toBeLessThanOrEqual(320);
        expect(Math.abs(geometry.body - geometry.setup)).toBeLessThanOrEqual(4);
        await assertScanActionsReachable(page, 540);
        await page.locator('.scan-options').evaluate((node) => {
          (node as HTMLDetailsElement).open = true;
        });
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>('.source-scan-dialog')?.dataset.scanState ===
            'results',
        );
        expect(
          await page
            .locator('.source-scan-dialog')
            .evaluate((node) => node.getBoundingClientRect().height),
        ).toBeGreaterThan(geometry.height);
      } finally {
        await page.close();
      }
    });
  for (const viewport of [
    { width: 960, height: 540, visual: 300, textScale: 1 },
    { width: 320, height: 640, visual: 640, textScale: 2 },
    { width: 640, height: 360, visual: 360, textScale: 2 },
  ])
    it(`initial Scan keeps actions inside visual height ${viewport.visual}, width ${viewport.width}, text ${viewport.textScale}`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addStyleTag({ content: await applicationStyles() });
        await page.evaluate(({ visual, textScale }) => {
          document.documentElement.classList.add('viewport-keyboard-open');
          document.documentElement.style.setProperty('--visible-viewport-height', `${visual}px`);
          if (textScale !== 1) {
            const nodes = [
              ...document.querySelectorAll<HTMLElement>(
                '.source-scan-dialog,.source-scan-dialog *',
              ),
            ].map((node) => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
            for (const { node, size } of nodes) node.style.fontSize = `${size * textScale}px`;
          }
        }, viewport);
        await assertScanActionsReachable(page, viewport.visual);
        const bounds = await page.locator('dialog').boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.visual);
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
  it('captures the actual check budget/profile and never relabels it after dropdown changes', async () => {
    const page = await fixture(true, true, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'budgetProfile', true));
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page
        .locator('.scan-options')
        .evaluate((el) => ((el as HTMLDetailsElement).open = true));
      await page.getByLabel('Channel check time').selectOption('60000');
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.getByLabel('Channel check time').selectOption('20000');
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const saved = await page.evaluate(() => Reflect.get(window, 'commits')[0].health);
      expect(saved.budgetMs).toBe(60000);
      expect(saved.observerProfile).toBe('inspection-v1@60000');
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByLabel('Channel check time').selectOption('45000');
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyBudgets'))).toEqual([45000]);
    } finally {
      await page.close();
    }
  });
  it('explains a different observer profile without implying a new playback result', async () => {
    const page = await fixture(false, false, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'historyFreshness', 'different-profile'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      const first = page.getByLabel('Saved checks', { exact: true }).locator('li').first();
      await first.waitFor();
      expect(await first.locator('p').textContent()).toBe(
        'Stream responded · Different check settings · Imported historical check',
      );
      expect(await first.locator('p').textContent()).not.toContain('playable');
      expect(await first.locator('p').textContent()).not.toContain('different-profile');
      await first.getByText('Check details', { exact: true }).click();
      expect(await first.locator('dl').textContent()).toContain(
        'Check settingsreachability-v1/native-http-v1',
      );
    } finally {
      await page.close();
    }
  });
  it('loads saved checks explicitly with bounded pages and restores the unsaved review', async () => {
    const page = await fixture(false, false, true);
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls').length)).toBe(0);
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(50);
      const first = page.getByLabel('Saved checks', { exact: true }).locator('li').first();
      expect(await first.locator('strong').textContent()).toBe('Saved 0');
      expect(await first.locator('details').getAttribute('open')).toBeNull();
      expect(await first.locator('dl').isVisible()).toBe(false);
      expect(await first.locator('time').getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
      expect(await first.locator('time').textContent()).not.toContain('T22:13');
      expect(await first.locator('span').textContent()).toBe(' · Windows');
      expect(await page.getByLabel('Search saved checks').getAttribute('placeholder')).toBe(
        'Channel, category or source',
      );
      await first.getByText('Check details', { exact: true }).click();
      expect(await first.locator('dl').isVisible()).toBe(true);
      expect(await first.locator('dl').textContent()).toContain('HTTP 200');
      expect(await first.locator('dl').textContent()).toContain('playback was not tested');
      expect(await first.locator('dl').textContent()).toContain('Alternate stream 2');
      expect(await first.locator('dl').textContent()).not.toContain('https://');
      expect(
        await page.getByLabel('Saved checks', { exact: true }).locator('li').first().textContent(),
      ).toContain('Stream responded · Older check · Imported historical check');
      expect(await page.locator('img').count()).toBe(0);
      await selectAction(page, 'next');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .getByLabel('Saved checks', { exact: true })
        .locator('li')
        .filter({ hasText: 'Saved 50' })
        .waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls')[1])).toEqual({
        offset: 50,
        query: '',
        revision: '2:3',
      });
      await page.getByLabel('Search saved checks').fill('Bears');
      await page
        .getByLabel('Saved checks', { exact: true })
        .locator('li')
        .filter({ hasText: 'Bears' })
        .waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(1);
      await selectAction(page, 'review');
      await page.getByRole('button', { name: 'Run action' }).click();
      expect(
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('rejects mixed-revision history pages and permits explicit first-page retry', async () => {
    const page = await fixture(false, false, true);
    try {
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'changed'));
      await selectAction(page, 'next');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Saved checks changed. Start from the first page.' })
        .waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(0);
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'normal'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls').at(-1))).toEqual({
        offset: 0,
        query: '',
      });
    } finally {
      await page.close();
    }
  });
  it('waits for owned history reads on close and ignores their late completion', async () => {
    const page = await fixture(false, false, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'blocked'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByText('Loading saved checks…').waitFor();
      await page.getByRole('button', { name: 'Close scan review' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog')?.open);
      expect(await page.evaluate(() => Reflect.get(window, 'historySettled'))).toBe(1);
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('saves only selected checked health with immutable review identity and profile', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      const health = await page.evaluate(() => Reflect.get(window, 'commits')[0].health);
      expect(health.platform).toBe('Fixture');
      expect(health.observerProfile).toBe('inspection-v1');
      expect(health.candidates).toHaveLength(1);
      expect(health.candidates[0].channel.name).toBe('Alpha 0');
      expect(health.observations).toHaveLength(1);
      expect(health.observations[0].verdict).toBe('Reachable');
      expect(health.observations[0].channelId).toBe(health.candidates[0].key);
    } finally {
      await page.close();
    }
  });
  it('refuses to relabel checked observations after the observer profile changes', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.evaluate(() => {
        Reflect.set(window, 'profile', 'inspection-v2');
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /Selection was not saved/ })
        .waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('displays completed health from a canceled batch while keeping Save fenced', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await page.evaluate(() => {
        Reflect.set(window, 'probeMode', 'partial');
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 2);
      await selectAction(page, 'cancel');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page
        .getByLabel('Candidate channels')
        .locator('li')
        .filter({ hasText: 'Alpha 0' })
        .filter({ hasText: 'Responded' })
        .waitFor();
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 },
  ])
    it(`saved checks remain bounded and navigable at ${viewport.width}x${viewport.height} with 200% text`, async () => {
      const page = await fixture(false, false, true);
      try {
        await page.setViewportSize(viewport);
        await page.addStyleTag({
          content:
            (await readFile('src/ui/style.css', 'utf8')) +
            '\n' +
            (await readFile('src/ui/guide.css', 'utf8')),
        });
        await selectAction(page, 'history');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
        await page
          .getByLabel('Saved checks', { exact: true })
          .locator('li')
          .first()
          .getByText('Check details', { exact: true })
          .click();
        await page.locator('dialog').evaluate((root) => {
          const sizes = [...root.querySelectorAll<HTMLElement>('*')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        await page.addStyleTag({ content: '.scan-candidates li {font-size:32px !important}' });
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .locator('li')
            .first()
            .locator('dl')
            .isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .evaluate((node) => node.scrollHeight > node.clientHeight),
        ).toBe(true);
        await selectAction(page, 'next');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page
          .getByLabel('Saved checks', { exact: true })
          .locator('li')
          .filter({ hasText: 'Saved 50' })
          .waitFor();
        const box = await page.getByRole('button', { name: 'Close scan review' }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        await page.getByRole('button', { name: 'Close scan review' }).click();
        expect(await page.locator('dialog').isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 },
  ])
    it(`review selection and paging remain clickable at ${viewport.width}x${viewport.height} with 200% text`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize(viewport);
        await page.addStyleTag({
          content:
            (await readFile('src/ui/style.css', 'utf8')) +
            '\n' +
            (await readFile('src/ui/guide.css', 'utf8')),
        });
        await scan(page);
        await page.locator('dialog').evaluate((root) => {
          const sizes = [...root.querySelectorAll<HTMLElement>('*')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        await page.addStyleTag({ content: '.scan-candidates label {font-size:24px !important}' });
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
        await selectAction(page, 'next');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page.getByRole('checkbox', { name: 'Select Alpha 50', exact: true }).check();
        await selectAction(page, 'previous');
        await page.getByRole('button', { name: 'Run action' }).click();
        expect(
          await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
        ).toBe(true);
        await page.getByRole('button', { name: 'Close scan review' }).click();
        expect(await page.locator('dialog').isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });
  it('uses the chosen check budget only for explicit selected checks and freezes it while busy', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .locator('.scan-options')
        .evaluate((el) => ((el as HTMLDetailsElement).open = true));
      await page.getByLabel('Channel check time', { exact: true }).selectOption('60000');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      expect(
        await page.evaluate(() => (window as unknown as { probeBudgets: number[] }).probeBudgets),
      ).toEqual([]);
      await page.evaluate(() => {
        (window as unknown as { probeMode: string }).probeMode = 'blocked';
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { probeBudgets: number[] }).probeBudgets.length === 1,
      );
      expect(await page.getByLabel('Channel check time', { exact: true }).isDisabled()).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { probeBudgets: number[] }).probeBudgets),
      ).toEqual([60000]);
      await selectAction(page, 'cancel');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { closedProbes: number }).closedProbes === 1,
      );
      expect(await page.getByLabel('Select Alpha 0', { exact: true }).isChecked()).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('rejects a changed selected candidate before any probe or guide enrichment', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { collectMode: string }).collectMode = 'shift';
      });
      await selectAction(page, 'guides');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.getAttribute('aria-label') === 'Scan configured sources' && !button.disabled,
        ),
      );
      expect(await page.evaluate(() => (window as unknown as { probes: string[] }).probes)).toEqual(
        [],
      );
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Alpha 0',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'guideReviews').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('automatic checks do not publish; optional selected guide suggestions require review', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      expect(await page.evaluate(() => (window as unknown as { probes: string[] }).probes)).toEqual(
        [],
      );
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await selectAction(page, 'guides');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByRole('button', { name: 'Review guide mapping' }).first().waitFor();
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Responded',
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).not.toContain(
        'PlayedHere',
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'no mapping saved',
      );
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits),
      ).toEqual([]);
      await page.getByRole('button', { name: 'Review guide mapping' }).first().click();
      expect(
        await page.evaluate(
          () => (window as unknown as { guideReviews: string[] }).guideReviews.length,
        ),
      ).toBe(1);
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it('cancels owned pipeline probes, waits for their cleanup and gates publication', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { probeMode: string }).probeMode = 'blocked';
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { probes: string[] }).probes.length === 1,
      );
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.getAttribute('aria-label') === 'Scan configured sources' && !button.disabled,
        ),
      );
      expect(
        await page.evaluate(() => (window as unknown as { closedProbes: number }).closedProbes),
      ).toBe(1);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Responded',
      );
    } finally {
      await page.close();
    }
  });
  it('reviews an unpersisted draft without importing all of its candidates', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        (window as unknown as { scan: { open(sources: unknown[]): void } }).scan.open([
          {
            source: {
              id: 'draft',
              name: 'New source',
              kind: 'url',
              location: 'https://fixture.invalid/draft',
            },
            fingerprint: 'draft-revision',
          },
        ]);
      });
      await scan(page);
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits.length),
      ).toBe(0);
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Not checked',
      );
      expect(await page.getByRole('button', { name: 'Check selected channels' }).isVisible()).toBe(
        false,
      );
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const saved = await page.evaluate(
        () =>
          (
            window as unknown as {
              commits: Array<{
                staged: { sources: Array<{ sourceId: string; candidates: unknown[] }> };
              }>;
            }
          ).commits[0].staged.sources,
      );
      expect(saved.map((entry) => entry.sourceId)).toEqual(['draft']);
      expect(saved[0].candidates).toHaveLength(1);
    } finally {
      await page.close();
    }
  });
  it('bounds results, renders source data inertly and saves only selected source provenance', async () => {
    const page = await fixture();
    try {
      await scan(page);
      expect(await page.locator('[aria-label="Candidate channels"] li').count()).toBe(50);
      expect(await page.locator('img').count()).toBe(0);
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const records = await page.evaluate(
        () =>
          (
            window as unknown as {
              commits: Array<{
                staged: {
                  sources: Array<{ sourceId: string; candidates: Array<{ name: string }> }>;
                  failedSourceIds: string[];
                };
              }>;
            }
          ).commits,
      );
      expect(records[0].staged.sources[0].sourceId).toBe('a');
      expect(records[0].staged.sources[0].candidates.map((entry) => entry.name)).toEqual([
        'Alpha 1',
      ]);
      expect(records[0].staged.failedSourceIds).toEqual(['b']);
    } finally {
      await page.close();
    }
  });
  it('cancellation waits for readers and refuses a canceled review save', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        (window as unknown as { collectMode: string }).collectMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Scan configured sources' }).click();
      await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      await page.getByText('Scan canceled. Existing channels retained.', { exact: true }).waitFor();
      expect(
        await page.evaluate(() => (window as unknown as { closedReaders: number }).closedReaders),
      ).toBe(2);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it('failed durable publication retains chosen preview and permits retry', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'fail';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Review retained.', { exact: true }).waitFor();
      expect(
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        false,
      );
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'normal';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it('stale catalog revisions fail before commit without clearing preview', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { revision: string }).revision = 'newer-review';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Review retained.', { exact: true }).waitFor();
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits.length),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('acknowledged commit is owned until settlement and Escape cannot undo it', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Saving reviewed selection…', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Run action' }).isDisabled()).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog', { name: 'Review source scan' }).isVisible()).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { resolveCommit: () => void }).resolveCommit(),
      );
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
});

async function applicationStyles(): Promise<string> {
  const files = ['style', 'management', 'guide', 'responsive', 'in-app-select', 'modal-viewport'];
  return (await Promise.all(files.map((file) => readFile(`src/ui/${file}.css`, 'utf8')))).join(
    '\n',
  );
}
async function assertScanActionsReachable(page: Page, visualHeight: number): Promise<void> {
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

it('Scan checks every one of 2001 candidates and Save needs no individual selections', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 2001);
      Reflect.set(window, 'probeFailName', 'Alpha 2000');
    });
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Save selected channels' }).isEnabled(), {
        timeout: 10000,
      })
      .toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(2001);
    expect(await page.getByRole('checkbox').count()).toBe(0);
    expect(await page.getByLabel('Candidate channels').locator('li').count()).toBe(50);
    expect(await page.getByRole('status').textContent()).toContain(
      '2000 channels responded. 1 could not be verified',
    );
    expect(await page.getByLabel('Scan review action').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Save selected channels' }).click();
    await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    const saved = await page.evaluate(() => Reflect.get(window, 'commits')[0]);
    expect(saved.staged.sources[0].candidates).toHaveLength(2000);
    expect(saved.health.observations).toHaveLength(2000);
    expect(
      saved.health.observations.every((o: { verdict: string }) => o.verdict === 'Reachable'),
    ).toBe(true);
  } finally {
    await page.close();
  }
});
it('automatic Scan cancellation joins the current probe and never checks later candidates or enables Save', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'probeMode', 'partial'));
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'probes').length >= 2);
    const started = await page.evaluate(() => Reflect.get(window, 'probes').length);
    expect(started).toBeLessThanOrEqual(5);
    await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Scan configured sources' }).isDisabled()).toBe(
      true,
    );
    await expect
      .poll(() => page.getByRole('button', { name: 'Scan configured sources' }).isDisabled())
      .toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(started - 1);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(started);
    expect(await page.getByLabel('Candidate channels').textContent()).toContain('Alpha 0');
    expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
      true,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
  } finally {
    await page.close();
  }
});

for (const outcome of ['responded', 'none', 'cancel'] as const) {
  it(`one-action automatic save ${outcome} retains checked publication ownership`, async () => {
    const page = await fixture(true, true);
    try {
      await page.evaluate((mode) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'commitAdvances', true);
        if (mode === 'none') Reflect.set(window, 'probeFailName', 'Alpha 0');
        if (mode === 'cancel') Reflect.set(window, 'probeMode', 'blocked');
        Reflect.get(window, 'scan').startAutomatic();
      }, outcome);
      if (outcome === 'cancel') {
        await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
        await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      }
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
      );
      expect(await page.getByLabel('Search scan results').isVisible()).toBe(false);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isVisible()).toBe(
        false,
      );
      expect(await page.getByText('Advanced', { exact: true }).isVisible()).toBe(false);
      const commits = await page.evaluate(() => Reflect.get(window, 'commits'));
      expect(commits).toHaveLength(outcome === 'responded' ? 1 : 0);
      if (outcome === 'responded') {
        expect(commits[0].staged.sources[0].candidates).toHaveLength(1);
        expect(commits[0].health.observations[0].verdict).toBe('Reachable');
        expect(await page.getByRole('status').textContent()).toBe('1 channel saved.');
      }
      if (outcome === 'none')
        expect(await page.getByRole('status').textContent()).toBe(
          'No channels responded. Nothing was added.',
        );
      if (outcome === 'cancel')
        expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(1);
    } finally {
      await page.close();
    }
  });
}

it('automatic hidden progress keeps checking and stopped scan resumes without recollection or duplicate batches', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'partial');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length >= 16);
    const dialog = page.getByRole('dialog', { name: 'Review source scan' });
    await dialog.getByRole('button', { name: 'Close scan review' }).click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    const before = await page.evaluate(() => Reflect.get(window, 'probes').length);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(before);
    await dialog.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
    );
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('20 channels saved.', { exact: true }).waitFor();
    const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    const commits = await page.evaluate(() => Reflect.get(window, 'commits'));
    expect(
      commits.flatMap((entry: { staged: { sources: { candidates: unknown[] }[] } }) =>
        entry.staged.sources.flatMap((source) => source.candidates),
      ),
    ).toHaveLength(20);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

async function installSelectionEpisode(page: Page): Promise<void> {
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
it('negotiated publication windows ACK first64 then four logical chunks once after Stop joins', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      Reflect.set(window, 'windowCheckpointKeys', []);
      host.checkpoint.prepareMutation = async (
        snapshot: { publishedKeys: string[] },
        signal: AbortSignal,
        _revision: string,
        limit: number,
        keys?: readonly string[],
      ) => {
        if (keys)
          Reflect.get(window, 'windowCheckpointKeys').push({
            cumulative: snapshot.publishedKeys.length,
            keys: [...keys],
            limit,
          });
        return { kind: 'save', checkpoint: await host.checkpoint.prepare(snapshot, signal) };
      };
      host.checkpoint.saveMutation = async (
        mutation: { checkpoint: string },
        revision: string,
        checkpointRevision: string,
        signal: AbortSignal,
      ) => host.checkpoint.save(mutation.checkpoint, revision, checkpointRevision, signal);
      const begin = host.beginSelectionEpisode;
      host.beginSelectionEpisode = async (...args: unknown[]) => ({
        ...(await begin(...args)),
        supportsWindow: true,
      });
      const commit = host.commit;
      Reflect.set(window, 'windows', []);
      host.commitWindow = async (
        chunks: { staged: unknown; health?: unknown }[],
        revision: string,
        signal: AbortSignal,
        checkpoint: unknown,
        episodeId: string,
      ) => {
        Reflect.get(window, 'windows').push(chunks);
        if (Reflect.get(window, 'windows').length === 2)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseWindow', resolve));
        return commit(
          chunks[0]!.staged,
          revision,
          signal,
          chunks[0]!.health,
          checkpoint,
          episodeId,
        );
      };
      Reflect.set(window, 'candidateCount', 320);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(() => Reflect.get(window, 'windows').length === 2);
    const sizes = await page.evaluate(() =>
      Reflect.get(window, 'windows').map((chunks: { health: { candidates: unknown[] } }[]) =>
        chunks.map((chunk) => chunk.health.candidates.length),
      ),
    );
    expect(sizes).toEqual([[64], [64, 64, 64, 64]]);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'windowCheckpointKeys').map(
          (entry: { cumulative: number; keys: string[]; limit: number }) => ({
            cumulative: entry.cumulative,
            newlyPublished: entry.keys.length,
            limit: entry.limit,
          }),
        ),
      ),
    ).toEqual([
      { cumulative: 64, newlyPublished: 64, limit: 256 },
      { cumulative: 320, newlyPublished: 256, limit: 256 },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(64);
    await page.evaluate(() => {
      Reflect.set(window, 'stopJoined', false);
      Reflect.get(window, 'scan')
        .stopAutomatic()
        .then(() => Reflect.set(window, 'stopJoined', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopJoined'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseWindow')());
    await page.waitForFunction(() => Reflect.get(window, 'stopJoined'));
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(320);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      320,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('an unnegotiated episode keeps64-entry legacy commits even when a window hook exists', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      host.commitWindow = async () => {
        throw new Error('Window must not be dispatched');
      };
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 130,
    );
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'commits').map(
          (commit: { health: { candidates: unknown[] } }) => commit.health.candidates.length,
        ),
      ),
    ).toEqual([64, 64, 2]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('a known predispatch size refusal preserves unACKed checks for explicit smaller Continue', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      const begin = host.beginSelectionEpisode;
      host.beginSelectionEpisode = async (...args: unknown[]) => ({
        ...(await begin(...args)),
        supportsWindow: true,
      });
      const commit = host.commit;
      Reflect.set(window, 'windowSizes', []);
      host.commitWindow = async (
        chunks: { staged: unknown; health: { candidates: unknown[] } }[],
        revision: string,
        signal: AbortSignal,
        checkpoint: unknown,
        episodeId: string,
      ) => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.health.candidates.length, 0);
        Reflect.get(window, 'windowSizes').push(size);
        if (size > 64) throw new (Reflect.get(window, 'ScanUI').SourceScanWindowSizeError)();
        return commit(
          chunks[0]!.staged,
          revision,
          signal,
          chunks[0]!.health,
          checkpoint,
          episodeId,
        );
      };
      Reflect.set(window, 'candidateCount', 320);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().phase === 'failed',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(64);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      64,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'windowSizes'))).toEqual([64, 256]);
    const checkedKeys = await page.evaluate(() => Reflect.get(window, 'probes'));
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'scanHost'),
        load = host.checkpoint.load;
      host.checkpoint.load = async (signal: AbortSignal) => {
        const saved = await load(signal);
        // Real wire omits undefined; collection may fill previously unknown format metadata.
        const parsed = JSON.parse(JSON.stringify(saved.parsed));
        for (const definition of parsed.sourceDefinitions) {
          definition.source.contentKind = 'catalog';
          definition.source.mediaMime = 'audio/x-mpegurl';
        }
        return { ...saved, parsed };
      };
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 320,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual(checkedKeys);
    expect(await page.evaluate(() => Reflect.get(window, 'windowSizes'))).toEqual([
      64, 256, 64, 64, 64, 64,
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('one selection episode owns multiple automatic publications after initial checkpoint ACK', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 130,
      undefined,
      { timeout: 6000 },
    );
    expect(await page.evaluate(() => Reflect.get(window, 'selectionEpisodes'))).toEqual([
      {
        episodeId: 'episode-1',
        generation: expect.any(Number),
        revision: 'review-1',
        sources: 2,
        scopes: 1,
        initialAcknowledged: true,
      },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'commitEpisodes'))).toEqual([
      'episode-1',
      'episode-1',
      'episode-1',
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
    ]);
  } finally {
    await page.close();
  }
});
it('Stop reconciles admitted settled observations blocked behind publisher capacity before durable ACK and Continue', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 80);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 80 &&
        Reflect.get(window, 'commits').length === 1 &&
        Reflect.get(window, 'scan').snapshot().checked < 80,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(() => {
      Reflect.set(window, 'stoppingCapacity', Reflect.get(window, 'scan').stopAutomatic());
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'resolveCommit')());
    await page.evaluate(() => Reflect.get(window, 'stoppingCapacity'));
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
    ]);
    const counts = await page.evaluate(() => ({
      snapshot: Reflect.get(window, 'scan').snapshot(),
      settled: Reflect.get(window, 'persisted').observations.length,
      responded: Reflect.get(window, 'persisted').observations.filter(
        (record: { verdict: string }) => ['Reachable', 'PlayedHere'].includes(record.verdict),
      ).length,
      published: Reflect.get(window, 'persisted').publishedKeys.length,
      firstAckNames: Reflect.get(window, 'commits')[0].staged.sources.flatMap(
        (source: { candidates: { name: string }[] }) =>
          source.candidates.map((candidate) => candidate.name),
      ),
    }));
    expect(counts.settled).toBe(80);
    expect(counts.responded).toBe(80);
    expect(counts.firstAckNames).toHaveLength(64);
    expect(counts.published).toBe(counts.firstAckNames.length);
    expect(counts.snapshot).toMatchObject({
      busy: false,
      checked: counts.settled,
      responded: counts.responded,
      published: counts.published,
    });
    await page.evaluate(() => {
      Reflect.set(window, 'commitMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 80,
      undefined,
      { timeout: 6000 },
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(80);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
    const batches = await page.evaluate(() =>
      Reflect.get(window, 'commits').map(
        (commit: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          commit.staged.sources.flatMap((source) =>
            source.candidates.map((candidate) => candidate.name),
          ),
      ),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commitEpisodes'))).toEqual([
      'episode-1',
      'episode-2',
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
      'episode-2',
    ]);
    expect(batches.map((batch: string[]) => batch.length)).toEqual([64, 16]);
    expect(new Set(batches.flat()).size).toBe(80);
  } finally {
    await page.close();
  }
});

it('automatic batches publish while later probes are pending, retain acknowledged channels on Cancel and Resume only remaining work', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'batch');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'commits').length === 1 && Reflect.get(window, 'probes').length === 20,
      undefined,
      { timeout: 6000 },
    );
    expect(
      await page.evaluate(
        () => Reflect.get(window, 'commits')[0].staged.sources[0].candidates.length,
      ),
    ).toBe(16);
    const dialog = page.getByRole('dialog', { name: 'Review source scan' });
    await dialog.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(4);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('20 channels saved.', { exact: true }).waitFor();
    const state = await page.evaluate(() => ({
      commits: Reflect.get(window, 'commits'),
      probes: Reflect.get(window, 'probes'),
    }));
    expect(state.commits).toHaveLength(2);
    expect(state.commits[1].staged.sources[0].candidates).toHaveLength(4);
    expect(state.probes).toHaveLength(24);
    expect(
      new Set(
        state.commits.flatMap((entry: { health: { observations: { channelId: string }[] } }) =>
          entry.health.observations.map((observation) => observation.channelId),
        ),
      ).size,
    ).toBe(20);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

for (const invalid of ['foreign', 'stale', 'canceled'] as const)
  it(`a ${invalid} probe remains unverified while its settled sibling publishes and cold Continue rechecks only the untrusted key`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((invalidKind) => {
        Reflect.set(window, 'candidateCount', 2);
        Reflect.set(window, 'parallelOrigins', true);
        Reflect.set(window, 'commitAdvances', true);
        Reflect.set(window, 'badProbeReply', true);
        const host = Reflect.get(window, 'scanHost'),
          probe = host.probe,
          prepare = host.checkpoint.prepare;
        host.probe = async (...args: unknown[]) => {
          const reply = await probe(...args);
          if (Reflect.get(window, 'badProbeReply') && reply.channelId.endsWith(':1'))
            return invalidKind === 'foreign'
              ? { ...reply, fingerprint: 'foreign' }
              : invalidKind === 'stale'
                ? { ...reply, observedAt: 1699999999999 }
                : { ...reply, evidence: { kind: 'canceled' } };
          return reply;
        };
        host.checkpoint.prepare = async (
          snapshot: { observations: { verdict: string }[] },
          signal: AbortSignal,
        ) => {
          if (
            snapshot.observations.some((observation) =>
              ['NotChecked', 'Canceled'].includes(observation.verdict),
            )
          )
            throw new Error('Unsettled checkpoint observations are forbidden');
          return prepare(snapshot, signal);
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, invalid);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().checked === 1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
        checked: 1,
        responded: 1,
        published: 1,
      });
      await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'persisted').observations.map(
            (observation: { verdict: string }) => observation.verdict,
          ),
        ),
      ).toEqual(['Reachable']);
      expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
        1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
      await page.evaluate(async () => {
        await Reflect.get(window, 'scan').dispose();
        Reflect.set(window, 'badProbeReply', false);
        Reflect.set(
          window,
          'scan',
          Reflect.get(window, 'ScanUI').mountSourceScan(
            document.getElementById('scan'),
            Reflect.get(window, 'scanHost'),
          ),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
        'unfinished',
      );
      await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'scan').snapshot().published === 2 &&
          !Reflect.get(window, 'scan').snapshot().busy,
      );
      const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
      expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
      expect(probes.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(2);
    } finally {
      await page.close();
    }
  });

it('trusted timeout stays settled and unpublished across Stop and cold Continue while only interrupted keys recheck', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeFailName', 'Alpha 0');
      Reflect.set(window, 'heldTimeoutPeers', 0);
      const host = Reflect.get(window, 'scanHost'),
        probe = host.probe;
      host.probe = async (
        ...args: [candidate: { channel: { name: string } }, signal: AbortSignal, budgetMs?: number]
      ) => {
        const reply = await probe(...args);
        const index = Number(args[0].channel.name.split(' ')[1]);
        if (index >= 17 && !Reflect.get(window, 'timeoutColdResume')) {
          await new Promise<void>((resolve) => {
            args[1].addEventListener(
              'abort',
              () =>
                setTimeout(() => {
                  Reflect.set(window, 'closedProbes', Reflect.get(window, 'closedProbes') + 1);
                  resolve();
                }, 40),
              { once: true },
            );
            Reflect.set(window, 'heldTimeoutPeers', Reflect.get(window, 'heldTimeoutPeers') + 1);
          });
        }
        return reply;
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'heldTimeoutPeers') === 3 &&
        Reflect.get(window, 'persisted')?.publishedKeys.length === 16,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const stopped = await page.evaluate(() => ({
      state: Reflect.get(window, 'scan').snapshot(),
      checkpoint: Reflect.get(window, 'persisted'),
      closed: Reflect.get(window, 'closedProbes'),
    }));
    expect(stopped.closed).toBe(3);
    expect(stopped.state).toMatchObject({ checked: 17, responded: 16, published: 16, busy: false });
    expect(stopped.checkpoint.observations).toHaveLength(17);
    const timeout = stopped.checkpoint.observations.find(
      (item: { verdict: string }) => item.verdict === 'TimedOut',
    );
    expect(timeout.evidence).toEqual({ kind: 'timeout' });
    expect(stopped.checkpoint.publishedKeys).not.toContain(timeout.channelId);
    expect(
      stopped.checkpoint.observations.some((item: { verdict: string }) =>
        ['Canceled', 'NotChecked'].includes(item.verdict),
      ),
    ).toBe(false);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'timeoutColdResume', true);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().checked)).toBe(17);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 19,
      undefined,
      { timeout: 6000 },
    );
    const resumed = await page.evaluate(() => ({
      state: Reflect.get(window, 'scan').snapshot(),
      checkpoint: Reflect.get(window, 'persisted'),
      probes: Reflect.get(window, 'probes'),
      collections: Reflect.get(window, 'collectCalls'),
      names: Reflect.get(window, 'commits').flatMap(
        (commit: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          commit.staged.sources.flatMap((source) =>
            source.candidates.map((candidate) => candidate.name),
          ),
      ),
    }));
    expect(resumed.state).toMatchObject({ checked: 20, responded: 19, published: 19, busy: false });
    expect(resumed.probes).toHaveLength(23);
    for (let index = 0; index < 20; index++)
      expect(resumed.probes.filter((key: string) => key.endsWith(`:${index}`))).toHaveLength(
        index < 17 ? 1 : 2,
      );
    expect(resumed.collections).toBe(2);
    expect(resumed.checkpoint.observations).toHaveLength(20);
    expect(
      resumed.checkpoint.observations.find(
        (item: { channelId: string }) => item.channelId === timeout.channelId,
      ),
    ).toEqual(timeout);
    expect(resumed.checkpoint.publishedKeys).not.toContain(timeout.channelId);
    expect(resumed.names).not.toContain('Alpha 0');
    expect(new Set(resumed.names).size).toBe(19);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'completed',
    );
  } finally {
    await page.close();
  }
});

it('untrusted checks present paused Continue and cold admission rechecks only the unfinished key', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 2);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'untrustedPresentationReply', true);
      const host = Reflect.get(window, 'scanHost'),
        probe = host.probe;
      host.probe = async (
        ...args: [candidate: { channel: { name: string } }, signal: AbortSignal, budgetMs?: number]
      ) => {
        const reply = await probe(...args);
        return Reflect.get(window, 'untrustedPresentationReply') && reply.channelId.endsWith(':1')
          ? { ...reply, evidence: { kind: 'canceled' } }
          : reply;
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().checked === 1,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'paused',
      checked: 1,
      published: 1,
      lastFailure: 'none',
    });
    await expect
      .poll(() => page.getByRole('status').textContent())
      .toContain('Finish scan to retry unfinished checks');
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('Some checks were not confirmed');
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').observations.length)).toBe(1);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'untrustedPresentationReply', false);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 2,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'completed',
      checked: 2,
      published: 2,
      lastFailure: 'none',
    });
    const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    expect(probes.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
  } finally {
    await page.close();
  }
});

it('durable automatic checkpoint restarts without recollection or acknowledged probes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'probeMode', 'batch');
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'commits').length === 1 && Reflect.get(window, 'probes').length === 20,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').suspend();
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
      Reflect.set(window, 'probeMode', 'normal');
    });
    const beforeEntry = await page.evaluate(() => ({
      collects: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes').length,
      commits: Reflect.get(window, 'commits').length,
    }));
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      total: 20,
      checked: 16,
      responded: 16,
      published: 16,
      lastFailure: 'none',
      busy: false,
    });
    expect(
      await page.evaluate(() => ({
        collects: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
      })),
    ).toEqual(beforeEntry);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 2);
    const result = await page.evaluate(() => ({
      collects: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes'),
      saved: Reflect.get(window, 'persisted'),
      writes: Reflect.get(window, 'checkpointWrites'),
    }));
    expect(result.collects).toBe(2);
    expect(result.probes).toHaveLength(24);
    expect(new Set(result.probes.slice(0, 16)).size).toBe(16);
    expect(result.probes.slice(20)).toEqual(result.probes.slice(16, 20));
    expect(result.saved.publishedKeys).toHaveLength(20);
    expect(result.writes.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'completed',
    );
  } finally {
    await page.close();
  }
});

it('entry admission coalesces an owned cold read and never probes or reopens a closed dialog', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'checkpointLoadMode', 'blocked');
      const scan = Reflect.get(window, 'scan');
      const first = scan.prepareAutomaticEntry();
      Reflect.set(window, 'entrySame', first === scan.prepareAutomaticEntry());
      Reflect.set(window, 'entryWork', first);
    });
    await page.waitForFunction(() => Reflect.get(window, 'checkpointLoads') === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'entrySame'))).toBe(true);
    await page.getByRole('button', { name: 'Close scan review' }).click();
    await page.evaluate(async () => {
      await Reflect.get(window, 'entryWork');
    });
    expect(
      await page
        .locator('dialog.source-scan-dialog')
        .evaluate((el) => (el as HTMLDialogElement).open),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('fresh entry checks ownership without starting and invalid progress cannot masquerade as fresh', async () => {
  const page = await fixture(true, true, false, true);
  try {
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'fresh',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointLoads'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'activity'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'invalidCheckpoint', true);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unavailable',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'scan').rescanAutomatic());
    await page.waitForFunction(() => Reflect.get(window, 'checkpointDiscards').length === 1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('invalid durable checkpoint refuses implicit restart and requires exact-owner Rescan', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'invalidCheckpoint', true);
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('could not resume');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards')[0].jobId)).toBe(
      'known-invalid',
    );
  } finally {
    await page.close();
  }
});

it('background resumes same hidden automatic owner while explicit Cancel stays stopped', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'probeMode', 'batch');
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 20 && Reflect.get(window, 'commits').length === 1,
      undefined,
      { timeout: 6000 },
    );
    await page.getByRole('button', { name: 'Close scan review' }).click();
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').suspend();
      Reflect.set(window, 'probeMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 24 && Reflect.get(window, 'commits').length === 2,
    );
    expect(
      await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(24);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').rescanAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 40);
    await page.getByRole('button', { name: 'Cancel operation', includeHidden: true }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('dialog button[aria-label="Scan configured sources"]')
          ?.hasAttribute('disabled'),
    );
    const count = await page.evaluate(() => Reflect.get(window, 'probes').length);
    await page.evaluate(() => Reflect.get(window, 'scan').resume());
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(count);
  } finally {
    await page.close();
  }
});

it('suspension joins a late checkpoint read and resumes collection only on explicit foreground admission', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'checkpointLoadMode', 'blocked');
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'checkpointLoads') === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').suspend());
    expect(await page.evaluate(() => Reflect.get(window, 'closedCheckpointLoads'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    await page.evaluate(async () => {
      Reflect.set(window, 'checkpointLoadMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
  } finally {
    await page.close();
  }
});

it('checkpoint persistence failure rejects suspension acknowledgement and preserves RAM retry', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'probeMode', 'batch');
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 20 && Reflect.get(window, 'commits').length === 1,
      undefined,
      { timeout: 6000 },
    );
    const rejected = await page.evaluate(async () => {
      Reflect.set(window, 'checkpointSaveMode', 'fail');
      try {
        await Reflect.get(window, 'scan').suspend();
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      16,
    );
    await page.evaluate(async () => {
      Reflect.set(window, 'checkpointSaveMode', 'normal');
      Reflect.set(window, 'probeMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(24);
  } finally {
    await page.close();
  }
});

it('dispose retains the acknowledged stopped checkpoint without preparing or saving after native admission freezes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const saved = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
    const writes = await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length);
    expect(writes).toBe(2); // Initial checkpoint plus joined Stop checkpoint.
    await page.evaluate(async () => {
      const checkpoint = Reflect.get(window, 'scanHost').checkpoint;
      Reflect.set(window, 'forbiddenCheckpointCalls', 0);
      checkpoint.prepare = checkpoint.save = async () => {
        Reflect.set(
          window,
          'forbiddenCheckpointCalls',
          Reflect.get(window, 'forbiddenCheckpointCalls') + 1,
        );
        throw new Error('application-closing');
      };
      await Reflect.get(window, 'scan').dispose();
      await Reflect.get(window, 'scan').dispose();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'forbiddenCheckpointCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(writes);
    expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(saved);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});

for (const suspendFirst of [false, true])
  it(`dispose joins active probes ${suspendFirst ? 'and pending suspension' : 'directly'} while retaining the last paired checkpoint`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'candidateCount', 20);
        Reflect.set(window, 'parallelOrigins', true);
        Reflect.set(window, 'probeMode', 'batch');
        Reflect.set(window, 'commitAdvances', true);
        Reflect.get(window, 'scan').startAutomatic();
      });
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'probes').length === 20 &&
          Reflect.get(window, 'persisted')?.publishedKeys.length === 16,
        undefined,
        { timeout: 6000 },
      );
      const saved = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
      await page.evaluate(async (withSuspension) => {
        const checkpoint = Reflect.get(window, 'scanHost').checkpoint;
        Reflect.set(window, 'forbiddenCheckpointCalls', 0);
        checkpoint.prepare = checkpoint.save = async () => {
          Reflect.set(
            window,
            'forbiddenCheckpointCalls',
            Reflect.get(window, 'forbiddenCheckpointCalls') + 1,
          );
          throw new Error('application-closing');
        };
        const scan = Reflect.get(window, 'scan');
        const suspension = withSuspension ? scan.suspend() : Promise.resolve();
        await Promise.all([suspension, scan.dispose()]);
      }, suspendFirst);
      expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(4);
      expect(await page.evaluate(() => Reflect.get(window, 'forbiddenCheckpointCalls'))).toBe(0);
      expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(
        saved,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
      expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

it('automatic review admits another origin while sixteen earlier same-origin candidates wait and Stop joins both', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 17);
      Reflect.set(window, 'fairOrigins', true);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 2);
    const before = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes'),
      closed: Reflect.get(window, 'closedProbes'),
      commits: Reflect.get(window, 'commits'),
    }));
    expect(before.probes[0]).toMatch(/:0$/);
    expect(before.probes[1]).toMatch(/:16$/);
    expect(before.closed).toBe(0);
    expect(before.commits).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel operation' }).click();
    await page.getByText('Review retained.', { exact: true }).waitFor();
    const after = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes'),
      closed: Reflect.get(window, 'closedProbes'),
      commits: Reflect.get(window, 'commits'),
    }));
    expect(after.probes).toEqual(before.probes);
    expect(after.closed).toBe(2);
    expect(after.commits).toHaveLength(0);
  } finally {
    await page.close();
  }
});

it('automatic publications share one immutable review without changing captured membership', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      const host = Reflect.get(window, 'scanHost');
      const prepare = host.checkpoint.prepare;
      const captures: unknown[] = [];
      Reflect.set(window, 'captureChecks', captures);
      let previous: unknown;
      host.checkpoint.prepare = (
        snapshot: {
          review: { candidates: { channel: { urls: string[] } }[] };
          observations: unknown[];
        },
        signal: AbortSignal,
      ) => {
        const channel = snapshot.review.candidates[0].channel;
        const before = channel.urls[0];
        const mutated = Reflect.set(channel.urls, '0', 'https://foreign.invalid/');
        captures.push({
          frozen: Object.isFrozen(snapshot.review) && Object.isFrozen(channel.urls),
          mutated,
          unchanged: channel.urls[0] === before,
          sameReview: previous === undefined || previous === snapshot.review,
          observations: snapshot.observations.length,
        });
        previous = snapshot.review;
        return prepare(snapshot, signal);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('130 channels saved.', { exact: true }).waitFor();
    const captures = await page.evaluate(() => Reflect.get(window, 'captureChecks'));
    expect(captures.length).toBeGreaterThanOrEqual(2);
    for (const capture of captures)
      expect(capture).toMatchObject({
        frozen: true,
        mutated: false,
        unchanged: true,
        sameReview: true,
      });
    expect(captures[0].observations).toBeLessThan(captures.at(-1).observations);
  } finally {
    await page.close();
  }
});
it('collection settled notification waits for canceled readers before releasing metadata', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'collectMode', 'blocked');
      Reflect.set(window, 'settledReaders', []);
      Reflect.get(window, 'scanHost').onCollectionSettled = () => {
        Reflect.get(window, 'settledReaders').push(Reflect.get(window, 'closedReaders'));
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'collectCalls') === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'settledReaders'))).toEqual([]);
    await page.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'settledReaders').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'settledReaders'))).toEqual([2]);
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
  } finally {
    await page.close();
  }
});

it('inline automatic query filters before probes and publishes observational progress without a modal', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'inlineProgress', []);
      Reflect.set(window, 'modalCalls', 0);
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        Reflect.set(window, 'modalCalls', Reflect.get(window, 'modalCalls') + 1);
        return show.call(this);
      };
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) => {
        Reflect.get(window, 'inlineProgress').push(event);
        throw new Error('observational failure');
      };
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: ' Alpha   1 ',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'modalCalls'))).toBe(0);
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(11);
    const events = await page.evaluate(() => Reflect.get(window, 'inlineProgress'));
    expect(events.at(-1)).toMatchObject({
      query: 'Alpha 1',
      presentation: 'inline',
      checked: 11,
      published: 11,
      busy: false,
    });
    const names = await page.evaluate(() =>
      Reflect.get(window, 'commits').flatMap(
        (entry: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          entry.staged.sources.flatMap((source) =>
            source.candidates.map((channel) => channel.name),
          ),
      ),
    );
    expect(names).toHaveLength(11);
    expect(names.every((name: string) => name.includes('Alpha 1'))).toBe(true);
  } finally {
    await page.close();
  }
});
it('inline Stop joins admitted probes and Continue retains query while a different query requires Rescan', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'partial');
      Reflect.set(window, 'inlineProgress', []);
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) =>
        Reflect.get(window, 'inlineProgress').push(event);
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Alpha 1',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 11);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(11);
    const before = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes').length,
      collects: Reflect.get(window, 'collectCalls'),
    }));
    await page.evaluate(() =>
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      }),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    expect(
      await page.evaluate(() => Reflect.get(window, 'inlineProgress').at(-1).scopeRefusal),
    ).toBe('query-changed');
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(before.probes);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collects);
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    await page.evaluate(() =>
      Reflect.get(window, 'scan').rescanAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      }),
    );
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Other');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(
      before.collects + 2,
    );
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});

it('inline cold checkpoint refuses a different query before checking without opening recovery modal', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Alpha 1',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'coldProgress', []);
      Reflect.set(window, 'probes', []);
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) =>
        Reflect.get(window, 'coldProgress').push(event);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan')!,
          Reflect.get(window, 'scanHost'),
        ),
      );
      await Reflect.get(window, 'scan').prepareAutomaticEntry();
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    expect(await page.evaluate(() => Reflect.get(window, 'coldProgress').at(-1))).toMatchObject({
      scopeRefusal: 'query-changed',
      presentation: 'inline',
    });
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});

it('initial durable collection waits for actual ACK before any probe and loadedjob avoidsinitialrewrite', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.save;
      host.checkpoint.save = async (...args: unknown[]) => {
        Reflect.set(window, 'initialEntered', true);
        await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toMatchObject({
      observations: [],
      publishedKeys: [],
      platform: 'Fixture',
      observerProfile: 'inspection-v1',
    });
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'scanHost');
      host.checkpoint.save = async () => ({ committed: true, checkpointRevision: '2' });
      await Reflect.get(window, 'scan').stopAutomatic();
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'probes', []);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(document.getElementById('scan'), host),
      );
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
  } finally {
    await page.close();
  }
});
it.each(['failure', 'cas'])(
  'initial durable %s prevents allprobes andpublication',
  async (mode) => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((mode) => {
        const host = Reflect.get(window, 'scanHost');
        host.checkpoint.save = async () => {
          throw new Error(mode === 'cas' ? 'catalog-revision-stale' : 'Controlled write failure');
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, mode);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().phase === 'failed',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toBeNull();
    } finally {
      await page.close();
    }
  },
);
it('Stop joins heldinitialwrite and retainslateirreversibleACK withoutobsoleteprobes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.save;
      let first = true;
      host.checkpoint.save = async (...args: unknown[]) => {
        if (first) {
          first = false;
          Reflect.set(window, 'initialEntered', true);
          await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        }
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    await page.evaluate(() => {
      Reflect.set(window, 'stopDone', false);
      Reflect.set(
        window,
        'stopWork',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'stopDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.evaluate(() => Reflect.get(window, 'stopWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toMatchObject({
      observations: [],
      publishedKeys: [],
    });
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointRevision'))).toBe('2');
  } finally {
    await page.close();
  }
});
it('wholecapture refusal isexplicitRAM-only andemptyjobneverstartsprobeorwrites', async () => {
  for (const empty of [false, true]) {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((empty) => {
        Reflect.set(window, 'candidateCount', empty ? -1 : 1);
        Reflect.set(window, 'commitAdvances', true);
        const host = Reflect.get(window, 'scanHost');
        host.checkpoint.prepare = async () => null;
        Reflect.get(window, 'scan').startAutomatic();
      }, empty);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().phase === 'completed',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(empty ? 0 : 1);
      if (!empty)
        expect(await page.getByRole('alert').textContent()).toContain('restart requires Rescan');
    } finally {
      await page.close();
    }
  }
});

it('initial mutation write also prevents probes until exact ACK', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.saveMutation;
      host.checkpoint.saveMutation = async (...args: unknown[]) => {
        Reflect.set(window, 'initialEntered', true);
        await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'initialMutationAcks'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'initialMutationAcks'))).toEqual([
      { revision: '1' },
    ]);
  } finally {
    await page.close();
  }
});
it('Stop joins canceled initialpreparation then saves with freshsignal without obsoleteprobes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      const host = Reflect.get(window, 'scanHost'),
        prepare = host.checkpoint.prepare;
      let first = true;
      host.checkpoint.prepare = async (...args: unknown[]) => {
        if (first) {
          first = false;
          Reflect.set(window, 'initialEntered', true);
          await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        }
        return prepare(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    await page.evaluate(() => {
      Reflect.set(window, 'stopDone', false);
      Reflect.set(
        window,
        'stopWork',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'stopDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopDone'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.evaluate(() => Reflect.get(window, 'stopWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
  } finally {
    await page.close();
  }
});

it('Stop owns late episode setup and joins its disposal before becoming available', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'episodeDisposed', false);
      Reflect.get(window, 'scanHost').beginSelectionEpisode = async () => {
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseEpisodeSetup', resolve));
        return {
          episodeId: 'late-episode',
          dispose: async () => {
            await new Promise<void>((resolve) =>
              Reflect.set(window, 'releaseEpisodeDispose', resolve),
            );
            Reflect.set(window, 'episodeDisposed', true);
          },
        };
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseEpisodeSetup') === 'function',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'episodeStopDone', false);
      Reflect.set(
        window,
        'episodeStop',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'episodeStopDone', true)),
      );
      Reflect.get(window, 'releaseEpisodeSetup')();
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseEpisodeDispose') === 'function',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'episodeStopDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseEpisodeDispose')());
    await page.evaluate(() => Reflect.get(window, 'episodeStop'));
    expect(await page.evaluate(() => Reflect.get(window, 'episodeDisposed'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
  } finally {
    await page.close();
  }
});

async function continueFixture(declaredFormat = false, ramOnly = false, count = 2): Promise<Page> {
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
for (const drift of ['none', 'checkpoint', 'catalog', 'profile', 'invalid'] as const)
  it(`a null-prepared RAM-only Continue admits only its current owned scope with ${drift} drift`, async () => {
    const page = await continueFixture(false, true);
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
      }));
      expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toBeNull();
      await page.evaluate(async (change) => {
        if (change === 'checkpoint') Reflect.set(window, 'checkpointRevision', '1');
        if (change === 'catalog') Reflect.set(window, 'revision', 'foreign-catalog');
        if (change === 'profile') Reflect.set(window, 'profile', 'foreign-profile');
        if (change === 'invalid') Reflect.set(window, 'invalidCheckpoint', true);
        Reflect.set(window, 'badContinueReply', false);
        Reflect.get(window, 'scanHost').onProgress = (progress: unknown) =>
          Reflect.set(window, 'ramContinueProgress', progress);
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, drift);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collects);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
      if (drift === 'none') {
        expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(2);
        expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(
          before.probes + 1,
        );
        expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(
          before.commits + 1,
        );
      } else {
        expect(
          await page.evaluate(() => Reflect.get(window, 'ramContinueProgress').resumeRefusal),
        ).toBeDefined();
        expect(
          await page.evaluate(() => ({
            probes: Reflect.get(window, 'probes').length,
            commits: Reflect.get(window, 'commits').length,
            collects: Reflect.get(window, 'collectCalls'),
          })),
        ).toEqual(before);
      }
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
for (const change of [
  'url',
  'key',
  'order',
  'source-location',
  'http-grant',
  'declared-format',
] as const)
  it(`Continue refuses changed immutable ${change} despite an unchanged job and checkpoint revision`, async () => {
    const page = await continueFixture(change === 'declared-format');
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
        revision: Reflect.get(window, 'checkpointRevision'),
      }));
      await page.evaluate(async (kind) => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.onProgress = (progress: unknown) => Reflect.set(window, 'captureRefusal', progress);
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal),
            parsed = structuredClone(saved.parsed);
          if (kind === 'url') parsed.review.candidates[1].channel.urls[0] += '/different';
          else if (kind === 'key') parsed.review.candidates[1].key += '-different';
          else if (kind === 'order') parsed.review.candidates.reverse();
          else if (kind === 'source-location')
            parsed.sourceDefinitions[0].source.location += '/different';
          else if (kind === 'http-grant') parsed.sourceDefinitions[0].source.allowHttp = true;
          else parsed.sourceDefinitions[0].source.contentKind = 'media';
          return { ...saved, parsed };
        };
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, change);
      expect(await page.evaluate(() => Reflect.get(window, 'captureRefusal').resumeRefusal)).toBe(
        'changed',
      );
      expect(
        await page.evaluate(() => ({
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          collects: Reflect.get(window, 'collectCalls'),
          revision: Reflect.get(window, 'checkpointRevision'),
        })),
      ).toEqual(before);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
for (const race of ['missing', 'changed', 'completed', 'refused'] as const)
  it(`Continue never collects a fresh scan when ${race} changes after entry preparation`, async () => {
    const page = await continueFixture();
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
        'unfinished',
      );
      const before = await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        discards: Reflect.get(window, 'checkpointDiscards').length,
        counts: Reflect.get(window, 'scan').snapshot(),
      }));
      await page.evaluate(async (reason) => {
        Reflect.set(window, 'resumeProgress', []);
        Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
          Reflect.get(window, 'resumeProgress').push(p);
        if (reason === 'missing') Reflect.set(window, 'persisted', null);
        else if (reason === 'refused') Reflect.set(window, 'invalidCheckpoint', true);
        else if (reason === 'changed')
          Reflect.set(
            window,
            'checkpointRevision',
            String(Number(Reflect.get(window, 'checkpointRevision')) + 1),
          );
        else {
          const cp = Reflect.get(window, 'persisted');
          const key = cp.review.candidates[1].key;
          cp.observations.push({ ...cp.observations[0], channelId: key });
          cp.publishedKeys.push(key);
        }
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, race);
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          discards: Reflect.get(window, 'checkpointDiscards').length,
        })),
      ).toEqual({
        collect: before.collect,
        probes: before.probes,
        commits: before.commits,
        discards: before.discards,
      });
      expect(
        await page.evaluate(() => Reflect.get(window, 'resumeProgress').at(-1).resumeRefusal),
      ).toBe(race === 'refused' ? 'unavailable' : race);
      await page.evaluate(async () => {
        const scan = Reflect.get(window, 'scan');
        await scan.continueAutomatic({ presentation: 'inline' });
        scan.startAutomatic(undefined, { presentation: 'inline' });
      });
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
        })),
      ).toEqual({ collect: before.collect, probes: before.probes });
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
        lastFailure: 'other',
        total: before.counts.total,
        checked: before.counts.checked,
        responded: before.counts.responded,
        published: before.counts.published,
      });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('structural unfinished summary cannot authorize fresh collection after its checkpoint disappears', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(async () => {
      const scan = Reflect.get(window, 'scan');
      document.querySelector<HTMLDialogElement>('dialog.source-scan-dialog')!.close();
      Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
        Reflect.set(window, 'continueProgress', p);
      scan.presentSavedSummary(
        {
          schemaVersion: 1,
          checkpointStatus: 'valid',
          storedVersion: 3,
          total: 20,
          checked: 10,
          responded: 8,
          published: 8,
          unfinished: true,
          catalogRevision: '0',
          checkpointRevision: '0',
        },
        scan.snapshot().generation,
      );
      await scan.continueAutomatic({ presentation: 'inline' });
    });
    expect(await page.evaluate(() => Reflect.get(window, 'continueProgress'))).toMatchObject({
      resumeRefusal: 'missing',
      total: 20,
      checked: 10,
      responded: 8,
      published: 8,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards'))).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('Continue double-click owns one fresh admission and checks only the same job remaining key', async () => {
  const page = await continueFixture();
  try {
    const before = await page.evaluate(() => ({
      collect: Reflect.get(window, 'collectCalls'),
      loads: Reflect.get(window, 'checkpointLoads'),
      job: Reflect.get(window, 'persisted').jobId,
    }));
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost'),
        load = host.checkpoint.load;
      host.checkpoint.load = async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseContinueRead', resolve));
        return load(signal);
      };
      Reflect.set(window, 'badContinueReply', false);
      const scan = Reflect.get(window, 'scan');
      const first = scan.continueAutomatic({ presentation: 'inline' });
      Reflect.set(
        window,
        'continueSamePromise',
        first === scan.continueAutomatic({ presentation: 'inline' }),
      );
      Reflect.set(window, 'continuePromise', first);
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseContinueRead') === 'function',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'continueSamePromise'))).toBe(true);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseContinueRead')();
      await Reflect.get(window, 'continuePromise');
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      published: 2,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collect);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').jobId)).toBe(before.job);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointLoads'))).toBe(
      before.loads + 1,
    );
    const keys = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(keys.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    expect(keys.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

for (const action of ['stop', 'dispose'] as const)
  it(`Continue ${action} joins a held actual admission and suppresses obsolete completion`, async () => {
    const page = await continueFixture();
    try {
      const before = await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        writes: Reflect.get(window, 'checkpointWrites').length,
      }));
      await page.evaluate(() => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal);
          await new Promise<void>((resolve) =>
            Reflect.set(window, 'releaseJoinedContinue', resolve),
          );
          return saved;
        };
        Reflect.set(
          window,
          'admissionPromise',
          Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' }),
        );
      });
      await page.waitForFunction(
        () => typeof Reflect.get(window, 'releaseJoinedContinue') === 'function',
      );
      await page.evaluate((action) => {
        Reflect.set(window, 'continueShutdownSettled', false);
        const scan = Reflect.get(window, 'scan');
        const joined = action === 'stop' ? scan.stopAutomatic() : scan.dispose();
        Reflect.set(
          window,
          'continueShutdown',
          joined.then(() => Reflect.set(window, 'continueShutdownSettled', true)),
        );
      }, action);
      expect(await page.evaluate(() => Reflect.get(window, 'continueShutdownSettled'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(
        before.writes,
      );
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseJoinedContinue')();
        await Reflect.get(window, 'admissionPromise');
        await Reflect.get(window, 'continueShutdown');
      });
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
        })),
      ).toEqual({ collect: before.collect, probes: before.probes });
      expect(await page.evaluate(() => Reflect.get(window, 'continueShutdownSettled'))).toBe(true);
      if (action === 'dispose')
        expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(
          before.writes,
        );
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('admitted Continue retains new durable published counts when later checkpoint persistence fails', async () => {
  const page = await continueFixture();
  try {
    await page.evaluate(async () => {
      Reflect.set(window, 'badContinueReply', false);
      Reflect.set(window, 'checkpointSaveMode', 'fail');
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      published: 2,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      2,
    );
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});

it('failed explicit Rescan discard retains definitive Continue refusal and all saved records', async () => {
  const page = await continueFixture();
  try {
    await page.evaluate(async () => {
      Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
        Reflect.set(window, 'rescanProgress', p);
      Reflect.set(window, 'invalidCheckpoint', true);
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      Reflect.get(window, 'scanHost').checkpoint.discard = async () => {
        throw new Error('private-discard-failure');
      };
      Reflect.get(window, 'scan').rescanAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'rescanProgress').resumeRefusal)).toBe(
      'unavailable',
    );
    const before = await page.evaluate(() => ({
      collect: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes').length,
      commits: Reflect.get(window, 'commits').length,
    }));
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    expect(
      await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
      })),
    ).toEqual(before);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
