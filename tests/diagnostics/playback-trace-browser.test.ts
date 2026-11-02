// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';
let browser: Browser, code: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'playback-trace-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('virtual:trace')) return '\0virtual:trace';
          if (
            [
              'virtual:trace',
              '@tauri-apps/api/core',
              '@tauri-apps/plugin-dialog',
              '@tauri-apps/plugin-fs',
            ].includes(id)
          )
            return '\0' + id;
        },
        load(id) {
          if (id === '\0virtual:trace')
            return `export {installPlaybackDiagnostics} from ${JSON.stringify(resolve('src/ui/settings/playback-diagnostics.ts'))}; export {recordWebTrace} from ${JSON.stringify(resolve('src/diagnostics/playback-trace.ts'))}; export {installRemoteNavigation} from ${JSON.stringify(resolve('src/ui/shell/remote-navigation.ts'))};`;
          if (id === '\0@tauri-apps/api/core')
            return `export const isTauri=()=>true; export async function invoke(command,args){
    window.traceCalls ??=[];window.traceCalls.push({command,action:args?.request?.action});const r=window.report;
    if(command==='playback_trace'){
     const q=args.request;
     if(q.action==='record'&&window.rejectRecord)throw window.rejectRecord;
     if(window.holdAction===q.action)await new Promise(resolve=>window.releaseAction=resolve);
     if(q.action==='start'){r.active=true;r.untilMs=Date.now()+900000;r.records=[];}
     if(q.action==='stop'){r.active=false;}
     if(q.action==='clear'){r.active=false;r.records=[];}
     if(q.action==='record'){
      r.records.push({timestampMs:Date.now(),elapsedMs:1,record:q.record});
      if(q.record.event==='sample')r.records.push({timestampMs:Date.now(),elapsedMs:2,record:{mode:q.record.mode,event:'native-geometry',values:{aligned:false,expectedPlayerNative:[784,257,1088,612],playerNative:[1568,515,1088,612]}}});
      return {active:r.active,recorded:true};
     }
     return structuredClone(r);
    }
    throw Error('unexpected command');
   }`;
          if (id === '\0@tauri-apps/plugin-dialog')
            return `export const save=async()=>'/chosen/report.json';`;
          if (id === '\0@tauri-apps/plugin-fs')
            return `export const writeTextFile=async(path,text)=>{window.exported=JSON.parse(text);};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:trace', formats: ['iife'], name: 'TraceFixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw Error('fixture missing');
  const chunk = output.output.find((x) => x.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw Error('fixture missing');
  code = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});

it('keeps early DPAD input inside the initial read owner and preserves focus when that read settles', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await page.setContent(
      '<main id="app" data-device-kind="tv"><button id="open">Playback diagnostics</button><div id="screen"><video id="video"></video></div></main>',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'report', {
        schemaVersion: 1,
        version: '0.1.23',
        build: 1023,
        platform: 'android',
        active: true,
        startedAtMs: Date.now(),
        untilMs: Date.now() + 900000,
        droppedEvents: 0,
        records: [],
      });
      Reflect.set(window, 'holdAction', 'read');
    });
    let styles = (
      await Promise.all(
        ['style', 'management', 'responsive', 'modal-viewport', 'tv-density', 'event-history'].map(
          (name) => readStylesheet(`src/ui/${name}.css`),
        ),
      )
    ).join('\n');
    for (const font of [
      'yellowtail/Yellowtail-Regular.ttf',
      'roboto-condensed/RobotoCondensed-Variable.ttf',
    ])
      styles = styles.replace(
        `../../assets/fonts/${font}`,
        `data:font/ttf;base64,${(await readFile(`assets/fonts/${font}`)).toString('base64')}`,
      );
    await page.addStyleTag({ content: styles });
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      const fixture = Reflect.get(window, 'TraceFixture');
      Reflect.set(window, 'removeRemote', fixture.installRemoteNavigation());
      Reflect.set(
        window,
        'capture',
        fixture.installPlaybackDiagnostics({
          button: document.querySelector('#open'),
          app: document.querySelector('#app'),
          screen: document.querySelector('#screen'),
          video: document.querySelector('#video'),
          snapshot: () => ({ state: 'idle', selection: null, failure: null }),
        }),
      );
    });
    const open = page.getByRole('button', { name: 'Playback diagnostics', exact: true });
    const close = page.getByRole('button', { name: 'Close', exact: true });
    const start = page.getByRole('button', { name: 'Start 15-minute capture', exact: true });
    const clear = page.getByRole('button', { name: 'Clear report', exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    await browserExpect(close).toBeFocused();
    await browserExpect(start).toBeDisabled();
    await browserExpect(clear).toBeDisabled();
    await page.keyboard.press('ArrowLeft');
    // Initial read legitimately disables actions. The early arrow cannot select
    // Clear, and is not a promise that a later action will be focused instead.
    await browserExpect(clear).not.toBeFocused();
    await page.evaluate(() => Reflect.set(window, 'pendingReadFocus', document.activeElement));
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')();
    });
    await browserExpect(start).toBeEnabled();
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'pendingReadFocus')),
    ).toBe(true);
    // The controlled protocol waits for readiness and verifies its target before
    // activating it. No mutation is needed to make four LEFTs reach Stop.
    await close.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await browserExpect(
      page.getByRole('button', { name: 'Stop recording', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('status')).toContainText('Recording stopped.');
    await browserExpect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await browserExpect(open).toBeFocused();
  } finally {
    await page.evaluate(async () => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')?.();
      await Reflect.get(window, 'capture')?.dispose();
      Reflect.get(window, 'removeRemote')?.();
    });
    await page.close();
  }
});

it('keeps remote Close focus through delayed reads/actions without reclaiming navigation or a closed dialog', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main id="app"><button id="open">Playback diagnostics</button><button id="elsewhere">Other settings</button><div id="screen"><video id="video"></video></div></main>',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'report', {
        schemaVersion: 1,
        version: '0.1.22',
        build: 1022,
        platform: 'windows',
        active: false,
        startedAtMs: 0,
        untilMs: 0,
        droppedEvents: 0,
        records: [],
      });
      Reflect.set(window, 'holdAction', 'read');
    });
    await page.addStyleTag({ content: await readFile('src/ui/event-history.css', 'utf-8') });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      const fixture = Reflect.get(window, 'TraceFixture');
      Reflect.set(
        window,
        'capture',
        fixture.installPlaybackDiagnostics({
          button: document.querySelector('#open'),
          app: document.querySelector('#app'),
          screen: document.querySelector('#screen'),
          video: document.querySelector('#video'),
          snapshot: () => ({ state: 'idle', selection: null, failure: null }),
        }),
      );
    });
    const open = page.getByRole('button', { name: 'Playback diagnostics', exact: true });
    const close = page.getByRole('button', { name: 'Close', exact: true });
    const start = page.getByRole('button', { name: 'Start 15-minute capture', exact: true });
    await open.click();
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseAction')))
      .toBe('function');
    await browserExpect(close).toBeFocused();
    await browserExpect(close).toBeEnabled();
    await browserExpect(start).toBeDisabled();
    await page.getByLabel('Capture summary', { exact: true }).focus();
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')();
    });
    await browserExpect(start).toBeEnabled();
    await browserExpect(page.getByLabel('Capture summary', { exact: true })).toBeFocused();
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', 'start');
      Reflect.deleteProperty(window, 'releaseAction');
    });
    await start.click();
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseAction')))
      .toBe('function');
    await browserExpect(close).toBeFocused();
    await browserExpect(start).toBeDisabled();
    await page.getByRole('status').focus();
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')();
    });
    await browserExpect(start).toBeEnabled();
    await browserExpect(page.getByRole('status')).toBeFocused();
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', 'read');
      Reflect.deleteProperty(window, 'releaseAction');
    });
    await page.getByRole('button', { name: 'Export report', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseAction')))
      .toBe('function');
    await browserExpect(close).toBeFocused();
    await close.click();
    await browserExpect(open).toBeFocused();
    await page.getByRole('button', { name: 'Other settings', exact: true }).focus();
    await page.evaluate(() => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')();
    });
    await expect.poll(() => page.evaluate(() => !!Reflect.get(window, 'exported'))).toBe(true);
    await browserExpect(
      page.getByRole('dialog', { name: 'Playback diagnostics', exact: true }),
    ).toBeHidden();
    await browserExpect(
      page.getByRole('button', { name: 'Other settings', exact: true }),
    ).toBeFocused();
    await page.evaluate(() => Reflect.get(window, 'capture').dispose());
  } finally {
    await page.evaluate(async () => {
      Reflect.set(window, 'holdAction', null);
      Reflect.get(window, 'releaseAction')?.();
      await Reflect.get(window, 'capture')?.dispose();
    });
    await page.close();
  }
});
afterAll(async () => {
  await browser?.close();
});
it('records measured offset evidence, exports redacted data and stops cleanly', async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.setContent(
      '<main id="app"><button id="open">Playback diagnostics</button><div id="screen" style="position:absolute;left:784px;top:257px;width:1088px;height:612px"><video id="video" style="width:100%;height:100%"></video></div></main>',
    );
    await page.evaluate(() =>
      Reflect.set(window, 'report', {
        schemaVersion: 1,
        version: '0.1.6',
        build: 1006,
        platform: 'windows',
        active: false,
        startedAtMs: 0,
        untilMs: 0,
        droppedEvents: 0,
        records: [],
      }),
    );
    await page.addStyleTag({ content: await readFile('src/ui/event-history.css', 'utf-8') });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      const fixture = Reflect.get(window, 'TraceFixture');
      Reflect.set(
        window,
        'capture',
        fixture.installPlaybackDiagnostics({
          button: document.getElementById('open'),
          app: document.getElementById('app'),
          screen: document.getElementById('screen'),
          video: document.getElementById('video'),
          snapshot: () => ({
            state: 'playing',
            selection: {
              id: 'account-private-identity',
              name: 'private title',
              url: 'https://user:password@secret.invalid/token',
            },
            failure: null,
          }),
        }),
      );
    });
    await page.getByRole('button', { name: 'Playback diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Start 15-minute capture', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'report').records.length))
      .toBeGreaterThan(1);
    await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      for (let i = 0; i < 20; i++) {
        app.classList.toggle('playing', true);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    expect(
      await page.evaluate(
        () =>
          Reflect.get(window, 'report').records.filter(
            (r: { record: { event: string } }) => r.record.event === 'sample',
          ).length,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
    await expect
      .poll(() => page.getByLabel('Capture summary').textContent())
      .toContain('1 measured view-bound mismatches');
    expect(
      await page.getByLabel('Capture summary').evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Export report', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!Reflect.get(window, 'exported'))).toBe(true);
    const report = await page.evaluate(() => Reflect.get(window, 'exported'));
    expect(
      report.records.some(
        (r: { record: { values: { playerNative?: number[] } } }) =>
          r.record.values.playerNative?.[0] === 1568,
      ),
    ).toBe(true);
    const text = JSON.stringify(report);
    for (const secret of [
      'password',
      'secret.invalid',
      'private-identity',
      'private title',
      '/token',
    ])
      expect(text).not.toContain(secret);
    await page.evaluate(() => {
      document.getElementById('screen')!.style.left = '10px';
      document.getElementById('app')!.classList.add('expanded');
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Reflect.get(window, 'report').records.filter(
              (r: { record: { event: string } }) => r.record.event === 'sample',
            ).length,
        ),
      )
      .toBe(2);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'report').active)).toBe(false);
    for (const [rejection, category] of [
      ['playback-trace-invalid', 'validation'],
      ['https://user:password@secret.invalid/private-error', 'unknown'],
    ]) {
      await page.evaluate((reason) => Reflect.set(window, 'rejectRecord', reason), rejection);
      await page.getByRole('button', { name: 'Start 15-minute capture', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
      await browserExpect(page.getByRole('status')).toContainText(
        `Recording could not continue (${category})`,
      );
      expect(await page.getByRole('status').textContent()).not.toMatch(
        /password|secret|https|private-error/,
      );
    }
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.evaluate(() => Reflect.get(window, 'capture').dispose());
    expect(await page.getByRole('dialog', { name: 'Playback diagnostics' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});
