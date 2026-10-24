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
import { chooseSettingsSection, openSourceImport } from './settings-navigation-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { rawConsumerPressure } from './sharing-pressure-helper.mjs';
import { OwnedCdp } from './sharing-cdp-owner.mjs';
import { armMetadataBarrier } from './sharing-metadata-barrier.mjs';

const input = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/native-sharing-pause',
  new Date().toISOString().replaceAll(':', '-'),
);
const data = path.join(directory, 'data');
await mkdir(data, { recursive: true });
const executable = path.join(directory, 'GenX-sharing-pause-fixture.exe');
await copyFile(input, executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  scope:
    'Exploratory public sample: packaged Windows host and two isolated pinned-TLS Chromium viewers; not ordinary phone trust provisioning or deterministic CI',
  fixtureSeed: 'owned-catalog-owned-loopback-cert-public-google-cast-samples-v1',
  research: [
    'https://developers.google.com/cast/codelabs/cast-receiver',
    'https://storage.googleapis.com/cpe-sample-media/content.json',
  ],
  externalAvailability: 'not yet observed',
  executableSha256: hash(await readFile(executable)),
  harnessSha256: hash(await readFile(new URL(import.meta.url))),
  launchCount: 0,
  exitCount: 0,
  checks: [],
};
const fixture = await startFixtureServer();
const publicMode = process.argv.includes('--public');
const pressureMode = process.argv.includes('--pressure');
const rawPressureMode = process.argv.includes('--raw-pressure');
if (pressureMode && !publicMode)
  throw new Error('Pressure mode requires explicit --public exploration.');
if (rawPressureMode && !publicMode)
  throw new Error('Raw pressure requires explicit --public exploration.');
let selectedUrl = fixture.url + '/hls/live.m3u8?owned=sharing-pause';
// A distinct owned stream: the scan saves one channel per stream address.
let secondUrl = fixture.url + '/hls/master.m3u8?owned=sharing-pause-two';

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
      '#EXTM3U\n#EXTINF:-1 tvg-id="selected" group-title="Fixture",Sharing sample one\n' +
        selectedUrl +
        '\n#EXTINF:-1 tvg-id="unselected" group-title="Fixture",Sharing sample two\n' +
        secondUrl +
        '\n',
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
let app, browser, page, hostOwner;
const viewerOwners = [];
async function milestone(phase) {
  await appendFile(
    path.join(directory, 'phases.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), phase }) + '\n',
  );
}
async function confirmChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  const onExit = () => finish();
  let finish;
  await new Promise((resolve) => {
    finish = resolve;
    child.once('exit', onExit);
    timer = setTimeout(resolve, 1000);
  });
  clearTimeout(timer);
  child.off('exit', onExit);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error('Owned child exit unconfirmed');
}
function ownedProcess(child, profile) {
  return new OwnedCdp(child.pid, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.spawnargs.includes('--user-data-dir=' + profile))
      throw new Error('Owned profile identity mismatch');
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
    await confirmChildExit(child);
  });
}
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
  app.on('error', () => {
    report.nativeSpawnError = true;
  });
  hostOwner = new OwnedCdp(app.pid, async () => {
    if (app.exitCode !== null || app.signalCode !== null) return;
    if (app.spawnfile !== executable) throw new Error('Owned native executable identity mismatch');
    let timer;
    /* eslint-disable no-undef -- Public shutdown IPC in the owned packaged WebView. */
    const graceful = page
      ?.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
      .catch(() => undefined);
    /* eslint-enable no-undef */
    await Promise.race([
      graceful,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(timer);
    if (app.exitCode === null && app.signalCode === null) {
      report.gracefulDiagnosticCleanup = 'unconfirmed; exact owned process fallback';
      execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
        stdio: 'ignore',
      });
    }
    await confirmChildExit(app);
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
  browser = await hostOwner.run('host CDP connect', () =>
    chromium.connectOverCDP(endpoint, { timeout: 10000 }),
  );
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
  if (browser && !hostOwner.dead)
    await hostOwner.run('host CDP disconnect', () => browser.close()).catch(() => undefined);
  browser = undefined;
  page = undefined;
  if (owned && owned.exitCode === null) {
    await Promise.race([new Promise((resolve) => owned.once('exit', resolve)), wait(5000)]);
  }
  if (owned && owned.exitCode === null) {
    await hostOwner.kill();
    throw new Error('Graceful owned application shutdown was not confirmed.');
  }
  if (owned) {
    report.exitCount++;
    if (owned.exitCode !== 0) throw new Error('Owned application exited unsuccessfully.');
  }
  app = undefined;
}

const viewerBrowsers = [];
const viewers = [];
const diagnostics = [];
async function attachDiagnostics(viewer, index) {
  const detail = {
    index,
    routes: {},
    loadingFailures: [],
    consoleErrors: [],
    errorResponses: [],
    video: null,
  };
  diagnostics.push(detail);
  const owner = viewerOwners[index];
  const session = await owner.run('diagnostic session', () =>
    viewer.context().newCDPSession(viewer),
  );
  await owner.run('diagnostic network enable', () => session.send('Network.enable'));
  const requestKinds = new Map();
  const kind = (url) => {
    const pathname = new URL(url).pathname;
    return pathname.startsWith('/media/')
      ? 'media'
      : ['/state', '/pair', '/hls.js', '/viewer.js', '/viewer.css', '/'].includes(pathname)
        ? pathname
        : 'other';
  };
  session.on('Network.requestWillBeSent', (event) => {
    if (requestKinds.size < 256) requestKinds.set(event.requestId, kind(event.request.url));
  });
  session.on('Network.loadingFailed', (event) => {
    if (detail.loadingFailures.length < 24)
      detail.loadingFailures.push({
        kind: requestKinds.get(event.requestId) ?? 'unknown',
        error: event.errorText,
        canceled: event.canceled ?? false,
        blockedReason: event.blockedReason ?? null,
        corsError: event.corsErrorStatus?.corsError ?? null,
      });
    requestKinds.delete(event.requestId);
  });
  session.on('Network.loadingFinished', (event) => requestKinds.delete(event.requestId));
  viewer.on('console', (message) => {
    if (message.type() === 'error' && detail.consoleErrors.length < 12)
      detail.consoleErrors.push(
        message
          .text()
          .replace(/https?:\/\/[^\s"')]+/g, '[address]')
          .replace(/[A-Za-z0-9_-]{40,}/g, '[opaque]')
          .slice(0, 512),
      );
  });
  viewer.on('response', async (response) => {
    const route = kind(response.url());
    const headers = response.headers();
    const key = JSON.stringify({
      kind: route,
      status: response.status(),
      transferEncoding: headers['transfer-encoding'] ?? null,
      contentType: headers['content-type'] ?? null,
      contentLength: headers['content-length'] ?? null,
    });
    if (Object.keys(detail.routes).length < 32 || detail.routes[key])
      detail.routes[key] = (detail.routes[key] ?? 0) + 1;
    if (route === 'media' && !response.ok() && detail.errorResponses.length < 8) {
      try {
        const body = await response.body();
        if (body.length <= 16384) {
          const parsed = JSON.parse(body.toString('utf8'));
          const category =
            typeof parsed.error === 'string' && /^[a-z-]{1,80}$/.test(parsed.error)
              ? parsed.error
              : 'unclassified';
          detail.errorResponses.push({ status: response.status(), category });
        }
      } catch {
        detail.errorResponses.push({
          status: response.status(),
          category: 'unreadable-error-body',
        });
      }
    }
  });
  /* eslint-disable no-undef -- Test-only observations execute in the isolated viewer DOM. */
  await viewer.addInitScript(() => {
    const categories = {};
    Object.defineProperty(window, 'fixtureHlsErrors', { value: categories });
    document.addEventListener('DOMContentLoaded', () => {
      if (!window.Hls) return;
      const original = window.Hls.prototype.trigger;
      window.Hls.prototype.trigger = function (event, ...args) {
        if (event === window.Hls.Events.ERROR) {
          const data = args[0] ?? {};
          const key = JSON.stringify({
            type: data.type ?? null,
            details: data.details ?? null,
            fatal: data.fatal ?? false,
            responseCode: data.response?.code ?? null,
          });
          if (Object.keys(categories).length < 24 || categories[key])
            categories[key] = (categories[key] ?? 0) + 1;
        }
        return original.call(this, event, ...args);
      };
    });
  });
  /* eslint-enable no-undef */
}
const certificate = await readFile('src-tauri/src/lan/fixtures/loopback-cert.der');
const rootCertificate = await readFile('src-tauri/src/lan/fixtures/loopback-root.der');
const key = await readFile('src-tauri/src/lan/fixtures/loopback-key.der');
const pem = (label, bytes) =>
  `-----BEGIN ${label}-----\n${bytes
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END ${label}-----\n`;
const certPath = path.join(directory, 'owned-loopback-chain.pem');
const keyPath = path.join(directory, 'owned-loopback-key.pem');
await writeFile(certPath, pem('CERTIFICATE', certificate) + pem('CERTIFICATE', rootCertificate));
await writeFile(keyPath, pem('PRIVATE KEY', key));
const spki = createHash('sha256')
  .update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const sharingPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const address = `https://127.0.0.1:${sharingPort}`;
async function sample(target) {
  return target.locator('#video').evaluate((video) => {
    const quality = video.getVideoPlaybackQuality();
    return {
      time: video.currentTime,
      frames: quality.totalVideoFrames - quality.droppedVideoFrames,
      width: video.videoWidth,
      height: video.videoHeight,
      paused: video.paused,
    };
  });
}
async function advancing(target) {
  const before = await sample(target);
  await expect
    .poll(async () => (await sample(target)).time, { timeout: 45000 })
    .toBeGreaterThan(before.time + 0.5);
  // Frame counters can trail media time just after a cold start.
  await expect
    .poll(async () => (await sample(target)).frames, { timeout: 45000 })
    .toBeGreaterThan(before.frames);
  const after = await sample(target);
  report.lastAdvancing = { before, after };
  expect(after.width).toBeGreaterThan(0);
  expect(after.paused).toBe(false);
  return { before, after };
}
async function state(target) {
  return target.evaluate(async () => {
    const response = await fetch('/state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    return { status: response.status, body: await response.json() };
  });
}
async function settings() {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sharing');
  return page.getByLabel('Encrypted LAN sharing', { exact: true });
}
async function closeSettings() {
  await page.locator('#settings-dialog [data-close="settings-dialog"]').click();
}
async function nativeViewers() {
  /* eslint-disable no-undef -- Public native IPC, no private owner counters. */
  return hostOwner.run('paired viewers', () =>
    page.evaluate(() => window.__TAURI_INTERNALS__.invoke('sharing_viewers')),
  );
  /* eslint-enable no-undef */
}
async function resourceSample(label) {
  const rootSession = await hostOwner.run('host root session', () =>
    browser.newBrowserCDPSession(),
  );
  const pageSession = await hostOwner.run('host page session', () =>
    page.context().newCDPSession(page),
  );
  try {
    await hostOwner.run('performance enable', () => pageSession.send('Performance.enable'));
    const info = await hostOwner.run('process sample', () =>
      rootSession.send('SystemInfo.getProcessInfo'),
    );
    const metrics = await hostOwner.run('metrics sample', () =>
      pageSession.send('Performance.getMetrics'),
    );
    const ids = [...new Set([app.pid, ...info.processInfo.map((entry) => entry.id)])].filter(
      (id) => Number.isSafeInteger(id) && id > 0,
    );
    if (ids.length > 32) throw new Error('Owned process sampling bound exceeded.');
    const memory = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@((Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue) | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,HandleCount) | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 },
      ).trim() || '[]',
    );
    const types = new Map(info.processInfo.map((entry) => [entry.id, entry.type]));
    return {
      label,
      at: new Date().toISOString(),
      host: await sample(page),
      processes: (Array.isArray(memory) ? memory : [memory]).map((entry) => ({
        ...entry,
        cdpType: entry.Id === app.pid ? 'native-app' : (types.get(entry.Id) ?? null),
      })),
      rendererMetrics: Object.fromEntries(
        ['JSHeapUsedSize', 'Nodes', 'JSEventListeners', 'Documents'].map((name) => [
          name,
          metrics.metrics.find((entry) => entry.name === name)?.value ?? null,
        ]),
      ),
      pairedViewerCount: (await nativeViewers()).length,
      ownerCounts:
        'No production owned-request counter API; process/CDP observations are not owner counts.',
    };
  } finally {
    if (!hostOwner.dead) {
      await hostOwner.run('page detach', () => pageSession.detach());
      await hostOwner.run('root detach', () => rootSession.detach());
    }
  }
}
async function pressureCase() {
  const result = {
    scope: 'Exploratory throttled consumer disappearance; measurements, no memory acceptance',
    status: 'UNEXERCISED',
    samples: [],
  };
  report.pressure = result;
  await milestone('pressure-start');
  const slow = viewers[0];
  const healthy = viewers[1];
  const owner = viewerOwners[0];
  const session = await owner.run('slow network session', () => slow.context().newCDPSession(slow));
  const active = new Set();
  let completed = 0,
    failed = 0,
    highwater = 0;
  session.on('Network.requestWillBeSent', (event) => {
    if (
      new URL(event.request.url).origin === address &&
      new URL(event.request.url).pathname.startsWith('/media/')
    ) {
      active.add(event.requestId);
      highwater = Math.max(highwater, active.size);
    }
  });
  session.on('Network.loadingFinished', (event) => {
    if (active.delete(event.requestId)) completed++;
  });
  session.on('Network.loadingFailed', (event) => {
    if (active.delete(event.requestId)) failed++;
  });
  await owner.run('slow network enable', () => session.send('Network.enable'));
  await milestone('pressure-before-throttle-sample');
  result.samples.push(await resourceSample('before-throttle'));
  await owner.run('slow throttle', () =>
    session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 250,
      downloadThroughput: 32768,
      uploadThroughput: 65536,
    }),
  );
  await slow.locator('#video').evaluate((video) => {
    video.currentTime = Math.min(video.currentTime + 45, video.duration - 10);
  });
  const start = Date.now();
  while (active.size === 0 && Date.now() - start < 10000) await wait(100);
  result.activeAtThrottle = active.size;
  result.healthyDuringThrottle = await advancing(healthy);
  result.hostDuringThrottle = await advancing(page);
  result.samples.push(await resourceSample('during-throttle'));
  result.browserRequestObservations = {
    highwater,
    active: active.size,
    completed,
    failed,
    scope: 'CDP-observed slow Chromium media requests only, not native request owners',
  };
  const beforeIds = await nativeViewers();
  expect(beforeIds).toHaveLength(2);
  const vanishedAt = Date.now();
  await milestone('pressure-slow-browser-termination');
  await owner.kill();
  // Never detach CDP sessions after deliberately terminating their transport.
  result.disappearance =
    'Owned isolated Chromium process forcibly ended without host pause/stop/revoke.';
  let remaining = beforeIds;
  while (remaining.length > 1 && Date.now() - vanishedAt < 32000) {
    await wait(250);
    remaining = await nativeViewers();
  }
  expect(remaining).toHaveLength(1);
  await milestone('pressure-lease-expired');
  result.leaseExpiryObservedMilliseconds = Date.now() - vanishedAt;
  result.leasePolicyMilliseconds = 30000;
  result.observationPollToleranceMilliseconds = 2000;
  result.healthyAfterDisappearance = await advancing(healthy);
  result.hostAfterDisappearance = await advancing(page);
  await milestone('pressure-healthy-advance-confirmed');
  result.samples.push(await resourceSample('after-expiry'));
  await wait(5000);
  result.samples.push(await resourceSample('after-expiry-idle-5s'));
  result.status =
    result.activeAtThrottle > 0 ? 'PASS_EXPLORATORY' : 'PARTIAL_NO_ACTIVE_THROTTLED_MEDIA';
  // The slow browser transport has already been terminated; no dead-session detach.
}
try {
  if (publicMode) {
    const response = await fetch('https://storage.googleapis.com/cpe-sample-media/content.json', {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Public sample catalog unavailable.');
    const catalog = await response.json();
    selectedUrl = catalog.bbb?.stream?.hls_ts;
    secondUrl = catalog.ed?.stream?.hls_ts;
    for (const url of [selectedUrl, secondUrl])
      if (typeof url !== 'string' || new URL(url).origin !== 'https://storage.googleapis.com')
        throw new Error('Public sample catalog changed.');
  }
  await launch();
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(origin + '/catalog');
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.locator('#mute-button').click();
  await page
    .locator('button[data-channel]')
    .filter({ hasText: 'Sharing sample one' })
    .first()
    .click();
  report.hostInitial = await advancing(page);
  let panel = await settings();
  await panel.getByLabel('Private interface IPv4 address').fill('127.0.0.1');
  await panel.getByLabel('Port', { exact: true }).fill(String(sharingPort));
  await panel.getByLabel('Trusted certificate file').fill(certPath);
  await panel.getByLabel('Certificate private key file').fill(keyPath);
  // The owned fixture is plain HTTP; sharing must be told so explicitly.
  if (!publicMode)
    await panel.getByRole('checkbox', { name: /Allow HTTP upstream streams/ }).check();
  await panel.getByRole('button', { name: 'Start sharing', exact: true }).click();
  await expect(panel).toContainText('Sharing is on');
  let previousSecret = '';
  for (let index = 0; index < 2; index++) {
    previousSecret =
      /View-only invitation: ([A-Za-z0-9_-]+)/.exec(await panel.textContent())?.[1] ?? '';
    await panel.getByRole('button', { name: 'New view-only invitation', exact: true }).click();
    const invitation = await expect
      .poll(async () => {
        const text = await panel.textContent();
        const secret = /View-only invitation: ([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
        return secret !== '' && secret !== previousSecret;
      })
      .toBe(true);
    void invitation;
    const secret = /View-only invitation: ([A-Za-z0-9_-]+)/.exec(await panel.textContent())[1];
    previousSecret = secret;
    const viewerReservation = http.createServer();
    await new Promise((resolve) => viewerReservation.listen(0, '127.0.0.1', resolve));
    const viewerPort = viewerReservation.address().port;
    await new Promise((resolve) => viewerReservation.close(resolve));
    const viewerProcess = spawn(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      [
        '--headless=new',
        `--ignore-certificate-errors-spki-list=${spki}`,
        `--remote-debugging-port=${viewerPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${path.join(directory, `viewer-${index}`)}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    viewerProcess.on('error', () => {
      report.viewerSpawnError = true;
    });
    const owner = ownedProcess(viewerProcess, path.join(directory, `viewer-${index}`));
    viewerOwners.push(owner);
    const ownedBrowser = await owner.run('viewer CDP connect', async () => {
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        try {
          return await chromium.connectOverCDP(`http://127.0.0.1:${viewerPort}`, { timeout: 500 });
        } catch {
          await wait(100);
        }
      }
      throw new Error('Viewer CDP readiness timed out.');
    });
    viewerBrowsers.push(ownedBrowser);
    const viewer = await owner.run('viewer new page', () => ownedBrowser.newPage());
    viewers.push(viewer);
    await attachDiagnostics(viewer, index);
    viewer.on('response', async (response) => {
      if (new URL(response.url()).pathname === '/pair') {
        report.pairResponses ??= [];
        report.pairResponses.push({
          status: response.status(),
          error: response.ok() ? null : await response.text(),
        });
      }
    });
    await viewer.goto(address);
    await viewer.locator('#secret').fill(secret);
    await viewer.getByRole('button', { name: 'Connect securely', exact: true }).click();
    await expect(viewer.locator('#view')).toBeVisible();
    await viewer.locator('#video').evaluate((video) => {
      video.muted = true;
    });
    await viewer.locator('#watch').click();
  }
  await closeSettings();
  const publication = await state(viewers[0]);
  expect(publication.status).toBe(200);
  expect(publication.body.revision).toBeGreaterThan(0);
  const oldPath = publication.body.mediaPath;
  report.publication = {
    revision: publication.body.revision,
    mediaPathIssued: typeof oldPath === 'string',
  };
  if (publicMode) {
    report.viewersInitial = await Promise.all(viewers.map(advancing));
    report.externalAvailability = 'host and two relayed viewers decoded the official samples';
    if (pressureMode) {
      await pressureCase();
    }
  } else {
    /* Loopback upstream is intentionally refused by production LAN policy. */
    report.externalAvailability =
      'not attempted; owned loopback fixture exercises native publication IDs only';
    const status = await viewers[0].evaluate(
      async (resource) => (await fetch(resource)).status,
      oldPath,
    );
    expect(status).toBe(502);
  }
  await page.locator('#pause-button').click();
  await expect(page.locator('#playback-status')).toHaveText('Paused');
  expect((await sample(page)).paused).toBe(true);
  const preserved = await state(viewers[pressureMode ? 1 : 0]);
  expect(preserved.body).toEqual(publication.body);
  report.hostPausePublicationPreserved = true;
  if (publicMode) {
    report.viewersDuringHostPause = await Promise.all(
      (pressureMode ? [viewers[1]] : viewers).map(advancing),
    );
    if (!pressureMode) {
      await viewers[0].locator('#video').evaluate((video) => video.pause());
      const paused = await sample(viewers[0]);
      report.otherViewerDuringPeerPause = await advancing(viewers[1]);
      const still = await sample(viewers[0]);
      expect(still.paused).toBe(true);
      expect(Math.abs(still.time - paused.time)).toBeLessThan(0.1);
      report.viewerPauseIndependent = true;
    }
  }
  await page.locator('#pause-button').click();
  report.hostResumed = await advancing(page);
  // Await installation receipts before clicking: neither listener may race the switch.
  await hostOwner.run('arm host metadata', () =>
    page.locator('#video').evaluate(armMetadataBarrier),
  );
  if (publicMode)
    await viewerOwners[1].run('arm remote metadata', () =>
      viewers[1].locator('#video').evaluate(armMetadataBarrier),
    );
  try {
    await page
      .locator('button[data-channel]')
      .filter({ hasText: 'Sharing sample two' })
      .first()
      .click();
    expect(
      await hostOwner.run(
        'new host metadata',
        () => page.locator('#video').evaluate((video) => video.fixtureMetadataBarrier.result),
        22000,
      ),
    ).toBe(true);
    await expect(page.locator('#watch-title')).toHaveText('Sharing sample two');
    await expect(page.locator('#playback-status')).toHaveText('Playing');
    report.hostNewChannelMetadataObserved = true;
    report.hostNewChannel = await advancing(page);
    if (publicMode) {
      expect(
        await viewerOwners[1].run(
          'new remote metadata',
          () =>
            viewers[1].locator('#video').evaluate((video) => video.fixtureMetadataBarrier.result),
          22000,
        ),
      ).toBe(true);
      report.viewerNewChannelMetadataObserved = true;
    }
  } finally {
    if (!hostOwner.dead)
      await hostOwner
        .run('cancel host metadata listener', () =>
          page.locator('#video').evaluate((video) => video.fixtureMetadataBarrier.cancel()),
        )
        .catch(() => {});
    if (publicMode && !viewerOwners[1].dead)
      await viewerOwners[1]
        .run('cancel remote metadata listener', () =>
          viewers[1].locator('#video').evaluate((video) => video.fixtureMetadataBarrier.cancel()),
        )
        .catch(() => {});
  }
  await expect
    .poll(async () => (await state(viewers[1])).body.revision, { timeout: 20000 })
    .not.toBe(publication.body.revision);
  const oldStatus = await viewers[1].evaluate(
    async (resource) => (await fetch(resource)).status,
    oldPath,
  );
  expect(oldStatus).toBe(401);
  report.oldPublicationRejected = oldStatus;
  if (publicMode) {
    report.viewerNewChannel = await advancing(viewers[1]);
  }
  panel = await settings();
  if (rawPressureMode) {
    await milestone('raw-pressure-start');
    const oldSecret =
      /View-only invitation: ([A-Za-z0-9_-]+)/.exec(await panel.textContent())?.[1] ?? '';
    await panel.getByRole('button', { name: 'New view-only invitation', exact: true }).click();
    await expect
      .poll(async () => {
        const secret =
          /View-only invitation: ([A-Za-z0-9_-]+)/.exec(await panel.textContent())?.[1] ?? '';
        return secret !== '' && secret !== oldSecret;
      })
      .toBe(true);
    const secret = /View-only invitation: ([A-Za-z0-9_-]+)/.exec(await panel.textContent())[1];
    report.rawPressureResources = [await resourceSample('before-raw-readers')];
    report.rawPressure = await rawConsumerPressure({
      address,
      ca: pem('CERTIFICATE', rootCertificate),
      secret,
      observeHealthy: async () => {
        const observation = { viewer: await advancing(viewers[1]), host: await advancing(page) };
        report.rawPressureResources.push(await resourceSample('raw-reader-observation'));
        return observation;
      },
    });
    report.rawPressureResources.push(await resourceSample('after-raw-readers'));
  }
  await panel.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await expect(panel).toContainText('Sharing is off');
  await closeSettings();
  report.hostAfterStopSharing = await advancing(page);
  report.listenerClosed = await viewers[1].evaluate(async (base) => {
    try {
      await fetch(base + '/state', { signal: AbortSignal.timeout(3000) });
      return false;
    } catch {
      return true;
    }
  }, address);
  expect(report.listenerClosed).toBe(true);
  report.status = publicMode ? 'PASS_EXPLORATORY' : 'PASS_PUBLICATION_ONLY';
  if (pressureMode && report.pressure.status !== 'PASS_EXPLORATORY')
    report.status = 'PARTIAL_PRESSURE_UNEXERCISED';
  if (rawPressureMode && report.rawPressure.status !== 'PASS_EXPLORATORY')
    report.status = 'PARTIAL_RAW_PRESSURE_UNEXERCISED';
  report.checks.push(
    'native UI explicit encrypted sharing; host pause preserves authoritative publication; old IDs refused after new channel; sharing stop leaves local decoder advancing',
  );
} catch (error) {
  if (String(error?.message).includes('INCOMPLETE_HARNESS_CDP'))
    report.status = 'INCOMPLETE_HARNESS_CDP';
  for (let index = 0; index < viewers.length; index++) {
    if (viewerOwners[index].dead) continue;
    await viewerOwners[index]
      .run('failure diagnostics', async () => {
        diagnostics[index].video = await viewers[index]
          .locator('#video')
          .evaluate((video) => ({
            time: video.currentTime,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            errorCode: video.error?.code ?? null,
          }))
          .catch(() => null);
        diagnostics[index].status = await viewers[index]
          .locator('#status')
          .textContent()
          .catch(() => null);
        /* eslint-disable no-undef -- Test-only injected viewer diagnostic object. */
        diagnostics[index].hlsErrors = await viewers[index]
          .evaluate(() => window.fixtureHlsErrors)
          .catch(() => null);
        /* eslint-enable no-undef */
      })
      .catch(() => {
        diagnostics[index].diagnosticIncomplete = true;
      });
  }
  report.failureDiagnostic = String(error?.message ?? 'Unknown fixture failure')
    .replace(/https?:\/\/[^\s"')]+/g, '[address]')
    .replace(/[A-Fa-f0-9]{64}/g, '[opaque token]')
    .slice(0, 1200);
  report.failure =
    'Sharing fixture assertion failed; inspect retained screenshots and observed report fields. External sample availability does not determine CI acceptance.';
  process.exitCode = 1;
  if (page && !hostOwner.dead)
    await hostOwner
      .run('host failure screenshot', () =>
        page.screenshot({ path: path.join(directory, 'host-failure.png') }),
      )
      .catch(() => {});
  for (let index = 0; index < viewers.length; index++)
    if (!viewerOwners[index].dead)
      await viewerOwners[index]
        .run('viewer failure screenshot', () =>
          viewers[index].screenshot({ path: path.join(directory, `viewer-${index}-failure.png`) }),
        )
        .catch(() => {});
} finally {
  for (let index = 0; index < viewerOwners.length; index++) {
    const owner = viewerOwners[index];
    if (!owner.dead) {
      if (viewerBrowsers[index])
        await owner.run('viewer close', () => viewerBrowsers[index].close()).catch(() => {});
      if (!owner.dead)
        await owner.kill().catch(() => {
          report.cleanupFailure = 'Viewer process closure unconfirmed';
          process.exitCode = 1;
        });
    }
  }
  try {
    await shutdown();
  } catch {
    report.status = 'FAIL';
    report.cleanupFailure = 'Owned application graceful exit unconfirmed';
    process.exitCode = 1;
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await fixture.close();
  await milestone('cleanup-complete');
  report.cleanup = {
    catalogSockets: sockets.size,
    catalogResponses: activeResponses,
    fixture: fixture.stats(),
    catalogRequests,
    unselectedRequests,
    exitCount: report.exitCount,
    isolatedViewerBrowsersClosed: viewerBrowsers.length,
    viewerProcessOwners: viewerOwners.map((owner) => ({
      pid: owner.pid,
      transportClosed: owner.terminationConfirmed === true,
    })),
  };
  report.viewerDiagnostics = diagnostics;
  if (
    hostOwner?.timedOut ||
    viewerOwners.some((owner) => owner.timedOut || !owner.terminationConfirmed)
  ) {
    report.status = 'INCOMPLETE_HARNESS_CDP';
    process.exitCode = 1;
  }
  if (
    sockets.size !== 0 ||
    activeResponses !== 0 ||
    fixture.stats().activeResponses !== 0 ||
    fixture.stats().activeSockets !== 0 ||
    fixture.stats().timers !== 0
  ) {
    report.status = 'FAIL';
    report.cleanupFailure = 'Owned fixture resources did not return to zero.';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ status: report.status, report: path.join(directory, 'report.json') }),
  );
}
