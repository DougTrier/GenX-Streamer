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

/* global window, document, CSS, performance, Event, WebSocket -- callbacks execute only inside GenX's WebView. */
// Device check (owner request, October 23, 2026): one repeatable pass over an
// installed GenX with the device's own channels, changing no saved data.
// Plays channels muted and records, from GenX's own page and its live
// ownership counters:
//   - decoded playback (media time and frames advance) and start times;
//   - rapid switching: only the last choice plays, one engine at a time;
//   - pause/resume; fullscreen and the device's Back key, without a second engine;
//   - the Guide opened while a channel plays;
//   - directional keys move focus inside GenX;
//   - a channel marked as failing ends in a clear message, not "Playing";
// Puts back the library, category, search and sound it found. A channel stays
// playing: follow with scripts/android-exit-check.mjs, whose ordinary exit and
// clean relaunch also prove cleanup (and return GenX to its idle start).
//
//   ADB=<adb> node scripts/device-check.mjs <adb-serial> <out.json>
// Exit code 0 PASS, 1 FAIL (a check failed), 3 INCOMPLETE (could not run).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

const run = promisify(execFile);
const [SERIAL, OUT] = process.argv.slice(2);
if (!SERIAL || !OUT) {
  console.error('usage: device-check.mjs <adb-serial> <out.json>');
  process.exit(3);
}
const adb = async (...args) =>
  (
    await run(process.env.ADB ?? 'adb', ['-s', SERIAL, ...args], {
      windowsHide: true,
      timeout: 60000,
    })
  ).stdout.trim();
const report = {
  serial: SERIAL,
  started: new Date().toISOString(),
  checks: [],
  status: 'INCOMPLETE',
};
const check = (name, pass, detail = {}) => report.checks.push({ name, pass: !!pass, ...detail });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let port;
let found;
let page;
try {
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  report.apkSha256 = (
    await adb('shell', 'sha256sum $(pm path com.tmg.tv | sed s/package://)')
  ).slice(0, 64);
  const pid = (await adb('shell', 'pidof com.tmg.tv')).split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error('GenX is not running');
  port = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  // Plain DevTools protocol: some Android WebViews refuse Playwright's
  // browser-context setup (the Flip 2's does).
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = pages.find(
    (entry) => entry.type === 'page' && entry.url.includes('tauri.localhost'),
  );
  if (!target) throw new Error('GenX page not found');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  const evaluate = (fn, argument) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, (data) =>
        data.result?.exceptionDetails || data.error
          ? reject(
              new Error(JSON.stringify(data.result?.exceptionDetails ?? data.error).slice(0, 300)),
            )
          : resolve(data.result?.result?.value),
      );
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: `(${fn})(${JSON.stringify(argument ?? null)})`,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      );
    });
  page = { evaluate };
  const click = (id) => evaluate((element) => document.getElementById(element)?.click(), id);
  const text = (id) =>
    evaluate((element) => document.getElementById(element)?.textContent ?? '', id);
  const state = () =>
    page.evaluate(() => ({
      paid: document.getElementById('paid-tv-button')?.getAttribute('aria-pressed') === 'true',
      category: document.getElementById('category-button')?.textContent?.trim() ?? '',
      search: document.getElementById('search')?.value ?? '',
      muted: document.getElementById('mute-button')?.getAttribute('aria-pressed') === 'true',
      status: document.getElementById('playback-status')?.textContent ?? '',
      title: document.getElementById('watch-title')?.textContent?.trim() ?? '',
    }));
  const owners = () => page.evaluate(() => window.__GENX_PLAYBACK_OWNERS__?.counts ?? null);
  found = await state();
  report.found = found;
  await page.evaluate(() => {
    const mute = document.getElementById('mute-button');
    if (mute?.getAttribute('aria-pressed') !== 'true') mute?.click();
  });
  // The device's own channels: the first rows that have not failed checks.
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.channel-row')]
      .map((row) => ({
        id: row.querySelector('button[data-channel]')?.dataset.channel,
        failing: row.dataset.notResponding === 'true',
      }))
      .filter((row) => row.id),
  );
  const healthy = rows.filter((row) => !row.failing).map((row) => row.id);
  report.rowsSeen = rows.length;
  const play = (id) =>
    page.evaluate(async (channel) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const video = document.getElementById('video');
      const status = () => document.getElementById('playback-status')?.textContent ?? '';
      document.querySelector(`button[data-channel="${CSS.escape(channel)}"]`)?.click();
      const started = performance.now();
      let first = null;
      while (performance.now() - started < 30000) {
        await sleep(200);
        if (status().startsWith('Playing') && video.currentTime > 0) {
          if (first === null)
            first = {
              time: video.currentTime,
              frames: video.getVideoPlaybackQuality().totalVideoFrames,
            };
          else if (video.currentTime - first.time >= 1)
            return {
              playing: true,
              startMs: Math.round(performance.now() - started),
              framesAdvanced: video.getVideoPlaybackQuality().totalVideoFrames - first.frames,
              size: `${video.videoWidth}x${video.videoHeight}`,
            };
        }
      }
      return { playing: false, status: status() };
    }, id);
  // 1. Decoded playback on several channels.
  const plays = [];
  for (const id of healthy.slice(0, 6)) plays.push(await play(id));
  report.plays = plays;
  const decoded = plays.filter((result) => result.playing && result.framesAdvanced > 0);
  check('decoded playback on the device’s own channels', decoded.length >= 3, {
    decoded: decoded.length,
    tried: plays.length,
  });
  // 2. Rapid switching: ten choices 100 ms apart; only the last one plays.
  const burst = healthy.slice(0, 10);
  if (burst.length >= 3) {
    const last = burst.at(-1);
    await page.evaluate(async (ids) => {
      for (const id of ids) {
        document.querySelector(`button[data-channel="${CSS.escape(id)}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }, burst);
    let peak = { controllerEngines: 0, browserEngines: 0, hlsInstances: 0 };
    let settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      await wait(300);
      const counts = (await owners()) ?? {};
      for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], counts[key] ?? 0);
      settled = (await state()).status.startsWith('Playing');
    }
    const current = await page.evaluate(
      () =>
        document.querySelector('.channel-row button[aria-current="true"]')?.dataset.channel ?? null,
    );
    check(
      'rapid switching ends on the last choice with one engine',
      settled &&
        current === last &&
        peak.controllerEngines <= 1 &&
        peak.browserEngines <= 1 &&
        peak.hlsInstances <= 1,
      {
        peakAfterBurst: peak,
        lastChosenIsCurrent: current === last,
      },
    );
  }
  // 3. Pause and resume.
  await click('pause-button');
  await wait(1500);
  const paused = (await state()).status;
  await click('pause-button');
  await wait(3000);
  check(
    'pause and resume',
    paused.startsWith('Paused') && (await state()).status.startsWith('Playing'),
    { paused },
  );
  // 4. Fullscreen and the device's Back key, without a second engine.
  await click('fullscreen-button');
  await wait(1500);
  const entered = await text('fullscreen-button');
  await adb('shell', 'input', 'keyevent', '4');
  await wait(1500);
  const left = await text('fullscreen-button');
  const afterBack = await owners();
  check(
    'fullscreen and Back without a second engine',
    /exit/i.test(entered ?? '') &&
      !/exit/i.test(left ?? '') &&
      (await state()).status.startsWith('Playing') &&
      (afterBack?.browserEngines ?? 0) <= 1,
    {
      entered: entered?.trim(),
      left: left?.trim(),
      engines: afterBack && {
        controller: afterBack.controllerEngines,
        browser: afterBack.browserEngines,
      },
    },
  );
  // 5. The Guide while a channel plays.
  await click('guide-button');
  await wait(3000);
  const guideOpen = await page.evaluate(() => {
    const open = [
      ...document.querySelectorAll(
        'dialog[open], [role="dialog"]:not([hidden]), .guide-panel:not([hidden])',
      ),
    ];
    return open.some((element) => element.getBoundingClientRect().height > 0);
  });
  const whileGuide = (await state()).status;
  await adb('shell', 'input', 'keyevent', '4');
  await wait(1500);
  check(
    'Guide opens while a channel keeps playing',
    guideOpen && whileGuide.startsWith('Playing'),
    { whileGuide },
  );
  // 6. Directional keys move focus inside GenX.
  const focused = [];
  for (const key of ['20', '20', '22', '19']) {
    await adb('shell', 'input', 'keyevent', key);
    await wait(400);
    focused.push(
      await page.evaluate(() => {
        const element = document.activeElement;
        return element && element !== document.body
          ? element.id || element.className || element.tagName
          : null;
      }),
    );
  }
  check(
    'directional keys move focus inside GenX',
    focused.filter(Boolean).length >= 3 && new Set(focused).size >= 2,
    { focused },
  );
  // 7. A channel marked as failing ends in a clear message.
  const failing = rows.find((row) => row.failing);
  if (failing) {
    const outcome = await play(failing.id);
    const message = await page.evaluate(
      () =>
        document
          .getElementById('player-overlay')
          ?.innerText.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160) ?? '',
    );
    check('a failing channel ends in a clear message', !outcome.playing && message.length > 10, {
      status: outcome.status,
      message,
    });
  } else
    report.checks.push({
      name: 'a failing channel ends in a clear message',
      pass: null,
      note: 'no failing row on screen',
    });
  report.status = report.checks.every((item) => item.pass !== false) ? 'PASS' : 'FAIL';
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  if (found && page) {
    await page
      .evaluate(async (wanted) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const paid = document.getElementById('paid-tv-button');
        if ((paid?.getAttribute('aria-pressed') === 'true') !== wanted.paid)
          document.getElementById(wanted.paid ? 'paid-tv-button' : 'live-tv-button')?.click();
        await sleep(4000);
        const search = document.getElementById('search');
        search.value = wanted.search;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1500);
        const mute = document.getElementById('mute-button');
        if ((mute?.getAttribute('aria-pressed') === 'true') !== wanted.muted) mute?.click();
      }, found)
      .catch(() => undefined);
    report.restored = await page
      .evaluate(() => ({
        paid: document.getElementById('paid-tv-button')?.getAttribute('aria-pressed') === 'true',
        category: document.getElementById('category-button')?.textContent?.trim() ?? '',
        search: document.getElementById('search')?.value ?? '',
        muted: document.getElementById('mute-button')?.getAttribute('aria-pressed') === 'true',
        status: document.getElementById('playback-status')?.textContent ?? '',
      }))
      .catch(() => null);
  }
  socket?.close();
  if (port) await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined);
  report.finished = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      {
        status: report.status,
        checks: report.checks.map(
          (c) => `${c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'N/A '} ${c.name}`,
        ),
        error: report.error,
        restored: report.restored,
      },
      null,
      1,
    ),
  );
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 3;
}
