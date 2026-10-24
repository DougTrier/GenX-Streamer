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

import { openSourceImport } from './settings-navigation-helper.mjs';
import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Pass an explicit fresh P07 executable; this runner never builds it.');
const directory = path.resolve(
  'artifacts/playback-error-native',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'tmg-tv.exe');
await copyFile(path.resolve(input), executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = hash(await readFile(executable));
const report = {
  scope:
    'Windows packaged native P07 IPC and visible failure actions; controlled fixtures, DNS diagnostic may remain pending',
  started: new Date().toISOString(),
  sha256,
  status: 'FAIL',
  checks: [],
  cleanup: { confirmed: false },
  dns: { status: 'pending' },
};
const sockets = new Set(),
  responses = new Set();
let totalRequests = 0;
function track(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return server;
}
function owned(response) {
  responses.add(response);
  response.once('close', () => responses.delete(response));
  response.once('finish', () => responses.delete(response));
}
let httpUrl, tlsUrl;
const plain = track(
  http.createServer((request, response) => {
    owned(response);
    totalRequests++;
    const route = new URL(request.url, 'http://fixture.invalid').pathname;
    if (route === '/headers') return;
    if (route === '/body') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.write('#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
      return;
    }
    if (route === '/catalog') {
      response.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
      response.end(
        `#EXTM3U\n#EXTINF:-1,TLS refusal fixture\n${tlsUrl}/certificate\n#EXTINF:-1,Access refusal fixture\n${httpUrl}/status/403\n#EXTINF:-1,Body timeout fixture\n${httpUrl}/body\n`,
      );
      return;
    }
    const code = Number(route.split('/').at(-1));
    if ([401, 403, 404, 429, 503].includes(code)) {
      if (code === 429 || code === 503) response.setHeader('Retry-After', code === 429 ? '7' : '9');
      response.writeHead(code, { 'Content-Type': 'text/plain' });
      response.end('Controlled failure');
      return;
    }
    response.writeHead(404);
    response.end();
  }),
);
const identity = path.resolve('src-tauri/src/lan/fixtures');
const certBytes = await readFile(path.join(identity, 'loopback-cert.der'));
const certificate = new X509Certificate(certBytes).toString();
const key = createPrivateKey({
  key: await readFile(path.join(identity, 'loopback-key.der')),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' });
const secure = track(
  https.createServer({ cert: certificate, key }, (request, response) => {
    owned(response);
    totalRequests++;
    if (request.url === '/downgrade') {
      response.writeHead(302, { Location: httpUrl + '/status/403' });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end('Controlled TLS endpoint');
  }),
);
// Handshake refusal is expected; no fixture certificate is installed or trusted.
secure.on('tlsClientError', () => {});
await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
httpUrl = `http://127.0.0.1:${plain.address().port}`;
tlsUrl = `https://127.0.0.1:${secure.address().port}`;
report.tlsFixtureSha256 = hash(certBytes);
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
async function invokeFailure(command, url, allowHttp = true) {
  const result = await page.evaluate(
    async ({ command, url, allowHttp }) => {
      const invoke = Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke;
      try {
        const value = await invoke(command, {
          url,
          allowHttp,
          requestId: globalThis.crypto.randomUUID(),
        });
        return {
          ok: true,
          status: value.status,
          retryAfter: value.headers?.['retry-after'] ?? null,
        };
      } catch (error) {
        if (typeof error !== 'string' || error.length > 1024) return { ok: false, invalid: true };
        try {
          const value = JSON.parse(error);
          return {
            ok: false,
            category: value.category,
            phase: value.phase,
            status: value.status,
            retryAfter: value.retryAfter,
          };
        } catch {
          return { ok: false, invalid: true };
        }
      }
    },
    { command, url, allowHttp },
  );
  if (result.invalid)
    throw new Error('Native playback did not return a bounded structured envelope');
  return result;
}
try {
  const data = path.join(directory, 'data');
  await mkdir(data, { recursive: true });
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  let endpoint;
  for (let n = 0; n < 200; n++) {
    if (app.exitCode !== null || report.launchFailed)
      throw new Error('Owned application unavailable');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const version = await response.json();
        endpoint = version.webSocketDebuggerUrl;
        report.webview = version.Browser;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Owned WebView endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No owned page');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  for (const command of ['inspect_source', 'fetch_media']) {
    for (const status of [401, 403, 404, 429, 503]) {
      report.activeCheck = { fixture: `HTTP${status}`, command };
      const value = await invokeFailure(command, httpUrl + `/status/${status}`);
      report.checks.push({ fixture: `HTTP${status}`, command, value });
      expect(value.status).toBe(status);
      if (command === 'inspect_source') {
        expect(value.ok).toBe(false);
        expect(value.category).toBe('http');
        expect(value.phase).toBe('headers');
      } else expect(value.ok).toBe(true);
      if (status === 429 || status === 503)
        expect(value.retryAfter).toBe(status === 429 ? '7' : '9');
    }
    for (const [fixture, url, category, phase] of [
      ['refused-scheme', 'file:///controlled-refusal', 'url-policy-refused', 'unknown'],
      ['HTTP-not-granted', httpUrl + '/status/403', 'url-policy-refused', 'unknown'],
      ['untrusted-TLS', tlsUrl + '/certificate', 'tls-failure', 'connect'],
      ['delayed-headers', httpUrl + '/headers', 'timeout', 'unknown'],
      ['partial-body', httpUrl + '/body', 'timeout', 'body'],
    ]) {
      const value = await invokeFailure(command, url, fixture !== 'HTTP-not-granted');
      report.activeCheck = { fixture, command };
      report.checks.push({ fixture, command, value });
      expect(value.ok).toBe(false);
      expect(value.category).toBe(category);
      expect(value.phase).toBe(phase);
    }
  }
  // Reqwest returns unsupported-scheme redirects without following them. A separate
  // credential-bearing HTTP target exercises the custom redirect policy.
  let redirectRequests = 0;
  const redirect = track(
    http.createServer((request, response) => {
      owned(response);
      redirectRequests++;
      response.writeHead(302, {
        Location:
          request.url === '/credentials'
            ? `http://fixture:fixture@127.0.0.1:${redirect.address().port}/never-follow`
            : 'file:///controlled-refusal',
      });
      response.end();
    }),
  );
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    for (const fixture of ['unsupported-scheme-redirect', 'credential-redirect']) {
      report.activeCheck = { fixture, command: 'inspect_source' };
      const before = redirectRequests;
      const value = await invokeFailure(
        'inspect_source',
        `http://127.0.0.1:${redirect.address().port}/${fixture === 'credential-redirect' ? 'credentials' : 'redirect'}`,
      );
      const requests = redirectRequests - before;
      report.checks.push({ fixture, command: 'inspect_source', value, requests });
      expect(value.ok).toBe(false);
      expect(requests).toBe(1);
      expect(value.phase).toBe('headers');
      if (fixture === 'unsupported-scheme-redirect') {
        expect(value.category).toBe('http');
        expect(value.status).toBe(302);
      } else expect(value.category).toBe('redirect-refused');
    }
  } finally {
    redirect.closeAllConnections();
    await new Promise((resolve) => redirect.close(resolve));
  }
  await openSourceImport(page);
  await page.locator('#allow-http').check();
  // Ordinary file fixture setup preserves negative/decoder baselines; not Scan proof.
  report.catalogSetup = {
    route: 'ordinary-local-playlist-file',
    scope: 'Synthetic catalog setup; not URL Scan acceptance',
  };
  await importFixtureCatalogFile(page, httpUrl + '/catalog');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  for (const [title, message] of [
    // Wording from src/playback/failure-guidance.ts (October 2026).
    ['TLS refusal fixture', /could not establish a secure connection/],
    ['Access refusal fixture', /refused|not allowed|denied/i],
    ['Body timeout fixture', /media download did not finish in time/],
  ]) {
    report.activeCheck = { fixture: title, command: 'visible-player' };
    await page.locator('button[data-channel]').filter({ hasText: title }).first().click();
    await expect(page.locator('#playback-status')).toHaveText('Unable to play', { timeout: 25000 });
    await expect(page.locator('#overlay-message')).toHaveText(message);
    const action = await page.locator('#overlay-message').textContent();
    expect(action).not.toMatch(/geograph|certificate.*bypass|127\.0\.0\.1|file:\/\//i);
    report.checks.push({ fixture: title, visibleAction: action });
  }
  const dns = await invokeFailure(
    'inspect_source',
    'https://genx-p07-owned-negative.invalid/source',
  );
  if (!dns.ok && dns.category === 'dns-failure') {
    report.dns = {
      status: 'measured',
      scope: 'bounded OS resolver negative .invalid diagnostic; not isolated DNS CI',
      value: dns,
    };
  } else {
    report.dns = {
      status: 'pending',
      reason: 'OS resolver did not establish the expected negative diagnostic',
    };
  }
  await page.screenshot({ path: path.join(directory, 'failure-actions.png') });
  report.status = report.dns.status === 'measured' ? 'PASS' : 'INCOMPLETE';
  if (report.status === 'INCOMPLETE') process.exitCode = 2;
} catch (error) {
  report.failure =
    error instanceof Error && error.message.startsWith('Native playback')
      ? error.message
      : 'A controlled playback error assertion failed; inspect retained redacted case results.';
  // The assertion text names the fixture, locator and expected wording only.
  if (error instanceof Error && !error.message.startsWith('Native playback'))
    report.assertion = error.message.slice(0, 600);
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    await page
      ?.evaluate(() => Reflect.get(globalThis, '__TAURI_INTERNALS__').invoke('request_exit'))
      .catch(() => {});
    const until = Date.now() + 5000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (app.exitCode === null && app.signalCode === null) {
      report.cleanup.forced = true;
      app.kill();
      const killedUntil = Date.now() + 5000;
      while (app.exitCode === null && app.signalCode === null && Date.now() < killedUntil)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await browser?.close().catch(() => {});
  const stopped = [plain, secure].map((server) => new Promise((resolve) => server.close(resolve)));
  for (const server of [plain, secure]) server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await Promise.all(stopped);
  report.cleanup = {
    ...report.cleanup,
    confirmed:
      !!app && (app.exitCode !== null || app.signalCode !== null) && !report.cleanup.forced,
    exitCode: app?.exitCode,
    signal: app?.signalCode,
    sockets: sockets.size,
    responses: responses.size,
    totalRequests,
  };
  if (!report.cleanup.confirmed || sockets.size || responses.size) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  if (hash(await readFile(executable)) !== sha256) {
    report.status = 'FAIL';
    report.binaryChanged = true;
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({ status: report.status, sha256, report: path.join(directory, 'report.json') }) +
      '\n',
  );
}
