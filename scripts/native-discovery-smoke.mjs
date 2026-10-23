/* global window, document -- callbacks execute only inside this script's isolated WebView. */
// Packaged Windows discovery check against real public services, in an isolated
// profile (TMG_DATA_DIR). Public availability is observed, not asserted: only the
// app's own behavior (bounded replies, caching, UI wiring, ordinary exit) gates PASS.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const exe = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const searchOnly = process.argv.includes('--search-only');
const query = process.argv.find((a) => a.startsWith('--query='))?.slice(8) ?? 'ESPN';
const scanSeconds = Number(
  process.argv.find((a) => a.startsWith('--scan-seconds='))?.slice(15) ?? 240,
);
const base = path.resolve('artifacts/native-discovery-smoke');
const directory = path.join(base, new Date().toISOString().replaceAll(':', '-'));
const data = path.join(directory, `data-${Date.now()}`);
await mkdir(data, { recursive: true });
const report = {
  scope:
    'Packaged Windows discovery behavior on an isolated profile with real public services; observations of public data are not availability guarantees',
  started: new Date().toISOString(),
  executable: exe,
  sha256: createHash('sha256')
    .update(await readFile(exe))
    .digest('hex'),
  query,
  status: 'FAIL',
  checks: [],
  observations: {},
  evidenceDirectory: directory,
};
const describeError = (error) => (error instanceof Error ? error.message : String(error));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, page;
let exitReceipt = null;
let exitRequestedAt = null;
const invoke = (command, args) =>
  page.evaluate(
    ([name, values]) =>
      window.__TAURI_INTERNALS__
        .invoke(name, values)
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error: String(error) })),
    [command, args],
  );
try {
  app = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  app.on('error', (error) => (report.launchError = error.message));
  app.once('exit', (code, signal) => {
    exitReceipt = { code, signal, atMs: performance.now(), requested: exitRequestedAt !== null };
  });
  let endpoint;
  for (let i = 0; i < 300 && !endpoint; i++) {
    if (report.launchError || exitReceipt) throw new Error('Owned app exited before readiness.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) endpoint = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await wait(100);
  }
  if (!endpoint) throw new Error('Native WebView debugging endpoint did not become ready.');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('No native application WebView page.');
  page.setDefaultTimeout(20000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  report.console = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()) && report.console.length < 200)
      report.console.push(`${message.type()}: ${message.text().slice(0, 500)}`);
  });
  page.on('pageerror', (error) => report.console.push(`pageerror: ${error.message.slice(0, 500)}`));
  report.checks.push('Embedded UI ready on an isolated profile');

  if (!searchOnly) {
    // R4: repeated directory reads reuse the bounded native cache.
    const directoryUrl = 'https://api.github.com/repositories/157616880';
    const first = await invoke('inspect_source_directory', {
      url: directoryUrl,
      requestId: 'smoke-dir-1',
    });
    const second = await invoke('inspect_source_directory', {
      url: directoryUrl,
      requestId: 'smoke-dir-2',
    });
    report.observations.directory = {
      first: first.ok ? first.value.cache : first.error,
      second: second.ok ? second.value.cache : second.error,
    };
    if (first.ok) {
      if (!second.ok || second.value.cache !== 'fresh-cache')
        throw new Error('A repeated directory read within 15 minutes did not reuse the cache.');
      report.checks.push('Repeated GitHub directory read served from the bounded native cache');
    } else if (!/rate-limited|unavailable/.test(first.error))
      throw new Error(`Directory read failed unexpectedly: ${first.error}`);

    // R7: explicit series identity lookup (real TVmaze).
    const series = await invoke('series_identity_lookup', {
      query: 'Don Knotts',
      requestId: 'smoke-series',
    });
    report.observations.series = series.ok ? series.value : series.error;
    if (series.ok) {
      if (series.value.attribution !== 'Show information from TVmaze (CC BY-SA 4.0)')
        throw new Error('Series reply lacks attribution.');
      report.checks.push(
        `Series lookup returned ${series.value.shows.length} shows and person=${series.value.person?.name ?? 'none'}`,
      );
    }
  }
  // Optional explicit provider configuration through Settings (no GitHub directory needed).
  const providers = process.argv.find((a) => a.startsWith('--providers='))?.slice(12);
  if (providers) {
    await page.locator('#settings-button').click();
    await page.locator('#settings-section').click();
    await page.locator('[data-settings-section="advanced"]').click();
    await page
      .locator('#settings-dialog details summary', { hasText: 'Discovery providers' })
      .click();
    const registry = {
      schemaVersion: 1,
      reviewedChannelProviders: providers.split(',').map((location, index) => ({
        id: `smoke-provider-${index}`,
        name: new URL(location).pathname.split('/').at(-1),
        location,
        provenance: 'https://github.com/iptv-org/iptv',
      })),
      reviewedGuideProviders: [],
    };
    await page.locator('#provider-configuration').fill(JSON.stringify(registry, null, 2));
    await page.locator('#save-provider-configuration').click();
    await expect(page.locator('#provider-configuration-status')).not.toBeEmpty();
    report.observations.providerConfiguration = await page
      .locator('#provider-configuration-status')
      .textContent();
    await page.locator('[data-close="settings-dialog"]').first().click();
  }
  // R1/R4: Live TV magnifier searches with real online discovery and probing.
  const stop = page.locator('#inline-scan-stop');
  const status = async () =>
    (await page
      .locator('#inline-scan-status')
      .textContent()
      .catch(() => '')) ?? '';
  const watchSearch = async (text, limitMs, finished) => {
    await page.locator('#search').fill(text);
    await page.locator('#search-programs').click();
    const began = performance.now();
    const trail = [];
    let sawReading = false;
    let sawIndexing = false;
    let checkingMs = null;
    let firstChannelMs = null;
    const before = await page.locator('button[data-channel]').count();
    while (performance.now() - began < limitMs) {
      const current = await status();
      if (/Reading source/.test(current)) sawReading = true;
      if (/\d+ of \d+ entries read/.test(current)) sawIndexing = true;
      if (checkingMs === null && /Preparing channel checks|of \d+ checked/.test(current))
        checkingMs = Math.round(performance.now() - began);
      const problem =
        (await page
          .locator('#inline-scan-error')
          .textContent()
          .catch(() => '')) ?? '';
      if (!trail.length || trail.at(-1).status !== current || trail.at(-1).error !== problem)
        trail.push({
          atMs: Math.round(performance.now() - began),
          status: current,
          error: problem,
        });
      if (firstChannelMs === null && (await page.locator('button[data-channel]').count()) > before)
        firstChannelMs = Math.round(performance.now() - began);
      if (await finished(began, { checkingMs, firstChannelMs })) break;
      await wait(500);
    }
    const diagnostics = await page
      .evaluate(() => ({ bounded: window.__GENX_BOUNDED_SCAN__, scan: window.__GENX_SCAN__ }))
      .catch(() => null);
    return {
      diagnostics,
      query: text,
      sawReading,
      sawIndexing,
      checkingMs,
      firstChannelMs,
      statusTrail: trail.slice(0, 80),
    };
  };
  // 1. A narrow first search, allowed to complete so its index is recorded.
  report.observations.firstSearch = await watchSearch(query, scanSeconds * 1000, async (began) => {
    const elapsed = performance.now() - began;
    return elapsed > 5000 && !(await stop.isVisible().catch(() => false));
  });
  // Completion is the app's own scan phase, not merely a hidden Stop button.
  report.observations.firstSearch.completed =
    report.observations.firstSearch.diagnostics?.scan?.phase === 'completed';
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 60000 });
  }
  report.checks.push(
    `First search "${query}": checks after ${report.observations.firstSearch.checkingMs} ms; completed=${report.observations.firstSearch.completed}`,
  );
  if (!searchOnly) {
    // 2. A different query after completion reuses the unchanged index this session.
    const secondQuery = process.argv.find((a) => a.startsWith('--second='))?.slice(9) ?? 'CNN';
    report.observations.secondSearch = await watchSearch(
      secondQuery,
      180000,
      async (began, s) => s.checkingMs !== null && performance.now() - began - s.checkingMs > 20000,
    );
    if (report.observations.firstSearch.completed && report.observations.secondSearch.sawIndexing)
      throw new Error('A query search after a completed search re-indexed an unchanged source.');
    if (report.observations.firstSearch.completed)
      report.checks.push(
        `Second search "${secondQuery}": checks after ${report.observations.secondSearch.checkingMs} ms; re-indexed=${report.observations.secondSearch.sawIndexing}`,
      );
    else {
      // An unfinished first scan must refuse a different query instead of continuing it.
      await expect(page.locator('#inline-scan-error')).toContainText('Scan query changed', {
        timeout: 20000,
      });
      report.checks.push('A different query during an unfinished search offered Continue/Rescan');
      // Rescan with the new query is a new search: recently indexed sources are reused.
      const began = performance.now();
      await page.locator('#inline-scan-rescan').click();
      let rescanIndexing = false;
      let rescanChecksMs = null;
      while (performance.now() - began < 180000 && rescanChecksMs === null) {
        const current = await status();
        if (/\d+ of \d+ entries read/.test(current)) rescanIndexing = true;
        if (
          /Preparing channel checks|of \d+ checked/.test(current) &&
          /“?CNN|Preparing/.test(current)
        )
          rescanChecksMs = Math.round(performance.now() - began);
        await wait(250);
      }
      report.observations.rescanNewQuery = { rescanIndexing, rescanChecksMs };
      if (rescanIndexing)
        throw new Error('Rescan with a new query re-indexed unchanged recent sources.');
      report.checks.push(
        `Rescan with a new query reached checks in ${rescanChecksMs} ms without re-indexing`,
      );
      if (await stop.isVisible().catch(() => false)) {
        await stop.click();
        await expect(stop).toBeHidden({ timeout: 60000 });
      }
    }
    // 3. A third query while the second is unfinished is refused, not silently continued.
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 60000 });
      report.checks.push('Online search stopped explicitly and joined');
      await page.locator('#search').fill('Weather');
      await page.locator('#search-programs').click();
      await expect(page.locator('#inline-scan-error')).toContainText('Scan query changed', {
        timeout: 20000,
      });
      report.checks.push('A different query during an unfinished search offered Continue/Rescan');
    }
    report.observations.visibleChannels = (
      await page.locator('button[data-channel]').allTextContents()
    ).slice(0, 20);
  }
  if (!searchOnly) {
    // R2: publisher guide suggestions from saved channels; R9: grabber export.
    const pack = await invoke('guide_pack_suggestions', {});
    report.observations.packSuggestions = pack.ok ? pack.value : pack.error;
    if (!pack.ok) throw new Error(`Pack suggestions failed: ${pack.error}`);
    const grabber = await invoke('guide_grabber_channels', { requestId: 'smoke-grabber' });
    report.observations.grabber = grabber.ok
      ? {
          channels: grabber.value.channels,
          unmatched: grabber.value.unmatched,
          sites: grabber.value.sites.slice(0, 5),
          xmlBytes: grabber.value.xml.length,
        }
      : grabber.error;
    if (grabber.ok) {
      await writeFile(path.join(directory, 'grabber-channels.xml'), grabber.value.xml);
      report.checks.push(`Grabber list prepared for ${grabber.value.channels} saved channels`);
    }

    // R9 control is present in Settings and inside the dialog bounds.
    await page.locator('#settings-button').click();
    report.observations.guideStatus = await page
      .locator('#settings-dialog p', { hasText: 'Program guides:' })
      .first()
      .textContent()
      .catch(() => null);
    await page.locator('#settings-section').click();
    await page.locator('[data-settings-section="advanced"]').click();
    await page
      .locator('#settings-dialog details', {
        has: page.locator('summary', { hasText: 'Discovery providers' }),
      })
      .evaluate((details) => {
        details.open = true;
      });
    const control = page.locator('#export-guide-grabber');
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const bounds = await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog').getBoundingClientRect();
      const button = document.getElementById('export-guide-grabber').getBoundingClientRect();
      return { inside: button.left >= dialog.left && button.right <= dialog.right };
    });
    if (!bounds.inside) throw new Error('Grabber export control is clipped horizontally.');
    await page.locator('[data-close="settings-dialog"]').first().click();
    report.checks.push('Settings grabber export control visible within the dialog');

    // R7 UI: GenXtra search shows TVmaze chips without autoplay.
    await page.locator('#genxtra-button').click();
    await page.locator('#search').fill('Don Knotts');
    await page.locator('#search-programs').click();
    const chips = page.locator('.gx-archive-series-chip');
    try {
      await expect(chips.first()).toBeVisible({ timeout: 30000 });
      report.observations.genxtraChips = await chips.allTextContents();
      report.checks.push('GenXtra Search showed show suggestions');
    } catch {
      report.observations.genxtraChips = 'not shown within 30 s';
    }
    report.observations.playbackStatus = await page
      .locator('#playback-status')
      .textContent()
      .catch(() => null);
    await page.screenshot({ path: path.join(directory, 'genxtra-suggestions.png') });
    const cancel = page.locator('.gx-archive-search button', { hasText: 'Cancel request' });
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    await page.locator('#live-tv-button').click();
    await page.screenshot({ path: path.join(directory, 'live-tv.png') });
  }
  if (exitReceipt) throw new Error('Owned app exited before ordinary shutdown was requested.');
  report.status = 'PASS';
} catch (error) {
  report.error = describeError(error);
  process.exitCode = 1;
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined);
} finally {
  if (app) {
    report.closure = { requested: false, forced: false };
    if (!exitReceipt && page && !page.isClosed()) {
      exitRequestedAt = performance.now();
      report.closure.requested = true;
      void page
        .evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
        .catch(() => undefined);
      for (let i = 0; i < 600 && !exitReceipt; i++) await wait(100);
    }
    if (!exitReceipt) {
      report.closure.forced = true;
      report.status = 'FAIL';
      process.exitCode = 1;
      try {
        app.kill();
      } catch {}
      for (let i = 0; i < 50 && !exitReceipt; i++) await wait(100);
    }
    report.closure.exit = exitReceipt;
    report.closure.ordinary =
      !!exitReceipt && exitReceipt.requested && exitReceipt.code === 0 && !report.closure.forced;
    if (exitReceipt)
      report.closure.elapsedMs = Math.round(
        exitReceipt.atMs - (exitRequestedAt ?? exitReceipt.atMs),
      );
    if (!report.closure.ordinary) {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  }
  await browser?.close().catch(() => undefined);
  try {
    const database = new DatabaseSync(path.join(data, 'genx.sqlite3'), { readOnly: true });
    report.savedRecords = {
      channels: database.prepare('SELECT COUNT(*) AS total FROM channel').get().total,
      sources: database.prepare('SELECT COUNT(*) AS total FROM source').get().total,
      guideSources: database.prepare('SELECT COUNT(*) AS total FROM guide_source').get().total,
      guideMappings: database.prepare('SELECT COUNT(*) AS total FROM guide_mapping').get().total,
      integrity: database.prepare('PRAGMA quick_check').get().quick_check,
    };
    database.close();
    if (report.savedRecords.integrity !== 'ok') {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  } catch (error) {
    report.savedRecordsError = describeError(error);
  }
  // The isolated profile is a test byproduct; its counts are recorded above.
  if (!process.argv.includes('--keep-profile') && path.basename(data).startsWith('data-'))
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { status: report.status, error: report.error, checks: report.checks, directory },
      null,
      2,
    ),
  );
}
