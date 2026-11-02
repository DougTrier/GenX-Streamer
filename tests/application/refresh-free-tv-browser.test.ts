// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from '@playwright/test';

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: 'src/application/health/channel-health-controller.ts',
        formats: ['iife'],
        name: 'ChannelHealth',
      },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Health controller bundle missing.');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Health controller entry missing.');
  bundle = chunk.code;
  browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
});
afterAll(async () => browser?.close());

async function fixture() {
  const page = await browser.newPage();
  await page.setContent(`
    <main id="app" data-ready="true"></main>
    <input id="search">
    <div class="filters"><button data-filter="all"></button>
      <button data-filter="unresponsive" aria-pressed="true"></button></div>
    <select id="compact-filter"><option value="unresponsive"></option></select>
    <section id="dead-channels"><span id="dead-channels-text"></span>
      <button id="remove-dead-channels">Remove</button></section>
    <button id="remove-channel">Remove selected</button>`);
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
      const checks = new Map(['bad','favorite'].map(id => [id, {
        channelId:id,checkedMs:86400000,okMs:null,firstFailMs:0,
        lastFailMs:86400000,verdict:'TimedOut',notResponding:true
      }]));
      const state = {edits:[],discovery:[],notices:[],failure:false,action:null};
      const env = {
        applicationClosing:false,addChannelsEntryWork:null,
        settings:{favorites:['favorite'],removedChannels:[]},
        catalog:{schemaVersion:1,sources:[],channels:['bad','favorite','working'].map(id => ({
          id,name:id,sourceId:'list',category:'Sports',urls:['https://fixture.invalid/'+id]
        }))},
        channelCheckMarks:checks,slowChannelIds:new Set(),catalogBrowseViewRevision:0,
        contentLibrary:'live',accountBrowser:{selectedAccount:null},
        element:id => document.getElementById(id),
        player:{snapshot:{state:'idle',selection:null},subscribe:() => () => {}},
        sharingBridge:{stop:async () => {}},
        browser:{setSlow:() => {},setNotResponding:() => {},search:() => {}},
        sourceScan:{snapshot:() => ({busy:false})},
        scanController:{healthPlatform:null,automaticScanActive:false},
        nativeViewingForeground:true,
        notice:message => state.notices.push(message),
        editPublicChannelGroup:async(id,action,more=[]) => {
          const ids = [id,...more]; state.edits.push({ids,action});
          if(action.kind==='remove')env.settings.removedChannels.push(...ids);
        },
        startInlineDiscovery:rescan => {
          state.discovery.push(rescan);
          if(state.failure)throw new Error('controlled-refresh-failed');
        },
        playbackAction:work => {state.action=work;},
      };
      window.healthFixture={env,state,controller:ChannelHealth.createChannelHealthController(env)};
    `,
  });
  return page;
}

it('Refresh starts discovery without removing still-listed channels carrying generic failure marks', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const f = Reflect.get(window, 'healthFixture');
      await f.controller.refreshFreeTv();
      return { state: f.state, settings: f.env.settings, channels: f.env.catalog.channels.length };
    });
    expect(result.state.discovery).toEqual([false]);
    expect(result.state.edits).toEqual([]);
    expect(result.settings.removedChannels).toEqual([]);
    expect(result.settings.favorites).toEqual(['favorite']);
    expect(result.channels).toBe(3);
  } finally {
    await page.close();
  }
});

it('a failed source refresh cannot remove generic Not responding channels first', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const f = Reflect.get(window, 'healthFixture');
      f.state.failure = true;
      let failure = '';
      try {
        await f.controller.refreshFreeTv();
      } catch (error) {
        failure = error instanceof Error ? error.message : 'unexpected';
      }
      return { failure, edits: f.state.edits, removed: f.env.settings.removedChannels };
    });
    expect(result.failure).toBe('controlled-refresh-failed');
    expect(result.edits).toEqual([]);
    expect(result.removed).toEqual([]);
  } finally {
    await page.close();
  }
});

it('explicit Remove Not responding still removes the marked group while retaining saved data and favorites', async () => {
  const page = await fixture();
  try {
    await page.locator('#remove-dead-channels').click();
    const result = await page.evaluate(async () => {
      const f = Reflect.get(window, 'healthFixture');
      await f.state.action;
      return {
        edits: f.state.edits,
        settings: f.env.settings,
        channels: f.env.catalog.channels.length,
      };
    });
    expect(result.edits).toEqual([{ ids: ['bad', 'favorite'], action: { kind: 'remove' } }]);
    expect(result.settings.removedChannels).toEqual(['bad', 'favorite']);
    expect(result.settings.favorites).toEqual(['favorite']);
    expect(result.channels).toBe(3);
  } finally {
    await page.close();
  }
});
