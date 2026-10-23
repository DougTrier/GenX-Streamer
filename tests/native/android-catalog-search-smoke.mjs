import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createSearchFixture,
  measureCatalogSearch,
} from '../../scripts/measure-catalog-search.mjs';
import path from 'node:path';

const serial = process.argv[2];
const expectedApkArguments = process.argv.filter((argument) =>
  argument.startsWith('--expected-apk-sha256='),
);
if (
  expectedApkArguments.length !== 1 ||
  !/^--expected-apk-sha256=[a-f0-9]{64}$/.test(expectedApkArguments[0])
)
  throw new Error('One explicit lowercase SHA256 --expected-apk-sha256 is required.');
const expectedApkSha256 = expectedApkArguments[0].split('=')[1];
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
  'artifacts/android-catalog-search',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  status: 'FAIL',
  serial,
  started: new Date().toISOString(),
  scope:
    'Physical Android actual 100k file import, Sports-filter visible-frame search; no media, speech or receiver action',
  checks: [],
};
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
  page.setDefaultTimeout(60000);
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

try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw new Error('Approved device mismatch');
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  apkPath = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!apkPath || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(apkPath))
    throw new Error('Installed APK unavailable');
  report.apkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
  report.expectedApkSha256 = expectedApkSha256;
  if (report.apkSha256 !== expectedApkSha256) throw new Error('Expected exact frozen APK');
  await launch();
  original = await invoke('read_record_pair');
  if (!original.catalog || !original.preferences)
    throw new Error('Existing reversible pair required');
  report.initialMetadata = {
    catalogRevision: original.catalogRevision,
    healthRevision: original.healthRevision,
    healthInitialized: original.health !== null,
  };
  await invoke('write_record_pair', {
    catalog: JSON.stringify({ schemaVersion: 1, sources: [], channels: [] }),
    preferences: JSON.stringify({ ...JSON.parse(original.preferences), sources: [] }),
  });
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
  const bytes = createSearchFixture();
  report.fixture = {
    seed: 'bench-100k-even-sports-odd-news-v1',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entries: 100000,
  };
  await page.locator('#import-button').click();
  const picker = page.waitForEvent('filechooser');
  await page.locator('#playlist-file').click();
  await (await picker).setFiles({ name: 'benchmark.m3u', mimeType: 'text/plain', buffer: bytes });
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 60000 });
  await expect(page.locator('#channel-count')).toHaveText('100,000 channels', { timeout: 60000 });
  report.initialDomRows = await page.locator('.channel').count();
  if (report.initialDomRows >= 30) throw new Error('Rendering exceeded bounded rows');
  report.measurements = await measureCatalogSearch(page);
  await page.screenshot({ path: path.join(directory, 'measured.png') });
  if (!report.measurements.summary.every((group) => group.within200Ms))
    throw new Error('Search p95 exceeds 200ms budget');
  report.checks.push(
    'Full 100k actual frontend file import; 30 cold-reloaded document and 30 warm Sports-filter searches through visible frame',
  );
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.message ?? error);
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
        report.restoredMetadata = {
          catalogRevision: restored.catalogRevision,
          healthRevision: restored.healthRevision,
          initializedEmptyInsteadOfNull: original.health === null,
        };
      }
    } catch (error) {
      failed(error);
    }
    try {
      await shutdown();
      report.nativeProcessExitConfirmed = true;
    } catch (error) {
      failed(error);
    }
  }
  await browser?.close().catch(failed);
  if (forwardedPort) await adb('forward', '--remove', `tcp:${forwardedPort}`).catch(failed);
  if (apkPath) {
    report.finalApkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
    if (report.finalApkSha256 !== report.apkSha256) failed('Installed APK changed');
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        directory,
        status: report.status,
        error: report.error,
        summary: report.measurements?.summary,
      },
      null,
      2,
    ),
  );
}
