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

import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const serial = process.env.GENX_APPROVED_FLIP_SERIAL ?? '';
const expected = '795029aea059dc54dcfabcac99a3b545b06c713bbd28b64096b50e011ae5be5b';
const execute = promisify(execFile);
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const directory = path.resolve(
  'artifacts/android-fullscreen-format',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  status: 'FAIL',
  serial,
  scope: 'One owned-window fullscreen field-format diagnostic; no streams or rotation changes',
  snapshots: [],
};
let browser, page, forward, originals, originalDisplay, apk;
/* eslint-disable no-undef -- This closure executes inside the owned Android WebView. */
const invoke = (command) =>
  page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
/* eslint-enable no-undef */
async function settings() {
  return {
    accelerometer_rotation: await adb(
      'shell',
      'settings',
      'get',
      'system',
      'accelerometer_rotation',
    ),
    user_rotation: await adb('shell', 'settings', 'get', 'system', 'user_rotation'),
  };
}
/* eslint-disable no-undef -- Geometry closure executes inside the owned Android WebView. */
async function snapshot(stage) {
  const dump = await adb('shell', 'dumpsys', 'window', 'windows');
  const blocks = dump.split(/\n\s*(?=Window #\d+ Window\{)/);
  const own = blocks.filter((block) =>
    /^\s*Window #\d+ Window\{[^\n]*com\.tmg\.tv\/[^\n]*MainActivity/.test(block),
  );
  const relevant =
    /Insets|insets|Requested|requested|Visibility|Visibilities|VisibleTypes|mSystemUiVisibility|mViewVisibility|mHasSurface|mFrame|mAttrs|mLayoutSeq|mDisplayId/;
  report.snapshots.push({
    stage,
    ownWindowCount: own.length,
    windows: own.map((block) => ({
      heading: block.split('\n')[0].trim(),
      fields: block
        .split('\n')
        .filter((line) => relevant.test(line))
        .map((line) => line.trim().slice(0, 1024))
        .slice(0, 120),
    })),
    focusMatchesOwned: dump
      .split('\n')
      .some((line) => /mCurrentFocus=|mFocusedApp=/.test(line) && /com\.tmg\.tv/.test(line)),
    label: await page.locator('#fullscreen-button').textContent(),
    geometry: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  });
}
/* eslint-enable no-undef */
try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw Error('Approved model mismatch');
  apk = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!apk || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(apk))
    throw Error('APK path unavailable');
  report.apkSha256 = (await adb('shell', 'sha256sum', apk)).split(/\s/)[0];
  if (report.apkSha256 !== expected) throw Error('Installed APK mismatch');
  originalDisplay = await settings();
  report.originalDisplaySettings = originalDisplay;
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  forward = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${forward}`, {
        timeout: 1000,
        noDefaults: true,
      });
      break;
    } catch {
      await wait(100);
    }
  }
  if (!browser) throw Error('WebView unavailable');
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  originals = await invoke('read_record_pair');
  await snapshot('baseline');
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await wait(300);
  await snapshot('entered');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
  await wait(300);
  await snapshot('back-exited');
  const after = await invoke('read_record_pair');
  report.logicalRecordsUnchanged =
    after.catalog === originals.catalog &&
    after.preferences === originals.preferences &&
    after.health === originals.health;
  report.revisions = {
    before: { catalog: originals.catalogRevision, health: originals.healthRevision },
    after: { catalog: after.catalogRevision, health: after.healthRevision },
  };
  if (!report.logicalRecordsUnchanged) throw Error('Unexpected canonical data change');
  expect(await settings()).toEqual(originalDisplay);
  report.displaySettingsUnchanged = true;
  report.status = 'PASS_DIAGNOSTIC';
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  const failed = (error) => {
    report.cleanupError = String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  };
  if (page) {
    await invoke('request_exit').catch(() => {});
    let exited = false;
    for (let i = 0; i < 50; i++) {
      try {
        await adb('shell', 'pidof', 'com.tmg.tv');
      } catch (error) {
        if (error.code === 1) {
          exited = true;
          break;
        }
        failed(error);
        break;
      }
      await wait(100);
    }
    report.nativeProcessExitConfirmed = exited;
    if (!exited) failed('Native process remains');
  }
  await browser?.close().catch(failed);
  if (forward) await adb('forward', '--remove', `tcp:${forward}`).catch(failed);
  if (apk) {
    report.finalApkSha256 = (await adb('shell', 'sha256sum', apk)).split(/\s/)[0];
    if (report.finalApkSha256 !== expected) failed('APK changed');
  }
  if (originalDisplay) {
    report.finalDisplaySettings = await settings();
    if (JSON.stringify(report.finalDisplaySettings) !== JSON.stringify(originalDisplay))
      failed('Display settings changed');
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, error: report.error }));
}
