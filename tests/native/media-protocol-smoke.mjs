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

import { openSourceImport } from './settings-navigation-helper.mjs';
import { saveCompletedSourceScan } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const inputExe = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/media-protocol',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'tmg-tv.exe');
await copyFile(inputExe, executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = hash(await readFile(executable));
const fixtureDirectory = path.resolve('tests/fixtures/media/protocol');
const fixture = JSON.parse(await readFile(path.join(fixtureDirectory, 'generation.json'), 'utf8'));
for (const item of fixture.outputs) {
  if (hash(await readFile(path.join(fixtureDirectory, item.name))) !== item.sha256)
    throw new Error('Protocol fixture output hash mismatch');
}
const report = {
  scope:
    'Windows copied debug executable actual AES-128 TS and fMP4 map/byterange decode; no Android/receiver claim',
  started: new Date().toISOString(),
  sourceExecutable: inputExe,
  executable,
  sha256,
  fixture,
  status: 'FAIL',
  checks: [],
  cleanup: { confirmed: false },
};
const fixtures = await startFixtureServer();
const catalog = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
  response.end(
    `#EXTM3U\n#EXTINF:-1,Owned encrypted TS\n${fixtures.url}/protocol/aes/master.m3u8?fixture=owned\n#EXTINF:-1,Owned range fMP4\n${fixtures.url}/protocol/range/index.m3u8?fixture=owned\n`,
  );
});
await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
try {
  const data = path.join(directory, 'data');
  await mkdir(data, { recursive: true });
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  let endpoint;
  for (let n = 0; n < 200; n++) {
    if (app.exitCode !== null || report.launchFailed)
      throw new Error('Owned application exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const version = await response.json();
        endpoint = version.webSocketDebuggerUrl;
        report.webview = version.Browser;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Owned WebView endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No owned application page');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`http://127.0.0.1:${catalog.address().port}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toContainText('2 channels');
  for (const title of ['Owned encrypted TS', 'Owned range fMP4']) {
    const before = fixtures.stats().protocolRequests.length;
    await page.locator('button[data-channel]').filter({ hasText: title }).first().click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
    const sample = () =>
      page.locator('#video').evaluate((video) => ({
        time: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        paused: video.paused,
      }));
    await expect.poll(async () => (await sample()).time, { timeout: 15000 }).toBeGreaterThan(3);
    const first = await sample();
    await page.waitForTimeout(600);
    const second = await sample();
    if (
      first.width !== 320 ||
      first.height !== 180 ||
      second.frames <= first.frames ||
      second.time <= first.time + 0.1 ||
      second.paused
    )
      throw new Error('Protocol stream lacked actual decoded-frame and time progression');
    const requests = fixtures.stats().protocolRequests.slice(before);
    if (title === 'Owned encrypted TS') {
      if (
        !requests.some(
          (item) =>
            item.path.endsWith('/aes.key') &&
            item.status === 200 &&
            item.bytes === 16 &&
            item.query === '?fixture=owned',
        )
      )
        throw new Error('AES key resource with query was not fetched');
      if (
        !requests.some(
          (item) => item.path.endsWith('/aes000.ts') && item.query === '?fixture=owned',
        )
      )
        throw new Error('Encrypted segment with relative query was not fetched');
    } else {
      const ranged = requests.filter((item) => item.path.endsWith('/ranges.mp4'));
      const init = fixture.inputs.find((item) => item.name === 'init.mp4').bytes;
      const secondOffset =
        init + fixture.inputs.find((item) => item.name === 'fmp4segment000.m4s').bytes;
      if (
        !ranged.some(
          (item) =>
            item.range === `bytes=0-${init - 1}` && item.status === 206 && item.bytes === init,
        )
      )
        throw new Error('fMP4 initialization map byte range not served as206');
      if (
        !ranged.some(
          (item) =>
            item.range?.startsWith(`bytes=${init}-`) &&
            item.status === 206 &&
            item.contentRange &&
            item.query === '?fixture=owned',
        )
      )
        throw new Error('fMP4 media byte range not served as206');
      if (ranged.some((item) => item.status !== 206))
        throw new Error('Ranged media fetched without206');
      if (!ranged.some((item) => item.range?.startsWith(`bytes=${secondOffset}-`)))
        throw new Error('Implicit next-segment byte range was not requested');
    }
    report.checks.push({ title, first, second, requests });
    await page.screenshot({
      path: path.join(directory, title.includes('encrypted') ? 'aes.png' : 'range.png'),
    });
  }
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    await page
      ?.evaluate(() => Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke('request_exit'))
      .catch(() => {});
    const until = Date.now() + 5000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      report.cleanup.forced = true;
      report.status = 'FAIL';
      process.exitCode = 1;
      const killedUntil = Date.now() + 5000;
      while (app.exitCode === null && app.signalCode === null && Date.now() < killedUntil)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await browser?.close().catch(() => {});
  await fixtures.close();
  catalog.closeAllConnections();
  await new Promise((resolve) => catalog.close(resolve));
  const closed = fixtures.stats();
  report.requests = closed.protocolRequests;
  report.cleanup = {
    ...report.cleanup,
    confirmed:
      !!app && (app.exitCode !== null || app.signalCode !== null) && !report.cleanup.forced,
    exitCode: app?.exitCode,
    signal: app?.signalCode,
    activeSockets: closed.activeSockets,
    activeResponses: closed.activeResponses,
    timers: closed.timers,
  };
  if (
    !report.cleanup.confirmed ||
    closed.activeSockets ||
    closed.activeResponses ||
    closed.timers
  ) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  if (hash(await readFile(executable)) !== sha256) {
    report.status = 'FAIL';
    report.binaryChanged = true;
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      sha256,
      report: path.join(directory, 'report.json'),
      error: report.error,
    }) + '\n',
  );
}
