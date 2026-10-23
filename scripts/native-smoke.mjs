/* global window -- callbacks execute only inside this script's isolated WebView. */
import { importFixtureCatalogFile } from './scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from './fixture-server.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const exe = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const base = path.resolve('artifacts/native-smoke');
const directory = path.join(base, new Date().toISOString().replaceAll(':', '-'));
const data = path.join(directory, `data-${Date.now()}`);
await mkdir(data, { recursive: true });
const report = {
  scope:
    'Windows packaged native TS/fMP4/AES/map/range playback; isolated fixture library, not source-scan or release acceptance',
  started: new Date().toISOString(),
  executable: exe,
  sha256: createHash('sha256')
    .update(await readFile(exe))
    .digest('hex'),
  status: 'FAIL',
  checks: [],
  evidenceDirectory: directory,
};
const expected = process.argv.find((argument) => argument.startsWith('--sha256='))?.slice(9);
if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || report.sha256 !== expected))
  throw new Error('Exact expected packaged binary SHA-256 mismatch.');
const cases = [
  { id: 'ts', title: 'Owned TS fixture', resource: '/hls/master.m3u8' },
  { id: 'fmp4', title: 'Owned fMP4 fixture', resource: '/media/fmp4.m3u8' },
  { id: 'aes', title: 'Owned AES fixture', resource: '/protocol/aes/master.m3u8' },
  { id: 'range', title: 'Owned byte range fixture', resource: '/protocol/range/index.m3u8' },
];
const fixtures = await startFixtureServer();
const catalogServer = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/x-mpegurl');
  response.end(
    '#EXTM3U\n' +
      cases
        .map(
          ({ id, title, resource }) =>
            `#EXTINF:-1 tvg-id="${id}" group-title="Sports",${title}\n${fixtures.url}${resource}\n`,
        )
        .join(''),
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
let exitReceipt = null;
let exitRequestedAt = null;
let exitObserver = null;
let exitObserverSettled = false;
let expectedFavoriteId;
const describeError = (error) => (error instanceof Error ? error.message : String(error));
const fail = (message) => {
  report.status = 'FAIL';
  report.cleanupError = message;
  process.exitCode = 1;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
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
  app.once('exit', (code, signal) => {
    exitReceipt = { code, signal, atMs: performance.now(), requested: exitRequestedAt !== null };
  });
  let endpoint;
  for (let i = 0; i < 200; i++) {
    if (report.launchError) throw new Error(`Owned app launch failed: ${report.launchError}`);
    if (exitReceipt || app.exitCode !== null || app.signalCode !== null)
      throw new Error('Owned app exited before readiness.');
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
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('No native application WebView page.');
  page.setDefaultTimeout(15000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  report.startup = await page.evaluate(() => window.__GENX_STARTUP__);
  report.checks.push('Embedded UI ready without Vite server');
  await expect(page.locator('#channel-count')).toContainText('0 channels');
  await page.locator('#settings-button').click();
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await importFixtureCatalogFile(page, catalogUrl);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toContainText('4 channels');
  report.checks.push(
    'Explicit local fixture import through Settings; no online source discovery or source scan claimed',
  );
  for (const { title } of cases) {
    const button = page.locator('button[data-channel]').filter({ hasText: title });
    const selectedId = await button.getAttribute('data-channel');
    if (!selectedId) throw new Error('Controlled playback case has no exact channel identity.');
    expectedFavoriteId = selectedId;
    const before = await page.locator('#video').evaluate((video) => ({
      source: video.currentSrc,
      acquired: window.__GENX_PLAYBACK_OWNERS__?.acquired.browserEngines,
    }));
    if (!Number.isSafeInteger(before.acquired))
      throw new Error('Owned browser-engine acquisition evidence is unavailable.');
    await button.click();
    await expect(page.locator('#watch-title')).toHaveText(title);
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
    await expect
      .poll(
        () =>
          page.locator('#video').evaluate((video, prior) => {
            const owners = window.__GENX_PLAYBACK_OWNERS__;
            return (
              !!video.currentSrc &&
              video.currentSrc !== prior.source &&
              owners?.acquired.browserEngines > prior.acquired &&
              owners.counts.browserEngines === 1
            );
          }, before),
        { timeout: 15000 },
      )
      .toBe(true);
    const initial = await page.locator('#video').evaluate((video) => ({
      source: video.currentSrc,
      time: video.currentTime,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
    }));
    if (!initial.source || initial.source === before.source)
      throw new Error('Controlled case did not retain its newly selected source.');
    await expect
      .poll(
        () =>
          page
            .locator('#video')
            .evaluate(
              (video, first) =>
                video.currentSrc === first.source &&
                video.videoWidth === 320 &&
                video.videoHeight > 0 &&
                !video.paused &&
                video.readyState >= 2 &&
                video.currentTime > 1 &&
                video.currentTime >= first.time + 0.25 &&
                video.getVideoPlaybackQuality().totalVideoFrames >= first.frames + 2,
              initial,
            ),
        { timeout: 15000 },
      )
      .toBe(true);
    await expect(page.locator('#watch-title')).toHaveText(title);
    const decoded = await page.locator('#video').evaluate(
      (video, first) => ({
        time: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        sourceFenced: video.currentSrc === first.source,
        progressedSeconds: video.currentTime - first.time,
        freshFrames: video.getVideoPlaybackQuality().totalVideoFrames - first.frames,
        audioDecodedBytes:
          typeof video.webkitAudioDecodedByteCount === 'number'
            ? video.webkitAudioDecodedByteCount
            : null,
      }),
      initial,
    );
    if (!decoded.sourceFenced || decoded.freshFrames < 2 || decoded.progressedSeconds < 0.25)
      throw new Error('Controlled case lost its owned source or fresh decoded progress.');
    report.checks.push({ title, sourceChanged: true, newEngineObserved: true, decoded });
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Playing');
  }
  report.fixture = fixtures.stats();
  const protocol = report.fixture.protocolRequests;
  if (!protocol.some((request) => request.path.endsWith('/aes.key') && request.status === 200))
    throw new Error('Encrypted fixture decoded without an observed owned key request.');
  if (
    !protocol.some(
      (request) =>
        request.path.endsWith('/ranges.mp4') &&
        request.status === 206 &&
        request.range === 'bytes=0-1333',
    )
  )
    throw new Error('No native initialization-map range request observed.');
  if (
    !protocol.some(
      (request) =>
        request.path.endsWith('/ranges.mp4') &&
        request.status === 206 &&
        request.range === 'bytes=1334-61608',
    )
  )
    throw new Error('No native media byte-range request observed.');
  const favorite = page
    .locator('.channel-row')
    .filter({
      has: page.locator('button[data-channel]').filter({ hasText: cases.at(-1).title }),
    })
    .locator('[data-channel-action="favorite"]');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await page.keyboard.press('Escape');
  await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
  report.checks.push('Native fullscreen/Escape, pause/resume, durable favorite write');
  // The Guide opened beside actual playback (T094): the channel keeps playing
  // while the Guide is open and after it closes; media time keeps advancing.
  await expect(page.locator('#playback-status')).toHaveText('Playing');
  const mediaBeforeGuide = await page.locator('#video').evaluate((video) => video.currentTime);
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  await expect(guide).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.locator('#playback-status')).toHaveText('Playing');
  await page.keyboard.press('Escape');
  await expect(guide).not.toBeVisible();
  await expect(page.locator('#playback-status')).toHaveText('Playing');
  await expect
    .poll(() => page.locator('#video').evaluate((video) => video.currentTime), { timeout: 10000 })
    .toBeGreaterThan(mediaBeforeGuide + 1);
  report.checks.push('Guide opened and closed beside actual playback; playback continued');
  if (process.argv.includes('--discover')) {
    await page.locator('#cast-button').click();
    await page.locator('#cast-discover').click();
    await expect(page.locator('#cast-discover')).toBeEnabled({ timeout: 15000 });
    report.discoveredDevices = await page.locator('#cast-devices button').allTextContents();
    report.discoveryStatus = await page.locator('#cast-status').textContent();
    await page.locator('[data-close="cast-dialog"]').click();
  }
  await page.screenshot({ path: path.join(directory, 'native-player.png') });
  report.ownersBeforeExit = await page.evaluate(() => window.__GENX_PLAYBACK_OWNERS__);
  if (exitReceipt || app.exitCode !== null || app.signalCode !== null)
    throw new Error('Owned app exited before ordinary shutdown was requested.');
  report.status = 'PASS';
} catch (error) {
  report.error = describeError(error);
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
    report.failureDialogs = await page
      .locator('dialog[open]')
      .allTextContents()
      .catch(() => []);
  }
} finally {
  if (app) {
    report.closure = { requested: false, ordinary: false, forced: false };
    if (exitReceipt || app.exitCode !== null || app.signalCode !== null) {
      report.closure.unexpectedExit = true;
      fail('Owned isolated app exited before ordinary shutdown was requested.');
    } else if (page && !page.isClosed() && app.pid) {
      exitRequestedAt = performance.now();
      report.closure.requested = true;
      exitObserver = page
        .evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
        .then(() => {
          report.closure.observer = 'fulfilled';
        })
        .catch((error) => {
          report.closure.observer = 'rejected';
          report.closure.observerError = describeError(error);
        })
        .finally(() => {
          exitObserverSettled = true;
        });
      for (let i = 0; i < 300 && !exitReceipt; i++) await wait(100);
    }
    if (!exitReceipt && app.pid) {
      report.closure.forced = true;
      fail('Owned isolated app failed ordinary shutdown.');
      try {
        app.kill();
      } catch (error) {
        report.closure.killError = describeError(error);
      }
      for (let i = 0; i < 50 && !exitReceipt; i++) await wait(100);
    }
    report.closure.exitConfirmed = exitReceipt !== null;
    if (exitReceipt) {
      report.closure.exitCode = exitReceipt.code;
      report.closure.signal = exitReceipt.signal;
      report.closure.ordinary =
        report.closure.requested &&
        !report.closure.forced &&
        exitReceipt.requested &&
        exitReceipt.code === 0 &&
        exitReceipt.signal === null;
      if (report.closure.ordinary) {
        report.closure.elapsedMs = exitReceipt.atMs - exitRequestedAt;
        report.closure.twoSecondTargetMet = report.closure.elapsedMs <= 2000;
      } else fail('Owned isolated app did not confirm ordinary exit with code zero and no signal.');
    } else fail('Owned isolated app exit remains unconfirmed.');
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      fail(`Owned debugging connection did not close: ${describeError(error)}`);
    }
  }
  if (exitObserver) {
    // Closing the owned CDP transport settles a target-closed invocation too.
    // Never serialize a success with a detached or unconfirmed observer.
    for (let i = 0; i < 50 && !exitObserverSettled; i++) await wait(100);
    report.closure.observerJoined = exitObserverSettled;
    if (exitObserverSettled) await exitObserver;
    else fail('Owned ordinary-exit invocation observer did not settle.');
  }
  if (report.status === 'PASS') {
    let database;
    try {
      database = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
      const favoriteRows = database
        .prepare(
          'SELECT f.id,c.name FROM favorite f LEFT JOIN channel c ON c.id=f.id ORDER BY f.ordinal',
        )
        .all();
      const favoriteIdentityMatches =
        favoriteRows.length === 1 &&
        favoriteRows[0].id === expectedFavoriteId &&
        favoriteRows[0].name === cases.at(-1).title;
      report.savedRecords = {
        format: 'closed normalized SQLite',
        favoriteIdentityMatches,
        favorites: database.prepare('SELECT COUNT(*) AS total FROM favorite').get().total,
        channels: database.prepare('SELECT COUNT(*) AS total FROM channel').get().total,
        sources: database.prepare('SELECT COUNT(*) AS total FROM source').get().total,
        integrity: database.prepare('PRAGMA quick_check').get().quick_check,
      };
      if (
        !report.savedRecords.favoriteIdentityMatches ||
        report.savedRecords.favorites !== 1 ||
        report.savedRecords.channels !== 4 ||
        report.savedRecords.integrity !== 'ok'
      ) {
        report.status = 'FAIL';
        report.persistenceError =
          'Closed SQLite persisted records did not match native UI changes.';
        process.exitCode = 1;
      }
    } catch (error) {
      report.status = 'FAIL';
      report.persistenceError = error.message;
      process.exitCode = 1;
    } finally {
      database?.close();
    }
  }
  await fixtures.close();
  catalogServer.closeAllConnections();
  await new Promise((resolve) => catalogServer.close(resolve));
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
