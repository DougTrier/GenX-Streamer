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

import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const url = new URL(option('--url', ''));
if (url.protocol !== 'https:' || url.username || url.password)
  throw new Error('Supply an explicit HTTPS media URL.');
const name = option('--name', 'User-selected live channel')
  .replace(/[\r\n]/g, ' ')
  .slice(0, 120);
const seconds = Number(option('--seconds', '60'));
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300)
  throw new Error('Duration must be 10–300 seconds.');
const exe = path.resolve(option('--exe', 'src-tauri/target/debug/tmg-tv.exe'));
const directory = path.resolve(
  'artifacts/public-stream',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  scope: 'User-requested public live stream diagnostic; availability is not deterministic CI',
  status: 'FAIL',
  started: new Date().toISOString(),
  name,
  sourceHost: url.hostname,
  executableSha256: createHash('sha256')
    .update(await readFile(exe))
    .digest('hex'),
  requestedSeconds: seconds,
  samples: [],
};
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
try {
  app = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: path.join(directory, 'data'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  let endpoint;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (report.launchFailed || app.exitCode !== null) throw new Error('launch');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const info = await response.json();
        endpoint = info.webSocketDebuggerUrl;
        report.webview = info.Browser;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('debug-endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#import-button').click();
  await page.locator('#playlist-file').setInputFiles({
    name: 'user-selected-live-test.m3u',
    mimeType: 'application/x-mpegurl',
    buffer: Buffer.from(
      `#EXTM3U\n#EXTINF:-1 tvg-id="public-test" group-title="News",${name}\n${url.href}\n`,
    ),
  });
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  await page.locator('.channel').first().click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 25000 });
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    const decoded = await page.locator('#video').evaluate((video) => ({
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
      paused: video.paused,
      readyState: video.readyState,
    }));
    const state = await page.locator('#playback-status').textContent();
    report.samples.push({ elapsedSeconds: (Date.now() - start) / 1000, state, decoded });
    if (state === 'Unable to play') throw new Error('playback');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(5000, seconds * 1000 - (Date.now() - start))),
    );
  }
  const last = report.samples.at(-1)?.decoded;
  const first = report.samples[0]?.decoded;
  if (
    !last ||
    !first ||
    last.width === 0 ||
    last.frames <= first.frames + 10 ||
    last.time <= first.time + 5
  )
    throw new Error('decode-progress');
  await page.screenshot({ path: path.join(directory, 'player.png') });
  await page.locator('#pause-button').click();
  await expect(page.locator('#playback-status')).toHaveText('Paused');
  const pauseStart = await page
    .locator('#video')
    .evaluate((video) => ({ paused: video.paused, time: video.currentTime }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pauseEnd = await page
    .locator('#video')
    .evaluate((video) => ({ paused: video.paused, time: video.currentTime }));
  report.pauseActual = {
    start: pauseStart,
    end: pauseEnd,
    observedMilliseconds: 500,
    toleranceSeconds: 0.1,
  };
  if (!pauseStart.paused || !pauseEnd.paused || Math.abs(pauseEnd.time - pauseStart.time) > 0.1)
    throw new Error('pause-progress');
  report.pauseVerified = true;
  report.status = 'PASS';
} catch {
  report.error = 'Public playback did not satisfy the observed decoder/progress checks.';
  if (page) {
    report.playerState = await page
      .locator('#playback-status')
      .textContent()
      .catch(() => 'Unavailable');
    const message = await page
      .locator('#overlay-message')
      .textContent()
      .catch(() => null);
    report.playerMessage = message && !/https?:\/\//i.test(message) ? message : 'Details redacted.';
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (app && app.exitCode === null) {
    const exited = new Promise((resolve) => app.once('exit', () => resolve(true)));
    app.kill();
    let timer;
    report.processExitConfirmed = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!report.processExitConfirmed) {
      report.status = 'FAIL';
      report.error = 'Owned application shutdown did not confirm within five seconds.';
      process.exitCode = 1;
    }
  } else report.processExitConfirmed = !app || app.exitCode !== null;
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      directory,
      samples: report.samples.length,
      playerMessage: report.playerMessage,
    }),
  );
}
