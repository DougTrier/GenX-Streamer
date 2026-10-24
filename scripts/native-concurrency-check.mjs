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

/* global window -- callbacks execute only inside this script's isolated WebView. */
// Packaged Windows check that background work never blocks or ends other work:
// a full channel scan, an explicit Guide build, page switches and GenXtra playback
// run together. Isolated profile (TMG_DATA_DIR), real public services. Public
// availability is observed, not asserted; the app's own behavior gates PASS.
// Usage: node scripts/native-concurrency-check.mjs [exe] [--keep-profile] [--title="Outer Limits"]
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const exe = path.resolve(
  process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'src-tauri/target/debug/tmg-tv.exe',
);
const title = process.argv.find((a) => a.startsWith('--title='))?.slice(8) ?? 'Outer Limits';
const directory = path.resolve(
  'artifacts/native-concurrency',
  new Date().toISOString().replaceAll(':', '-'),
);
const data = path.join(directory, `data-${Date.now()}`);
await mkdir(data, { recursive: true });
const report = {
  scope:
    'Packaged Windows concurrency behavior on an isolated profile with real public services; public availability is observation only',
  started: new Date().toISOString(),
  executable: exe,
  sha256: createHash('sha256')
    .update(await readFile(exe))
    .digest('hex'),
  status: 'FAIL',
  checks: [],
  failures: [],
  timeline: [],
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const began = performance.now();
const mark = (event, detail = {}) =>
  report.timeline.push({ atMs: Math.round(performance.now() - began), event, ...detail });
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
let exitReceipt = null;
const text = async (selector) =>
  (
    (await page
      .locator(selector)
      .first()
      .textContent({ timeout: 2000 })
      .catch(() => '')) ?? ''
  ).trim();
const scanState = async () => ({
  status: await text('#inline-scan-status'),
  error: await text('#inline-scan-error'),
  phase: await page.evaluate(() => window.__GENX_SCAN__?.phase ?? null).catch(() => null),
  playback: await text('#playback-status'),
});
// Time one page switch: click, then the target library pressed and the UI ready.
const switchTo = async (id) => {
  const start = performance.now();
  await page.locator(`#${id}`).click();
  await expect(page.locator(`#${id}`)).toHaveAttribute('aria-pressed', 'true', { timeout: 60000 });
  const ms = Math.round(performance.now() - start);
  mark(`switch:${id}`, { ms, ...(await scanState()) });
  return ms;
};
try {
  app = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  app.once('exit', (code, signal) => (exitReceipt = { code, signal }));
  let endpoint;
  for (let i = 0; i < 300 && !endpoint; i++) {
    if (exitReceipt) throw new Error('Owned app exited before readiness.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) endpoint = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await wait(100);
  }
  if (!endpoint) throw new Error('Native WebView debugging endpoint did not become ready.');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('No native application WebView page.');
  page.setDefaultTimeout(20000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 120000 });
  mark('ready');

  // 1. A full channel scan (empty query) until channel checks are running.
  await page.locator('#search').fill('');
  await page.locator('#search-programs').click();
  mark('scan:start');
  const checksBy = performance.now() + 8 * 60000;
  while (performance.now() < checksBy) {
    const state = await scanState();
    if (/of \d+ checked/.test(state.status)) break;
    if (state.error) throw new Error(`Scan failed before checks: ${state.error}`);
    await wait(1000);
  }
  mark('scan:checking', await scanState());
  // Let some channels save so the Guide has something to build for.
  await wait(30000);
  mark('scan:after-30s', await scanState());

  // 2. Guide, then an explicit Find program guides build.
  await switchTo('guide-button');
  const find = page.getByRole('button', { name: 'Find program guides', exact: true }).first();
  await find.click({ timeout: 20000 });
  mark('guide:find');
  await wait(5000);
  mark('guide:after-5s', { guide: await text('dialog[open] [role="status"]') });

  // 3. GenXtra while the Guide build and scan run; search and play a title.
  report.genxtraSwitchMs = await switchTo('genxtra-button');
  await page.locator('#search').fill(title);
  await page.locator('#search-programs').click();
  const result = page.locator('.gx-archive-title-button').first();
  await result.waitFor({ timeout: 120000 });
  await result.click();
  const play = page.getByRole('button', { name: /^Play\b/ }).first();
  await play.click({ timeout: 60000 });
  const resume = page.getByRole('button', { name: /^(Resume from|Start over)/ }).first();
  if (await resume.isVisible({ timeout: 3000 }).catch(() => false)) await resume.click();
  await expect(page.locator('#playback-status')).toHaveText(/Playing/, { timeout: 60000 });
  mark('genxtra:playing', await scanState());
  // Playback must survive background work.
  let dropped = null;
  for (let i = 0; i < 30; i++) {
    await wait(1000);
    const playback = await text('#playback-status');
    if (!/Playing|Buffering/.test(playback)) {
      dropped = playback;
      break;
    }
  }
  mark('genxtra:after-30s', { dropped, ...(await scanState()) });

  // 4. Back to Live TV: the scan must still be alive and the list reachable.
  report.liveSwitchMs = await switchTo('live-tv-button');
  await wait(20000);
  const final = await scanState();
  mark('live:after-20s', final);
  const channels = await page.locator('#channel-list .channel').count();
  const history = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('read_diagnostic_events'),
  );
  report.events = (history.events ?? history).slice(-30);
  report.observations = { channelsListed: channels, final };

  const failed = report.events.some((e) => e.code === 'scan-failed');
  const restarted = report.events.filter((e) => e.code === 'scan-started').length > 1;
  if (failed) report.failures.push('The channel scan failed during concurrent work.');
  if (restarted) report.failures.push('The channel scan restarted after a page switch.');
  if (dropped) report.failures.push(`GenXtra playback stopped: ${dropped}`);
  if (report.genxtraSwitchMs > 3000)
    report.failures.push(`Switching to GenXtra took ${report.genxtraSwitchMs} ms.`);
  if (report.liveSwitchMs > 3000)
    report.failures.push(`Switching to Live TV took ${report.liveSwitchMs} ms.`);
  if (!channels) report.failures.push('The Live TV channel list was empty after the switch.');
  report.status = report.failures.length ? 'FAIL' : 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.failures.push(report.error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 })
      .catch(() => undefined);
} finally {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(directory, 'final.png'), timeout: 10000 })
      .catch(() => undefined);
    void page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
      .catch(() => undefined);
  }
  for (let i = 0; i < 240 && !exitReceipt; i++) await wait(250);
  report.ordinaryExit = !!exitReceipt;
  if (!exitReceipt) {
    app?.kill();
    report.status = 'FAIL';
  }
  await browser?.close().catch(() => undefined);
  if (!process.argv.includes('--keep-profile'))
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { status: report.status, failures: report.failures, evidence: directory },
      null,
      2,
    ),
  );
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
