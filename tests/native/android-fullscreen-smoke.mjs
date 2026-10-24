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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import path from 'node:path';
import { parseRequestedBars } from './android-window-flags.mjs';

const serial = process.argv[2];
if (
  serial !== (process.env.GENX_APPROVED_FLIP_SERIAL ?? '') ||
  !process.argv.includes('--physical-approved')
)
  throw new Error('Only the explicitly approved Flip2 may run this proof.');
const execute = promisify(execFile);
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const expectedArgs = process.argv.filter((arg) => arg.startsWith('--expected-apk-sha256='));
if (expectedArgs.length !== 1 || !/^--expected-apk-sha256=[a-f0-9]{64}$/.test(expectedArgs[0]))
  throw new Error('An explicit exact APK SHA256 is required');
const expectedApk = expectedArgs[0].split('=')[1];
const directory = path.resolve(
  'artifacts/android-fullscreen',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const name = `Owned fullscreen ${Date.now()}`;
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  serial,
  scope:
    'Physical Flip2 repeated native fullscreen/Back/button exit, rotation geometry and control hitboxes, channel changes and foreground interrupts; originals restored',
  checks: [],
};
const fixture = await startFixtureServer();
const sockets = new Set();
let requests = 0;
const server = http.createServer((_request, response) => {
  requests++;
  response.setHeader('Content-Type', 'application/x-mpegurl');
  response.end(
    `#EXTM3U\n#EXTINF:-1 group-title="Fixture",${name} A\n${fixture.url}/hls/live.m3u8?channel=a\n#EXTINF:-1 group-title="Fixture",${name} B\n${fixture.url}/hls/live.m3u8?channel=b\n`,
  );
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const ports = [String(server.address().port), new URL(fixture.url).port];
let browser, page, forwardedPort, original, apkPath, originalDisplay;
/* eslint-disable no-undef -- Public native IPC executes inside the owned packaged WebView. */
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
/* eslint-enable no-undef */
async function launch() {
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  if (!/^\d+$/.test(pid)) throw new Error('App PID unavailable');
  forwardedPort = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwardedPort}`, {
        timeout: 1000,
        noDefaults: true,
      });
      break;
    } catch {
      await wait(100);
    }
  }
  if (!browser) throw new Error('Native WebView readiness timed out');
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  page.setDefaultTimeout(20000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
}
async function shutdown() {
  await Promise.race([invoke('request_exit').catch(() => undefined), wait(5000)]);
  let exited = false;
  for (let count = 0; count < 50; count++) {
    try {
      await adb('shell', 'pidof', 'com.tmg.tv');
    } catch (error) {
      if (error.code === 1) {
        exited = true;
        break;
      }
      throw error;
    }
    await wait(100);
  }
  await browser?.close();
  browser = undefined;
  page = undefined;
  if (forwardedPort) await adb('forward', '--remove', `tcp:${forwardedPort}`);
  forwardedPort = undefined;
  if (!exited) throw new Error('Native process did not exit gracefully');
  report.exitCount = (report.exitCount ?? 0) + 1;
}

async function geometry() {
  /* eslint-disable no-undef -- Executed in the owned Android WebView. */
  return page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    visualWidth: visualViewport?.width,
    visualHeight: visualViewport?.height,
  }));
  /* eslint-enable no-undef */
}
async function hitboxes() {
  /* eslint-disable no-undef -- Executed in the owned Android WebView. */
  const boxes = await page.evaluate(() =>
    ['pause-button', 'mute-button', 'expand-button', 'fullscreen-button'].map((id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      return {
        id,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        inViewport:
          rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        ownsCenter: element.contains(document.elementFromPoint(x, y)),
      };
    }),
  );
  /* eslint-enable no-undef */
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.inViewport).toBe(true);
    expect(box.ownsCenter).toBe(true);
  }
  return boxes;
}
async function nativeInsets(fullscreen) {
  let captured;
  await expect
    .poll(
      async () => {
        const dump = await adb('shell', 'dumpsys', 'window', 'windows');
        const blocks = dump.split(/(?=\s*Window #\d+ Window\{)/);
        const own = blocks.find((block) =>
          /Window #\d+ Window\{[^\n]*com\.tmg\.tv\/[^\n]*MainActivity/.test(block),
        );
        if (!own) return false;
        const line = own
          .split('\n')
          .find((line) =>
            /mRequestedVisibleTypes=|mRequestedVisibilities:|Requested visibilities:/.test(line),
          );
        if (!line) return false;
        const parsed = parseRequestedBars(line);
        if (!parsed) return false;
        const { statusVisible, navigationVisible } = parsed;
        captured = {
          statusVisible,
          navigationVisible,
          requestedFullscreen: fullscreen,
          evidence: line.trim().slice(0, 512),
        };
        return statusVisible === !fullscreen && navigationVisible === !fullscreen;
      },
      {
        timeout: 5000,
        message: 'Native own-window requested system-bar flags must match fullscreen',
      },
    )
    .toBe(true);
  return captured;
}
async function pauseAndExit() {
  if (page && (await page.locator('#playback-status').textContent()) === 'Playing')
    await page.locator('#pause-button').click();
  await shutdown();
}
try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw new Error('Approved device mismatch');
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  apkPath = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!apkPath || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(apkPath))
    throw new Error('APK path unavailable');
  report.apkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
  if (report.apkSha256 !== expectedApk) throw new Error('Exact installed APK mismatch');
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  await launch();
  original = await invoke('read_record_pair');
  if (!original.catalog || !original.preferences)
    throw new Error('Original canonical pair required');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`${origin}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await page.locator('#search').fill(name);
  await page.locator('#search').press('Tab');
  const imported = await invoke('read_record_pair');
  const channel = JSON.parse(imported.catalog).channels.find(
    (channel) => channel.name === `${name} A`,
  );
  if (!channel) throw new Error('Actual UI canonical fixture import missing');
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  await page.getByRole('button', { name: new RegExp(`${name} A`) }).click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
  const sample = () =>
    page.locator('#video').evaluate((video) => {
      const quality = video.getVideoPlaybackQuality?.();
      return {
        mediaTime: video.currentTime,
        total: quality?.totalVideoFrames,
        dropped: quality?.droppedVideoFrames,
        presented: quality ? quality.totalVideoFrames - quality.droppedVideoFrames : null,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
      };
    });
  const progress = async () => {
    await expect
      .poll(async () => (await sample()).mediaTime, { timeout: 15000 })
      .toBeGreaterThan(1);
    const before = await sample();
    await wait(500);
    const after = await sample();
    if (!Number.isSafeInteger(before.presented) || !Number.isSafeInteger(after.presented)) {
      report.status = 'UNSUPPORTED';
      throw new Error(
        'Actual decoder-quality counters unavailable; no alternate or synthetic evidence',
      );
    }
    expect(after.presented).toBeGreaterThan(before.presented);
    expect(after.mediaTime).toBeGreaterThan(before.mediaTime);
    expect(after.width).toBeGreaterThan(0);
    expect(after.height).toBeGreaterThan(0);
    expect(after.paused).toBe(false);
    return { before, after };
  };
  const requestCount = () => ({ catalog: requests, media: fixture.stats().totalRequests });
  report.initialDecode = await progress();
  originalDisplay = {
    accelerometer_rotation: await adb(
      'shell',
      'settings',
      'get',
      'system',
      'accelerometer_rotation',
    ),
    user_rotation: await adb('shell', 'settings', 'get', 'system', 'user_rotation'),
  };
  if (
    !/^(?:null|[01])$/.test(originalDisplay.accelerometer_rotation) ||
    !/^(?:null|[0-3])$/.test(originalDisplay.user_rotation)
  )
    throw new Error('Display settings snapshot unsupported; no settings changed');
  report.originalDisplaySettings = originalDisplay;
  await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  report.cycles = [];
  let naturalLandscape;
  for (let cycle = 0; cycle < 6; cycle++) {
    const rotation = cycle % 2;
    const entry = { cycle: cycle + 1, rotation };
    report.cycles.push(entry);
    await adb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    if (naturalLandscape !== undefined) {
      await expect
        .poll(async () => {
          const viewport = await geometry();
          return viewport.width > viewport.height;
        })
        .toBe(rotation === 0 ? naturalLandscape : !naturalLandscape);
    } else {
      await wait(500);
      const viewport = await geometry();
      naturalLandscape = viewport.width > viewport.height;
    }
    entry.viewport = await geometry();
    entry.orientation = entry.viewport.width > entry.viewport.height ? 'landscape' : 'portrait';
    await hitboxes();
    await page.locator('#fullscreen-button').click();
    await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
    entry.fullscreenNative = await nativeInsets(true);
    entry.fullscreenGeometry = await geometry();
    entry.fullscreenControls = await hitboxes();
    entry.fullscreenDecode = await progress();
    await adb('shell', 'input', 'keyevent', '4');
    await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
    entry.backExitNative = await nativeInsets(false);
    await page.locator('#fullscreen-button').click();
    await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
    await nativeInsets(true);
    await page.locator('#fullscreen-button').click();
    await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
    entry.buttonExitNative = await nativeInsets(false);
    await page.locator('#fullscreen-button').click();
    await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
    await nativeInsets(true);
    const selected = `${name} ${cycle % 2 === 0 ? 'B' : 'A'}`;
    await page.getByRole('button', { name: new RegExp(selected) }).click();
    await expect(page.locator('#watch-title')).toHaveText(selected);
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    entry.changedChannelDecode = await progress();
    entry.channelChangeNative = await nativeInsets(true);
    await adb('shell', 'input', 'keyevent', '3');
    await expect(page.locator('#playback-status')).toHaveText('Paused', { timeout: 10000 });
    await expect.poll(() => fixture.stats().activeResponses).toBe(0);
    const quiet = requestCount();
    await wait(750);
    expect(requestCount()).toEqual(quiet);
    await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await wait(250);
    expect(requestCount()).toEqual(quiet);
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    entry.foregroundDecode = await progress();
    entry.foregroundNative = await nativeInsets(true);
    await adb('shell', 'input', 'keyevent', '4');
    await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
    entry.interruptExitNative = await nativeInsets(false);
    await page.screenshot({ path: path.join(directory, `cycle-${cycle + 1}.png`) });
  }
  expect(new Set(report.cycles.map((entry) => entry.orientation))).toEqual(
    new Set(['portrait', 'landscape']),
  );
  report.checks.push(
    'Six real rotation/fullscreen cycles across both actual WebView orientations, native system-bar flags, repeated Back/button exit, visible 44px control hit targets, actual decoded channel changes and explicit foreground resume',
  );
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.message ?? error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
} finally {
  const failed = (error) => {
    report.cleanupError = String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  };
  // Graceful shutdown disposes decoder and awaits its capture/queued writes before restoration.
  if (page) {
    try {
      await pauseAndExit();
    } catch (error) {
      failed(error);
    }
  }
  if (original) {
    try {
      await launch();
      const current = await invoke('read_record_pair');
      await invoke('write_record_pair', {
        catalog: original.catalog,
        preferences: original.preferences,
        health: original.health ?? JSON.stringify({ schemaVersion: 1, records: [] }),
        expectedCatalogRevision: current.catalogRevision,
        expectedHealthRevision: current.healthRevision,
      });
      const restored = await invoke('read_record_pair');
      expect(restored.catalog).toBe(original.catalog);
      expect(restored.preferences).toBe(original.preferences);
      expect(JSON.parse(restored.health).records).toEqual(
        original.health ? JSON.parse(original.health).records : [],
      );
      report.originalLogicalRecordsRestored = true;
      report.restoredMetadata = {
        catalogRevision: restored.catalogRevision,
        healthRevision: restored.healthRevision,
        initializedEmptyInsteadOfNull: original.health === null,
      };
    } catch (error) {
      failed(error);
    }
  }
  if (page) {
    try {
      await shutdown();
      report.nativeProcessExitConfirmed = true;
    } catch (error) {
      failed(error);
    }
  }
  if (originalDisplay) {
    try {
      for (const [key, value] of Object.entries(originalDisplay)) {
        if (value === 'null') await adb('shell', 'settings', 'delete', 'system', key);
        else await adb('shell', 'settings', 'put', 'system', key, value);
        expect(await adb('shell', 'settings', 'get', 'system', key)).toBe(value);
      }
      report.displaySettingsRestored = true;
    } catch (error) {
      failed(error);
    }
  }
  await browser?.close().catch(failed);
  if (forwardedPort) await adb('forward', '--remove', `tcp:${forwardedPort}`).catch(failed);
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(failed);
  if (apkPath) {
    report.finalApkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
    if (report.finalApkSha256 !== report.apkSha256) failed('Installed APK changed');
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fixture.close();
  await wait(30);
  report.fixtureAfterClose = fixture.stats();
  report.catalogSocketsAfterClose = sockets.size;
  if (
    report.fixtureAfterClose.activeSockets ||
    report.fixtureAfterClose.activeResponses ||
    report.fixtureAfterClose.timers ||
    sockets.size
  )
    failed('Fixture resources remain');
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, error: report.error }, null, 2));
}
