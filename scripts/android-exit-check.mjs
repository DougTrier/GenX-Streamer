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

// LX10/LX11 (docs/lifecycle-media-invariants.md): GenX's ordinary exit on a
// physical Android device leaves no GenX native crash in an observation window,
// and a relaunch starts cleanly. Prints one JSON report; exit code 0 PASS,
// 1 FAIL, 3 INCOMPLETE (for example a locked device: it never enters a PIN).
//
// Usage: node scripts/android-exit-check.mjs <adb-serial> [launcher-category] [observe-seconds]
// Requires adb (ANDROID_HOME or the default SDK path) and a debuggable GenX build.
// Never force-stops GenX: it asks GenX itself to exit (request_exit).
/* global WebSocket -- built into Node 22 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const [serial, category = 'android.intent.category.LAUNCHER', observeArg = '60'] =
  process.argv.slice(2);
if (!serial) {
  console.error(
    'usage: node scripts/android-exit-check.mjs <adb-serial> [launcher-category] [observe-seconds]',
  );
  process.exit(2);
}
const sdk = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const adbPath = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adb = async (...args) =>
  (
    await run(adbPath, ['-s', serial, ...args], { windowsHide: true, timeout: 60_000 })
  ).stdout.trim();
const shell = (command) => adb('shell', command).catch(() => '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pid = async () => (await shell('pidof com.tmg.tv')).trim();
const activityCount = async () =>
  Number((await shell('dumpsys activity activities | grep -c "com.tmg.tv/"')).trim() || 0);
const genxCrashes = async () =>
  (await shell('logcat -d -b crash'))
    .split('\n')
    .filter((line) => /com\.tmg\.tv|FORTIFY/.test(line) && !/ F crashpad/.test(line));

const locked = async () =>
  /mDreamingLockscreen=true|isKeyguardShowing=true|mShowingLockscreen=true/.test(
    await shell(
      'dumpsys window | grep -E "mDreamingLockscreen|isKeyguardShowing|mShowingLockscreen"',
    ),
  );
const report = { serial, invariant: ['LX10', 'LX11'], steps: [], status: 'FAIL' };
let blocked = null;
const step = (name, ok, detail) => report.steps.push({ name, ok, ...(detail ? { detail } : {}) });

async function requestExit() {
  const processId = await pid();
  if (!processId) return 'not running';
  const port = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${processId}`);
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = pages.find((p) => p.type === 'page' && p.url.includes('tauri.localhost'));
    if (!page) return 'no app page';
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: "window.__TAURI_INTERNALS__.invoke('request_exit')" },
      }),
    );
    for (let i = 0; i < 240; i++) {
      if (!(await pid()).split(/\s+/).includes(processId)) break;
      await wait(500);
    }
    try {
      ws.close();
    } catch {}
    return (await pid()).split(/\s+/).includes(processId) ? 'still running' : 'exited';
  } finally {
    await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined);
  }
}

try {
  await shell('input keyevent KEYCODE_WAKEUP');
  if (!(await pid())) {
    await shell(`monkey -p com.tmg.tv -c ${category} 1`);
    await wait(20_000);
  } else {
    // Android freezes background apps; bring GenX forward so it hears the request.
    await shell(`monkey -p com.tmg.tv -c ${category} 1`);
    await wait(6_000);
  }
  if (await locked())
    blocked = 'device locked before exit (unlock it; the check never enters a PIN)';
  const original = await pid();
  step('running before exit', Boolean(original));
  await adb('logcat', '-c', '-b', 'crash').catch(() => undefined);
  const exit = await requestExit();
  const finished = (await activityCount()) === 0;
  step('ordinary exit finished the task', exit === 'exited' || finished, exit);
  await wait(Number(observeArg) * 1000);
  const afterExit = await genxCrashes();
  step(
    `no GenX crash within ${observeArg} s of exit`,
    afterExit.length === 0,
    afterExit.slice(0, 3),
  );
  // Android may start a separate background GenX process later (profile
  // compilation); the check is that the exiting process itself ended.
  step('exiting process ended', !(await pid()).split(/\s+/).includes(original));
  await shell('input keyevent KEYCODE_WAKEUP');
  if (!blocked && (await locked()))
    blocked = 'device locked during the observation window; relaunch not checked';
  await shell(`monkey -p com.tmg.tv -c ${category} 1`);
  let resumed = false;
  for (let i = 0; i < 30 && !resumed; i++) {
    await wait(2_000);
    resumed = /com\.tmg\.tv\/\.MainActivity/.test(
      await shell('dumpsys activity activities | grep -m1 topResumedActivity'),
    );
  }
  step('relaunch resumed MainActivity', resumed);
  await wait(10_000);
  const afterRelaunch = await genxCrashes();
  step('no GenX crash after relaunch', afterRelaunch.length === 0, afterRelaunch.slice(0, 3));
  const failed = report.steps.filter((s) => !s.ok).map((s) => s.name);
  if (blocked && failed.every((name) => /relaunch/.test(name))) {
    // A blocked check is incomplete, never a pass (AGENTS.md).
    report.status = 'INCOMPLETE';
    report.blocked = blocked;
  } else report.status = failed.length === 0 ? 'PASS' : 'FAIL';
} catch (error) {
  step('check ran', false, String(error).slice(0, 200));
}
report.finished = new Date().toISOString();
console.log(JSON.stringify(report, null, 1));
process.exitCode = report.status === 'PASS' ? 0 : report.status === 'INCOMPLETE' ? 3 : 1;
