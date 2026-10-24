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

import { chooseSettingsSection } from './settings-navigation-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';

const input = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/native-health-history',
  new Date().toISOString().replaceAll(':', '-'),
);
const data = path.join(directory, 'data');
await mkdir(data, { recursive: true });
const executable = path.join(directory, 'GenX-health-fixture.exe');
await copyFile(input, executable);
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  scope:
    'Packaged Windows selected reachability observations and same-data restart; no decoder or imported-history claim',
  fixtureSeed: 'selected-http200-403-404-plus-unselected-v1',
  executableSha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  launchCount: 0,
  exitCount: 0,
  fixtureRequests: {},
  checks: [],
};
const segmentBytes = await readFile(new URL('../fixtures/media/segment000.ts', import.meta.url));
report.segmentSha256 = createHash('sha256').update(segmentBytes).digest('hex');
const sockets = new Set();
let activeResponses = 0;
let origin;
const server = http.createServer((request, response) => {
  const endpoint = new URL(request.url, 'http://fixture.invalid').pathname;
  report.fixtureRequests[endpoint] = (report.fixtureRequests[endpoint] ?? 0) + 1;
  activeResponses++;
  response.once('close', () => activeResponses--);
  if (endpoint === '/catalog') {
    response.setHeader('Content-Type', 'application/x-mpegurl');
    response.end(
      '#EXTM3U\n' +
        [
          ['reachable', 'Owned reachable'],
          ['denied', 'Owned denied'],
          ['missing', 'Owned missing'],
          ['unselected', 'Owned unselected'],
        ]
          .map(
            ([id, name]) =>
              `#EXTINF:-1 tvg-id="${id}" group-title="Fixture",${name}\n${origin}/${id}\n`,
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
origin = `http://127.0.0.1:${server.address().port}`;
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
async function action(value) {
  await page.getByLabel('Scan review action').selectOption(value);
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
}
async function savedRows() {
  await action('history');
  const list = page.getByLabel('Saved checks', { exact: true });
  await expect(list.locator('li')).toHaveCount(3);
  const rows = await list.locator('li').allTextContents();
  for (const [name, verdict] of [
    ['Owned reachable', 'Stream responded'],
    ['Owned denied', 'Access denied'],
    ['Owned missing', 'Temporarily unavailable'],
  ]) {
    const item = list.locator('li').filter({ has: page.locator('strong', { hasText: name }) });
    await expect(item).toHaveCount(1);
    await expect(item.locator('p').first()).toHaveText(`${verdict} · Recent check`);
    await expect(item.locator('details')).not.toHaveAttribute('open', '');
    await expect(item.locator('summary')).toHaveText('Check details');
    await expect(item.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    const metadata = await item.locator('dl').textContent();
    expect(metadata).toContain('Local check');
    expect(metadata).toContain('Primary stream');
    expect(metadata).toContain('reachability-v3/native-media-resources-v1/max-20000/sequential');
    expect(metadata).toContain('Platformwindows');
    expect(metadata).toMatch(/HTTP (200|403|404)/);
    await item.locator('summary').click();
    await expect(item.locator('details')).toHaveAttribute('open', '');
    await expect(item.locator('dl')).toBeVisible();
    await item.locator('summary').click();
  }
  expect(rows.every((row) => !row.includes('Playback observed'))).toBe(true);
  return rows;
}
function inspectDatabase() {
  const db = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT c.name,h.channel_id,h.source_id,h.url_ordinal,h.platform,h.observer_profile,h.target_fingerprint,h.observed_at,h.verdict,h.origin,h.evidence_json FROM channel_health h JOIN channel c ON c.id=h.channel_id ORDER BY c.name',
      )
      .all();
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(8);
    expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM channel').get().n).toBe(3);
    expect(db.prepare('SELECT count(*) AS n FROM source').get().n).toBe(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.platform).toBe('windows');
      expect(row.observer_profile).toBe(
        'reachability-v3/native-media-resources-v1/max-20000/sequential',
      );
      expect(row.origin).toBe('local');
      expect(row.url_ordinal).toBe(0);
      expect(row.target_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row.observed_at).toBeGreaterThanOrEqual(Date.parse(report.started));
      const expected =
        row.name === 'Owned reachable'
          ? ['Reachable', 200]
          : row.name === 'Owned denied'
            ? ['AccessDenied', 403]
            : ['TemporaryUnavailable', 404];
      expect(row.verdict).toBe(expected[0]);
      expect(JSON.parse(row.evidence_json)).toEqual({
        kind: 'http',
        status: expected[1],
        ...(expected[1] === 200 ? { contentRecognized: true } : {}),
      });
    }
    return {
      schema: 8,
      integrity: 'ok',
      rows,
      metadata: db
        .prepare('SELECT catalog_revision,health_revision,health_present FROM metadata')
        .get(),
    };
  } finally {
    db.close();
  }
}
try {
  await launch();
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
  for (const name of ['Owned reachable', 'Owned denied', 'Owned missing'])
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke('read_record_pair'),
    ),
  ).toEqual(beforeScanPair);
  expect(report.fixtureRequests['/unselected']).toBe(1);
  expect(report.fixtureRequests['/checked-segment.ts']).toBe(1);
  report.postScanRequests = { ...report.fixtureRequests };
  // Automatic Scan already checked all four; selection controls only publication.
  await page.getByRole('checkbox', { name: `Select ${'Owned unselected'}`, exact: true }).uncheck();
  await expect(
    page.getByRole('button', { name: 'Save selected channels', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel('Candidate channels').locator('li').filter({ hasText: 'Owned reachable ·' }),
  ).toContainText('Responded');
  await page.getByRole('button', { name: 'Save selected channels', exact: true }).click();
  await expect(page.getByText('Selected channels saved.', { exact: true })).toBeVisible();
  expect(report.fixtureRequests).toEqual(report.postScanRequests);
  expect(report.fixtureRequests['/unselected']).toBe(1);
  expect(report.fixtureRequests['/checked-segment.ts']).toBe(1);
  report.postScanRequests = { ...report.fixtureRequests };
  report.initialRows = await savedRows();
  report.sqliteBefore = inspectDatabase();
  report.checks.push(
    'All four candidates checked once; only three explicitly selected candidates persisted with exact HTTP evidence; no decoder claim',
  );
  await page.screenshot({ path: path.join(directory, 'saved-before-restart.png') });
  await shutdown();
  const before = await stat(path.join(data, 'genx.sqlite3'), { bigint: true });
  const counts = JSON.stringify(report.fixtureRequests);
  await launch();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'discovery');
  await page.getByRole('button', { name: 'Scan sources', exact: true }).click();
  report.restartedRows = await savedRows();
  expect(report.restartedRows).toEqual(report.initialRows);
  report.sqliteAfter = inspectDatabase();
  expect(report.sqliteAfter).toEqual(report.sqliteBefore);
  const after = await stat(path.join(data, 'genx.sqlite3'), { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.birthtimeNs).toBe(before.birthtimeNs);
  expect(JSON.stringify(report.fixtureRequests)).toBe(counts);
  report.fileIdentity = {
    sameFile: true,
    inode: before.ino.toString(),
    createdNanoseconds: before.birthtimeNs.toString(),
    sameDataDirectory: true,
  };
  report.checks.push(
    'Same SQLite file and exact observations survive actual shutdown/relaunch; history view performs no probes',
  );
  await page.screenshot({ path: path.join(directory, 'saved-after-restart.png') });
  report.status = 'PASS';
} catch (error) {
  report.error = /https?:\/\//i.test(String(error))
    ? 'Packaged health history assertion failed; URL-bearing detail redacted.'
    : String(error.message ?? error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try {
    await shutdown();
  } catch {
    report.status = 'FAIL';
    report.cleanupError = 'Owned application shutdown was not confirmed.';
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await wait(20);
  report.cleanup = {
    applicationExited: !app || app.exitCode !== null,
    sockets: sockets.size,
    activeResponses,
  };
  if (sockets.size || activeResponses || report.launchCount !== report.exitCount) {
    report.status = 'FAIL';
    report.cleanupError = 'Owned native or fixture resources remain unconfirmed.';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      launchCount: report.launchCount,
      exitCount: report.exitCount,
      cleanup: report.cleanup,
    }),
  );
}
