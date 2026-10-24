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

import { createHash } from 'node:crypto';
import { chooseSettingsSection } from './settings-navigation-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
const directory = path.resolve(
  'artifacts/android-health',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const tag = `Owned health ${Date.now()}`;
const names = ['reachable', 'denied', 'missing', 'unselected'].map((item) => `${tag} ${item}`);
const report = {
  status: 'FAIL',
  serial,
  started: new Date().toISOString(),
  scope:
    'Physical Android reviewed reachability save and actual restart; no decoder, microphone or receiver claim',
  fixtureSeed: 'selected-http200-403-404-unselected-v1',
  requests: {},
  checks: [],
};
let origin;
const segmentBytes = await readFile(new URL('../fixtures/media/segment000.ts', import.meta.url));
report.segmentSha256 = createHash('sha256').update(segmentBytes).digest('hex');
const sockets = new Set();
let activeResponses = 0;
const server = http.createServer((request, response) => {
  const endpoint = new URL(request.url, 'http://fixture.invalid').pathname;
  report.requests[endpoint] = (report.requests[endpoint] ?? 0) + 1;
  activeResponses++;
  response.once('close', () => activeResponses--);
  if (endpoint === '/catalog') {
    response.setHeader('Content-Type', 'application/x-mpegurl');
    response.end(
      '#EXTM3U\n' +
        ['reachable', 'denied', 'missing', 'unselected']
          .map(
            (id, index) =>
              `#EXTINF:-1 tvg-id="${tag}-${id}" group-title="Fixture",${names[index]}\n${origin}/${id}\n`,
          )
          .join(''),
    );
  } else if (endpoint === '/reachable') {
    response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    response.end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nchecked-segment.ts\n#EXT-X-ENDLIST\n',
    );
  } else if (endpoint === '/checked-segment.ts') {
    response.setHeader('Content-Type', 'video/mp2t');
    response.end(segmentBytes);
  } else {
    response.statusCode = endpoint === '/denied' ? 403 : 404;
    response.end();
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixturePort = String(server.address().port);
origin = `http://127.0.0.1:${fixturePort}`;
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
async function action(value) {
  await page.getByLabel('Scan review action').selectOption(value);
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
}
async function savedRows() {
  await action('history');
  const list = page.getByLabel('Saved checks', { exact: true });
  await expect(list.locator('li').filter({ hasText: tag })).toHaveCount(3);
  const observations = [];
  for (const [index, status] of [
    [0, 'Stream responded'],
    [1, 'Access denied'],
    [2, 'Temporarily unavailable'],
  ]) {
    const row = list.locator('li').filter({ hasText: names[index] });
    await expect(row.locator('strong')).toHaveText(names[index]);
    await expect(row.locator('p').first()).toHaveText(`${status} · Recent check`);
    const timestamp = await row.locator('time').getAttribute('datetime');
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    await expect(row).toContainText('Android');
    const details = row.locator('details');
    await expect(details).not.toHaveAttribute('open', '');
    await row.getByText('Check details', { exact: true }).click();
    await expect(details).toHaveAttribute('open', '');
    const metadata = {};
    for (const label of [
      'Stream',
      'Check settings',
      'Platform',
      'Origin',
      'Exact check time',
      'Evidence',
    ]) {
      const term = details.locator('dt').filter({ hasText: new RegExp(`^${label}$`) });
      metadata[label] = await term.locator('xpath=following-sibling::dd[1]').textContent();
    }
    expect(metadata.Stream).toBe('Primary stream');
    expect(metadata['Check settings']).toBe(
      'reachability-v3/native-media-resources-v1/max-20000/sequential',
    );
    expect(metadata.Platform).toBe('android');
    expect(metadata.Origin).toBe('Local check');
    expect(metadata['Exact check time']).toBe(timestamp);
    expect(metadata.Evidence).toContain(`HTTP ${[200, 403, 404][index]}`);
    expect(metadata.Evidence).toContain('playback was not tested');
    observations.push({
      name: names[index],
      summary: `${status} · Recent check`,
      timestamp,
      metadata,
    });
  }
  return observations;
}
try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw new Error('Approved device model mismatch');
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  apkPath = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!apkPath || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(apkPath))
    throw new Error('Installed APK path unavailable');
  report.apkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
  await adb('reverse', `tcp:${fixturePort}`, `tcp:${fixturePort}`);
  await launch();
  original = await invoke('read_record_pair');
  if (!original.catalog || !original.preferences)
    throw new Error('Existing canonical data required');
  report.initialHealth = {
    initialized: original.health !== null,
    recordCount: original.health ? JSON.parse(original.health).records.length : 0,
    catalogRevision: original.catalogRevision,
    healthRevision: original.healthRevision,
  };
  const beforeScanPair = await page.evaluate(() =>
    Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke('read_record_pair'),
  );
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`${origin}/catalog`);
  await page.locator('#load-button').click();
  const review = page.getByRole('dialog', { name: 'Review source scan', exact: true });
  await expect(
    review.getByRole('button', { name: 'Scan configured sources', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await review.locator('.scan-options > summary').click();
  await review.getByRole('checkbox', { name: 'Show all collected channels', exact: true }).check();
  await expect(page.getByLabel('Candidate channels').locator('li')).toHaveCount(4);
  for (const name of names.slice(0, 3))
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke('read_record_pair'),
    ),
  ).toEqual(beforeScanPair);
  expect(report.requests['/unselected']).toBe(1);
  expect(report.requests['/checked-segment.ts']).toBe(1);
  report.postScanRequests = { ...report.requests };
  // Automatic Scan already checked all four; selection controls only publication.
  await page.getByRole('checkbox', { name: `Select ${names[3]}`, exact: true }).uncheck();
  await expect(
    page.getByLabel('Candidate channels').locator('li').filter({ hasText: names[0] }),
  ).toContainText('Responded');
  await page.getByRole('button', { name: 'Save selected channels', exact: true }).click();
  await expect(page.getByText('Selected channels saved.', { exact: true })).toBeVisible();
  expect(report.requests).toEqual(report.postScanRequests);
  report.initialRows = await savedRows();
  const before = await invoke('read_record_pair');
  const ownedChannels = JSON.parse(before.catalog).channels.filter((channel) =>
    channel.name.startsWith(tag),
  );
  expect(ownedChannels).toHaveLength(3);
  const ids = new Set(ownedChannels.map((channel) => channel.id));
  report.observations = JSON.parse(before.health).records.filter((record) =>
    ids.has(record.channelId),
  );
  expect(report.observations).toHaveLength(3);
  expect(report.requests['/unselected']).toBe(1);
  expect(report.requests['/checked-segment.ts']).toBe(1);
  report.postScanRequests = { ...report.requests };
  await page.screenshot({ path: path.join(directory, 'before-restart.png') });
  const requestCounts = JSON.stringify(report.requests);
  await shutdown();
  await launch();
  const after = await invoke('read_record_pair');
  expect(after).toEqual(before);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'discovery');
  await page.getByRole('button', { name: 'Scan sources', exact: true }).click();
  report.restartedRows = await savedRows();
  expect(report.restartedRows).toEqual(report.initialRows);
  expect(JSON.stringify(report.requests)).toBe(requestCounts);
  await page.screenshot({ path: path.join(directory, 'after-restart.png') });
  report.checks.push(
    'Actual selected checks/save and restart preserve exact canonical snapshot and contextual observations without automatic probes',
  );
  report.status = 'PASS';
} catch (error) {
  report.error = /https?:\/\//i.test(String(error))
    ? 'URL-bearing assertion detail redacted'
    : String(error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
} finally {
  const failed = (error) => {
    report.cleanupError = String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  };
  if (page) {
    try {
      if (original) {
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
        report.restoreMetadata = {
          initializedEmptyInsteadOfNull: original.health === null,
          catalogRevision: restored.catalogRevision,
          healthRevision: restored.healthRevision,
          note: 'Revisions advance during reversible proof; null health becomes initialized empty, not bit-identical metadata restoration.',
        };
      }
      await shutdown();
      report.nativeProcessExitConfirmed = true;
    } catch (error) {
      failed(error);
    }
  }
  await browser?.close().catch(failed);
  if (forwardedPort) await adb('forward', '--remove', `tcp:${forwardedPort}`).catch(failed);
  await adb('reverse', '--remove', `tcp:${fixturePort}`).catch(failed);
  if (apkPath) {
    report.finalApkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
    if (report.finalApkSha256 !== report.apkSha256) failed('APK changed during proof');
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await wait(30);
  report.cleanup = { sockets: sockets.size, activeResponses };
  if (sockets.size || activeResponses) failed('Fixture resources remained');
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { directory, status: report.status, cleanup: report.cleanup, error: report.error },
      null,
      2,
    ),
  );
}
