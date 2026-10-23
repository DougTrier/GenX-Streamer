import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chooseSettingsSection } from './settings-navigation-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
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
  'artifacts/android-decoded-health',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const name = `Owned decoded ${Date.now()}`;
const profile = 'decoder-v1/html-video-quality-presented-v1';
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  serial,
  scope:
    'Physical Android actual selected decoder-quality PlayedHere persistence; no callback fallback, microphone or receiver',
  checks: [],
};
const fixture = await startFixtureServer();
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

async function recordFor(channelId) {
  const saved = await invoke('read_record_pair');
  return {
    saved,
    record: saved.health
      ? JSON.parse(saved.health).records.find(
          (r) =>
            r.channelId === channelId &&
            r.platform === 'android' &&
            r.observerProfile === profile &&
            r.checkedUrlOrdinal === 0,
        )
      : undefined,
  };
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
  // File fixture setup preserves the decoder-only health baseline; not Scan proof.
  report.catalogSetup = {
    route: 'ordinary-local-playlist-file',
    scope: 'Synthetic catalog setup; not URL Scan acceptance',
  };
  await importFixtureCatalogFile(page, `${origin}/catalog`);
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
      };
    });
  await expect.poll(async () => (await sample()).mediaTime, { timeout: 15000 }).toBeGreaterThan(2);
  const first = await sample();
  await wait(1200);
  const second = await sample();
  report.decoderSamples = [first, second];
  if (
    !Number.isSafeInteger(first.presented) ||
    !Number.isSafeInteger(second.presented) ||
    second.presented <= first.presented
  ) {
    report.status = 'UNSUPPORTED';
    report.captureUnsupported =
      'Decoder-quality presented counters did not advance; no alternate callback or synthetic evidence substituted';
    throw new Error(report.captureUnsupported);
  }
  expect(second.mediaTime).toBeGreaterThan(first.mediaTime);
  expect(second.width).toBeGreaterThan(0);
  expect(second.height).toBeGreaterThan(0);
  let captured;
  await expect
    .poll(
      async () => {
        captured = await recordFor(channel.id);
        return captured.record?.verdict;
      },
      { timeout: 20000 },
    )
    .toBe('PlayedHere');
  const record = captured.record;
  report.observation = record;
  expect(record.origin).toBe('local');
  expect(record.evidence.kind).toBe('decoded');
  expect(record.sourceId).toBe(channel.sourceId);
  expect(record.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(record.evidence.after.mediaTime).toBeGreaterThan(record.evidence.before.mediaTime);
  expect(record.evidence.after.decodedFrames).toBeGreaterThan(record.evidence.before.decodedFrames);
  expect(captured.saved.catalog).toBe(imported.catalog);
  expect(captured.saved.catalogRevision).toBe(imported.catalogRevision);
  await page.screenshot({ path: path.join(directory, 'observed.png') });
  await pauseAndExit();
  const counts = () => ({ catalog: requests, media: fixture.stats().totalRequests });
  const stoppedCounts = counts();
  await launch();
  await wait(500);
  const restarted = await recordFor(channel.id);
  expect(restarted.record).toEqual(record);
  expect(counts()).toEqual(stoppedCounts);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'discovery');
  await page.getByRole('button', { name: 'Scan sources', exact: true }).click();
  await page.getByLabel('Scan review action').selectOption('history');
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  const row = page
    .getByLabel('Saved checks', { exact: true })
    .locator('li')
    .filter({ hasText: name });
  await expect(row.locator('strong')).toHaveText(name);
  await expect(row.locator('p').first()).toContainText('Playback observed');
  await expect(row.locator('time')).toHaveAttribute(
    'datetime',
    new Date(record.observedAt).toISOString(),
  );
  expect(counts()).toEqual(stoppedCounts);
  report.restartCounts = stoppedCounts;
  await page.screenshot({ path: path.join(directory, 'restarted-history.png') });
  report.checks.push(
    'Actual quality total-minus-dropped/time progress saved as exact local PlayedHere and survives quiet same-data restart/history',
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
