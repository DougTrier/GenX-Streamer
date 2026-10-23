import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chooseSettingsSection, openSourceImport } from './settings-navigation-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';

const input = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/native-decoded-health',
  new Date().toISOString().replaceAll(':', '-'),
);
const data = path.join(directory, 'data');
await mkdir(data, { recursive: true });
const executable = path.join(directory, 'GenX-decoded-health-fixture.exe');
await copyFile(input, executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  scope:
    'Packaged Windows deliberately selected actual HLS decode, health-only publication and same-data restart',
  fixtureSeed: 'owned-live-hls-selected-one-unselected-v1',
  executableSha256: hash(await readFile(executable)),
  launchCount: 0,
  exitCount: 0,
  checks: [],
};
const fixture = await startFixtureServer();
const selectedUrl = fixture.url + '/hls/live.m3u8?owned=decoded-health';
let origin;
let catalogRequests = 0;
let unselectedRequests = 0;
let activeResponses = 0;
const sockets = new Set();
const server = http.createServer((request, response) => {
  activeResponses++;
  response.once('close', () => activeResponses--);
  if (request.url === '/catalog') {
    catalogRequests++;
    response.setHeader('Content-Type', 'application/x-mpegurl');
    response.end(
      '#EXTM3U\n#EXTINF:-1 tvg-id="selected" group-title="Fixture",Owned decoded channel\n' +
        selectedUrl +
        '\n#EXTINF:-1 tvg-id="unselected" group-title="Fixture",Owned unselected channel\n' +
        origin +
        '/unselected\n',
    );
  } else {
    unselectedRequests++;
    response.statusCode = 404;
    response.end();
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
let app, browser, page;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function launch() {
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  report.launchCount++;
  let launchError = false;
  app.on('error', () => {
    launchError = true;
  });
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (launchError || app.exitCode !== null)
      throw new Error('Owned packaged application did not launch.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const info = await response.json();
        endpoint = info.webSocketDebuggerUrl;
        report.webview = info.Browser;
        break;
      }
    } catch {}
    await wait(100);
  }
  if (!endpoint) throw new Error('Owned CDP endpoint readiness timed out.');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  page.setDefaultTimeout(20000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
}
async function shutdown() {
  const owned = app;
  if (page && owned?.exitCode === null) {
    /* eslint-disable no-undef -- Public native shutdown IPC in this test-owned packaged WebView. */
    await Promise.race([
      page.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit')).catch(() => undefined),
      wait(5000),
    ]);
    /* eslint-enable no-undef */
  }
  await browser?.close().catch(() => undefined);
  browser = undefined;
  page = undefined;
  if (owned && owned.exitCode === null) {
    await Promise.race([new Promise((resolve) => owned.once('exit', resolve)), wait(5000)]);
  }
  if (owned && owned.exitCode === null) {
    owned.kill();
    await Promise.race([new Promise((resolve) => owned.once('exit', resolve)), wait(5000)]);
    throw new Error('Graceful owned application shutdown was not confirmed.');
  }
  if (owned) {
    report.exitCount++;
    if (owned.exitCode !== 0) throw new Error('Owned application exited unsuccessfully.');
  }
  app = undefined;
}

/* eslint-disable no-undef -- Actual public IPC/video observations execute inside the isolated packaged WebView. */
const pair = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('read_record_pair'));
const quality = () =>
  page.locator('#video').evaluate((video) => {
    const quality = video.getVideoPlaybackQuality();
    return {
      mediaTime: video.currentTime,
      decodedFrames: quality.totalVideoFrames - quality.droppedVideoFrames,
      total: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
      width: video.videoWidth,
      height: video.videoHeight,
      paused: video.paused,
      seeking: video.seeking,
    };
  });
/* eslint-enable no-undef */
function database() {
  const db = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT * FROM channel_health ORDER BY channel_id,url_ordinal,platform,observer_profile',
      )
      .all();
    return {
      schema: db.prepare('PRAGMA user_version').get().user_version,
      integrity: db.prepare('PRAGMA quick_check').get().quick_check,
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      channels: db.prepare('SELECT count(*) AS n FROM channel').get().n,
      sources: db.prepare('SELECT count(*) AS n FROM source').get().n,
      rows,
      metadata: db.prepare('SELECT catalog_revision,health_revision FROM metadata').get(),
    };
  } finally {
    db.close();
  }
}
async function history() {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'discovery');
  await page.getByRole('button', { name: 'Scan sources', exact: true }).click();
  await page.getByLabel('Scan review action').selectOption('history');
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  const row = page.getByLabel('Saved checks', { exact: true }).locator('li');
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveText('Owned decoded channel');
  await expect(row.locator('p').first()).toHaveText('Playback observed · Recent check');
  await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await row.locator('summary').click();
  await expect(row.locator('dl')).toBeVisible();
  await expect(row.locator('dl')).toContainText('decoder-v1/html-video-quality-presented-v1');
  await expect(row.locator('dl')).toContainText('Decoded');
  const text = await row.textContent();
  await row.locator('summary').click();
  await page.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await page.locator('#settings-dialog [data-close="settings-dialog"]').click();
  return text;
}
try {
  await launch();
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  // Ordinary file fixture setup preserves negative/decoder baselines; not Scan proof.
  report.catalogSetup = {
    route: 'ordinary-local-playlist-file',
    scope: 'Synthetic catalog setup; not URL Scan acceptance',
  };
  await importFixtureCatalogFile(page, origin + '/catalog');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.locator('#mute-button').click();
  await expect.poll(async () => JSON.parse((await pair()).preferences).muted).toBe(true);
  const baseline = await pair();
  expect(database().rows).toHaveLength(0);
  await page
    .locator('button[data-channel]')
    .filter({ hasText: 'Owned decoded channel' })
    .first()
    .click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 25000 });
  const first = await quality();
  await expect
    .poll(async () => (await quality()).mediaTime, { timeout: 20000 })
    .toBeGreaterThan(first.mediaTime + 1);
  const second = await quality();
  expect(second.decodedFrames).toBeGreaterThan(first.decodedFrames);
  expect(second.width).toBeGreaterThan(0);
  expect(second.height).toBeGreaterThan(0);
  await expect.poll(() => database().rows.length, { timeout: 20000 }).toBe(1);
  const saved = database();
  const record = saved.rows[0];
  const evidence = JSON.parse(record.evidence_json);
  // Decoded health arrived in schema 8; later schemas keep it.
  expect(saved.schema).toBeGreaterThanOrEqual(8);
  expect(saved.integrity).toBe('ok');
  expect(saved.foreignKeys).toHaveLength(0);
  expect(saved.channels).toBe(2);
  expect(saved.sources).toBe(1);
  expect(record).toMatchObject({
    url_ordinal: 0,
    platform: 'windows',
    observer_profile: 'decoder-v1/html-video-quality-presented-v1',
    origin: 'local',
    verdict: 'PlayedHere',
  });
  expect(evidence.kind).toBe('decoded');
  expect(evidence.after.mediaTime).toBeGreaterThan(evidence.before.mediaTime);
  expect(evidence.after.decodedFrames).toBeGreaterThan(evidence.before.decodedFrames);
  expect(evidence.elapsedMilliseconds).toBeGreaterThan(0);
  expect(evidence.elapsedMilliseconds).toBeLessThanOrEqual(120000);
  for (const sample of [evidence.before, evidence.after]) {
    expect(sample.width).toBeGreaterThan(0);
    expect(sample.height).toBeGreaterThan(0);
    expect(Number.isSafeInteger(sample.decodedFrames)).toBe(true);
  }
  const published = await pair();
  const catalog = JSON.parse(published.catalog);
  const channel = catalog.channels.find((channel) => channel.id === record.channel_id);
  const source = catalog.sources.find((source) => source.id === record.source_id);
  expect(channel.urls[record.url_ordinal]).toBe(selectedUrl);
  const expectedFingerprint = hash(
    JSON.stringify([
      'health-target-v1',
      source.id,
      source.kind,
      source.location,
      source.allowHttp === true,
      channel.id,
      record.url_ordinal,
      selectedUrl,
    ]),
  );
  expect(record.target_fingerprint).toBe(expectedFingerprint);
  expect(published.catalog).toBe(baseline.catalog);
  expect(published.preferences).toBe(baseline.preferences);
  expect(published.catalogRevision).toBe(baseline.catalogRevision);
  expect(Number(published.healthRevision)).toBe(Number(baseline.healthRevision) + 1);
  report.observedDecode = { first, second };
  report.persisted = saved;
  report.canonicalHashes = {
    catalog: hash(published.catalog),
    preferences: hash(published.preferences),
    selectedUrl: hash(selectedUrl),
  };
  report.checks.push(
    'Actual selected HLS frames/time produce one PlayedHere record, exact canonical primary ordinal and query-bearing URL fingerprint',
  );
  await wait(1500);
  expect((await quality()).decodedFrames).toBeGreaterThan(second.decodedFrames);
  expect((await pair()).healthRevision).toBe(published.healthRevision);
  await page.locator('#pause-button').click();
  await expect(page.locator('#playback-status')).toHaveText('Paused');
  const paused = await quality();
  await wait(1000);
  const afterPause = await quality();
  expect(paused.paused).toBe(true);
  expect(afterPause.paused).toBe(true);
  expect(Math.abs(afterPause.mediaTime - paused.mediaTime)).toBeLessThanOrEqual(0.1);
  expect((await pair()).healthRevision).toBe(published.healthRevision);
  expect(database().rows).toEqual(saved.rows);
  report.pause = { before: paused, after: afterPause };
  // Nothing plays the unselected channel; the quiet saved-channel check
  // (October 19, 2026) may check it once while nothing plays (at most a
  // manifest and one segment).
  expect(unselectedRequests).toBeLessThanOrEqual(2);
  report.unselectedChannelChecks = unselectedRequests;
  expect(catalogRequests).toBe(1);
  report.initialHistory = await history();
  await page.screenshot({ path: path.join(directory, 'paused-player.png') });
  report.checks.push(
    'Health-only save preserves catalog/preferences; repeated real frames and pause produce no further health revisions or unselected probes',
  );
  await shutdown();
  const before = await stat(path.join(data, 'genx.sqlite3'), { bigint: true });
  const counts = { catalogRequests, unselectedRequests, media: fixture.stats().totalRequests };
  await launch();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
  report.restartedHistory = await history();
  expect(report.restartedHistory).toBe(report.initialHistory);
  expect(database()).toEqual(saved);
  const restarted = await pair();
  expect(restarted.catalog).toBe(published.catalog);
  expect(restarted.preferences).toBe(published.preferences);
  expect(restarted.health).toBe(published.health);
  expect({ catalogRequests, unselectedRequests, media: fixture.stats().totalRequests }).toEqual(
    counts,
  );
  const after = await stat(path.join(data, 'genx.sqlite3'), { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.birthtimeNs).toBe(before.birthtimeNs);
  report.fileIdentity = {
    sameFile: true,
    inode: before.ino.toString(),
    createdNanoseconds: before.birthtimeNs.toString(),
  };
  report.checks.push(
    'Graceful same-data restart retains exact local decoder evidence and friendly saved history without auto-play or probes',
  );
  await page.screenshot({ path: path.join(directory, 'restarted-player.png') });
  report.status = 'PASS';
} catch (error) {
  report.error = /https?:\/\//i.test(String(error))
    ? 'Decoded health proof failed; URL-bearing details redacted.'
    : String(error.message ?? error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try {
    await shutdown();
  } catch {
    report.status = 'FAIL';
    report.cleanupError = 'Owned application shutdown unconfirmed.';
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fixture.close();
  await wait(20);
  report.fixtureAfterClose = fixture.stats();
  report.cleanup = {
    applicationExited: !app || app.exitCode !== null,
    catalogSockets: sockets.size,
    catalogActiveResponses: activeResponses,
    launches: report.launchCount,
    exits: report.exitCount,
  };
  if (
    sockets.size ||
    activeResponses ||
    report.fixtureAfterClose.activeSockets ||
    report.fixtureAfterClose.activeResponses ||
    report.fixtureAfterClose.timers ||
    report.launchCount !== report.exitCount
  ) {
    report.status = 'FAIL';
    report.cleanupError = 'Owned application or fixture resources remain unconfirmed.';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      cleanup: report.cleanup,
      error: report.error,
    }),
  );
}
