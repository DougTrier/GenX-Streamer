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
/* eslint-disable no-undef -- window/Event callbacks execute in the owned WebView only. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { mkdir, copyFile, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from './fixture-server.mjs';
import { OwnedCdp } from '../tests/native/sharing-cdp-owner.mjs';
const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function parseProcesses(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.length || rows.length > 128) throw new Error('Invalid process sample.');
  const keys = new Set();
  return rows.map((row) => {
    if (
      !row ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      typeof row.created !== 'string' ||
      !row.created ||
      row.created.length > 80 ||
      !['cpuSeconds', 'privateBytes', 'workingBytes', 'handles', 'threads'].every(
        (key) => Number.isFinite(row[key]) && row[key] >= 0,
      )
    )
      throw new Error('Invalid process sample.');
    const key = row.pid + ':' + row.created;
    if (keys.has(key)) throw new Error('Duplicate process sample.');
    keys.add(key);
    return {
      pid: row.pid,
      created: row.created,
      cpuSeconds: row.cpuSeconds,
      privateBytes: row.privateBytes,
      workingBytes: row.workingBytes,
      handles: row.handles,
      threads: row.threads,
    };
  });
}
export function assessProcessDelta(before, after, elapsedMs, logicalCores) {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    !Number.isSafeInteger(logicalCores) ||
    logicalCores < 1
  )
    throw new Error('Invalid CPU interval.');
  const previous = new Map(parseProcesses(before).map((row) => [row.pid + ':' + row.created, row]));
  const current = parseProcesses(after);
  let cpuSeconds = 0,
    unmatchedProcesses = 0;
  const perProcess = current.map((row) => {
    const old = previous.get(row.pid + ':' + row.created);
    let delta = null;
    if (old && row.cpuSeconds >= old.cpuSeconds) {
      delta = row.cpuSeconds - old.cpuSeconds;
      cpuSeconds += delta;
    } else unmatchedProcesses++;
    return { pid: row.pid, created: row.created, cpuSecondsDelta: delta };
  });
  return {
    elapsedMs,
    logicalCores,
    cpuSecondsDelta: cpuSeconds,
    cpuPercentOneCore: (cpuSeconds / (elapsedMs / 1000)) * 100,
    cpuPercentMachine: (cpuSeconds / (elapsedMs / 1000) / logicalCores) * 100,
    unmatchedProcesses,
    exitedProcesses: [...previous.keys()].filter(
      (key) => !current.some((row) => row.pid + ':' + row.created === key),
    ).length,
    privateBytes: current.reduce((sum, row) => sum + row.privateBytes, 0),
    workingBytes: current.reduce((sum, row) => sum + row.workingBytes, 0),
    handles: current.reduce((sum, row) => sum + row.handles, 0),
    threads: current.reduce((sum, row) => sum + row.threads, 0),
    perProcess,
  };
}
export function readPlaybackCounts(snapshot) {
  const keys = [
    'controllerEngines',
    'browserEngines',
    'controllerTimers',
    'initializationWaits',
    'nativeLoads',
    'nativeCancels',
  ];
  if (
    snapshot?.schemaVersion !== 1 ||
    !snapshot.counts ||
    !keys.every((key) => Number.isSafeInteger(snapshot.counts[key]) && snapshot.counts[key] >= 0)
  )
    throw new Error('Invalid playback owner sample.');
  return Object.fromEntries(keys.map((key) => [key, snapshot.counts[key]]));
}
export function classifyResourceError(error) {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('INCOMPLETE_HARNESS_CDP:')) return 'incomplete-cdp';
  if (error?.name === 'TimeoutError') return 'observation-timeout';
  if (
    message === 'Invalid playback owner sample.' ||
    message === 'Invalid process sample.' ||
    message === 'Duplicate process sample.'
  )
    return 'invalid-sample';
  if (
    message === 'Background playback owner did not drain.' ||
    message === 'Owned process exit unconfirmed.' ||
    message === 'Owned process identity not confirmed.' ||
    message === 'Graceful exit unconfirmed.'
  )
    return 'ownership-unconfirmed';
  if (message === 'Background owned fixture networking continued.')
    return 'background-network-active';
  if (
    message === 'Paused media unexpectedly advanced.' ||
    message === 'Background audio/video did not pause.'
  )
    return 'paused-media-advanced';
  if (message === 'Controlled decoder progress missing.') return 'decoder-progress-missing';
  if (message === 'Measurement interrupted.') return 'interrupted';
  return 'unclassified-redacted';
}
async function powershell(command) {
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 5000, maxBuffer: 1048576 },
  );
  return stdout.trim();
}
async function processTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process owner.');
  return parseProcesses(
    await powershell(
      `$all=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${pid});do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and !$ids.Contains([int]$p.ProcessId)){[void]$ids.Add([int]$p.ProcessId);$added=$true}}}while($added);@($all|Where-Object{$ids.Contains([int]$_.ProcessId)}|ForEach-Object{$p=Get-Process -Id $_.ProcessId -ErrorAction Stop;[pscustomobject]@{pid=[int]$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');cpuSeconds=[double]$p.TotalProcessorTime.TotalSeconds;privateBytes=[double]$p.PrivateMemorySize64;workingBytes=[double]$p.WorkingSet64;handles=[int]$p.HandleCount;threads=[int]$p.Threads.Count}})|ConvertTo-Json -Compress`,
    ),
  );
}
export async function runWindowsResources(args) {
  if (process.platform !== 'win32') throw new Error('Windows measurement requires Windows.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--exe', '--seconds', '--interval'].includes(args[i]) || !args[i + 1])
      throw new Error('Usage: --exe path [--seconds 10 --interval 2]');
    options[args[i]] = args[i + 1];
  }
  if (!options['--exe']) throw new Error('Explicit executable required.');
  const seconds = Number(options['--seconds'] ?? 10),
    interval = Number(options['--interval'] ?? 2);
  if (
    !Number.isInteger(seconds) ||
    seconds < 5 ||
    seconds > 120 ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 10
  )
    throw new Error('Invalid measurement duration.');
  const directory = path.resolve(
    'artifacts/windows-resources',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  const data = path.join(directory, 'data');
  await mkdir(data, { recursive: true });
  const executable = path.join(directory, 'GenX-resource-fixture.exe');
  await copyFile(path.resolve(options['--exe']), executable);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const report = {
    status: 'FAIL',
    scope:
      'Whole owned Windows process-tree measurement; no CPU/memory/battery acceptance ceilings',
    started: new Date().toISOString(),
    executableSha256: sha(await readFile(executable)),
    helperSha256: sha(await readFile(new URL(import.meta.url))),
    logicalCores: cpus().length,
    requestedPhaseSeconds: seconds,
    intervalSeconds: interval,
    backgroundMethod:
      'controlled native-app-background event plus CDP frozen lifecycle; not physical OS minimization',
    phases: [],
    forcedCleanup: false,
  };
  let fixture,
    server,
    app,
    browser,
    page,
    owner,
    session,
    lastProcesses = [];
  let exitPromise;
  let rootCreated;
  let stage = 'preflight';
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let networkRequests = 0,
    networkBytes = 0;
  const proxyOwners = new Set();
  const ownedExit = async () => {
    if (!app || app.exitCode !== null || app.signalCode !== null) return;
    const quoted = executable.replaceAll("'", "''");
    const match = await powershell(
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${app.pid}';if($p.ExecutablePath -eq '${quoted}' -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${rootCreated}'){'owned'}`,
    );
    if (match !== 'owned') throw new Error('Owned process identity not confirmed.');
    report.forcedCleanup = true;
    await exec('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
    });
    await Promise.race([exitPromise, wait(1000)]);
    if (app.exitCode === null && app.signalCode === null)
      throw new Error('Owned process exit unconfirmed.');
  };
  try {
    stage = 'fixture-start';
    fixture = await startFixtureServer();
    server = http.createServer(async (req, res) => {
      networkRequests++;
      const send = (body) => {
        networkBytes += Buffer.byteLength(body);
        res.end(body);
      };
      if (req.url === '/catalog') {
        res.setHeader('Content-Type', 'application/x-mpegurl');
        send(
          `#EXTM3U\n#EXTINF:-1 group-title="Fixture",Owned resource channel\nhttp://127.0.0.1:${server.address().port}/hls/live.m3u8\n`,
        );
        return;
      }
      const abort = new AbortController();
      proxyOwners.add(abort);
      res.once('close', () => abort.abort());
      const timeout = setTimeout(() => abort.abort(), 5000);
      try {
        if (!req.url?.startsWith('/') || req.url.startsWith('//'))
          throw new Error('Fixture path refused');
        const upstream = await fetch(fixture.url + req.url, { signal: abort.signal });
        res.statusCode = upstream.status;
        res.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') ?? 'application/octet-stream',
        );
        for await (const chunk of upstream.body) {
          networkBytes += chunk.byteLength;
          if (!res.write(chunk))
            await new Promise((resolve) => {
              res.once('drain', resolve);
              res.once('close', resolve);
            });
        }
        res.end();
      } catch {
        if (!res.headersSent) res.statusCode = 502;
        res.end();
      } finally {
        clearTimeout(timeout);
        proxyOwners.delete(abort);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const catalogUrl = `http://127.0.0.1:${server.address().port}/catalog`;
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    stage = 'app-launch';
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
    let spawnFailed = false;
    app.once('error', () => {
      spawnFailed = true;
    });
    exitPromise = new Promise((resolve) => app.once('exit', resolve));
    if (!Number.isSafeInteger(app.pid)) throw new Error('Owned launch PID unavailable.');
    rootCreated = await powershell(
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${app.pid}').CreationDate.ToUniversalTime().ToString('o')`,
    );
    let endpoint;
    for (let i = 0; i < 200; i++) {
      if (spawnFailed || app.exitCode !== null) throw new Error('Owned app launch failed.');
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          endpoint = (await r.json()).webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await wait(100);
    }
    if (!endpoint) throw new Error('Owned CDP readiness incomplete.');
    stage = 'cdp-connect';
    owner = new OwnedCdp(app.pid, ownedExit);
    browser = await owner.run('connect', () => chromium.connectOverCDP(endpoint));
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) throw new Error('Owned WebView missing.');
    page.setDefaultTimeout(10000);
    await owner.run(
      'app ready',
      () => expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 30000 }),
      32000,
    );
    session = await owner.run('page session', () => page.context().newCDPSession(page));
    async function sample(phase) {
      if (interrupted) throw new Error('Measurement interrupted.');
      const processes = await processTree(app.pid);
      lastProcesses = processes;
      const playback = await owner.run('playback sample', () =>
        page.locator('#video').evaluate((video) => {
          const q = video.getVideoPlaybackQuality();
          return {
            time: video.currentTime,
            frames: q.totalVideoFrames - q.droppedVideoFrames,
            total: q.totalVideoFrames,
            dropped: q.droppedVideoFrames,
            paused: video.paused,
            width: video.videoWidth,
            height: video.videoHeight,
          };
        }),
      );
      const owners = await owner.run('owner sample', () =>
        page.evaluate(() => window.__GENX_PLAYBACK_OWNERS__ ?? null),
      );
      const stats = fixture.stats();
      delete stats.requests;
      const value = {
        network: {
          requests: networkRequests,
          bytes: networkBytes,
          activeProxyOwners: proxyOwners.size,
        },
        phase,
        at: new Date().toISOString(),
        monotonicMs: performance.now(),
        processes,
        playback,
        owners,
        fixture: stats,
      };
      await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(value) + '\n');
      return value;
    }
    async function phase(name, expectation) {
      stage = name;
      const first = await sample(name);
      let previous = first,
        last = first;
      const deltas = [];
      while (performance.now() - first.monotonicMs < seconds * 1000) {
        await wait(
          Math.min(interval * 1000, seconds * 1000 - (performance.now() - first.monotonicMs)),
        );
        last = await sample(name);
        deltas.push(
          assessProcessDelta(
            previous.processes,
            last.processes,
            last.monotonicMs - previous.monotonicMs,
            report.logicalCores,
          ),
        );
        previous = last;
      }
      if (
        expectation === 'playing' &&
        (last.playback.frames <= first.playback.frames ||
          last.playback.time <= first.playback.time ||
          last.playback.paused)
      )
        throw new Error('Controlled decoder progress missing.');
      if (
        expectation === 'paused' &&
        (!last.playback.paused || Math.abs(last.playback.time - first.playback.time) > 0.1)
      )
        throw new Error('Paused media unexpectedly advanced.');
      report.phases.push({ name, first, last, deltas });
    }
    await phase('idle', 'paused');
    stage = 'catalog-import';
    await owner.run(
      'import owned catalog',
      async () => {
        await page.locator('#import-button').click();
        await page.locator('#allow-http').check();
        await page.locator('#playlist-url').fill(catalogUrl);
        await page.locator('#load-button').click();
        await saveCompletedSourceScan(page, 30000);
        await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 30000 });
        await page.locator('.channel').first().click();
        await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
      },
      55000,
    );
    await phase('playing', 'playing');
    await owner.run('manual pause', () => page.locator('#pause-button').click());
    await phase('manual-paused', 'paused');
    stage = 'background-notification';
    await owner.run('background suspension', () =>
      page.evaluate(() => window.dispatchEvent(new Event('native-app-background'))),
    );
    // Sample after actual decoder suspension, then freeze JS to measure the whole native tree without UI polling.
    stage = 'background-owner-drain';
    await expect
      .poll(() =>
        owner.run('background owners', () =>
          page.evaluate(() => window.__GENX_PLAYBACK_OWNERS__?.counts?.controllerEngines ?? -1),
        ),
      )
      .toBe(0)
      .catch((error) => {
        if (classifyResourceError(error) === 'incomplete-cdp') throw error;
        throw new Error('Background playback owner did not drain.');
      });
    const beforeFrozen = await sample('background-before-freeze');
    const drainedCounts = readPlaybackCounts(beforeFrozen.owners);
    for (const count of Object.values(drainedCounts)) {
      if (count !== 0) throw new Error('Background playback owner did not drain.');
    }
    if (!beforeFrozen.playback.paused) throw new Error('Background audio/video did not pause.');
    stage = 'background-frozen';
    await owner.run('freeze', () => session.send('Page.setWebLifecycleState', { state: 'frozen' }));
    const frozen = [];
    let frozenPrevious = beforeFrozen;
    const start = performance.now();
    while (performance.now() - start < seconds * 1000) {
      await wait(interval * 1000);
      if (interrupted) throw new Error('Measurement interrupted.');
      const processes = await processTree(app.pid);
      lastProcesses = processes;
      const at = performance.now();
      const row = {
        phase: 'background-frozen',
        monotonicMs: at,
        processes,
        network: {
          requests: networkRequests,
          bytes: networkBytes,
          activeProxyOwners: proxyOwners.size,
        },
        delta: assessProcessDelta(
          frozenPrevious.processes,
          processes,
          at - frozenPrevious.monotonicMs,
          report.logicalCores,
        ),
      };
      frozenPrevious = row;
      frozen.push(row);
      await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(row) + '\n');
    }
    report.background = { before: beforeFrozen, samples: frozen };
    if (networkRequests !== beforeFrozen.network.requests || proxyOwners.size)
      throw new Error('Background owned fixture networking continued.');
    await owner.run('foreground', () =>
      session.send('Page.setWebLifecycleState', { state: 'active' }),
    );
    await phase('foreground-no-autoplay', 'paused');
    stage = 'graceful-exit';
    await owner.run(
      'graceful exit',
      () =>
        page
          .evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
          .then(
            () => {
              report.exitIpc = 'resolved';
            },
            () => {
              report.exitIpc = 'transport-closed-or-refused';
            },
          ),
      7000,
    );
    await Promise.race([exitPromise, wait(6000)]);
    if (app.exitCode !== 0) throw new Error('Graceful exit unconfirmed.');
    report.status = 'MEASURED';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { stage, category: classifyResourceError(error) };
    report.error = 'Controlled resource measurement or clean ownership check failed.';
    process.exitCode = 1;
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      try {
        await ownedExit();
      } catch {
        report.cleanupFailure = true;
      }
    }
    if (browser) {
      try {
        await owner.run('detach observer', () => browser.close(), 3000);
      } catch {
        report.observerCleanupUnconfirmed = true;
      }
    }
    report.nativeExited = !app || app.exitCode !== null || app.signalCode !== null;
    report.remainingOwnedProcesses = [];
    for (const row of lastProcesses) {
      const alive = await powershell(
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}';if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${row.created}'){'alive'}`,
      ).catch(() => 'unknown');
      if (alive) report.remainingOwnedProcesses.push({ pid: row.pid, result: alive });
    }
    for (const abort of proxyOwners) abort.abort();
    if (fixture) {
      await fixture.close();
      report.fixtureAfterClose = fixture.stats();
      delete report.fixtureAfterClose.requests;
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (
      report.forcedCleanup ||
      !report.nativeExited ||
      report.remainingOwnedProcesses.length ||
      report.cleanupFailure ||
      report.observerCleanupUnconfirmed
    ) {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
    report.networkAfterClose = {
      requests: networkRequests,
      bytes: networkBytes,
      activeProxyOwners: proxyOwners.size,
    };
    if (proxyOwners.size) {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    report.finished = new Date().toISOString();
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({ status: report.status, directory, forcedCleanup: report.forcedCleanup }),
    );
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runWindowsResources(process.argv.slice(2));
