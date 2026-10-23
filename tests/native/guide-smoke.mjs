import { openSourceImport } from './settings-navigation-helper.mjs';
import { saveCompletedSourceScan } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';

const executable = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/native-guide',
  new Date().toISOString().replaceAll(':', '-'),
);
const data = path.join(directory, 'data');
await mkdir(data, { recursive: true });
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
  scope: 'Packaged Windows native guide UI and IPC',
  executable,
  sha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
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
      `#EXTM3U\n#EXTINF:-1 tvg-id="fox" group-title="News",Owned guide Fox\n${fixture.url}/hls/live.m3u8\n#EXTINF:-1 tvg-id="sports" group-title="Sports",Owned guide Sports\n${fixture.url}/hls/live.m3u8\n`,
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
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
try {
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.on('error', (error) => {
    report.launchError = error.message;
  });
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.exitCode !== null) throw new Error('Owned application exited before readiness');
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
  if (!endpoint) throw new Error('Native CDP readiness timeout');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
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
  report.speechCapabilities = await invoke('speech_capabilities');
  expect(report.speechCapabilities).toEqual({
    platform: 'windows',
    onDeviceAvailable: true,
    serviceAvailable: false,
    permissionGranted: true,
    cloudConsentRequired: true,
  });
  await invoke('speech_cancel', { requestId: 'packaged-never-started-speech' });
  const voiceButton = page.getByRole('button', { name: 'Voice search', exact: true });
  await expect(voiceButton).toBeVisible();
  await expect(voiceButton).toHaveAttribute('data-state', 'idle');
  await expect(voiceButton).toHaveAttribute('aria-pressed', 'false');
  report.speechScope = 'Capability probe and cancellation only; microphone never started';
  const network = await invoke('cast_network_scope');
  expect(Number.isSafeInteger(network.generation)).toBe(true);
  expect(network.generation).toBeGreaterThanOrEqual(0);
  expect(network.scopeId).toEqual(expect.any(String));
  expect(['interfaces-and-routes', 'interfaces-only']).toContain(network.observation);
  report.receiverNetwork = network;
  report.receiverRefusals = {
    unknownSelection: await reject(
      invoke('cast_validate_receiver', {
        deviceId: 'unissued-packaged-fixture',
        expectedNetwork: network,
        allowUnverifiedIdentity: false,
      }),
      /cast-receiver-expired-rediscover/,
    ),
    rawStart: await reject(
      invoke('cast_start', {
        deviceId: 'unissued-packaged-fixture',
        sessionId: 'packaged-negative-session',
        selection: {
          id: 'never-loaded',
          name: 'Never loaded',
          url: 'https://example.com/never-requested.m3u8',
          contentType: 'application/vnd.apple.mpegurl',
        },
        allowHttp: false,
        allowHttpReceiver: false,
      }),
      /cast-issued-handle-expired-revalidate/,
    ),
    loopback: await reject(
      invoke('cast_register_receiver', { address: '127.0.0.1', name: 'Refused loopback' }),
      /cast-known-receiver-invalid/,
    ),
  };
  report.checks.push(
    'Packaged local speech capabilities and cancellation without opening microphone',
    'Opaque network scope and unknown/raw/loopback receiver refusals; no discovery or LOAD',
  );
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`${guideOrigin}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  await page.locator('#mute-button').click();
  await page
    .locator('button[data-channel]')
    .filter({ hasText: /Owned guide Fox/ })
    .first()
    .click();
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
  if (report.initialDecode.frames < 2) throw new Error('Actual decoder proof absent');
  const records = await invoke('read_record_pair');
  const catalog = JSON.parse(records.catalog);
  const fox = catalog.channels.find((channel) => channel.name === 'Owned guide Fox');
  const sports = catalog.channels.find((channel) => channel.name === 'Owned guide Sports');
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
  await expect(dialog).toContainText('No guide configured. Add an online XMLTV source or file.');
  await dialog.getByLabel('Guide view', { exact: true }).selectOption('sources');
  await dialog.getByLabel('Guide source task', { exact: true }).selectOption('add');
  await expect(dialog.getByLabel('Guide source name', { exact: true })).toBeVisible();
  await dialog.getByLabel('Guide source name', { exact: true }).fill('Owned online fixture');
  await dialog.getByLabel('Online XMLTV URL', { exact: true }).fill(`${guideOrigin}/double`);
  await dialog.getByLabel('Allow HTTP for this guide source', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save source and preview', exact: true }).click();
  await expect(dialog).toContainText('1 guide channels \u00b7 2 programs', { timeout: 20000 });
  await dialog.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
  await expect
    .poll(async () => {
      const saved = (await invoke('guide_sources')).find(
        (source) => source.name === 'Owned online fixture',
      );
      return saved ? (await invoke('guide_coverage', { sourceId: saved.id })).programCount : 0;
    })
    .toBe(2);
  let sources = await invoke('guide_sources');
  const online = sources.find((source) => source.name === 'Owned online fixture');
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
  expect(await invoke('guide_mappings')).toEqual([]);
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
  const file = await invoke('guide_save_source', {
    source: {
      id: 'owned-file',
      name: 'Owned file fixture',
      location: 'fixture.data',
      kind: 'file',
      allowHttp: false,
      revision: 0,
      updatedMs: null,
    },
    expectedRevision: 0,
  });
  const previewFile = (requestId) =>
    page.evaluate(
      ({ text, requestId }) =>
        window.__TAURI_INTERNALS__.invoke(
          'guide_preview_file',
          new TextEncoder().encode(text).buffer,
          { headers: { 'x-genx-guide-source': 'owned-file', 'x-genx-guide-request': requestId } },
        ),
      { text: fileXml, requestId },
    );
  const filePreview = await previewFile('owned-file-preview');
  await invoke('guide_commit', {
    ticket: filePreview.ticket,
    expectedRevision: file.revision,
    allowEmpty: false,
  });
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
    appChannelIds: [],
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
    'Raw binary file preview, two-source seven-day NFKC token search and visible guide search',
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
      id: 'owned-slow',
      name: 'Slow fixture',
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
    report.finalDecode.frames <= report.initialDecode.frames ||
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
  const database = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
  try {
    report.sqlite = {
      schema: database.prepare('PRAGMA user_version').get().user_version,
      programs: database.prepare('SELECT count(*) AS count FROM guide_program').get().count,
      mappings: database.prepare('SELECT count(*) AS count FROM guide_mapping').get().count,
      integrity: database.prepare('PRAGMA quick_check').get().quick_check,
    };
  } finally {
    database.close();
  }
  if (
    report.sqlite.schema !== 5 ||
    report.sqlite.programs !== 3 ||
    report.sqlite.mappings !== 2 ||
    report.sqlite.integrity !== 'ok'
  )
    throw new Error('Canonical guide SQLite evidence mismatch');
  report.checks.push('Guide publication persists in native SQLite v5 while catalog remains intact');
  await page.locator('#guide-button').click();
  await page.screenshot({ path: path.join(directory, 'native-guide.png') });
  report.status = 'PASS';
  /* eslint-enable no-undef */
} catch (error) {
  report.error = String(error.message ?? error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (page) {
    /* eslint-disable no-undef -- Shutdown applies only to this isolated test-owned application. */
    let exitTimer;
    await Promise.race([
      page.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit')).catch(() => undefined),
      new Promise((resolve) => {
        exitTimer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(exitTimer);
    /* eslint-enable no-undef */
  }
  await browser?.close().catch(() => undefined);
  if (app && app.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000);
      app.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  if (app && app.exitCode === null) {
    app.kill();
    report.cleanupError = 'Owned application did not exit after native shutdown';
    report.status = 'FAIL';
    process.exitCode = 1;
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
  ) {
    report.cleanupError = 'Fixture retained resources after owned native shutdown';
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
