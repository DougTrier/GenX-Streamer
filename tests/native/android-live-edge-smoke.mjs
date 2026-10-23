import { saveCompletedSourceScan } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { startLiveEdgeFixture } from './live-edge-fixture.mjs';
import path from 'node:path';

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
  'artifacts/android-live-edge',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const name = `Owned live edge ${Date.now()}`;
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  serial,
  scope:
    'Physical Flip2 expired moving-live-window recovery after twenty-five seconds Home; actual seekable edge and decoder progress, originals restored',
  checks: [],
};
const fixture = await startLiveEdgeFixture();
const sockets = new Set();
let requests = 0;
const server = http.createServer((_request, response) => {
  requests++;
  response.setHeader('Content-Type', 'application/x-mpegurl');
  response.end(`#EXTM3U\n#EXTINF:-1 group-title="Fixture",${name}\n${fixture.url}/hls/live.m3u8\n`);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const ports = [String(server.address().port), new URL(fixture.url).port];
let browser, page, forwardedPort, original, apkPath;
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
  const channel = JSON.parse(imported.catalog).channels.find((channel) => channel.name === name);
  if (!channel) throw new Error('Actual UI canonical fixture import missing');
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
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
        seekable: Array.from({ length: video.seekable.length }, (_, index) => ({
          start: video.seekable.start(index),
          end: video.seekable.end(index),
        })),
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
  const beforeBackground = fixture.window();
  report.beforeBackground = beforeBackground;
  await adb('shell', 'input', 'keyevent', '3');
  await expect(page.locator('#playback-status')).toHaveText('Paused', { timeout: 10000 });
  // eslint-disable-next-line no-undef -- This callback executes inside the Android WebView.
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
  await expect.poll(() => fixture.stats().activeResponses).toBe(0);
  const stopped = requestCount();
  const backgroundStarted = Date.now();
  await wait(25000);
  expect(requestCount()).toEqual(stopped);
  report.backgroundDurationMilliseconds = Date.now() - backgroundStarted;
  report.resumeWindow = fixture.window();
  expect(report.resumeWindow.first - beforeBackground.first).toBeGreaterThanOrEqual(10);
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  // eslint-disable-next-line no-undef -- This callback executes inside the Android WebView.
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect(page.locator('#playback-status')).toHaveText('Paused');
  await wait(250);
  expect(requestCount()).toEqual(stopped);
  const resumedAt = Date.now();
  await page.locator('#pause-button').click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
  report.resumedDecode = await progress();
  const resumed = fixture.stats().requests.filter((entry) => entry.at >= resumedAt);
  const manifest = resumed.find((entry) => entry.path === '/hls/live.m3u8');
  const segment = resumed.find((entry) => entry.sequence !== null);
  if (!manifest || !segment) throw new Error('Fresh resume manifest and segment identity required');
  expect(manifest.first).toBeGreaterThanOrEqual(report.resumeWindow.first);
  expect(segment.sequence).toBeGreaterThanOrEqual(manifest.first);
  expect(segment.sequence).toBeLessThanOrEqual(segment.latest);
  const resumedSample = report.resumedDecode.after;
  const range = resumedSample.seekable.at(-1);
  if (!range) throw new Error('Actual decoder seekable range unavailable');
  expect(resumedSample.mediaTime).toBeGreaterThanOrEqual(range.start);
  expect(resumedSample.mediaTime).toBeLessThanOrEqual(range.end);
  const edgeGapSeconds = range.end - resumedSample.mediaTime;
  expect(edgeGapSeconds).toBeLessThanOrEqual(6);
  report.resumedWindowEvidence = { manifest, firstSegment: segment, range, edgeGapSeconds };
  await page.screenshot({ path: path.join(directory, 'resumed-live.png') });
  report.checks.push(
    'Real moving four-segment live window advanced beyond old media during twenty-five-second background; no requests/automatic resume; fresh current-window manifest and segment, actual seekable live edge and decoded-frame/time progression',
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
