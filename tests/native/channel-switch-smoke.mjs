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

import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startSwitchFixtureServer } from '../../scripts/switch-fixture-server.mjs';
import { chooseSettingsSection } from './settings-navigation-helper.mjs';

const input = process.argv[2];
if (!input) throw new Error('Pass an explicit executable; this harness never builds or installs.');
const count = Number(process.argv[3] ?? 500);
const expectedSha256 = process.argv[4];
if (
  process.argv.length > 5 ||
  (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256))
)
  throw new Error('Usage: channel-switch-smoke executable [count [expectedSHA256]]');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputSha256 = hash(await readFile(path.resolve(input)));
if (expectedSha256 !== undefined && inputSha256 !== expectedSha256)
  throw new Error('Expected executable hash differs.');
const fixture = await startSwitchFixtureServer({ count });
const directory = path.resolve(
  'artifacts/channel-switch-native',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'tmg-tv.exe');
await copyFile(path.resolve(input), executable);
const sha256 = hash(await readFile(executable));
if (sha256 !== inputSha256) throw new Error('Copied executable hash differs.');
const report = {
  status: 'FAIL',
  started: new Date().toISOString(),
  sha256,
  expectedSha256: expectedSha256 ?? null,
  requestedSelections: count,
  actualSelections: 0,
  decodedSelections: 0,
  staleCompletionGroups: 0,
  scope:
    'Windows actual UI switches, observed decoder progress on each retained selection, canceled intermediate gates; CDP aggregates are not owned engine/listener/timer counts',
  fixtureSeed: 'ordered-three-generation-gates-v1',
  mediaSha256: fixture.mediaSha256,
  resourceAcceptance:
    'MEASUREMENTS_ONLY; no prospective memory ceiling or native engine/listener counters',
  groups: [],
  samples: [],
  cleanup: { confirmed: false },
  closeCaptures: [],
};
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page, browserSession, session;
const ownedProcessIds = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeOperations = new Set();
async function closeOperation(work, milliseconds = 5000) {
  let timer;
  const pending = Promise.resolve()
    .then(work)
    .finally(() => closeOperations.delete(pending));
  closeOperations.add(pending);
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned close observation timed out.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function captureClose(label) {
  if (!page || page.isClosed()) return;
  const value = await closeOperation(() =>
    page.evaluate(() => {
      const close = Reflect.get(globalThis, '__GENX_CLOSE__'),
        final = Reflect.get(globalThis, '__GENX_CLOSE_FINALIZATION__');
      return {
        close:
          close?.schemaVersion === 1
            ? {
                schemaVersion: 1,
                frozen: close.frozen === true,
                freezeFailed: close.freezeFailed === true,
                generation: Number.isSafeInteger(close.generation) ? close.generation : null,
                running: close.running === true,
                acknowledged: close.acknowledged === true,
                acknowledgmentPending: close.acknowledgmentPending === true,
                slots:
                  Array.isArray(close.slots) && close.slots.length <= 64
                    ? close.slots.map((value) =>
                        ['idle', 'pending', 'failed', 'done'].includes(value) ? value : 'unknown',
                      )
                    : null,
              }
            : null,
        finalization:
          final?.schemaVersion === 1
            ? {
                schemaVersion: 1,
                stage: [
                  'idle',
                  'catalog-writes',
                  'preferences',
                  'event-history',
                  'diagnostics',
                  'native-acknowledgment',
                  'completed',
                ].includes(final.stage)
                  ? final.stage
                  : 'unknown',
                failed: final.failed === true,
                pending: final.pending === true,
              }
            : null,
      };
    }),
  );
  report.closeCaptures.push({ label, ...value });
}
const sampleVideo = () =>
  page.locator('#video').evaluate((video) => ({
    time: video.currentTime,
    frames: video.getVideoPlaybackQuality().totalVideoFrames,
    width: video.videoWidth,
    height: video.videoHeight,
    paused: video.paused,
  }));
async function resources(label) {
  const metrics = await session.send('Performance.getMetrics');
  const processes = await browserSession.send('SystemInfo.getProcessInfo');
  const targets = await browserSession.send('Target.getTargets');
  const types = new Map(processes.processInfo.map((process) => [process.id, process.type]));
  const ids = [...new Set([app.pid, ...types.keys()])].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  for (const id of ids) ownedProcessIds.add(id);
  if (ids.length > 128) throw new Error('Owned process coverage exceeds the sampling bound.');
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
  const value = (name) => metrics.metrics.find((metric) => metric.name === name)?.value ?? null;
  const snapshot = {
    label,
    at: new Date().toISOString(),
    selections: report.actualSelections,
    state: await page.locator('#playback-status').textContent(),
    watchTitle: await page.locator('#watch-title').textContent(),
    video: await sampleVideo(),
    heapBytes: value('JSHeapUsedSize'),
    nodes: value('Nodes'),
    listeners: value('JSEventListeners'),
    documents: value('Documents'),
    workers: targets.targetInfos.filter((target) =>
      ['worker', 'shared_worker', 'service_worker'].includes(target.type),
    ).length,
    processes: (Array.isArray(memory) ? memory : [memory]).map((process) => ({
      ...process,
      cdpType: types.get(process.Id) ?? 'native-app',
    })),
    fixtureActive: fixture.stats().active,
  };
  report.samples.push(snapshot);
  await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(snapshot) + '\n');
}
async function select(generation) {
  const title = `Switch ${String(generation).padStart(3, '0')}`;
  await page.locator('#search').fill(title);
  const target = page
    .getByRole('button', { name: new RegExp(`^${title}(?: ·|$)`) })
    .and(page.locator('#channel-list button.channel[data-channel]'));
  await expect(target).toHaveCount(1);
  await target.click();
  report.actualSelections++;
  await expect
    .poll(
      () =>
        fixture
          .stats()
          .records.some((record) => record.generation === generation && record.kind === 'manifest'),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect(page.locator('#playback-status')).toHaveText('Connecting…');
  await expect(page.locator('#watch-title')).toHaveText(title);
}
async function decoded(generation) {
  fixture.release(generation);
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
  await expect
    .poll(async () => (await sampleVideo()).time, { timeout: 10000 })
    .toBeGreaterThan(0.05);
  const first = await sampleVideo();
  await wait(150);
  const second = await sampleVideo();
  expect(second.width).toBe(320);
  expect(second.height).toBe(180);
  expect(second.paused).toBe(false);
  expect(second.frames).toBeGreaterThan(first.frames);
  expect(second.time).toBeGreaterThan(first.time + 0.03);
  expect(
    fixture
      .stats()
      .records.some(
        (record) =>
          record.generation === generation && record.kind === 'segment' && record.finished,
      ),
  ).toBe(true);
  report.decodedSelections++;
  return { first, second };
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
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  if (Number.isSafeInteger(app.pid)) ownedProcessIds.add(app.pid);
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.exitCode !== null || report.launchFailed)
      throw new Error('Owned application failed before readiness');
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
    await wait(100);
  }
  if (!endpoint) throw new Error('Owned WebView unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No owned page');
  browserSession = await browser.newBrowserCDPSession();
  session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await resources('ready-before-warmup');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  // Ordinary file fixture setup preserves negative/decoder baselines; not Scan proof.
  report.catalogSetup = {
    route: 'ordinary-local-playlist-file',
    scope: 'Synthetic catalog setup; not URL Scan acceptance',
  };
  // The helper saves the reviewed scan and closes the review itself.
  await importFixtureCatalogFile(page, fixture.url + '/catalog');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await select(0);
  await decoded(0);
  report.actualSelections = 0;
  report.decodedSelections = 0;
  await resources('warmup-not-counted');
  let generation = 1,
    nextSample = 25;
  while (generation + 2 <= count) {
    const a = generation++,
      b = generation++,
      c = generation++;
    report.activeGroup = { a, b, c };
    await select(a);
    await select(b);
    await select(c);
    fixture.release(a);
    fixture.release(b);
    await expect
      .poll(
        () =>
          fixture
            .stats()
            .records.filter(
              (record) => [a, b].includes(record.generation) && record.closed === null,
            ).length,
        { timeout: 5000 },
      )
      .toBe(0);
    const heldFirst = await sampleVideo();
    await wait(150);
    const heldSecond = await sampleVideo();
    await expect(page.locator('#playback-status')).toHaveText('Connecting…');
    expect(heldSecond.frames).toBe(heldFirst.frames);
    expect(Math.abs(heldSecond.time - heldFirst.time)).toBeLessThan(0.03);
    expect(
      fixture
        .stats()
        .records.some((record) => [a, b].includes(record.generation) && record.kind === 'segment'),
    ).toBe(false);
    const progress = await decoded(c);
    report.groups.push({ a, b, c, heldFirst, heldSecond, progress });
    report.staleCompletionGroups++;
    if (report.actualSelections >= nextSample) {
      await resources('periodic');
      nextSample += 25;
    }
  }
  for (; generation <= count; generation++) {
    await select(generation);
    await decoded(generation);
  }
  expect(report.actualSelections).toBe(count);
  await resources('final-playing');
  await page.screenshot({ path: path.join(directory, 'final-playing.png') });
  // The removed record belongs only to this runner's temporary, isolated library.
  // This exercises the public UI path that awaits actual playback stop/disposal.
  await page.locator('#remove-channel').click();
  await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
  await expect
    .poll(async () => await sampleVideo())
    .toMatchObject({ time: 0, frames: 0, width: 0, height: 0, paused: true });
  const stoppedAt = Date.now();
  const stoppedRequestCount = fixture.stats().records.length;
  const stoppedGeneration = fixture.stats().records.at(-1)?.generation;
  for (const seconds of [0, 5, 30]) {
    await wait(Math.max(0, stoppedAt + seconds * 1000 - Date.now()));
    await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
    expect(await sampleVideo()).toMatchObject({
      time: 0,
      frames: 0,
      width: 0,
      height: 0,
      paused: true,
    });
    expect(fixture.stats().active).toBe(0);
    // The stopped channel is never asked for again. Other saved channels may be
    // checked by the quiet saved-channel check (October 19, 2026), which runs
    // while nothing plays; each such request must be complete, nothing held.
    const after = fixture.stats().records.slice(stoppedRequestCount);
    expect(after.filter((record) => record.generation === stoppedGeneration)).toEqual([]);
    expect(after.every((record) => record.finished && record.released)).toBe(true);
    report.idleSavedChannelChecks = after.length;
    await resources(`stopped-natural-idle-${seconds}s`);
  }
  report.stopEvidence = {
    path: 'Remove current owned fixture channel UI',
    naturalIdleSeconds: 30,
    retiredNetworkQuiet: true,
    forcedGc: false,
  };
  report.status = 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.message.slice(0, 1000) : 'Switch assertion failed';
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    try {
      await captureClose('before-ordinary-exit');
      await page.screenshot({
        path: path.join(directory, 'before-ordinary-exit.png'),
        timeout: 5000,
      });
    } catch {
      report.cleanup.closeCaptureUnconfirmed = true;
    }
    try {
      if (!(await page.locator('#settings-dialog').isVisible()))
        await page.locator('#settings-button').click({ timeout: 5000 });
      report.cleanup.ordinaryExitRequested = true;
      await page.locator('#exit-button').click({ timeout: 10000 });
    } catch {
      // The native window can close before Playwright's click acknowledgment arrives.
      report.cleanup.exitInteractionUnconfirmed = true;
    }
    const until = Date.now() + 30000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < until) await wait(50);
    if (app.exitCode === null && app.signalCode === null) {
      try {
        await captureClose('ordinary-exit-unconfirmed');
      } catch {
        report.cleanup.closeCaptureUnconfirmed = true;
      }
    }
    report.cleanup.ordinaryExitConfirmed =
      report.cleanup.ordinaryExitRequested === true &&
      app.exitCode === 0 &&
      app.signalCode === null;
    if (app.exitCode === null && app.signalCode === null) {
      report.cleanup.forced = true;
      report.status = 'FAIL';
      process.exitCode = 1;
      // Exact spawned child only; forced termination is failed cleanup, never ordinary Exit.
      report.cleanup.forcedSignalSent = app.kill();
      const killedUntil = Date.now() + 5000;
      while (app.exitCode === null && app.signalCode === null && Date.now() < killedUntil)
        await wait(50);
    }
  }
  if (report.cleanup.ordinaryExitConfirmed !== true) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  await browser?.close().then(
    () => {
      report.cleanup.observerClosed = true;
    },
    () => {
      report.cleanup.observerClosed = false;
    },
  );
  const settledObservations = await Promise.allSettled([...closeOperations]);
  report.cleanup.closeObservationsJoined = closeOperations.size === 0;
  report.cleanup.closeObservationRejections = settledObservations.filter(
    (result) => result.status === 'rejected',
  ).length;
  let remainingProcesses = [];
  const processDeadline = Date.now() + 5000;
  do {
    try {
      if (ownedProcessIds.size) {
        remainingProcesses = JSON.parse(
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `@((Get-Process -Id ${[...ownedProcessIds].join(',')} -ErrorAction SilentlyContinue) | Select-Object Id,ProcessName) | ConvertTo-Json -Compress`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 },
          ).trim() || '[]',
        );
        if (!Array.isArray(remainingProcesses)) remainingProcesses = [remainingProcesses];
      }
    } catch {
      report.cleanup.processAbsenceUnconfirmed = true;
      report.status = 'FAIL';
      process.exitCode = 1;
      break;
    }
    if (remainingProcesses.length) await wait(100);
  } while (remainingProcesses.length && Date.now() < processDeadline);
  report.requests = fixture.stats().records;
  let closed;
  try {
    closed = await fixture.close();
  } catch {
    closed = { sockets: null, active: null };
    report.cleanup.fixtureCloseUnconfirmed = true;
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.cleanup = {
    ...report.cleanup,
    ...closed,
    remainingProcesses,
    exitCode: app?.exitCode ?? null,
    signal: app?.signalCode ?? null,
    confirmed:
      !!app &&
      app.exitCode === 0 &&
      app.signalCode === null &&
      report.cleanup.ordinaryExitConfirmed === true &&
      report.cleanup.observerClosed === true &&
      report.cleanup.closeObservationsJoined === true &&
      !report.cleanup.closeCaptureUnconfirmed &&
      !report.cleanup.processAbsenceUnconfirmed &&
      closed.sockets === 0 &&
      closed.active === 0 &&
      remainingProcesses.length === 0 &&
      !report.cleanup.forced,
  };
  if (!report.cleanup.confirmed || hash(await readFile(executable)) !== sha256) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      actualSelections: report.actualSelections,
      decodedSelections: report.decodedSelections,
      report: path.join(directory, 'report.json'),
    }),
  );
}
