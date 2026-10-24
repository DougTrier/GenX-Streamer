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
import { gzipSync } from 'node:zlib';
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
  'artifacts/android-guide',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const ownedTag = `Android guide fixture ${Date.now()}`;
let ownedFileId = `android-guide-file-${Date.now()}`;
const ownedSlowId = `android-guide-slow-${Date.now()}`;
const seedTime = Math.floor(Date.now() / 60000) * 60000;
const timestamp = (time) =>
  new Date(time)
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14) + ' +0000';
const day = 86400000;
const sourceXml = `<tv><channel id="fox"><display-name>Fixture Fox guide</display-name></channel><programme channel="fox" start="${timestamp(seedTime - 3600000)}" stop="${timestamp(seedTime + 3600000)}"><title>Fox current live</title></programme><programme channel="fox" start="${timestamp(seedTime + day)}" stop="${timestamp(seedTime + day + 3600000)}"><title>Chicago Bears tomorrow</title><desc>Football versus Packers</desc></programme></tv>`;
const fileXml = `<tv><channel id="sports"><display-name>Fixture Sports guide</display-name></channel><programme channel="sports" start="${timestamp(seedTime + 2 * day)}" stop="${timestamp(seedTime + 2 * day + 3600000)}"><title>Sunday Football</title><desc>Chicago Bears versus Lions</desc></programme></tv>`;
const report = {
  status: 'FAIL',
  scope: `Installed Android ${physical ? 'physical Retroid Pocket Flip 2' : 'emulator'} guide UI and native IPC`,
  serial,
  started: new Date().toISOString(),
  fixtureSeed: 'guide-current-double-gzip-seven-day-two-feed-v1',
  seedTime,
  checks: [],
};
const fixture = await startFixtureServer();
const timers = new Set();
let guideOrigin;
const server = http.createServer((request, response) => {
  if (request.url === '/catalog') {
    response.end(
      `#EXTM3U\n#EXTINF:-1 tvg-id="fox" group-title="News",${ownedTag} Fox\n${fixture.url}/hls/live.m3u8\n#EXTINF:-1 tvg-id="sports" group-title="Sports",${ownedTag} Sports\n${fixture.url}/hls/live.m3u8\n`,
    );
  } else if (request.url === '/double') {
    const bytes = gzipSync(gzipSync(sourceXml));
    response.setHeader('Content-Encoding', 'gzip');
    response.end(bytes);
  } else if (request.url === '/slow') {
    response.write('<tv>');
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.end('</tv>');
    }, 30000);
    timers.add(timer);
    response.once('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  } else response.end('<tv><programme>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
guideOrigin = `http://127.0.0.1:${server.address().port}`;
let browser, page, originalRecords, installedApk, forwardedPort;
const ports = [new URL(fixture.url).port, String(server.address().port)];
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
  const reject = async (promise, pattern) => {
    let reason;
    try {
      await promise;
    } catch (error) {
      reason = String(error);
    }
    if (!reason || !pattern.test(reason))
      throw new Error('Expected native guide refusal was absent');
    return reason;
  };
  originalRecords = await invoke('read_record_pair');
  if (!originalRecords.catalog || !originalRecords.preferences)
    throw new Error('Existing canonical pair required for reversible proof');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`${guideOrigin}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  await page.locator('#search').fill(ownedTag);
  await page.locator('#search').press('Tab');
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  await page.getByRole('button', { name: `${ownedTag} Fox`, exact: false }).click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
  await expect
    .poll(() => page.evaluate(() => document.getElementById('video').currentTime), {
      timeout: 20000,
    })
    .toBeGreaterThan(1);
  const frames = () =>
    page.evaluate(() => {
      const video = document.getElementById('video');
      return {
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        time: video.currentTime,
        width: video.videoWidth,
      };
    });
  report.initialDecode = await frames();
  if (report.initialDecode.frames < 2) {
    report.presentedFrames = await page.locator('#video').evaluate(
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
            samples.push({ presentedFrames: metadata.presentedFrames, time: video.currentTime });
            if (samples.length >= 3) {
              clearTimeout(timer);
              resolve(samples);
            } else callback = video.requestVideoFrameCallback(next);
          };
          callback = video.requestVideoFrameCallback(next);
        }),
    );
    const seen = report.presentedFrames;
    if (
      seen.length < 3 ||
      seen[2].presentedFrames <= seen[0].presentedFrames ||
      seen[2].time <= seen[0].time
    )
      throw new Error('Actual decoded progression absent');
  }
  const records = await invoke('read_record_pair');
  const catalog = JSON.parse(records.catalog);
  const fox = catalog.channels.find((channel) => channel.name === `${ownedTag} Fox`);
  const sports = catalog.channels.find((channel) => channel.name === `${ownedTag} Sports`);
  if (!fox || !sports) throw new Error('Fixture catalog channel identities missing');
  report.catalogIdentity = { fox: fox.id, sports: sports.id, source: fox.sourceId };
  fox.geography = { country: 'US', region: 'AMER', state: 'US-IL' };
  fox.geographyProvenance = [
    { field: 'country', value: 'US', sourceId: fox.sourceId, kind: 'user', scope: 'user-reviewed' },
    {
      field: 'state',
      value: 'US-IL',
      sourceId: fox.sourceId,
      kind: 'user',
      scope: 'user-reviewed',
    },
  ];
  await invoke('write_record_pair', {
    catalog: JSON.stringify(catalog),
    preferences: records.preferences,
  });
  await page.locator('#guide-button').click();
  const dialog = page.getByRole('dialog', { name: 'Program guide', exact: true });
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('sources');
  await dialog.getByLabel('Guide source task', { exact: true }).selectOption('add');
  await expect(dialog.getByLabel('Guide source name', { exact: true })).toBeVisible();
  await dialog.getByLabel('Guide source name', { exact: true }).fill(ownedTag);
  await dialog.getByLabel('Online XMLTV URL', { exact: true }).fill(`${guideOrigin}/double`);
  await dialog.getByLabel('Allow HTTP for this guide source', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save source and preview', exact: true }).click();
  await expect(dialog).toContainText('1 guide channels \u00b7 2 programs', { timeout: 20000 });
  await dialog.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
  await expect
    .poll(async () => {
      const saved = (await invoke('guide_sources')).find((source) => source.name === ownedTag);
      return saved ? (await invoke('guide_coverage', { sourceId: saved.id })).programCount : 0;
    })
    .toBe(2);
  let sources = await invoke('guide_sources');
  const online = sources.find((source) => source.name === ownedTag);
  const firstCoverage = await invoke('guide_coverage', { sourceId: online.id });
  const suggestion = await invoke('guide_suggest_mapping', {
    query: {
      guideSourceId: online.id,
      expectedSourceRevision: online.revision,
      expectedPublishedRevision: firstCoverage.publishedRevision,
      providerId: 'fox',
      name: 'Owned guide Fox',
    },
  });
  expect(suggestion).toMatchObject({
    cacheStatus: 'current',
    match: 'provider-id',
    candidateCount: 1,
    reviewRequired: true,
    previewComplete: true,
  });
  expect(suggestion.candidatesPreview[0].xmltvChannelId).toBe('fox');
  expect(
    (await invoke('guide_mappings')).filter((mapping) => mapping.guideSourceId === online.id),
  ).toEqual([]);
  report.indexedSuggestion = suggestion;
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('mapping');
  await dialog.getByLabel('Mapping guide source', { exact: true }).selectOption(online.id);
  await dialog.getByRole('button', { name: 'Find guide channels', exact: true }).click();
  await expect(dialog.getByLabel('Mapping guide channel', { exact: true })).toContainText(
    'Fixture Fox guide',
  );
  await dialog.getByLabel('Mapping guide channel', { exact: true }).selectOption('fox');
  await dialog.getByRole('button', { name: 'Map selected channel', exact: true }).click();
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('channel');
  await expect(dialog).toContainText('Now: Fox current live');
  report.checks.push(
    'UI source configuration, double-gzip preview, reviewed atomic commit and explicit mapping',
  );
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('sources');
  await dialog.getByLabel('Guide source task', { exact: true }).selectOption('add');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  await dialog.getByRole('button', { name: 'Choose XMLTV file', exact: true }).click();
  const chooser = await chooserPromise;
  const uploadedFile = Buffer.from('<!--' + 'x'.repeat(65536) + '-->' + fileXml, 'utf8');
  await chooser.setFiles({
    name: `${ownedTag} file.xml`,
    mimeType: 'application/xml',
    buffer: uploadedFile,
  });
  await expect(dialog).toContainText(
    'Guide file selected. Preview it before saving schedule data.',
  );
  await dialog.getByRole('button', { name: 'Save source and preview', exact: true }).click();
  await expect(dialog).toContainText('1 guide channels · 1 programs', { timeout: 20000 });
  await dialog.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
  const file = (await invoke('guide_sources')).find(
    (source) => source.name === `${ownedTag} file.xml`,
  );
  expect(file?.kind).toBe('file');
  ownedFileId = file.id;
  await expect
    .poll(async () => (await invoke('guide_coverage', { sourceId: file.id })).programCount)
    .toBe(1);
  report.fileFrontend = {
    picker: 'actual input file chooser via CDP',
    bytes: uploadedFile.length,
    transport: 'shared Android sequential chunk adapter',
    programCount: 1,
  };
  const previewFile = (requestId) =>
    page.evaluate(
      async ({ text, requestId, sourceId }) => {
        const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
        const bytes = new TextEncoder().encode(' '.repeat(65536) + text);
        const admission = await invoke('guide_file_begin', {
          sourceId,
          requestId,
          totalBytes: bytes.length,
        });
        try {
          for (let offset = 0; offset < bytes.length; offset += admission.chunkBytes) {
            const chunk = bytes.slice(offset, offset + admission.chunkBytes);
            const progress = await invoke('guide_file_append', {
              uploadId: admission.uploadId,
              offset,
              bytes: Array.from(chunk),
            });
            if (progress.receivedBytes !== offset + chunk.length)
              throw new Error('Guide upload offset acknowledgement mismatch');
          }
          return await invoke('guide_file_finish', { uploadId: admission.uploadId });
        } finally {
          await invoke('guide_file_discard', { uploadId: admission.uploadId });
        }
      },
      { text: fileXml, requestId, sourceId: ownedFileId },
    );
  await invoke('guide_save_mapping', {
    mapping: {
      catalogSourceId: sports.sourceId,
      appChannelId: sports.id,
      guideSourceId: file.id,
      xmltvChannelId: 'sports',
    },
  });
  const query = {
    guideSourceId: '',
    appChannelIds: [fox.id, sports.id],
    windowStartMs: seedTime,
    windowEndMs: seedTime + 7 * day,
    search: '\uFF23\uFF28\uFF29\uFF23\uFF21\uFF27\uFF2F Bears',
    pageSize: 1,
    cursor: null,
  };
  const first = await invoke('guide_programs', { query });
  const next = await invoke('guide_programs', { query: { ...query, cursor: first.nextCursor } });
  if (
    first.programs.length !== 1 ||
    next.programs.length !== 1 ||
    first.programs[0].guideSourceId === next.programs[0].guideSourceId
  )
    throw new Error('Global two-feed search/paging omitted a mapped result');
  report.search = [first.programs[0], next.programs[0]];
  await dialog.getByRole('button', { name: 'Close guide', exact: true }).click();
  await page.locator('#guide-button').click();
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('search');
  await dialog.getByText('Change program search', { exact: true }).click();
  await dialog.getByLabel('Find a program', { exact: true }).fill('Chicago Bears');
  await dialog.getByLabel('Find a program', { exact: true }).press('Tab');
  await expect(dialog.getByRole('list', { name: 'Guide programs', exact: true })).toContainText(
    'Chicago Bears tomorrow',
  );
  await expect(dialog.getByRole('list', { name: 'Guide programs', exact: true })).toContainText(
    'Sunday Football',
  );
  report.checks.push(
    'Bounded multi-chunk Android file preview, two-source seven-day NFKC token search and visible guide search',
  );
  sources = await invoke('guide_sources');
  const current = sources.find((source) => source.id === online.id);
  const before = await invoke('guide_coverage', { sourceId: online.id });
  const bad = await invoke('guide_save_source', {
    source: { ...current, location: `${guideOrigin}/bad`, updatedMs: null },
    expectedRevision: current.revision,
  });
  report.badRefreshError = await reject(
    invoke('guide_preview', { sourceId: bad.id, requestId: 'owned-bad-refresh' }),
    /Guide|guide|XML|xml/,
  );
  const after = await invoke('guide_coverage', { sourceId: online.id });
  if (
    after.programCount !== before.programCount ||
    after.publishedRevision !== before.publishedRevision ||
    after.sourceRevision === after.publishedRevision
  )
    throw new Error('Failed refresh did not retain explicitly stale prior data');
  const staleSuggestion = await invoke('guide_suggest_mapping', {
    query: {
      guideSourceId: bad.id,
      expectedSourceRevision: bad.revision,
      expectedPublishedRevision: after.publishedRevision,
      providerId: 'fox',
      name: 'Owned guide Fox',
    },
  });
  expect(staleSuggestion).toMatchObject({
    cacheStatus: 'stale',
    candidateCount: 0,
    reviewRequired: true,
  });
  const late = await previewFile('owned-late-cancel');
  await invoke('cancel_playlist', { requestId: 'owned-late-cancel' });
  await reject(
    invoke('guide_commit', {
      ticket: late.ticket,
      expectedRevision: late.sourceRevision,
      allowEmpty: false,
    }),
    /expired|canceled/,
  );
  const slow = await invoke('guide_save_source', {
    source: {
      id: ownedSlowId,
      name: `${ownedTag} slow`,
      location: `${guideOrigin}/slow`,
      kind: 'url',
      allowHttp: true,
      revision: 0,
      updatedMs: null,
    },
    expectedRevision: 0,
  });
  await page.evaluate(
    async ({ sourceId }) => {
      const pending = window.__TAURI_INTERNALS__.invoke('guide_preview', {
        sourceId,
        requestId: 'owned-slow-cancel',
      });
      setTimeout(
        () =>
          window.__TAURI_INTERNALS__.invoke('cancel_playlist', { requestId: 'owned-slow-cancel' }),
        100,
      );
      try {
        await pending;
        throw new Error('Cancellation failed');
      } catch (error) {
        if (!/canceled/.test(String(error))) throw error;
      }
    },
    { sourceId: slow.id },
  );
  await expect.poll(() => timers.size).toBe(0);
  report.checks.push(
    'Malformed refresh retains stale last-valid data; late ticket and streaming cancellation refuse publication',
  );
  report.finalDecode = await frames();
  if (
    (report.initialDecode.frames >= 2 &&
      report.finalDecode.frames <= report.initialDecode.frames) ||
    report.finalDecode.time <= report.initialDecode.time
  )
    throw new Error('Guide work interrupted actual decoder progress');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const reloadedCatalog = JSON.parse((await invoke('read_record_pair')).catalog);
  const reloadedFox = reloadedCatalog.channels.find((channel) => channel.id === fox.id);
  expect(reloadedFox.geography).toEqual(fox.geography);
  expect(reloadedFox.geographyProvenance).toEqual(fox.geographyProvenance);
  const persisted = await invoke('guide_programs', { query });
  if (persisted.programs.length !== 1)
    throw new Error('Native guide persistence missing after WebView reload');
  report.nativePersistence = {
    scope: 'IPC reload; no live SQLite file copy',
    onlineCoverage: await invoke('guide_coverage', { sourceId: online.id }),
    fileCoverage: await invoke('guide_coverage', { sourceId: file.id }),
  };
  expect(report.nativePersistence.onlineCoverage.programCount).toBe(2);
  expect(report.nativePersistence.fileCoverage.programCount).toBe(1);
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await page.locator('#guide-button').click();
  await page.screenshot({ path: path.join(directory, 'native-guide.png') });
  const screen = await execute(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    timeout: 15000,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(path.join(directory, 'native-guide-screen.png'), screen.stdout);
  await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
  report.checks.push(
    'Back closes Guide before native fullscreen; guide/geography survive IPC reload',
  );
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
      const sources = await invoke('guide_sources');
      const ownedSources = sources.filter(
        (source) =>
          source.name === ownedTag || source.id === ownedFileId || source.id === ownedSlowId,
      );
      const ownedIds = new Set(ownedSources.map((source) => source.id));
      for (const mapping of (await invoke('guide_mappings')).filter((mapping) =>
        ownedIds.has(mapping.guideSourceId),
      ))
        await invoke('guide_remove_mapping', {
          catalogSourceId: mapping.catalogSourceId,
          appChannelId: mapping.appChannelId,
        });
      for (const source of ownedSources)
        await invoke('guide_remove_source', { id: source.id, expectedRevision: source.revision });
    } catch (error) {
      cleanupFailure(error);
    }
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
