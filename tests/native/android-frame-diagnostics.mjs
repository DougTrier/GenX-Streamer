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
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const serial = process.env.GENX_APPROVED_FLIP_SERIAL ?? '';
const fragmented = process.argv.includes('--fmp4');
const execute = promisify(execFile);
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], { windowsHide: true, timeout: 15000 })
  ).stdout.trim();
if ((await adb('shell', 'getprop', 'ro.product.model')) !== 'Retroid Pocket Flip2')
  throw new Error('Authorized device mismatch');
const output = path.resolve(
  'artifacts/android-frame-diagnostics',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer();
const title = `Frame diagnostic ${fragmented ? 'fMP4' : 'TS'} ${Date.now()}`;
const catalog = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.end(
    `#EXTM3U\n#EXTINF:-1 tvg-id="frame-diagnostic-ts",${title}\n${fixture.url}${fragmented ? '/media/fmp4.m3u8' : '/hls/master.m3u8'}\n`,
  );
});
await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));
const ports = [new URL(fixture.url).port, String(catalog.address().port)];
let browser;
let forward;
const report = { serial, status: 'FAIL', checks: [], started: new Date().toISOString() };
try {
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  if (!/^\d+$/.test(pid)) throw new Error('Missing application process');
  forward = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${forward}`, {
    noDefaults: true,
    timeout: 10000,
  });
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('tauri.localhost'));
  if (!page) throw new Error('Missing application WebView');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`http://127.0.0.1:${ports[1]}/source`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  await page.locator('#search').fill(title);
  /* eslint-disable no-undef -- Controlled physical WebView error telemetry. */
  await page.evaluate(() => {
    window.__frameDiagnosticErrors = [];
    document.getElementById('video').addEventListener('error', () => {
      window.__frameDiagnosticErrors.push(document.getElementById('video').error?.code ?? null);
    });
  });
  /* eslint-enable no-undef */
  await page.locator('.channel').filter({ hasText: title }).first().click();
  await expect
    .poll(() => page.locator('#playback-status').textContent(), { timeout: 20000 })
    .toMatch(/^(Playing|Unable to play)$/);
  // This callback executes inside the physical WebView.
  /* eslint-disable no-undef -- This callback runs inside the physical Android WebView. */
  report.decoder = await page.evaluate(async () => {
    const video = document.getElementById('video');
    const frames = [];
    const callbackAvailable = typeof video.requestVideoFrameCallback === 'function';
    if (callbackAvailable) {
      await new Promise((resolve) => {
        let finished = false;
        let handle;
        const finish = () => {
          if (finished) return;
          finished = true;
          video.cancelVideoFrameCallback(handle);
          resolve();
        };
        const timer = setTimeout(finish, 5000);
        const observe = (_now, metadata) => {
          frames.push({
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
            width: metadata.width,
            height: metadata.height,
          });
          if (frames.length >= 3) {
            clearTimeout(timer);
            finish();
          } else handle = video.requestVideoFrameCallback(observe);
        };
        handle = video.requestVideoFrameCallback(observe);
      });
    }
    return {
      callbackAvailable,
      callbacks: frames,
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      quality: video.getVideoPlaybackQuality(),
      webkitDecodedFrames: video.webkitDecodedFrameCount ?? null,
      readyState: video.readyState,
      paused: video.paused,
      error: video.error?.code ?? null,
      selectedLabel: document.querySelector('.channel[aria-current="true"]')?.textContent ?? null,
      nativeErrorEvents: window.__frameDiagnosticErrors,
      overlayMessage: document.getElementById('overlay-message')?.textContent,
      playbackStatus: document.querySelector('#playback-status')?.textContent,
      errorMessage: video.error?.message ?? null,
      mseSupported:
        typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e,mp4a.40.2"'),
      sourceIsFixture: video.currentSrc.includes('127.0.0.1'),
      sourceKind: video.currentSrc.startsWith('blob:') ? 'mse' : 'native',
    };
  });
  /* eslint-enable no-undef */
  await page.screenshot({ path: path.join(output, 'webview.png') });
  const screenshot = await execute(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  });
  await writeFile(path.join(output, 'physical.png'), screenshot.stdout);
  report.status = 'OBSERVED';
} catch (error) {
  report.error = String(error.message ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (forward) await adb('forward', '--remove', `tcp:${forward}`).catch(() => undefined);
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(() => undefined);
  await fixture.close();
  await new Promise((resolve) => catalog.close(resolve));
  report.finished = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
