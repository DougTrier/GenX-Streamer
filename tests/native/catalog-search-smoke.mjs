/* global window */
import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  createSearchFixture,
  measureCatalogSearch,
} from '../../scripts/measure-catalog-search.mjs';

if (process.argv.length !== 3 || process.platform !== 'win32')
  throw new Error(
    'Usage on Windows: node tests/native/catalog-search-smoke.mjs explicit-executable',
  );
const executableInput = path.resolve(process.argv[2]);
const directory = path.resolve(
  'artifacts/catalog-search-native',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'tmg-tv.exe');
await copyFile(executableInput, executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'FAIL',
  scope:
    'Windows packaged catalog search only; not Android, guide search or final release acceptance',
  started: new Date().toISOString(),
  executableInput,
  sha256: hash(await readFile(executable)),
  cleanup: {},
};
let app, browser, page;
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
try {
  const execute = promisify(execFile);
  const hardware = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  report.referenceDevice = {
    platform: process.platform,
    architecture: process.arch,
    cpu: JSON.parse(hardware.stdout),
  };
  const bytes = createSearchFixture();
  report.fixture = {
    seed: 'bench-100k-even-sports-odd-news-v1',
    bytes: bytes.length,
    sha256: hash(bytes),
  };
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: path.join(directory, 'data'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.exitCode !== null || report.launchFailed)
      throw new Error('Owned app exited before readiness');
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Native CDP readiness timeout');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#import-button').click();
  await page
    .locator('#playlist-file')
    .setInputFiles({ name: 'benchmark.m3u', mimeType: 'text/plain', buffer: bytes });
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 60000 });
  await expect(page.locator('#channel-count')).toHaveText('100,000 channels', { timeout: 60000 });
  report.initialDomRows = await page.locator('.channel').count();
  if (report.initialDomRows >= 30)
    throw new Error('Catalog rendering exceeded bounded row expectation');
  report.measurements = await measureCatalogSearch(page);
  if (!report.measurements.summary.every((group) => group.within200Ms))
    throw new Error('Search p95 exceeds 200ms budget');
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.message ?? error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (page) {
    let timer;
    await Promise.race([
      page.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit')).catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
  }
  await browser?.close().catch(() => undefined);
  if (app?.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000);
      app.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  if (app?.exitCode === null) {
    app.kill();
    report.cleanup.forcedTermination = true;
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.cleanup.nativeProcessExited = app ? app.exitCode !== null : true;
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
