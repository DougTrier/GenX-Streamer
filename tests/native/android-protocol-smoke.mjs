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
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';

const serial = process.argv[2] ?? 'emulator-5556';
const physical = process.argv.includes('--physical-approved');
if (
  physical
    ? serial !== (process.env.GENX_APPROVED_FLIP_SERIAL ?? '')
    : !/^emulator-\d+$/.test(serial)
)
  throw new Error('Select an emulator or the explicitly approved Retroid Pocket Flip 2.');
const adbPath =
  process.env.TMG_ADB ?? path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const execute = promisify(execFile);
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const confirmNativeExit = async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await adb('shell', 'pidof', 'com.tmg.tv');
    } catch (error) {
      if (error.code === 1) return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Native Android process remained after shutdown');
};
const directory = path.resolve(
  'artifacts/android-protocol',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const ownedTag = `Owned Android Protocol ${Date.now()}`;
const fixtureDirectory = path.resolve('tests/fixtures/media/protocol');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const protocolFixture = JSON.parse(
  await readFile(path.join(fixtureDirectory, 'generation.json'), 'utf8'),
);
for (const item of protocolFixture.outputs)
  if (hash(await readFile(path.join(fixtureDirectory, item.name))) !== item.sha256)
    throw new Error('Protocol fixture hash mismatch');
const report = {
  status: 'FAIL',
  scope:
    'Installed approved Android actual AES-128 TS/fMP4 ranges and P07 native IPC; no microphone or receiver',
  serial,
  started: new Date().toISOString(),
  fixture: protocolFixture,
  checks: [],
  failures: [],
};
const fixture = await startFixtureServer();
const timers = new Set();
const server = http.createServer((request, response) => {
  if (request.url === '/429') {
    response.writeHead(429, { 'Retry-After': '7' });
    response.end();
  } else if (request.url === '/body') {
    response.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': '100',
    });
    response.write('#EXTM3U\n');
    const timer = setTimeout(() => response.end(), 30000);
    timers.add(timer);
    response.once('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  } else
    response.end(
      `#EXTM3U\n#EXTINF:-1,${ownedTag} encrypted TS\n${fixture.url}/protocol/aes/master.m3u8?fixture=owned\n#EXTINF:-1,${ownedTag} range fMP4\n${fixture.url}/protocol/range/index.m3u8?fixture=owned\n`,
    );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pem = (kind, bytes) =>
  `-----BEGIN ${kind}-----\n${bytes
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END ${kind}-----\n`;
const tlsServer = https.createServer(
  {
    cert: pem(
      'CERTIFICATE',
      await readFile('src-tauri/src/sharing/lan/fixtures/loopback-cert.der'),
    ),
    key: pem('PRIVATE KEY', await readFile('src-tauri/src/sharing/lan/fixtures/loopback-key.der')),
  },
  (_request, response) => response.end('#EXTM3U\n'),
);
await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
let browser, page, originalRecords, installedApk, forwardedPort;
const ports = [
  new URL(fixture.url).port,
  String(server.address().port),
  String(tlsServer.address().port),
];
try {
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (physical && report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw new Error('Approved device identity mismatch');
  installedApk = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!installedApk || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(installedApk))
    throw new Error('Installed APK path unavailable');
  report.apkSha256 = (await adb('shell', 'sha256sum', installedApk)).split(/\s/)[0];
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  if (!/^\d+$/.test(pid)) throw new Error('Application PID unavailable');
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!browser) throw new Error('Android CDP readiness timeout');
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('Installed application WebView unavailable');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  /* eslint-disable no-undef -- Invocations and decoder observations execute inside the packaged WebView. */
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  originalRecords = await invoke('read_record_pair');
  if (!originalRecords.catalog || !originalRecords.preferences)
    throw new Error('Existing canonical pair required for reversible proof');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`${origin}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await page.locator('#search').fill(ownedTag);
  await page.locator('#search').press('Tab');
  expect(
    JSON.parse((await invoke('read_record_pair')).catalog).channels.filter((channel) =>
      channel.name.startsWith(ownedTag),
    ),
  ).toHaveLength(2);
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  for (const title of [`${ownedTag} encrypted TS`, `${ownedTag} range fMP4`]) {
    const before = fixture.stats().protocolRequests.length;
    await page.getByRole('button', { name: new RegExp(title) }).click();
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
      second.time <= first.time + 0.1 ||
      second.paused
    )
      throw new Error('Protocol stream lacked media clock/dimension progression');
    let presented;
    if (second.frames <= first.frames) {
      presented = await page.locator('#video').evaluate(
        (video) =>
          new Promise((resolve) => {
            const samples = [];
            let callback;
            const timer = setTimeout(() => {
              if (callback !== undefined) video.cancelVideoFrameCallback(callback);
              resolve(samples);
            }, 5000);
            if (typeof video.requestVideoFrameCallback !== 'function') {
              clearTimeout(timer);
              resolve(samples);
              return;
            }
            const next = (_now, metadata) => {
              samples.push({
                presentedFrames: metadata.presentedFrames,
                time: video.currentTime,
                metadataTime: metadata.mediaTime,
              });
              if (samples.length === 3) {
                clearTimeout(timer);
                resolve(samples);
              } else callback = video.requestVideoFrameCallback(next);
            };
            callback = video.requestVideoFrameCallback(next);
          }),
      );
      report.lastPresented = presented;
      if (
        presented.length !== 3 ||
        presented[2].presentedFrames <= presented[0].presentedFrames ||
        presented[2].time <= presented[0].time
      )
        throw new Error('Actual Android frames did not advance');
    }
    const requests = fixture.stats().protocolRequests.slice(before);
    if (title.includes('encrypted')) {
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
      const init = protocolFixture.inputs.find((item) => item.name === 'init.mp4').bytes;
      const secondOffset =
        init + protocolFixture.inputs.find((item) => item.name === 'fmp4segment000.m4s').bytes;
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
    report.checks.push({ title, first, second, presented, requests });
    await page.screenshot({
      path: path.join(directory, title.includes('encrypted') ? 'aes.png' : 'range.png'),
    });
  }
  const failureCase = async (name, url, expected) => {
    let observation;
    try {
      await invoke('inspect_source', { url, allowHttp: true, requestId: `android-p07-${name}` });
    } catch (error) {
      const raw = String(error);
      const encoded = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      observation = JSON.parse(encoded);
    }
    report.failures.push({ name, observation });
    expect(observation).toMatchObject(expected);
  };
  await failureCase('tls', `https://127.0.0.1:${tlsServer.address().port}/private?token=fixture`, {
    category: 'tls-failure',
    phase: 'connect',
  });
  await failureCase('dns', 'http://does-not-exist.genx-fixture.invalid/private?token=fixture', {
    category: 'dns-failure',
    phase: 'connect',
  });
  await failureCase('busy', `${origin}/429`, {
    category: 'http',
    phase: 'headers',
    status: 429,
    retryAfter: '7',
  });
  await failureCase('body', `${origin}/body`, { category: 'timeout', phase: 'body' });
  report.speechCapabilities = await invoke('speech_capabilities');
  await invoke('speech_cancel', { requestId: 'android-proof-never-started' });
  report.microphoneOpened = false;
  report.status = 'PASS';
  /* eslint-enable no-undef */
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
} finally {
  const cleanupFailure = (error) => {
    report.cleanupError = String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  };
  if (page) {
    /* eslint-disable no-undef -- Cleanup executes only inside the owned native application. */
    const invoke = (command, args = {}) =>
      page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
        command,
        args,
      });
    try {
      if (originalRecords?.catalog && originalRecords?.preferences) {
        const current = await invoke('read_record_pair');
        await invoke('write_record_pair', {
          catalog: originalRecords.catalog,
          preferences: originalRecords.preferences,
          health: originalRecords.health ?? JSON.stringify({ schemaVersion: 1, records: [] }),
          expectedCatalogRevision: current.catalogRevision,
          expectedHealthRevision: current.healthRevision,
        });
        await page.reload();
        await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
        const restored = await invoke('read_record_pair');
        expect(restored.catalog).toBe(originalRecords.catalog);
        expect(restored.preferences).toBe(originalRecords.preferences);
        expect(JSON.parse(restored.health).records).toEqual(
          originalRecords.health ? JSON.parse(originalRecords.health).records : [],
        );
        report.restoreMetadata = {
          catalogRevision: restored.catalogRevision,
          healthRevision: restored.healthRevision,
          initializedEmptyInsteadOfNull: originalRecords.health === null,
        };
        report.originalRecordsRestored = true;
      }
      let timer;
      await Promise.race([
        invoke('request_exit'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native shutdown timeout')), 5000);
        }),
      ])
        .catch(async (error) => {
          if (!/Target page, context or browser has been closed/.test(String(error))) throw error;
          try {
            const pid = await adb('shell', 'pidof', 'com.tmg.tv');
            if (pid) throw error;
          } catch (processError) {
            if (processError.code !== 1) throw processError;
          }
        })
        .finally(() => clearTimeout(timer));
      report.nativeProcessExitConfirmed = await confirmNativeExit();
    } catch (error) {
      cleanupFailure(error);
    }
    /* eslint-enable no-undef */
  }
  await browser?.close().catch(cleanupFailure);
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(cleanupFailure);
  if (forwardedPort) await adb('forward', '--remove', `tcp:${forwardedPort}`).catch(cleanupFailure);
  if (installedApk) {
    try {
      report.finalApkSha256 = (await adb('shell', 'sha256sum', installedApk)).split(/\s/)[0];
      if (report.finalApkSha256 !== report.apkSha256) cleanupFailure('APK changed during proof');
    } catch (error) {
      cleanupFailure(error);
    }
  }
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await fixture.close();
  tlsServer.closeAllConnections();
  await new Promise((resolve) => tlsServer.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.fixtureAfterClose = fixture.stats();
  if (
    report.fixtureAfterClose.activeResponses ||
    report.fixtureAfterClose.activeSockets ||
    report.fixtureAfterClose.timers
  )
    cleanupFailure('Fixture retained resources after owned shutdown');
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
