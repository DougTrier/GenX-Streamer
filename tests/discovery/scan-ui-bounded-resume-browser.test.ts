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
let browser: Browser, bundle: string;
beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/scan/source-scan.ts', formats: ['iife'], name: 'ScanUI' },
    },
  });
  const result = Array.isArray(built) ? built[0] : built;
  if (!result || !('output' in result)) throw new Error('Missing bounded UI fixture');
  const chunk = result.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing bounded UI fixture code');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent('<main id="scan"></main>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    const counts={total:13000,checked:100,responded:80,published:70};
    const revisions={catalogRevision:'3',healthRevision:'2',checkpointRevision:'4'};
    window.calls={factory:0,prepare:0,start:0,suspend:0,dispose:0,load:0,collect:0,commit:0};window.progressUpdates=[];
    window.mode='held';window.suspendHeld=false;window.disposeFailure=false;window.disposeHeld=false;window.startFailure=false;
    window.plan={schemaVersion:1,planId:'plan',jobId:'job',reviewDigest:'a'.repeat(64),sessionRevision:'capture',query:'Fox',createdAtMs:1700000000000,platform:'native',observerProfile:'native-v1',budgetMs:20000,sourcePolicies:[{sourceId:'source',fingerprint:'captured',allowHttp:false}],counts,revisions};
    let state={phase:'paused',failure:'none',counts,revisions,ownedReservations:0,active:0,maxOwnedReservations:0,capabilityEnabled:false,observerFailed:false,activeCallbacks:0,maxActiveCallbacks:0,workerStopped:false,quarantined:false};
    const listeners=new Set();
    const notify=()=>{for(const fn of listeners)fn(state)};
    window.finishBounded=(patch={})=>{state={...state,...patch};notify();window.resolveStart?.();};
    const service={
      prepare:async()=>{window.calls.prepare++;if(window.mode==='held')await new Promise(resolve=>window.resolvePrepare=resolve);return window.plan;},
      snapshot:()=>state,
      subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
      start:async()=>{window.calls.start++;state={...state,phase:'checking'};notify();await new Promise(resolve=>window.resolveStart=resolve);if(window.startFailure)throw new Error('Commit not confirmed')},
      suspend:async()=>{window.calls.suspend++;if(window.suspendHeld)await new Promise(resolve=>window.resolveSuspend=resolve);},
      dispose:async()=>{window.calls.dispose++;if(window.disposeHeld)await new Promise(resolve=>window.resolveDispose=resolve);if(window.disposeFailure)throw new Error('Cleanup not confirmed');state={...state,phase:'disposed',workerStopped:true};notify();},
    };
    const host={capture:()=>({revision:'logical',sources:[]}),revision:()=> 'logical',platform:()=> 'native',observerProfile:()=> 'native-v1',now:()=>1700000000100,onProgress:progress=>window.progressUpdates.push(progress),
      collect:async()=>{window.calls.collect++;throw new Error('Unexpected collection')},commit:async()=>{window.calls.commit++;throw new Error('Unexpected legacy commit')},
      checkpoint:{load:async()=>{window.calls.load++;return {checkpointStatus:'absent',jobId:null,checkpointRevision:'4',catalogRevision:'logical'}},discard:async()=>{throw new Error('Unexpected discard')},prepare:async()=>{throw new Error('Unexpected full checkpoint preparation')},save:async()=>{throw new Error('Unexpected full checkpoint write')}},
      createBoundedResume:async(scope,signal)=>{window.calls.factory++;window.scope=scope;if(window.mode==='null')return null;if(window.mode==='reject')throw new Error('Native admission refused');if(window.mode==='sources-changed')throw new ScanUI.ScanSourcesChanged();if(window.mode==='late-factory')await new Promise(resolve=>window.resolveFactory=resolve);return service;},
    };
    window.scan=ScanUI.mountSourceScan(document.getElementById('scan'),host);
    window.scan.presentSavedSummary({schemaVersion:1,checkpointStatus:'valid',storedVersion:3,total:13000,checked:100,responded:80,published:70,unfinished:true,catalogRevision:'3',checkpointRevision:'4'},0);
    window.continueOwned=()=>window.scan.continueAutomatic({presentation:'inline'});
  `,
  });
  return page;
}
const snapshot = (page: Page) => page.evaluate(() => Reflect.get(window, 'scan').snapshot());
const calls = (page: Page) => page.evaluate(() => Reflect.get(window, 'calls'));
for (const failure of ['commit-unconfirmed', 'cleanup-unconfirmed'] as const)
  it(`bounded ${failure} stays visibly stopped with guidance after the original service joins`, async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'ready');
        Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
      });
      await expect.poll(async () => (await calls(page)).start).toBe(1);
      await page.evaluate(
        (value) =>
          Reflect.get(
            window,
            'finishBounded',
          )({
            phase: value === 'commit-unconfirmed' ? 'quarantined' : 'failed',
            failure: value,
            counts: { total: 13000, checked: 164, responded: 144, published: 70 },
          }),
        failure,
      );
      await page.evaluate(() => Reflect.get(window, 'running'));
      expect(await snapshot(page)).toMatchObject({
        phase: 'failed',
        checked: 164,
        published: 70,
        busy: false,
        lastFailure: failure === 'commit-unconfirmed' ? 'publish-failed' : 'cancel-ack',
      });
      const final = await page.evaluate(() => Reflect.get(window, 'progressUpdates').at(-1));
      expect(final.status).toBe('Scan stopped | 164 of 13000 checked | 70 saved.');
      expect(final.status).not.toContain('Checking');
      expect(final.error).toContain(
        failure === 'commit-unconfirmed'
          ? 'Saving scan progress could not be confirmed'
          : 'Scan cleanup could not be confirmed',
      );
      expect(final.error).toContain(
        failure === 'commit-unconfirmed' ? 'Select Finish scan' : 'Reopen the app',
      );
      expect(final.error).toContain('Saved channels are retained');
      expect(final.canContinue).toBe(true);
      expect(await calls(page)).toMatchObject({ dispose: 1, load: 0, collect: 0, commit: 0 });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('a rejected commit remains visibly failed while successful service cleanup permits Close', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'ready');
      Reflect.set(window, 'startFailure', true);
      Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
    });
    await expect.poll(async () => (await calls(page)).start).toBe(1);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBounded',
      )({
        phase: 'quarantined',
        failure: 'commit-unconfirmed',
        counts: { total: 13000, checked: 164, responded: 144, published: 70 },
      }),
    );
    await page.evaluate(() => Reflect.get(window, 'running'));
    expect(await snapshot(page)).toMatchObject({
      phase: 'failed',
      checked: 164,
      published: 70,
      busy: false,
      lastFailure: 'publish-failed',
    });
    const progress = await page.evaluate(() => Reflect.get(window, 'progressUpdates').at(-1));
    expect(progress.error).toContain('Channels could not be saved');
    expect(progress.error).toContain('last saved progress');
    expect(progress.error).not.toContain('cleanup');
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    expect(await page.locator('dialog[aria-label="Review source scan"]').count()).toBe(0);
    expect(await calls(page)).toMatchObject({ factory: 1, start: 1, dispose: 1, commit: 0 });
  } finally {
    await page.close();
  }
});
it('cold Continue preserves summary during held small preparation, then uses only scalar ACK progress', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
    });
    await expect.poll(async () => (await calls(page)).prepare).toBe(1);
    expect(await snapshot(page)).toMatchObject({
      total: 13000,
      checked: 100,
      responded: 80,
      published: 70,
      busy: true,
    });
    expect(await calls(page)).toMatchObject({ load: 0, collect: 0, commit: 0, start: 0 });
    await page.evaluate(() => Reflect.get(window, 'resolvePrepare')());
    await expect.poll(async () => (await calls(page)).start).toBe(1);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBounded',
      )({
        phase: 'completed',
        counts: { total: 13000, checked: 13000, responded: 10000, published: 10000 },
        revisions: { catalogRevision: '4', healthRevision: '3', checkpointRevision: '5' },
      }),
    );
    await page.evaluate(() => Reflect.get(window, 'running'));
    expect(await snapshot(page)).toMatchObject({
      phase: 'completed',
      total: 13000,
      checked: 13000,
      published: 10000,
      busy: false,
    });
    expect(await calls(page)).toMatchObject({ load: 0, collect: 0, commit: 0, dispose: 1 });
    expect(await page.locator('[aria-label="Candidate channels"] li').count()).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
for (const refusal of ['reject', 'malformed', 'expired', 'profile', 'revision'] as const)
  it(`bounded ${refusal} admission cannot invoke legacy load or fresh collection`, async () => {
    const page = await fixture();
    try {
      await page.evaluate((kind) => {
        Reflect.set(window, 'mode', kind === 'reject' ? 'reject' : 'ready');
        const plan = Reflect.get(window, 'plan');
        if (kind === 'malformed') plan.candidates = [];
        if (kind === 'expired') plan.createdAtMs = 1;
        if (kind === 'profile') plan.observerProfile = 'changed';
        if (kind === 'revision') plan.revisions.checkpointRevision = '5';
      }, refusal);
      await page.evaluate(() => Reflect.get(window, 'continueOwned')());
      expect(await snapshot(page)).toMatchObject({
        phase: 'failed',
        total: 13000,
        checked: 100,
        published: 70,
      });
      expect(await calls(page)).toMatchObject({ start: 0, load: 0, collect: 0, commit: 0 });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('a scan whose sources were updated while paused says so and keeps its saved channels', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'sources-changed');
      return Reflect.get(window, 'continueOwned')();
    });
    expect(await snapshot(page)).toMatchObject({ phase: 'failed', checked: 100, published: 70 });
    expect(await calls(page)).toMatchObject({ start: 0, collect: 0, commit: 0 });
    // The inline panel shows exactly these progress fields.
    const shown = await page.evaluate(() => Reflect.get(window, 'progressUpdates').at(-1));
    expect(shown.status).toContain('This saved scan cannot continue.');
    expect(shown.error).toBe(
      'Your channel sources were updated after this scan paused. Its 70 saved channels are kept; Rescan checks the updated sources.',
    );
    expect(shown.canContinue).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('explicit unsupported preadmission null keeps legacy Continue refusal without a fresh scan', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'null');
      return Reflect.get(window, 'continueOwned')();
    });
    expect(await calls(page)).toMatchObject({ factory: 1, load: 1, start: 0, collect: 0 });
    expect(await snapshot(page)).toMatchObject({ phase: 'failed', checked: 100, published: 70 });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('an admitted query mismatch stays paused without probing, and a later job substitution is refused', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'ready');
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        intent: 'continue',
        query: 'Sports',
        presentation: 'inline',
      });
    });
    await expect.poll(async () => (await snapshot(page)).busy).toBe(false);
    expect(await snapshot(page)).toMatchObject({ phase: 'paused', checked: 100, published: 70 });
    expect(await calls(page)).toMatchObject({
      prepare: 1,
      start: 0,
      dispose: 1,
      load: 0,
      collect: 0,
    });
    await page.evaluate(() => {
      Reflect.get(window, 'plan').jobId = 'substitute';
      return Reflect.get(window, 'continueOwned')();
    });
    expect(await snapshot(page)).toMatchObject({ phase: 'failed', checked: 100, published: 70 });
    expect(await calls(page)).toMatchObject({ factory: 2, start: 0, load: 0, collect: 0 });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('actual service cleanup refusal remains a blocking failure rather than ordinary completed cleanup', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'ready');
      Reflect.set(window, 'disposeFailure', true);
      Reflect.set(window, 'cleanupRejected', false);
      Reflect.set(
        window,
        'running',
        Reflect.get(window, 'continueOwned')().catch(() =>
          Reflect.set(window, 'cleanupRejected', true),
        ),
      );
    });
    await expect.poll(async () => (await calls(page)).start).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'finishBounded')({ phase: 'paused' }));
    await page.evaluate(() => Reflect.get(window, 'running'));
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupRejected'))).toBe(true);
    expect(await snapshot(page)).toMatchObject({
      phase: 'failed',
      total: 13000,
      checked: 100,
      published: 70,
      busy: false,
      lastFailure: 'cancel-ack',
    });
    const progress = await page.evaluate(() => Reflect.get(window, 'progressUpdates').at(-1));
    expect(progress.status).toBe('Scan stopped. Cleanup could not be confirmed.');
    expect(progress.error).toBe(
      'Scan cleanup could not be confirmed. Reopen the app before continuing. Saved channels are retained.',
    );
    const refused = await page.evaluate(() =>
      Reflect.get(window, 'scan')
        .dispose()
        .then(
          () => false,
          () => true,
        ),
    );
    expect(refused).toBe(true);
    expect(await calls(page)).toMatchObject({ dispose: 2, load: 0, collect: 0 });
    expect(await page.locator('dialog[aria-label="Review source scan"]').count()).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'disposeFailure', false);
      Reflect.set(window, 'disposeHeld', true);
      Reflect.set(window, 'retryCleanupFinished', false);
      Reflect.set(
        window,
        'closing',
        Reflect.get(window, 'scan')
          .dispose()
          .then(() => Reflect.set(window, 'retryCleanupFinished', true)),
      );
    });
    await expect.poll(async () => (await calls(page)).dispose).toBe(3);
    expect(await page.evaluate(() => Reflect.get(window, 'retryCleanupFinished'))).toBe(false);
    expect(await page.locator('dialog[aria-label="Review source scan"]').count()).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'resolveDispose')());
    await page.evaluate(() => Reflect.get(window, 'closing'));
    expect(await page.evaluate(() => Reflect.get(window, 'retryCleanupFinished'))).toBe(true);
    expect(await page.locator('dialog[aria-label="Review source scan"]').count()).toBe(0);
    expect(await calls(page)).toMatchObject({ factory: 1, start: 1, dispose: 3, commit: 0 });
  } finally {
    await page.close();
  }
});
it('Stop joins held service cancellation and retains a late actual durable ACK before closing', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'ready');
      Reflect.set(window, 'suspendHeld', true);
      Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
    });
    await expect.poll(async () => (await calls(page)).start).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'stopped', false);
      Reflect.set(
        window,
        'stopWork',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'stopped', true)),
      );
    });
    await expect.poll(async () => (await calls(page)).suspend).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'stopped'))).toBe(false);
    await page.evaluate(() => {
      Reflect.get(
        window,
        'finishBounded',
      )({
        phase: 'paused',
        counts: { total: 13000, checked: 164, responded: 144, published: 134 },
        revisions: { catalogRevision: '4', healthRevision: '3', checkpointRevision: '5' },
      });
      Reflect.get(window, 'resolveSuspend')();
    });
    await page.evaluate(() => Reflect.get(window, 'stopWork'));
    expect(await snapshot(page)).toMatchObject({
      phase: 'paused',
      checked: 164,
      published: 134,
      busy: false,
    });
    expect(await calls(page)).toMatchObject({ load: 0, collect: 0, commit: 0, dispose: 1 });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('background suspension joins the bounded episode and Resume opens Continue with the last ACK fence', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'ready');
      Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
    });
    await expect.poll(async () => (await calls(page)).start).toBe(1);
    await page.evaluate(() =>
      Reflect.set(window, 'suspending', Reflect.get(window, 'scan').suspend()),
    );
    await expect.poll(async () => (await calls(page)).suspend).toBe(1);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBounded',
      )({
        phase: 'paused',
        counts: { total: 13000, checked: 164, responded: 144, published: 134 },
        revisions: { catalogRevision: '4', healthRevision: '3', checkpointRevision: '5' },
      }),
    );
    await page.evaluate(() => Reflect.get(window, 'suspending'));
    await page.evaluate(() => {
      const plan = Reflect.get(window, 'plan');
      plan.counts = { total: 13000, checked: 164, responded: 144, published: 134 };
      plan.revisions = { catalogRevision: '4', healthRevision: '3', checkpointRevision: '5' };
      Reflect.get(window, 'finishBounded')({ phase: 'paused', workerStopped: false });
      Reflect.set(window, 'resuming', Reflect.get(window, 'scan').resume());
    });
    await expect.poll(async () => (await calls(page)).start).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, 'scope'))).toEqual({
      jobId: 'job',
      checkpointRevision: '5',
    });
    expect(await calls(page)).toMatchObject({ load: 0, collect: 0, commit: 0 });
    await page.evaluate(() => Reflect.get(window, 'finishBounded')({ phase: 'paused' }));
    await page.evaluate(() => Reflect.get(window, 'resuming'));
    expect(await snapshot(page)).toMatchObject({ phase: 'paused', checked: 164, published: 134 });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('Dispose joins late factory ownership and never starts an obsolete plan', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'late-factory');
      Reflect.set(window, 'running', Reflect.get(window, 'continueOwned')());
    });
    await expect.poll(async () => (await calls(page)).factory).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'closed', false);
      Reflect.set(
        window,
        'closing',
        Reflect.get(window, 'scan')
          .dispose()
          .then(() => Reflect.set(window, 'closed', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'closed'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'resolveFactory')());
    await page.evaluate(() => Reflect.get(window, 'closing'));
    expect(await calls(page)).toMatchObject({
      prepare: 0,
      start: 0,
      dispose: 1,
      load: 0,
      collect: 0,
    });
    expect(await snapshot(page)).toMatchObject({ phase: 'disposed', checked: 100, published: 70 });
  } finally {
    await page.close();
  }
});
