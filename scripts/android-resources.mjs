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

import { saveCompletedSourceScan } from './scan-save-helper.mjs';
/* eslint-disable no-undef -- Public IPC/video callbacks run inside the explicitly owned Android WebView. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from './fixture-server.mjs';
const execute = promisify(execFile),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function parseAppUid(text) {
  const ids = [...text.matchAll(/\buserId=(\d+)\b/g)].map((match) => Number(match[1]));
  if (!ids.length || new Set(ids).size !== 1 || !Number.isSafeInteger(ids[0]) || ids[0] < 10000)
    throw new Error('App UID unavailable.');
  return ids[0];
}
export function parseUidProcesses(text, uid) {
  if (!Number.isSafeInteger(uid) || uid < 10000) throw new Error('Invalid app UID.');
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        parts.length === 3 &&
        /^\d+$/.test(parts[0]) &&
        /^\d+$/.test(parts[1]) &&
        Number(parts[1]) === uid,
    );
  if (rows.length > 32) throw new Error('UID process limit exceeded.');
  const result = rows.map((parts) => ({ pid: Number(parts[0]), uid }));
  if (
    result.some((row) => !Number.isSafeInteger(row.pid) || row.pid <= 0) ||
    new Set(result.map((row) => row.pid)).size !== result.length
  )
    throw new Error('Invalid UID process identity.');
  return result;
}
export function parseProcStat(text, pid) {
  const match = /^(\d+) \(.*\) (.*)$/.exec(text.trim());
  if (!match || Number(match[1]) !== pid) throw new Error('Process identity changed.');
  const fields = match[2].split(/\s+/),
    numbers = [11, 12, 19].map((index) => Number(fields[index]));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0) || !numbers[2])
    throw new Error('CPU stat unavailable.');
  return { pid, userTicks: numbers[0], systemTicks: numbers[1], startTicks: numbers[2] };
}
export function cpuDelta(before, after, elapsedMs, hz, cores) {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    !Number.isSafeInteger(hz) ||
    hz < 1 ||
    !Number.isSafeInteger(cores) ||
    cores < 1
  )
    throw new Error('CPU denominator unavailable.');
  if (before.pid !== after.pid || before.startTicks !== after.startTicks)
    return { status: 'identity-changed', cpuSeconds: null };
  const ticks = after.userTicks + after.systemTicks - before.userTicks - before.systemTicks;
  if (!Number.isFinite(ticks) || ticks < 0)
    return { status: 'counter-unavailable', cpuSeconds: null };
  const seconds = ticks / hz;
  return {
    status: 'measured',
    cpuSeconds: seconds,
    percentOneCore: (seconds / (elapsedMs / 1000)) * 100,
    percentMachine: (seconds / (elapsedMs / 1000) / cores) * 100,
  };
}
export function parsePss(text) {
  const modern = /TOTAL PSS:\s*(\d+)/.exec(text),
    legacy = /^\s*TOTAL\s+(\d+)\s+/m.exec(text),
    rss = /TOTAL RSS:\s*(\d+)/.exec(text);
  return {
    pssKiB: modern ? Number(modern[1]) : legacy ? Number(legacy[1]) : null,
    rssKiB: rss ? Number(rss[1]) : null,
  };
}
export function parsePower(text, uid) {
  const lines = text.split(/\r?\n/),
    marker = new RegExp(`\\buid=${uid}\\b|WorkSource\\{[^}]*\\b${uid}\\b`);
  const section = /Wake Locks:/.test(text);
  const count = lines.filter(
    (line) =>
      marker.test(line) &&
      /WakeLock|PARTIAL_WAKE_LOCK|SCREEN_BRIGHT_WAKE_LOCK|FULL_WAKE_LOCK/.test(line),
  ).length;
  return {
    wakeLockCount: section ? count : null,
    coverage: section ? 'UID-tagged wake-lock entries only' : 'unavailable',
  };
}
export function parseWindowFlags(text) {
  const blocks = text
    .split(/(?=Window #\d+ Window\{)/)
    .filter((block) => /^Window #\d+ Window\{[^\n]*com\.tmg\.tv[/.]/.test(block.trim()));
  const flags = blocks.map((block) => {
    const symbolic = /\bfl=([^]*?)\r?\n\s*pfl=/.exec(block)?.[1]?.trim();
    if (symbolic && /^[A-Z][A-Z0-9_]*(?:[\s|]+[A-Z][A-Z0-9_]*)*$/.test(symbolic))
      return /\bKEEP_SCREEN_ON\b/.test(symbolic);
    if (/\bKEEP_SCREEN_ON\b/.test(block)) return true;
    const match = /\bfl=(?:0x)?([a-fA-F0-9]+)\b/.exec(block);
    return match ? (parseInt(match[1], 16) & 0x80) !== 0 : null;
  });
  return {
    ownedWindows: blocks.length,
    keepScreenOn: flags.includes(true)
      ? true
      : flags.length && flags.every((flag) => flag === false)
        ? false
        : null,
  };
}
export function parseAndroidOptions(args) {
  const hashes = args.filter((arg) => /^--expected-apk-sha256=[a-f0-9]{64}$/.test(arg));
  if (
    args[0] !== (process.env.GENX_APPROVED_FLIP_SERIAL ?? '') ||
    args.filter((arg) => arg === '--physical-approved').length !== 1 ||
    hashes.length !== 1
  )
    throw new Error('Approved Flip2 and exact installed APK hash required.');
  const expected = hashes[0];
  if (
    !args.every(
      (arg, index) =>
        index === 0 ||
        arg === '--physical-approved' ||
        arg === expected ||
        /^--seconds=\d+$/.test(arg) ||
        /^--interval=\d+$/.test(arg),
    ) ||
    args.filter((arg) => arg.startsWith('--seconds=')).length > 1 ||
    args.filter((arg) => arg.startsWith('--interval=')).length > 1
  )
    throw new Error('Unknown measurement argument.');
  const seconds = Number(args.find((arg) => arg.startsWith('--seconds='))?.split('=')[1] ?? 10),
    interval = Number(args.find((arg) => arg.startsWith('--interval='))?.split('=')[1] ?? 2);
  if (seconds < 5 || seconds > 60 || interval < 2 || interval > 10)
    throw new Error('Invalid phase duration.');
  return { serial: args[0], expected, seconds, interval };
}
export async function waitForOwnedEndpoint({
  probe,
  connect,
  now = Date.now,
  sleep = wait,
  deadlineMs = 20000,
  onAttempt = () => {},
}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 20000)
    throw new Error('Invalid observer readiness deadline.');
  const deadline = now() + deadlineMs;
  let attempts = 0;
  while (now() < deadline) {
    onAttempt(++attempts, Math.max(1, deadline - now()));
    try {
      if (await probe(Math.max(1, Math.min(1000, deadline - now())))) {
        if (now() >= deadline) break;
        return await connect(Math.max(1, Math.min(10000, deadline - now())));
      }
    } catch (error) {
      // An outer observer timeout leaves an actual operation owned and pending.
      // Never start another connection until that ownership has settled.
      if (error instanceof Error && error.message === 'Observer deadline.') throw error;
    }
    if (now() < deadline) await sleep(Math.min(100, deadline - now()));
  }
  throw new Error('Owned observer readiness timed out.');
}
// Remove the one owned mapping even when settlement fails, and close handles
// only after pending connections settle so late browser handles remain reachable.
export async function drainOwnedObserver({ removeForward, settle, close }) {
  const failures = [];
  try {
    await removeForward();
  } catch (error) {
    failures.push(error);
  }
  try {
    await settle();
  } catch (error) {
    failures.push(error);
  }
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new Error('Observer settlement unconfirmed.');
}
export function classifyAndroidResourceError(error) {
  const message = error instanceof Error ? error.message : '';
  const known = {
    'Owned observer readiness timed out.': 'observer-readiness-timeout',
    'WebView unavailable.': 'page-missing',
    'Native app readiness timed out.': 'app-ready-timeout',
    'Original canonical pair required.': 'original-pair-required',
    'Installed APK mismatch.': 'apk-mismatch',
    'Observer deadline.': 'observer-operation-timeout',
    'Observer settlement unconfirmed.': 'observer-settlement-unconfirmed',
    'App PID identity changed.': 'process-identity-changed',
    'Observer ownership already exists.': 'observer-owner-conflict',
    'Graceful app exit unconfirmed.': 'graceful-exit-unconfirmed',
  };
  if (known[message]) return known[message];
  if (error?.code === 1) return 'adb-command-refused';
  return 'unclassified-redacted';
}
export function assessTerminalResources(fixture, catalogSockets) {
  const keys = ['activeSockets', 'activeResponses', 'timers'];
  if (
    !fixture ||
    !keys.every((key) => Number.isSafeInteger(fixture[key]) && fixture[key] >= 0) ||
    !Number.isSafeInteger(catalogSockets) ||
    catalogSockets < 0
  )
    return { clean: false, category: 'resource-observation-missing' };
  if (keys.some((key) => fixture[key] !== 0) || catalogSockets !== 0)
    return { clean: false, category: 'owned-resources-active' };
  return { clean: true, category: 'owned-resources-closed' };
}
export function requireOriginalPair(pair) {
  for (const key of ['catalog', 'preferences']) {
    if (typeof pair?.[key] !== 'string' || !pair[key].trim())
      throw new Error('Original canonical pair required.');
    let parsed;
    try {
      parsed = JSON.parse(pair[key]);
    } catch {
      throw new Error('Original canonical pair required.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Original canonical pair required.');
  }
  return pair;
}
export async function runRestoreCycle({ stop, launchIdle, restore }) {
  await stop();
  try {
    await launchIdle();
    await restore();
  } finally {
    await stop();
  }
}
export async function runAndroidResources(args) {
  const { expected, seconds, interval } = parseAndroidOptions(args);
  const serial = args[0],
    adbPath = path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
  const adb = async (...items) =>
    (
      await execute(adbPath, ['-s', serial, ...items], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 2097152,
      })
    ).stdout.trim();
  const directory = path.resolve(
    'artifacts/android-resources',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  await mkdir(directory, { recursive: true });
  const report = {
    status: 'FAIL',
    serial,
    started: new Date().toISOString(),
    scope:
      'Physical Flip2 app-UID resource measurement only; isolated WebView/GPU processes excluded unless attributable; no battery or performance acceptance',
    helperSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    phases: [],
  };
  let fixture,
    server,
    browser,
    page,
    forward,
    original,
    apkPath,
    uid,
    phase = 'preflight';
  const reverse = new Set();
  const catalogSockets = new Set();
  let launched = false;
  let ownedPid = null;
  report.launchCount = 0;
  report.exitCount = 0;
  report.ownedPids = [];
  report.observerConnections = [];
  const observerPending = new Set();
  const bounded = async (label, operation, ms = 10000) => {
    let timer;
    const entry = { label, promise: Promise.resolve().then(operation) };
    observerPending.add(entry);
    void entry.promise.finally(() => observerPending.delete(entry)).catch(() => {});
    try {
      return await Promise.race([
        entry.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            report.observerDeadline = true;
            reject(new Error('Observer deadline.'));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const invoke = (command, args = {}) =>
    bounded('native IPC', () =>
      page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
        command,
        args,
      }),
    );
  const connect = async () => {
    if (browser || page || observerPending.size)
      throw new Error('Observer ownership already exists.');
    phase = 'observer-pid';
    const pid = await adb('shell', 'pidof', 'com.tmg.tv');
    if (!/^\d+$/.test(pid)) throw new Error('App PID unavailable.');
    if (ownedPid && pid !== ownedPid) throw new Error('App PID identity changed.');
    ownedPid = pid;
    if (!report.ownedPids.includes(Number(pid))) report.ownedPids.push(Number(pid));
    phase = 'observer-forward';
    if (!forward)
      forward = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
    if (!/^\d+$/.test(forward)) throw new Error('Owned forward unavailable.');
    const connection = {
      started: new Date().toISOString(),
      attempts: 0,
      deadlineMs: 20000,
      connected: false,
    };
    report.observerConnections.push(connection);
    const origin = `http://127.0.0.1:${forward}`;
    phase = 'observer-readiness';
    await waitForOwnedEndpoint({
      probe: async (budget) => {
        const response = await fetch(origin + '/json/version', {
          signal: AbortSignal.timeout(budget),
        });
        if (!response.ok) return false;
        const version = await response.json();
        return typeof version.webSocketDebuggerUrl === 'string';
      },
      connect: (budget) =>
        bounded(
          'observer connect',
          async () => {
            // Assign inside the tracked operation, including a late settlement.
            browser = await chromium.connectOverCDP(origin, { timeout: budget, noDefaults: true });
            return browser;
          },
          budget,
        ),
      onAttempt: (attempt) => {
        connection.attempts = attempt;
      },
    });
    connection.connected = true;
    connection.finished = new Date().toISOString();
    phase = 'observer-page';
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.url().startsWith('devtools:'));
    if (!page) throw new Error('WebView unavailable.');
    page.setDefaultTimeout(10000);
    phase = 'app-ready';
    await expect(page.locator('#app'))
      .toHaveAttribute('data-ready', 'true', { timeout: 20000 })
      .catch(() => {
        throw new Error('Native app readiness timed out.');
      });
  };
  const closeObserver = async () => {
    await drainOwnedObserver({
      removeForward: async () => {
        if (forward) {
          await adb('forward', '--remove', `tcp:${forward}`);
          forward = undefined;
        }
      },
      settle: async () => {
        const pending = [...observerPending];
        if (pending.length)
          await bounded(
            'observer settlement',
            () => Promise.allSettled(pending.map((entry) => entry.promise)),
            5000,
          );
        if (observerPending.size) throw new Error('Observer settlement unconfirmed.');
      },
      close: async () => {
        if (browser) {
          const observed = browser;
          await bounded('observer close', () => observed.close(), 5000);
          browser = undefined;
          page = undefined;
        }
      },
    });
  };
  const shutdown = async () => {
    try {
      if (launched) {
        if (!page) {
          await closeObserver();
          await connect();
        }
        const currentPid = await adb('shell', 'pidof', 'com.tmg.tv').catch((error) => {
          if (error.code === 1) return '';
          throw error;
        });
        if (currentPid && currentPid !== ownedPid) throw new Error('App PID identity changed.');
        if (currentPid) await invoke('request_exit').catch(() => {});
        let exited = !currentPid;
        for (let i = 0; !exited && i < 50; i++) {
          try {
            const pid = await adb('shell', 'pidof', 'com.tmg.tv');
            if (pid !== ownedPid) throw new Error('App PID identity changed.');
          } catch (error) {
            if (error.code === 1) {
              exited = true;
              break;
            }
            throw error;
          }
          await wait(100);
        }
        if (!exited) throw new Error('Graceful app exit unconfirmed.');
        launched = false;
        ownedPid = null;
        report.exitCount++;
        report.nativeProcessExitConfirmed = true;
      }
    } finally {
      await closeObserver();
    }
  };
  const launchIdle = async () => {
    if (launched || browser || page || forward || observerPending.size)
      throw new Error('Previous instance ownership remains.');
    try {
      const pid = await adb('shell', 'pidof', 'com.tmg.tv');
      if (pid) throw new Error('App already active.');
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
    launched = true;
    report.launchCount++;
    report.nativeProcessExitConfirmed = false;
    await connect();
  };
  const restoreOriginal = async () => {
    const counts = await bounded('idle owners', () =>
      page.evaluate(() => window.__GENX_PLAYBACK_OWNERS__?.counts),
    );
    if (
      !counts ||
      counts.controllerEngines !== 0 ||
      counts.browserEngines !== 0 ||
      counts.nativeLoads !== 0
    )
      throw new Error('Restoration instance not idle.');
    const current = await invoke('read_record_pair');
    await invoke('write_record_pair', {
      catalog: original.catalog,
      preferences: original.preferences,
      health: original.health ?? JSON.stringify({ schemaVersion: 1, records: [] }),
      expectedCatalogRevision: current.catalogRevision,
      expectedHealthRevision: current.healthRevision,
    });
    const restored = await invoke('read_record_pair');
    report.originalLogicalRecordsRestored =
      restored.catalog === original.catalog &&
      restored.preferences === original.preferences &&
      JSON.stringify(JSON.parse(restored.health).records) ===
        JSON.stringify(original.health ? JSON.parse(original.health).records : []);
    if (!report.originalLogicalRecordsRestored) throw new Error('Record restoration unconfirmed.');
  };
  try {
    apkPath = (await adb('shell', 'pm', 'path', 'com.tmg.tv')).replace(/^package:/, '');
    if (!/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(apkPath))
      throw new Error('APK identity unavailable.');
    report.apkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
    if (report.apkSha256 !== expected.split('=')[1]) throw new Error('Installed APK mismatch.');
    try {
      const active = await adb('shell', 'pidof', 'com.tmg.tv');
      if (active) throw new Error('App already active.');
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    uid = parseAppUid(await adb('shell', 'dumpsys', 'package', 'com.tmg.tv'));
    report.uid = uid;
    const hzRaw = await adb('shell', 'getconf', 'CLK_TCK').catch(() => ''),
      coresRaw = await adb('shell', 'getconf', '_NPROCESSORS_ONLN').catch(() => '');
    const hz = /^\d+$/.test(hzRaw) ? Number(hzRaw) : null,
      cores = /^\d+$/.test(coresRaw) ? Number(coresRaw) : null;
    report.cpuDenominator = { hz, cores, missing: !hz || !cores };
    fixture = await startFixtureServer();
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/x-mpegurl');
      res.end(
        `#EXTM3U\n#EXTINF:-1 group-title="Fixture",Owned resource channel\n${fixture.url}/hls/live.m3u8\n`,
      );
    });
    server.on('connection', (socket) => {
      catalogSockets.add(socket);
      socket.once('close', () => catalogSockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const ports = [String(server.address().port), new URL(fixture.url).port],
      existing = await adb('reverse', '--list');
    for (const port of ports) {
      if (existing.split(/\r?\n/).some((line) => line.split(/\s+/).includes(`tcp:${port}`)))
        throw new Error('Reverse mapping already owned elsewhere.');
      await adb('reverse', `tcp:${port}`, `tcp:${port}`);
      reverse.add(port);
    }
    await launchIdle();
    phase = 'read-original';
    const saved = await invoke('read_record_pair');
    phase = 'validate-original';
    original = requireOriginalPair(saved);
    async function sample(name) {
      const processes = parseUidProcesses(
        await adb('shell', 'ps', '-A', '-o', 'PID,UID,NAME'),
        uid,
      );
      const rows = [];
      for (const process of processes) {
        const stat = await adb('shell', 'cat', `/proc/${process.pid}/stat`)
          .then((raw) => parseProcStat(raw, process.pid))
          .catch(() => null);
        const mem = await adb('shell', 'dumpsys', 'meminfo', String(process.pid))
          .then(parsePss)
          .catch(() => ({ pssKiB: null, rssKiB: null }));
        rows.push({ ...process, stat, ...mem });
      }
      const power = await adb('shell', 'dumpsys', 'power')
        .then((raw) => parsePower(raw, uid))
        .catch(() => ({ wakeLockCount: null, coverage: 'unavailable' }));
      const windows = await adb('shell', 'dumpsys', 'window', 'windows')
        .then(parseWindowFlags)
        .catch(() => ({ ownedWindows: 0, keepScreenOn: null }));
      const stats = fixture.stats();
      delete stats.requests;
      const row = {
        phase: name,
        at: new Date().toISOString(),
        monotonicMs: performance.now(),
        processes: rows,
        coverage: {
          uidProcesses: rows.length,
          cpuStatAvailable: rows.filter((row) => row.stat).length,
          pssAvailable: rows.filter((row) => row.pssKiB !== null).length,
          isolatedRendererExcluded: true,
          uidNetworkBytes: 'unavailable; fixture counters only',
        },
        power,
        windows,
        fixture: stats,
      };
      await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(row) + '\n');
      return row;
    }
    async function measure(name, observe = true) {
      phase = name;
      const readVideo = () =>
        bounded('video', () =>
          page.locator('#video').evaluate((v) => {
            const q = v.getVideoPlaybackQuality();
            return {
              paused: v.paused,
              time: v.currentTime,
              frames: q.totalVideoFrames - q.droppedVideoFrames,
              width: v.videoWidth,
              height: v.videoHeight,
            };
          }),
        );
      const videoBefore = observe ? await readVideo() : null;
      const first = await sample(name),
        samples = [];
      let previous = first;
      while (performance.now() - first.monotonicMs < seconds * 1000) {
        await wait(interval * 1000);
        const next = await sample(name);
        next.cpu = next.processes.map((item) => {
          const old = previous.processes.find((row) => row.pid === item.pid);
          return {
            pid: item.pid,
            measurement:
              old?.stat && item.stat && hz && cores
                ? cpuDelta(old.stat, item.stat, next.monotonicMs - previous.monotonicMs, hz, cores)
                : { status: 'sensor-unavailable' },
          };
        });
        samples.push(next);
        previous = next;
      }
      const video = observe
        ? await bounded('video', () =>
            page.locator('#video').evaluate((v) => {
              const q = v.getVideoPlaybackQuality();
              return {
                paused: v.paused,
                time: v.currentTime,
                frames: q.totalVideoFrames - q.droppedVideoFrames,
                width: v.videoWidth,
                height: v.videoHeight,
              };
            }),
          )
        : null;
      if (
        name === 'playing' &&
        (video.frames <= videoBefore.frames || video.time <= videoBefore.time || video.paused)
      )
        throw new Error('Decoder progress missing.');
      if (
        observe &&
        name !== 'playing' &&
        (!video.paused || Math.abs(video.time - videoBefore.time) > 0.1)
      )
        throw new Error('Paused playback advanced.');
      report.phases.push({ name, first, samples, videoBefore, video });
      return video;
    }
    await measure('idle');
    await page.locator('#import-button').click();
    await page.locator('#allow-http').check();
    await page.locator('#playlist-url').fill(`http://127.0.0.1:${server.address().port}/catalog`);
    await page.locator('#load-button').click();
    await saveCompletedSourceScan(page, 20000);
    await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
    if (await page.locator('#compact-view').isVisible())
      await page.locator('#compact-view').selectOption('channels');
    if (await page.locator('#compact-filter').isVisible())
      await page.locator('#compact-filter').selectOption('all');
    else await page.locator('[data-filter="all"]').click();
    await page.locator('#search').fill('Owned resource channel');
    await page.locator('#search').press('Tab');
    if (
      (await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true' &&
      (await page.locator('#mute-button').isVisible())
    )
      await page.locator('#mute-button').click();
    await page.locator('.channel').filter({ hasText: 'Owned resource channel' }).click();
    if (await page.locator('#compact-view').isVisible())
      await page.locator('#compact-view').selectOption('watch');
    if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
      await page.locator('#mute-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    const played = await measure('playing');
    if (!played || played.paused || played.frames < 1 || played.width !== 320)
      throw new Error('Decoder evidence missing.');
    await page.locator('#pause-button').click();
    await measure('manual-paused');
    await adb('shell', 'input', 'keyevent', '3');
    const before = fixture.stats().totalRequests;
    await measure('home-background', false);
    report.backgroundRequests = fixture.stats().totalRequests - before;
    await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
    const resumed = await measure('foreground-no-autoplay');
    if (!resumed.paused) throw new Error('Unexpected automatic playback.');
    phase = 'exit-before-restore';
    await runRestoreCycle({
      stop: shutdown,
      launchIdle,
      restore: async () => {
        phase = 'restore-idle-instance';
        await restoreOriginal();
      },
    });
    report.status = 'MEASURED';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { phase, category: classifyAndroidResourceError(error) };
    process.exitCode = 1;
  } finally {
    if (original && !report.originalLogicalRecordsRestored) {
      try {
        phase = 'failure-exit-before-restore';
        await runRestoreCycle({ stop: shutdown, launchIdle, restore: restoreOriginal });
      } catch {
        report.restoreIncomplete = true;
      }
    }
    if (launched || browser || forward) {
      try {
        await shutdown();
      } catch (error) {
        report.shutdownUnconfirmed = true;
        report.cleanupFailure = { phase, category: classifyAndroidResourceError(error) };
      }
    }
    report.observerPendingAfterCleanup = observerPending.size;
    if (observerPending.size) report.observerCloseUnconfirmed = true;
    for (const port of reverse)
      await adb('reverse', '--remove', `tcp:${port}`).catch(() => {
        report.mappingCleanupUnconfirmed = true;
      });
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (fixture) {
      await fixture.close();
      report.fixtureAfterClose = fixture.stats();
      delete report.fixtureAfterClose.requests;
    }
    report.catalogSocketsAfterClose = catalogSockets.size;
    report.terminalResources = assessTerminalResources(
      report.fixtureAfterClose,
      report.catalogSocketsAfterClose,
    );
    if (apkPath) {
      report.finalApkSha256 = (await adb('shell', 'sha256sum', apkPath).catch(() => '')).split(
        /\s/,
      )[0];
      if (report.finalApkSha256 !== report.apkSha256) report.apkChanged = true;
    }
    if (
      (original && !report.originalLogicalRecordsRestored) ||
      report.shutdownUnconfirmed ||
      report.observerCloseUnconfirmed ||
      report.mappingCleanupUnconfirmed ||
      report.apkChanged ||
      report.observerDeadline ||
      !report.terminalResources.clean
    ) {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
    report.finished = new Date().toISOString();
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, directory }));
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runAndroidResources(process.argv.slice(2));
