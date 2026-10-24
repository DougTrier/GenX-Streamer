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
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent('<main id="scan"></main>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
    window.effects={loads:0,collections:0,probes:0,writes:0,activity:[]};window.progress=[];
    window.summary={schemaVersion:1,checkpointStatus:'valid',storedVersion:3,total:13256,checked:8017,responded:8000,published:8000,unfinished:true,catalogRevision:'61',checkpointRevision:'60'};
    window.host={capture:()=>({revision:'61',sources:[]}),revision:()=> '61',
      collect:async()=>{window.effects.collections++;return {channels:[],warnings:[]}},
      probe:async()=>{window.effects.probes++;throw new Error('No probe expected')},
      commit:async()=>{window.effects.writes++;throw new Error('No write expected')},
      activity:active=>window.effects.activity.push(active),onProgress:p=>window.progress.push(p),
      checkpoint:{load:async()=>{window.effects.loads++;if(window.holdLoad)await new Promise(resolve=>window.releaseLoad=resolve);
        return {checkpointStatus:'absent',checkpoint:null,jobId:null,checkpointRevision:'60',catalogRevision:'61'}},
        prepare:async()=>{window.effects.writes++;throw new Error('No preparation expected')},
        save:async()=>{window.effects.writes++;throw new Error('No save expected')},
        discard:async()=>{window.effects.writes++;throw new Error('No discard expected')}}};
    window.scan=ScanUI.mountSourceScan(document.getElementById('scan'),window.host);
  `,
  });
  return page;
}
it('unfinished cold summary displays paused counts without admitting authority or any work', async () => {
  const page = await fixture();
  try {
    const observed = await page.evaluate(() => {
      const scan = Reflect.get(window, 'scan'),
        summary = Reflect.get(window, 'summary');
      const accepted = scan.presentSavedSummary(summary, scan.snapshot().generation);
      return {
        accepted,
        snapshot: scan.snapshot(),
        progress: Reflect.get(window, 'progress'),
        effects: Reflect.get(window, 'effects'),
      };
    });
    expect(observed.accepted).toBe(true);
    expect(observed.snapshot).toMatchObject({
      phase: 'paused',
      total: 13256,
      checked: 8017,
      published: 8000,
      busy: false,
      generation: 0,
    });
    expect(observed.progress).toHaveLength(1);
    expect(observed.progress[0]).toMatchObject({
      presentation: 'inline',
      savedSummary: 'unfinished',
    });
    expect(observed.progress[0].status).toContain('whether this progress can safely resume');
    expect(observed.effects).toEqual({
      loads: 0,
      collections: 0,
      probes: 0,
      writes: 0,
      activity: [],
    });
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
    // Showing counts must not mark admission loaded: Continue still reads the actual checkpoint.
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'fresh',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'effects').loads)).toBe(1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('completed and invalid summaries distinguish finished progress from Rescan-only unavailable state', async () => {
  for (const status of ['completed', 'invalid'] as const) {
    const page = await fixture();
    try {
      const progress = await page.evaluate((status) => {
        const summary =
          status === 'completed'
            ? { ...Reflect.get(window, 'summary'), total: 8017, unfinished: false }
            : {
                ...Reflect.get(window, 'summary'),
                checkpointStatus: 'invalid',
                storedVersion: null,
                total: 0,
                checked: 0,
                responded: 0,
                published: 0,
                unfinished: false,
              };
        Reflect.get(window, 'scan').presentSavedSummary(summary, 0);
        return Reflect.get(window, 'progress');
      }, status);
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        savedSummary: status,
        phase: status === 'invalid' ? 'failed' : 'completed',
        busy: false,
      });
      expect(progress[0].status).toContain(status === 'invalid' ? 'unavailable' : 'finished');
      // A finished scan offers Refresh and Rescan; an unusable one only Rescan.
      expect(progress[0].status).toContain(
        status === 'invalid'
          ? 'Select Rescan'
          : 'Select Refresh to look for new channels, or Rescan',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'effects'))).toEqual({
        loads: 0,
        collections: 0,
        probes: 0,
        writes: 0,
        activity: [],
      });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  }
});
it('absent and malformed summaries leave idle presentation unchanged', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const scan = Reflect.get(window, 'scan'),
        summary = Reflect.get(window, 'summary');
      const before = scan.snapshot();
      const absent = scan.presentSavedSummary(
        {
          ...summary,
          checkpointStatus: 'absent',
          storedVersion: null,
          total: 0,
          checked: 0,
          responded: 0,
          published: 0,
          unfinished: false,
        },
        0,
      );
      const malformed = scan.presentSavedSummary({ ...summary, checked: 100001 }, 0);
      return {
        before,
        after: scan.snapshot(),
        absent,
        malformed,
        progress: Reflect.get(window, 'progress'),
      };
    });
    expect(result.absent).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.after).toEqual(result.before);
    expect(result.progress).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('held summary cannot overwrite a newer admission, loaded absence, or disposed owner', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'holdLoad', true);
      Reflect.set(window, 'entry', Reflect.get(window, 'scan').prepareAutomaticEntry());
    });
    expect(await page.evaluate(() => Reflect.get(window, 'effects').loads)).toBe(1);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'scan').presentSavedSummary(Reflect.get(window, 'summary'), 0),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan');
        return scan.presentSavedSummary(Reflect.get(window, 'summary'), scan.snapshot().generation);
      }),
    ).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseLoad')();
      await Reflect.get(window, 'entry');
    });
    expect(
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan');
        return scan.presentSavedSummary(Reflect.get(window, 'summary'), scan.snapshot().generation);
      }),
    ).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'scan').presentSavedSummary(Reflect.get(window, 'summary'), 1),
      ),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'effects'))).toEqual({
      loads: 1,
      collections: 0,
      probes: 0,
      writes: 0,
      activity: [false],
    });
  } finally {
    await page.close();
  }
});
