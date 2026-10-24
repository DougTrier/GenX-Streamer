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

import { saveCompletedSourceScan } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/* global AbortController -- Node.js cancellation primitive. */

const serial = process.argv[2];
const seconds = Number(process.argv[3] ?? 7200);
const physical = process.argv.includes('--physical-approved');
if (
  physical
    ? serial !== (process.env.GENX_APPROVED_FLIP_SERIAL ?? '')
    : !/^emulator-\d+$/.test(serial ?? '')
)
  throw new Error('Select an emulator or the approved Flip 2 (GENX_APPROVED_FLIP_SERIAL).');
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400)
  throw new Error('Duration must be an integer from 10 to 86400 seconds.');
const execute = promisify(execFile);
const adbPath =
  process.env.TMG_ADB ?? path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
const output = path.resolve(
  'artifacts/android-soak',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(output, { recursive: true });
const receipt = JSON.parse(await readFile('tests/fixtures/media/generation.json', 'utf8'));
const report = {
  status: 'FAIL',
  scope: 'Installed Android controlled live HLS continuous decode',
  serial,
  requestedSeconds: seconds,
  started: new Date().toISOString(),
  fixtureSeed: receipt.fixtureSeed,
  encoder: receipt.version,
  samples: 0,
  memoryAcceptance: 'Measurements only; device budgets are not defined',
};
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const sleep = (ms) =>
  new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new Error('Soak interrupted'));
    };
    const timer = setTimeout(() => {
      controller.signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    controller.signal.addEventListener('abort', aborted, { once: true });
    if (controller.signal.aborted) aborted();
  });
const fixture = await startFixtureServer();
const title = `Owned Android Live Soak ${Date.now()}`;
const catalog = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/plain');
  response.end(
    `#EXTM3U\n#EXTINF:-1 tvg-id="android-live-soak" group-title="Sports",${title}\n${fixture.url}/hls/live.m3u8\n`,
  );
});
await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));
const ports = [new URL(fixture.url).port, String(catalog.address().port)];
let browser;
let forwarded;
let page;
const apkHash = async () => {
  const location = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!location || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(location))
    throw new Error('Invalid installed APK path');
  return (await adb('shell', 'sha256sum', location)).split(/\s/)[0];
};
try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (physical && report.model !== 'Retroid Pocket Flip2')
    throw new Error('Approved physical model mismatch');
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  report.abi = await adb('shell', 'getprop', 'ro.product.cpu.abi');
  report.apkSha256 = await apkHash();
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  if (!/^\d+$/.test(pid)) throw new Error('Application process unavailable');
  report.pid = pid;
  forwarded = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const ready = Date.now() + 20000;
  while (Date.now() < ready && !browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, {
        noDefaults: true,
        timeout: 1000,
      });
    } catch {
      await sleep(100);
    }
  }
  if (!browser) throw new Error('WebView debugging unavailable');
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((tab) => !tab.url().startsWith('devtools:'));
  if (!page) throw new Error('Application WebView unavailable');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`http://127.0.0.1:${ports[1]}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  await page.locator('#search').fill(title);
  await page.locator('.channel').filter({ hasText: title }).first().click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
  /* eslint-disable no-undef -- This predicate runs inside the Android WebView. */
  await expect
    .poll(() => page.evaluate(() => document.getElementById('video').currentTime), {
      timeout: 20000,
    })
    .toBeGreaterThan(1);
  /* eslint-enable no-undef */
  const sample = async () => {
    /* eslint-disable no-undef -- This function runs inside the physical Android WebView. */
    const result = await page.evaluate(() => {
      const video = document.getElementById('video');
      const quality = video.getVideoPlaybackQuality();
      return {
        state: document.getElementById('playback-status').textContent,
        time: video.currentTime,
        frames: quality.totalVideoFrames,
        dropped: quality.droppedVideoFrames,
        width: video.videoWidth,
        height: video.videoHeight,
        nativeError: video.error?.code ?? null,
        overlay: document.getElementById('overlay-message').textContent,
        visible: document.visibilityState,
        userAgent: navigator.userAgent,
        selected: document.querySelector('.channel[aria-current="true"]')?.textContent,
        heapBytes: performance.memory?.usedJSHeapSize ?? null,
      };
    });
    /* eslint-enable no-undef */
    const memory = await adb('shell', 'dumpsys', 'meminfo', 'com.tmg.tv');
    result.appTotalPssKb = Number(
      memory.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? memory.match(/TOTAL\s+(\d+)/)?.[1] ?? NaN,
    );
    const windows = await adb('shell', 'dumpsys', 'window', 'windows');
    const ownWindow = windows
      .split(/(?= {2}Window #\d+)/)
      .find((block) => /Window #\d+.*com\.tmg\.tv\/com\.tmg\.tv\.MainActivity/.test(block));
    result.windowKeepsScreenOn = !!ownWindow?.match(/fl=[^\n]*KEEP_SCREEN_ON/);
    result.fixture = fixture.stats();
    return result;
  };
  let previous = await sample();
  if (previous.width !== 320 || previous.frames < 2)
    throw new Error('Initial actual MSE frames unavailable');
  report.initial = previous;
  report.decodeStarted = new Date().toISOString();
  const start = performance.now();
  const end = start + seconds * 1000;
  while (performance.now() < end) {
    await sleep(Math.min(5000, end - performance.now()));
    const current = await sample();
    current.elapsedSeconds = (performance.now() - start) / 1000;
    report.lastSample = current;
    report.samples++;
    await appendFile(path.join(output, 'samples.jsonl'), `${JSON.stringify(current)}\n`);
    if (current.state !== 'Playing' || current.visible !== 'visible')
      throw new Error('Continuous foreground playback interrupted');
    if (
      current.nativeError ||
      current.width !== 320 ||
      current.frames <= previous.frames ||
      current.time <= previous.time
    )
      throw new Error('Actual decoded frames or media clock stopped advancing');
    if (!current.windowKeepsScreenOn) throw new Error('Foreground viewing wake flag missing');
    previous = current;
  }
  report.observedSeconds = (performance.now() - start) / 1000;
  if ((await apkHash()) !== report.apkSha256)
    throw new Error('Installed APK changed during the soak');
  await page.screenshot({ path: path.join(output, 'webview.png') });
  const capture = await execute(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  });
  await writeFile(path.join(output, 'physical.png'), capture.stdout);
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.message ?? error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (page) {
    let exitTimer;
    /* eslint-disable no-undef -- Explicit shutdown of this test-owned application session. */
    await Promise.race([
      page.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit')).catch(() => undefined),
      new Promise((resolve) => {
        exitTimer = setTimeout(resolve, 5000);
      }),
    ]);
    /* eslint-enable no-undef */
    clearTimeout(exitTimer);
  }
  await browser?.close().catch(() => undefined);
  if (forwarded) await adb('forward', '--remove', `tcp:${forwarded}`).catch(() => undefined);
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(() => undefined);
  await fixture.close();
  catalog.closeAllConnections();
  await new Promise((resolve) => catalog.close(resolve));
  report.fixtureAfterClose = fixture.stats();
  if (
    report.fixtureAfterClose.activeSockets ||
    report.fixtureAfterClose.activeResponses ||
    report.fixtureAfterClose.timers
  ) {
    report.status = 'FAIL';
    report.error = 'Test fixture resources remained after cleanup';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
