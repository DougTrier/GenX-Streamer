import { chooseSettingsSection, openSourceImport } from './settings-navigation-helper.mjs';
import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// node tests/native/playback-fault-matrix.mjs --exe=ABSOLUTE_EXE --sha256=EXPECTED_SHA256
const argumentsByName = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument === '--discover' && !argumentsByName.has('discover')) {
    argumentsByName.set('discover', true);
    continue;
  }
  const match = /^--(exe|sha256)=(.+)$/.exec(argument);
  if (!match || argumentsByName.has(match[1])) throw new Error('Invalid fault-matrix arguments.');
  argumentsByName.set(match[1], match[2]);
}
const requestedExe = argumentsByName.get('exe');
const expected = argumentsByName.get('sha256');
if (
  process.platform !== 'win32' ||
  typeof requestedExe !== 'string' ||
  !path.isAbsolute(requestedExe) ||
  typeof expected !== 'string' ||
  !/^[a-f0-9]{64}$/.test(expected)
)
  throw new Error('Windows fault matrix requires an absolute --exe and lowercase --sha256.');
const exe = path.resolve(requestedExe);
const actualSha256 = createHash('sha256')
  .update(await readFile(exe))
  .digest('hex');
if (actualSha256 !== expected)
  throw new Error('Fault-matrix executable SHA256 mismatch; not launched.');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repository, 'artifacts/native-playback-fault-matrix');
const directory = path.join(base, new Date().toISOString().replaceAll(':', '-'));
await mkdir(base, { recursive: true });
await mkdir(directory);
const data = await mkdtemp(path.join(directory, 'data-'));
const report = {
  scope:
    'Hash-pinned Windows native HLS playback: isolated local catalog import and Save, six controlled faults, decoded healthy recovery, ordinary Exit and fixture cleanup. No Android or public-source claim.',
  started: new Date().toISOString(),
  executable: exe,
  sha256: actualSha256,
  status: 'FAIL',
  checks: [],
  evidenceDirectory: directory,
};
const cases = [
  ['Headers stall', '/fault/headers-stall'],
  ['Body stall', '/fault/body-stall'],
  ['Rate limit', '/fault/429'],
  ['Service busy', '/fault/503'],
  ['Missing stream', '/fault/not-found'],
  ['Connection reset', '/fault/disconnect'],
];
const fixtures = await startFixtureServer();
const catalogServer = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/x-mpegurl');
  response.end(
    `#EXTM3U\n#EXTINF:-1 tvg-id="ts" group-title="Sports",Owned TS fixture\n${fixtures.url}/hls/master.m3u8\n#EXTINF:-1 tvg-id="fmp4" group-title="News",Owned fMP4 fixture\n${fixtures.url}/media/fmp4.m3u8\n#EXTINF:-1 tvg-id="stall" group-title="Fixture",Owned stalled fixture\n${fixtures.url}/fault/segment-stall.m3u8\n${cases.map(([title, route]) => `#EXTINF:-1 group-title="Fixture",${title}\n${fixtures.url}${route}\n`).join('')}`,
  );
});
await new Promise((resolve) => catalogServer.listen(0, '127.0.0.1', resolve));
const catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/catalog.m3u`;
// Reserve an ephemeral debugging port, then immediately hand it to this child.
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
try {
  if (
    createHash('sha256')
      .update(await readFile(exe))
      .digest('hex') !== expected
  ) {
    throw new Error('Fault-matrix executable changed before launch; not launched.');
  }
  app = spawn(exe, [], {
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
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error(`App exited before readiness: ${app.exitCode}`);
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
  if (!endpoint) throw new Error('Native WebView debugging endpoint did not become ready.');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No native application WebView page.');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  report.checks.push('Embedded UI ready without Vite server');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  // The helper saves the reviewed scan and closes the review itself.
  await importFixtureCatalogFile(page, catalogUrl, 20000);
  report.catalogSetup = 'Ordinary local playlist fixture; not URL Scan proof';
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  if (await page.locator('#settings-dialog').isVisible())
    await page.locator('#settings-dialog [data-close="settings-dialog"]').click();
  await expect(page.locator('#channel-count')).toContainText('9 channels');
  report.checks.push('Ordinary local fixture import, real worker parse, atomic catalog commit');
  for (const title of ['Owned TS fixture', 'Owned fMP4 fixture']) {
    await page.locator('#channel-list button.channel').filter({ hasText: title }).click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
    await expect
      .poll(
        () =>
          page.locator('#video').evaluate((video) => ({
            time: video.currentTime,
            width: video.videoWidth,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
          })),
        { timeout: 15000 },
      )
      .toMatchObject({ width: 320 });
    await expect
      .poll(() => page.locator('#video').evaluate((video) => video.currentTime), { timeout: 15000 })
      .toBeGreaterThan(1);
    const decoded = await page.locator('#video').evaluate((video) => ({
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
    }));
    if (decoded.frames < 2) throw new Error('Media time advanced without decoded frame evidence.');
    report.checks.push({ title, decoded });
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Playing');
  }
  await page.locator('#favorite-button').click();
  await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await page.keyboard.press('Escape');
  await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
  report.checks.push('Native fullscreen/Escape, pause/resume, durable favorite write');
  const database = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
  try {
    report.savedRecords = {
      format: 'normalized SQLite',
      favorites: database.prepare('SELECT COUNT(*) AS total FROM favorite').get().total,
      channels: database.prepare('SELECT COUNT(*) AS total FROM channel').get().total,
      sources: database.prepare('SELECT COUNT(*) AS total FROM source').get().total,
    };
    // The integrity scan runs after GenX exits (below): while GenX holds the file,
    // a read-only connection cannot construct its search index's virtual table.
    if (report.savedRecords.favorites !== 1 || report.savedRecords.channels !== 9)
      throw new Error('SQLite persisted records did not match native UI changes.');
  } finally {
    database.close();
  }
  if (argumentsByName.get('discover') === true) {
    await page.locator('#cast-button').click();
    await page.locator('#cast-discover').click();
    await expect(page.locator('#cast-discover')).toBeEnabled({ timeout: 15000 });
    report.discoveredDevices = await page.locator('#cast-devices button').allTextContents();
    report.discoveryStatus = await page.locator('#cast-status').textContent();
    await page.locator('[data-close="cast-dialog"]').click();
  }
  await page.screenshot({ path: path.join(directory, 'native-player.png') });
  report.faults = [];
  for (const [title, route] of cases) {
    const before = fixtures.stats().requests.length,
      started = Date.now(),
      states = [];
    await page.locator('#channel-list button.channel').filter({ hasText: title }).click();
    await expect(page.locator('#watch-title')).toHaveText(title);
    let failed = false;
    while (Date.now() - started <= 21000) {
      const state = (await page.locator('#playback-status').textContent()).trim();
      if (states.at(-1) !== state) states.push(state);
      if (state === 'Playing') throw Error(`${title} falsely reported Playing`);
      if (state === 'Unable to play') {
        failed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const elapsedMs = Date.now() - started;
    if (!failed) throw Error(`${title} exceeded 20s episode plus 1s observer tolerance`);
    await expect(page.locator('#retry-button')).toBeVisible();
    report.openAfterFailure = {
      title,
      route,
      failedAt: Date.now(),
      clickedAt: started,
      open: fixtures.stats().activePaths,
      requests: fixtures.stats().requests.slice(before),
    };
    // The player's request for the failed stream is not left open. The quiet
    // saved-channel check (October 19, 2026) starts once nothing plays, even on
    // a failure, and may probe this or other channels (including their format
    // variants such as route + '.ts'); those requests belong to that check.
    await expect
      .poll(() => fixtures.stats().activePaths.filter((open) => open === route).length, {
        timeout: 2000,
      })
      .toBe(0);
    const requests = fixtures
      .stats()
      .requests.slice(before)
      .filter((r) => r.path === route).length;
    const result = {
      title,
      route,
      states,
      elapsedMs,
      requests,
      applicationBudgetMs: 20000,
      observationToleranceMs: 1000,
      upstreamJoined: true,
    };
    report.faults.push(result);
    if (requests < 1 || requests > 3)
      throw Error(`${title} violates initial plus two retries request bound`);
    if ((route.endsWith('429') || route.endsWith('not-found')) && requests !== 1)
      throw Error(`${title} unexpectedly retried`);
    if (route.endsWith('503') && (requests !== 3 || elapsedMs < 1900))
      throw Error('503 did not honor Retry-After and bounded retry count');
    await page.screenshot({ path: path.join(directory, `${title.replaceAll(' ', '-')}.png`) });
    await page
      .locator('#channel-list button.channel')
      .filter({ hasText: 'Owned TS fixture' })
      .click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
    await expect
      .poll(() => page.locator('#video').evaluate((v) => v.currentTime), { timeout: 15000 })
      .toBeGreaterThan(1);
    result.recovered = await page.locator('#video').evaluate((v) => ({
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      width: v.videoWidth,
      height: v.videoHeight,
      time: v.currentTime,
    }));
    if (result.recovered.frames < 2 || result.recovered.width !== 320)
      throw Error(`${title} prevented healthy decoded recovery`);
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Paused');
  }
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null && page) {
    try {
      if ((await page.locator('#settings-dialog').isVisible()) === false)
        await page.locator('#settings-button').click();
      await page.locator('#exit-button').click();
      const until = Date.now() + 20000;
      while (app.exitCode === null && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
      report.ordinaryExitConfirmed = app.exitCode === 0;
    } catch {
      report.ordinaryExitConfirmed = false;
    }
  }
  if (report.ordinaryExitConfirmed !== true) {
    report.status = 'FAIL';
    process.exitCode = 1;
  } else if (report.savedRecords) {
    const closed = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
    try {
      report.savedRecords.integrity = closed.prepare('PRAGMA quick_check').get().quick_check;
    } finally {
      closed.close();
    }
    if (report.savedRecords.integrity !== 'ok') {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  }
  if (browser) await browser.close().catch(() => undefined);
  if (app && app.exitCode === null) {
    report.forcedOwnedCleanup = true;
    report.status = 'FAIL';
    process.exitCode = 1;
    app.kill();
    await new Promise((resolve) => {
      app.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
  }
  await fixtures.close();
  report.fixtureClosed = fixtures.stats();
  if (
    report.fixtureClosed.activeResponses ||
    report.fixtureClosed.activeSockets ||
    report.fixtureClosed.timers
  ) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  catalogServer.closeAllConnections();
  await new Promise((resolve) => catalogServer.close(resolve));
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
