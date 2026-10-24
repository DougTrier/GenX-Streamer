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
import { chromium, type Browser } from '@playwright/test';
import { grabberSummary, validateGrabberExport } from '../../src/platform/guide-grabber';

const reply = {
  xml: '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n  <channel site="tvtv.us" lang="en" xmltv_id="A.us@SD" site_id="1">A</channel>\n</channels>\n',
  channels: 1,
  unmatched: 4,
  sites: [{ site: 'tvtv.us', channels: 1 }],
  source: 'https://iptv-org.github.io/api/guides.json',
};
describe('guide grabber export validation', () => {
  it('admits the bounded native reply and refuses altered shapes', () => {
    expect(validateGrabberExport(reply).channels).toBe(1);
    for (const bad of [
      { ...reply, source: 'https://other.invalid' },
      { ...reply, xml: '<channels></channels>' },
      { ...reply, channels: -1 },
      { ...reply, sites: [{ site: 'x', channels: 'many' }] },
      null,
    ])
      expect(() => validateGrabberExport(bad)).toThrow();
  });
  it('summarizes truthfully without claiming coverage', () => {
    expect(grabberSummary(validateGrabberExport(reply), true)).toMatch(
      /^Saved 1 channels for the iptv-org grabber using tvtv\.us \(1\)\. 4 saved channels have no listing\./,
    );
    expect(grabberSummary({ ...validateGrabberExport(reply), channels: 0 }, false)).toContain(
      'Nothing was saved',
    );
  });
});

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
        entry: 'src/ui/guide/guide-grabber-settings.ts',
        formats: ['iife'],
        name: 'GrabberUI',
      },
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
interface GrabberWindow {
  calls: number;
  mode: 'ok' | 'cancel' | 'fail';
  GrabberUI: {
    installGuideGrabberExport(
      doc: Document,
      run: (signal: AbortSignal) => Promise<{ result: unknown; saved: boolean }>,
    ): unknown;
  };
}
describe('guide grabber settings control', () => {
  it('runs once per click, reports the outcome and recovers from failure', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent(
      '<button id="export-guide-grabber">Export</button><p id="guide-grabber-status"></p>',
    );
    await page.addScriptTag({ content: bundle });
    await page.evaluate((value) => {
      const w = window as unknown as GrabberWindow;
      w.calls = 0;
      w.mode = 'ok';
      w.GrabberUI.installGuideGrabberExport(document, async () => {
        w.calls++;
        await new Promise((r) => setTimeout(r, 50));
        if (w.mode === 'fail') throw new Error('offline');
        return { result: value, saved: w.mode === 'ok' };
      });
    }, reply);
    await page.click('#export-guide-grabber');
    expect(await page.isDisabled('#export-guide-grabber')).toBe(true);
    await page.waitForFunction(
      () => !(document.getElementById('export-guide-grabber') as HTMLButtonElement).disabled,
    );
    expect(await page.textContent('#guide-grabber-status')).toContain('Saved 1 channels');
    await page.evaluate(() => ((window as unknown as GrabberWindow).mode = 'cancel'));
    await page.click('#export-guide-grabber');
    await page.waitForFunction(() =>
      document.getElementById('guide-grabber-status')!.textContent!.includes('Save canceled'),
    );
    await page.evaluate(() => ((window as unknown as GrabberWindow).mode = 'fail'));
    await page.click('#export-guide-grabber');
    await page.waitForFunction(() =>
      document
        .getElementById('guide-grabber-status')!
        .textContent!.includes('could not be prepared'),
    );
    expect(await page.evaluate(() => (window as unknown as GrabberWindow).calls)).toBe(3);
    await page.close();
  });
});
