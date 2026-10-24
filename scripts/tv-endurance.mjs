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

/* global document, window, performance, requestAnimationFrame, setInterval, clearInterval -- page callbacks run only inside the TV WebView; the timers are Node's. */
// Low-resource endurance gate for the installed Android TV app.
//
// Drives the real app (remote D-pad keys plus its own controls through the
// WebView debugger) through Free TV, Paid TV, live channel changes, Video On
// Demand and GenXtra for a chosen duration, sampling memory (app + its WebView
// renderer), CPU, device memory/swap, frame smoothness, dropped video frames,
// playback errors and on-disk size. Writes a JSON report and exits nonzero
// when a budget fails or a measurement is incomplete.
//
// Safety: only the approved TV serial; never force-stops, clears data,
// installs, or reads typed values, credentials or stream addresses.
//
// Usage: node scripts/tv-endurance.mjs --serial <approved TV> [--minutes 20]
// The approved TV comes from GENX_APPROVED_TV_SERIAL.
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  parseProcessMemory,
  parseRendererBindings,
  parseSelectedWebViewProvider,
} from './tv-scan-resource-observer.mjs';

const APPROVED_SERIALS = (process.env.GENX_APPROVED_TV_SERIAL ?? '').split(',').filter(Boolean);
const PACKAGE = 'com.tmg.tv';
/** Initial budgets (owner targets, October 17, 2026); tune with evidence. */
export const BUDGETS = {
  browsingPssMiB: 250,
  playbackPssMiB: 400,
  growthMiBPerHour: 20,
  longFramePercent: 10,
  playbackFailures: 0,
};
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};

/** Least-squares slope (per hour) of [ms, MiB] points. */
export function growthPerHour(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  return (sxy / sxx) * 3_600_000;
}
/** PASS/FAIL/INCOMPLETE against the budgets from collected samples and steps. */
export function judge(samples, steps, budgets = BUDGETS) {
  const measured = samples.filter((s) => s.totalPssMiB !== null);
  const checks = [];
  const add = (name, value, limit, ok) => checks.push({ name, value, limit, ok });
  if (measured.length < 3 || measured.length < samples.length * 0.8)
    return { verdict: 'INCOMPLETE', reason: 'too few complete memory samples', checks };
  const browsing = measured.filter((s) => !s.playing).map((s) => s.totalPssMiB);
  const playing = measured.filter((s) => s.playing).map((s) => s.totalPssMiB);
  const max = (list) => (list.length ? Math.max(...list) : null);
  add(
    'peak browsing PSS (MiB)',
    max(browsing),
    budgets.browsingPssMiB,
    max(browsing) === null || max(browsing) <= budgets.browsingPssMiB,
  );
  add(
    'peak playback PSS (MiB)',
    max(playing),
    budgets.playbackPssMiB,
    max(playing) === null || max(playing) <= budgets.playbackPssMiB,
  );
  // Growth over the second half, after caches have warmed up.
  const half = measured.slice(Math.floor(measured.length / 2));
  const growth = growthPerHour(half.map((s) => [s.elapsedMs, s.totalPssMiB]));
  add(
    'memory growth (MiB/hour, second half)',
    growth === null ? null : Math.round(growth),
    budgets.growthMiBPerHour,
    growth === null || growth <= budgets.growthMiBPerHour,
  );
  const frames = steps.filter((s) => s.frames).map((s) => s.frames);
  const total = frames.reduce((n, f) => n + f.count, 0);
  const long = frames.reduce((n, f) => n + f.long, 0);
  const longPercent = total ? Math.round((long / total) * 1000) / 10 : null;
  add(
    'long frames while navigating (%)',
    longPercent,
    budgets.longFramePercent,
    longPercent === null || longPercent <= budgets.longFramePercent,
  );
  const failures = steps.filter((s) => s.kind === 'play' && !s.ok).length;
  add(
    'live channel starts that failed',
    failures,
    budgets.playbackFailures,
    failures <= budgets.playbackFailures,
  );
  return { verdict: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', checks };
}

async function main() {
  const serial = arg('serial');
  const minutes = Number(arg('minutes', '20'));
  if (!APPROVED_SERIALS.includes(serial)) throw new Error('Use the approved TV serial (--serial).');
  if (!Number.isFinite(minutes) || minutes < 2 || minutes > 240)
    throw new Error('--minutes must be 2 to 240.');
  const adbPath =
    process.env.TMG_ADB ??
    path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
  const run = promisify(execFile);
  const adb = async (...args) =>
    (
      await run(adbPath, ['-s', serial, ...args], {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();
  const pid = Number((await adb('shell', 'pidof', PACKAGE)).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Start the app on the TV first.');
  const directory = path.resolve(
    'artifacts/tv-endurance',
    new Date().toISOString().replaceAll(':', '-'),
  );
  await mkdir(directory, { recursive: true });
  const port = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('tauri') || p.url().startsWith('http'));
  if (!page) throw new Error('App page not found.');
  const started = Date.now();
  const samples = [];
  const steps = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const provider = parseSelectedWebViewProvider(await adb('shell', 'dumpsys', 'webviewupdate'));

  async function pageState() {
    return page.evaluate(() => {
      const video = document.querySelector('#video');
      const quality = video?.getVideoPlaybackQuality?.();
      const scan = window.__GENX_SCAN__;
      return {
        status: document.getElementById('playback-status')?.textContent ?? '',
        playing: !!video && !video.paused && video.currentTime > 0 && video.readyState >= 2,
        droppedFrames: quality?.droppedVideoFrames ?? null,
        totalFrames: quality?.totalVideoFrames ?? null,
        library: document.getElementById('app')?.dataset.contentLibrary ?? null,
        scan: scan ? { phase: scan.phase, checked: scan.checked, total: scan.total } : null,
      };
    });
  }
  let sampling = false;
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const [appText, processes, services, top, meminfo] = await Promise.all([
        adb('shell', 'dumpsys', 'meminfo', String(pid)),
        adb('shell', 'dumpsys', 'activity', 'processes'),
        adb('shell', 'dumpsys', 'activity', 'services'),
        adb('shell', 'top', '-b', '-n', '1', '-p', String(pid)),
        adb('shell', 'cat', '/proc/meminfo'),
      ]);
      const app = parseProcessMemory(appText);
      const graphics = /^\s*Graphics:\s+(\d+)/m.exec(appText);
      const binding = parseRendererBindings(
        processes,
        services,
        pid,
        PACKAGE,
        provider ?? undefined,
      );
      const renderers = [];
      for (const rendererPid of binding.rendererPids)
        renderers.push({
          pid: rendererPid,
          ...parseProcessMemory(await adb('shell', 'dumpsys', 'meminfo', String(rendererPid))),
        });
      const complete =
        app.pssKiB !== null &&
        binding.status === 'measured' &&
        renderers.every((r) => r.pssKiB !== null);
      const cpu = new RegExp(
        `^\\s*${pid}\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S\\s+([\\d.]+)`,
        'm',
      ).exec(top);
      const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? NaN);
      const state = await pageState();
      samples.push({
        elapsedMs: Date.now() - started,
        totalPssMiB: complete
          ? Math.round((app.pssKiB + renderers.reduce((s, r) => s + r.pssKiB, 0)) / 1024)
          : null,
        appPssMiB: app.pssKiB === null ? null : Math.round(app.pssKiB / 1024),
        rendererPssMiB: renderers.map((r) =>
          r.pssKiB === null ? null : Math.round(r.pssKiB / 1024),
        ),
        nativeHeapMiB:
          app.nativeHeapPssKiB === null ? null : Math.round(app.nativeHeapPssKiB / 1024),
        graphicsMiB: graphics ? Math.round(Number(graphics[1]) / 1024) : null,
        appCpuPercent: cpu ? Number(cpu[1]) : null,
        deviceAvailableMiB: Math.round(kib('MemAvailable') / 1024),
        swapUsedMiB: Math.round((kib('SwapTotal') - kib('SwapFree')) / 1024),
        ...state,
      });
    } catch (error) {
      samples.push({
        elapsedMs: Date.now() - started,
        totalPssMiB: null,
        error: String(error).slice(0, 120),
      });
    } finally {
      sampling = false;
    }
  }

  /** Measure frame pacing in the page while `action` runs. */
  async function framed(action) {
    await page.evaluate(() => {
      const probe = { count: 0, long: 0, max: 0, last: performance.now(), on: true };
      Reflect.set(window, '__enduranceFrames', probe);
      const tick = (now) => {
        if (!probe.on) return;
        const gap = now - probe.last;
        probe.last = now;
        probe.count++;
        if (gap > 50) probe.long++;
        probe.max = Math.max(probe.max, gap);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await action();
    return page.evaluate(() => {
      const probe = Reflect.get(window, '__enduranceFrames');
      probe.on = false;
      return { count: probe.count, long: probe.long, maxMs: Math.round(probe.max) };
    });
  }
  async function step(name, kind, body) {
    const begin = Date.now();
    try {
      const detail = await body();
      steps.push({ name, kind, ok: detail?.ok ?? true, ms: Date.now() - begin, ...detail });
    } catch (error) {
      steps.push({
        name,
        kind,
        ok: false,
        ms: Date.now() - begin,
        error: String(error).slice(0, 160),
      });
    }
  }
  const keys = (code, times) =>
    adb('shell', 'input', 'keyevent', ...Array(times).fill(String(code)));
  const click = (selector) =>
    page.evaluate((s) => {
      const node = document.querySelector(s);
      if (!node) throw new Error(`missing ${s}`);
      node.click();
    }, selector);
  const settle = (ms = 1500) => wait(ms);
  async function browseList(label) {
    await step(`${label}: scroll with remote`, 'browse', async () => {
      await page.evaluate(() => document.getElementById('channel-list')?.focus());
      return { frames: await framed(() => keys(20, 40)) };
    });
    for (const filter of ['movies', 'news', 'sports', 'all']) {
      await step(`${label}: ${filter} tab`, 'browse', async () => ({
        frames: await framed(async () => {
          await click(`.filters [data-filter="${filter}"]`);
          await settle();
        }),
      }));
    }
    await step(`${label}: search`, 'browse', async () => ({
      frames: await framed(async () => {
        await page.locator('#search').fill('news');
        await settle();
        await page.locator('#search').fill('');
        await settle();
      }),
    }));
  }
  async function play(query) {
    await step(`play ${query}`, 'play', async () => {
      await page.locator('#search').fill(query);
      await settle(2000);
      const begin = Date.now();
      await page.locator('.channel').first().click();
      for (let i = 0; i < 300; i++) {
        await wait(100);
        const state = await pageState();
        if (state.playing) {
          await wait(20_000);
          const after = await pageState();
          await page.locator('#search').fill('');
          return {
            ok: after.playing,
            startMs: Date.now() - begin - 20_000,
            droppedFrames: after.droppedFrames,
            totalFrames: after.totalFrames,
          };
        }
        if (/Unable/.test(state.status)) break;
      }
      await page.locator('#search').fill('');
      return { ok: false, status: (await pageState()).status };
    });
  }

  await sample();
  const timer = setInterval(() => void sample(), 30_000);
  try {
    const deadline = started + minutes * 60_000;
    let round = 0;
    while (Date.now() < deadline) {
      round++;
      await step(`round ${round}: Free TV`, 'nav', async () => {
        await click('#live-tv-button');
        await settle(2500);
      });
      await browseList('Free TV');
      await step(`round ${round}: Paid TV`, 'nav', async () => {
        await click('#paid-tv-button');
        await settle(3000);
      });
      await browseList('Paid TV');
      await play('BBC One London');
      await play('ESPN 2');
      await step('Video On Demand: browse', 'browse', async () => {
        if (!(await page.locator('#vod-button').isVisible())) return { skipped: 'no paid account' };
        await click('#vod-button');
        await page.waitForSelector('.vod-results .vod-title', { timeout: 60_000 });
        const frames = await framed(async () => {
          await page.evaluate(() => document.querySelector('.vod-results .vod-title')?.focus());
          await keys(20, 20);
          await settle();
        });
        await click('#vod-button');
        return { frames };
      });
      await step('GenXtra: browse', 'browse', async () => {
        const genxtra = page.getByRole('button', { name: /GenXtra/ }).first();
        await genxtra.click();
        await settle(4000);
        const frames = await framed(async () => {
          await keys(20, 20);
          await settle();
        });
        await click('#live-tv-button');
        await settle(2000);
        return { frames };
      });
    }
  } finally {
    clearInterval(timer);
    await wait(500);
    await sample();
    await page
      .locator('#pause-button')
      .click({ timeout: 5000 })
      .catch(() => undefined);
    await browser.close().catch(() => undefined);
    await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined);
  }
  const disk = await adb('shell', 'run-as', PACKAGE, 'du', '-s', `/data/user/0/${PACKAGE}`).catch(
    () => '',
  );
  const result = judge(samples, steps);
  const report = {
    scope: 'Installed Android TV app endurance (memory = app + its WebView renderer PSS)',
    serial,
    minutes,
    started: new Date(started).toISOString(),
    budgets: BUDGETS,
    appDataKiB: Number(disk.split(/\s+/)[0]) || null,
    ...result,
    samples,
    steps,
  };
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    JSON.stringify(
      {
        verdict: result.verdict,
        checks: result.checks,
        report: path.relative(process.cwd(), path.join(directory, 'report.json')),
      },
      null,
      1,
    ),
  );
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}

if (
  import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('tv-endurance.mjs')
)
  await main();
