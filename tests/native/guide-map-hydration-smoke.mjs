import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { importFixtureCatalogFile } from '../../scripts/scan-save-helper.mjs';
import { chooseSettingsSection } from './settings-navigation-helper.mjs';
import {
  CURRENT_TITLE,
  MAP_CHANNEL,
  MAP_HEADER,
  MAP_SOURCE,
  NEXT_TITLE,
  startGuideMapFixture,
} from './guide-map-hydration-fixture.mjs';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const protectedBinary = 'ad34eea1db81faaa2658d29aea3c4d697bfc470fc22df92d8fb3e49ac5da23cc';
export function exactGuideMapArguments(args) {
  const executable = args.find((v) => !v.startsWith('--'));
  const expected = args.find((v) => v.startsWith('--sha256='))?.slice(9);
  if (
    !executable ||
    !/^[a-f0-9]{64}$/.test(expected ?? '') ||
    expected === protectedBinary ||
    args.filter((v) => v.startsWith('--sha256=')).length !== 1
  )
    throw new Error(
      'Explicit owned packaged executable and exact --sha256 are required; protected user binary refused.',
    );
  return { executable: path.resolve(executable), expected };
}
async function port() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function observeSql(databasePath) {
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0;PRAGMA query_only=ON;BEGIN');
    const channel = db.prepare('SELECT id,source_id,provider_id,name FROM channel').all();
    const sources = db
      .prepare('SELECT id,name,revision,published_revision FROM guide_source WHERE name=?')
      .all(MAP_SOURCE);
    return {
      channels: channel,
      sources,
      automatic: db
        .prepare('SELECT automatic_guide_updates AS enabled FROM metadata WHERE singleton=1')
        .get().enabled,
      headers: db.prepare('SELECT guide_source_id,id FROM guide_channel').all(),
      mappings: db
        .prepare(
          'SELECT catalog_source_id,app_channel_id,guide_source_id,xmltv_channel_id FROM guide_mapping',
        )
        .all(),
      programs: db
        .prepare(
          'SELECT guide_source_id,channel_id,title,start_ms,stop_ms FROM guide_program ORDER BY start_ms,ordinal',
        )
        .all(),
    };
  } catch (error) {
    if ([5, 6].includes(error?.errcode)) return null;
    throw error;
  } finally {
    db?.close();
  }
}
async function dropdown(page, label, option) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function closeGuide(page) {
  const button = page.getByRole('button', { name: 'Close guide', exact: true });
  if (await button.isVisible()) {
    await button.click();
    await expect(
      page.getByRole('dialog', { name: 'Program guide', exact: true }),
    ).not.toBeVisible();
  }
}
async function unwindOwnedDialogs(page) {
  const review = page.getByRole('dialog', { name: 'Review source scan', exact: true });
  if (await review.isVisible()) {
    const close = review.getByRole('button', { name: 'Close scan review', exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(review).not.toBeVisible();
  }
  const imported = page.locator('#import-dialog');
  if (await imported.isVisible()) {
    const cancel = imported.locator('#cancel-import');
    if ((await cancel.isVisible()) && (await cancel.isEnabled())) await cancel.click();
    const close = imported.getByRole('button', { name: 'Close import', exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(imported).not.toBeVisible();
  }
  await closeGuide(page);
}
async function quiet(fixture, milliseconds = 600) {
  const before = fixture.stats().guideRequests;
  await wait(milliseconds);
  expect(fixture.stats().guideRequests).toBe(before);
  return { windowMs: milliseconds, guideRequests: before };
}
export async function runGuideMapHydration(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('Windows packaged runtime only.');
  const { executable, expected } = exactGuideMapArguments(args);
  const binaryHash = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  if (binaryHash !== expected) throw new Error('Exact packaged executable SHA-256 mismatch.');
  const directory = path.resolve(
    'artifacts/native-guide-map-hydration',
    new Date().toISOString().replaceAll(':', '-'),
  );
  const data = await mkdtemp(path.join(tmpdir(), 'genx-guide-map-hydration-owned-'));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(data, 'owned-fixture.json'),
    JSON.stringify({ kind: 'guide-map-hydration-only', binarySha256: binaryHash }),
  );
  const report = {
    schemaVersion: 1,
    status: 'FAIL',
    scope:
      'Exact packaged Windows actual-UI Guide Map hydration with controlled fixture; no TV/decoder/public-feed/release acceptance.',
    startedUtc: new Date().toISOString(),
    binarySha256: binaryHash,
    executable,
    data,
    evidenceDirectory: directory,
    checks: [],
    cleanup: { forced: false },
  };
  let media,
    fixture,
    app,
    browser,
    page,
    exitReceipt = null,
    exitRequested = false,
    exitStarted = 0;
  const fail = (message) => {
    report.status = 'FAIL';
    (report.failures ??= []).push(message);
    process.exitCode = 1;
  };
  try {
    media = await startFixtureServer();
    fixture = await startGuideMapFixture(media.url);
    report.fixtureSeed = {
      name: 'manual-unmapped-header-map-refetch-current-next-v1',
      seedTimeMs: fixture.seed,
    };
    const cdpPort = await port();
    report.debugPort = cdpPort;
    app = spawn(executable, [], {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        TMG_DATA_DIR: data,
        WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'WebView'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
      },
    });
    report.ownedPid = app.pid;
    app.once('error', (error) => {
      report.launchError = error.code ?? 'spawn-error';
    });
    app.once('exit', (code, signal) => {
      exitReceipt = {
        pid: app.pid,
        code,
        signal,
        afterUiRequest: exitRequested,
        elapsedMs: exitRequested ? performance.now() - exitStarted : null,
      };
    });
    let endpoint;
    for (let i = 0; i < 300; i++) {
      if (exitReceipt || app.exitCode !== null || app.signalCode !== null)
        throw new Error('Owned app exited before readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
          redirect: 'error',
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          endpoint = (await response.json()).webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await wait(100);
    }
    if (!endpoint) throw new Error('Owned CDP readiness timeout');
    browser = await chromium.connectOverCDP(endpoint);
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => !p.url().startsWith('devtools:'));
    if (!page) throw new Error('Owned WebView page absent');
    page.setDefaultTimeout(20000);
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
    await page.locator('#settings-button').click();
    // Automatic-guide control is mounted before the Advanced guide button,
    // inside the already-created Advanced section (not Settings backup).
    await chooseSettingsSection(page, 'advanced');
    await page.locator('#automatic-guide-updates').uncheck();
    await expect(page.locator('#automatic-guide-updates-status')).toHaveText(
      'Program guide preference saved.',
    );
    await chooseSettingsSection(page, 'sources');
    await page.locator('#import-button').click();
    const customSource = page.locator('#custom-source-options');
    if ((await customSource.getAttribute('open')) === null)
      await customSource.locator('summary').click();
    await page.locator('#allow-http').check();
    await importFixtureCatalogFile(page, `${fixture.origin}/catalog.m3u`);
    await expect(page.locator('#channel-count')).toContainText('1 channel');
    if (await page.locator('#settings-dialog').isVisible())
      await page.locator('#settings-dialog [data-close="settings-dialog"]').click();
    await page.locator('button[data-channel]').filter({ hasText: MAP_CHANNEL }).click();
    await expect(page.locator('#watch-title')).toHaveText(MAP_CHANNEL);
    await page.locator('#guide-button').click();
    await expect(page.getByRole('dialog', { name: 'Program guide', exact: true })).toBeVisible();
    report.openingGuide = await quiet(fixture);
    expect(report.openingGuide.guideRequests).toBe(0);
    await closeGuide(page);
    await page.locator('#settings-button').click();
    await chooseSettingsSection(page, 'advanced');
    await page.locator('#advanced-guide-button').click();
    const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
    await expect(guide).toBeVisible();
    await guide.locator('summary').filter({ hasText: 'Add guide link or file' }).click();
    await guide.getByLabel('Guide source name', { exact: true }).fill(MAP_SOURCE);
    await guide.getByLabel('Online XMLTV URL', { exact: true }).fill(`${fixture.origin}/guide.xml`);
    await guide.getByLabel('Allow HTTP for this guide source', { exact: true }).check();
    await guide.getByRole('button', { name: 'Save source and preview', exact: true }).click();
    await expect(
      guide.getByRole('button', { name: 'Save reviewed schedule', exact: true }),
    ).toBeEnabled();
    await guide.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
    await expect(guide).toContainText(/Reviewed guide schedule saved|Guide saved|saved/i);
    const databasePath = path.join(data, 'genx.sqlite3');
    await expect
      .poll(
        () => {
          const v = observeSql(databasePath);
          return (
            v &&
            v.sources.length === 1 &&
            v.headers.length === 1 &&
            v.programs.length === 0 &&
            v.mappings.length === 0
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const before = observeSql(databasePath);
    expect(before.channels).toHaveLength(1);
    expect(before.channels[0].name).toBe(MAP_CHANNEL);
    expect(before.channels[0].provider_id ?? '').toBe('');
    expect(before.automatic).toBe(0);
    expect(before.headers[0].id).toBe(MAP_HEADER);
    report.beforeMap = {
      channelCount: 1,
      providerIdAbsent: true,
      sourceCount: 1,
      headers: 1,
      retainedPrograms: 0,
      mappings: 0,
      automaticGuideOff: true,
      guideRequests: fixture.stats().guideRequests,
    };
    const channel = before.channels[0],
      source = before.sources[0];
    await dropdown(guide, 'Guide view', 'Channel mapping');
    await guide.getByLabel('Mapping guide source', { exact: true }).selectOption(source.id);
    await guide.getByLabel('Find the guide channel', { exact: true }).fill('');
    const lookup = guide.getByRole('button', { name: 'Find guide channels', exact: true });
    await lookup.click();
    await expect(
      guide
        .getByLabel('Mapping guide channel', { exact: true })
        .locator(`option[value="${MAP_HEADER}"]`),
    ).toHaveCount(1);
    await guide.getByLabel('Mapping guide channel', { exact: true }).selectOption(MAP_HEADER);
    const mapButton = guide.getByRole('button', { name: 'Map selected channel', exact: true });
    fixture.failGuide(true);
    const beforeFailure = fixture.stats().guideRequests;
    await mapButton.click();
    await expect(guide.getByRole('status', { name: 'Guide update', exact: true })).toHaveText(
      'Guide connection saved. Its schedule could not be updated. Retry from Manage sources.',
    );
    expect(fixture.stats().guideRequests).toBeGreaterThan(beforeFailure);
    const mapped = () => {
      const v = observeSql(databasePath);
      if (!v) return null;
      const m = v.mappings[0];
      return (
        v.mappings.length === 1 &&
        m.catalog_source_id === channel.source_id &&
        m.app_channel_id === channel.id &&
        m.guide_source_id === source.id &&
        m.xmltv_channel_id === MAP_HEADER
      );
    };
    await expect.poll(mapped).toBe(true);
    expect(observeSql(databasePath).programs).toHaveLength(0);
    report.failedHydration = {
      networkAttempted: true,
      mappingDurable: true,
      programsRetained: 0,
      failedGuideRequests: fixture.stats().failedGuideRequests,
    };
    fixture.failGuide(false);
    const beforeSuccess = fixture.stats().guideRequests;
    await mapButton.click();
    await expect(guide.getByRole('status', { name: 'Guide update', exact: true })).toHaveText(
      'Program guide connected. Listings are ready.',
    );
    expect(fixture.stats().guideRequests).toBeGreaterThan(beforeSuccess);
    await expect
      .poll(() => observeSql(databasePath)?.programs.map((v) => v.title))
      .toEqual([CURRENT_TITLE, NEXT_TITLE]);
    const after = observeSql(databasePath);
    expect(mapped()).toBe(true);
    expect(after.automatic).toBe(0);
    expect(
      after.programs.every((p) => p.guide_source_id === source.id && p.channel_id === MAP_HEADER),
    ).toBe(true);
    report.hydrated = {
      exactMapping: true,
      currentNextTitles: after.programs.map((p) => p.title),
      programs: 2,
      guideRequests: fixture.stats().guideRequests,
      automaticGuideOff: true,
    };
    await closeGuide(page);
    if (await page.locator('#settings-dialog').isVisible())
      await page.locator('#settings-dialog [data-close="settings-dialog"]').click();
    await page.locator('#guide-button').click();
    await expect(page.getByRole('dialog', { name: 'Program guide', exact: true })).toContainText(
      CURRENT_TITLE,
    );
    report.reopenedGuide = await quiet(fixture);
    await page.screenshot({ path: path.join(directory, 'hydrated-guide.png') });
    report.checks.push(
      'Opening Guide alone did not fetch during bounded observed window',
      'Actual UI added/reviewed/saved one guide with complete header but zero unmapped retained programmes',
      'Failed network hydration retained exact durable manual mapping',
      'Actual UI Map retry fetched again and persisted exact current/next programme rows with automatic updates Off',
      'Reopened Guide rendered actual current title without further fetch in observed window',
    );
    if (exitReceipt || app.exitCode !== null || app.signalCode !== null)
      throw new Error('Unexpected owned exit before ordinary Exit');
    report.status = 'PASS';
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Guide map runtime failed');
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  } finally {
    if (app) {
      report.cleanup.exitRequested = false;
      if (exitReceipt || app.exitCode !== null || app.signalCode !== null)
        fail('Owned app exited before UI Exit request');
      else if (page && !page.isClosed()) {
        try {
          await unwindOwnedDialogs(page);
          if (!(await page.locator('#settings-dialog').isVisible()))
            await page.locator('#settings-button').click();
          await expect(page.locator('#exit-button')).toBeVisible();
          exitRequested = true;
          exitStarted = performance.now();
          report.cleanup.exitRequested = true;
          await page.locator('#exit-button').click();
          report.cleanup.exitClickSettled = true;
        } catch (error) {
          report.cleanup.exitActionError =
            error instanceof Error ? error.message : 'UI Exit failed';
        }
        for (let i = 0; i < 300 && !exitReceipt; i++) await wait(100);
      }
      report.cleanup.exitReceipt = exitReceipt;
      report.cleanup.ordinary =
        !!exitReceipt &&
        report.cleanup.exitClickSettled === true &&
        exitReceipt.afterUiRequest &&
        exitReceipt.pid === app.pid &&
        exitReceipt.code === 0 &&
        exitReceipt.signal === null;
      report.cleanup.ownedChildAbsent = !!exitReceipt;
      if (!report.cleanup.ordinary)
        fail(
          'Exact owned ordinary UI Exit/code0/no-signal receipt unconfirmed; no forced kill performed',
        );
      report.cleanup.retainedOwnedProcess = !exitReceipt && Number.isSafeInteger(app.pid);
      if (report.cleanup.retainedOwnedProcess)
        report.cleanup.recovery = {
          pid: app.pid,
          debugPort: report.debugPort,
          status: 'OWNERSHIP_RETAINED_WAITING_FOR_ROOT_ORDINARY_UI_EXIT',
        };
    }
    if (browser && exitReceipt) {
      try {
        await browser.close();
      } catch {
        if (browser.isConnected()) fail('Owned CDP connection cleanup unconfirmed');
      }
      report.cleanup.debugConnectionClosed = !browser.isConnected();
    } else if (browser) {
      // Keep this process and its exact CDP ownership alive for root recovery.
      // Never hide a still-running owned app by unref/disconnect/force-quit.
      report.cleanup.debugConnectionClosed = !browser.isConnected();
      report.cleanup.debugConnectionRetained = browser.isConnected();
    }
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        fail('Owned Guide fixture cleanup unconfirmed');
      }
      report.fixtureFinal = fixture.stats();
    }
    if (media) {
      try {
        await media.close();
      } catch {
        fail('Owned media fixture cleanup unconfirmed');
      }
      report.mediaFinal = media.stats();
      if (
        report.mediaFinal.activeResponses ||
        report.mediaFinal.activeSockets ||
        report.mediaFinal.timers
      )
        fail('Owned media fixture retained resources');
    }
    const finalDb = path.join(data, 'genx.sqlite3');
    if (report.cleanup.ordinary && report.status === 'PASS') {
      let db;
      try {
        db = new DatabaseSync(finalDb, { readOnly: true });
        report.closedSql = {
          quickCheck: db.prepare('PRAGMA quick_check').get().quick_check,
          foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
          channelCount: db.prepare('SELECT COUNT(*) AS n FROM channel').get().n,
          mappingCount: db.prepare('SELECT COUNT(*) AS n FROM guide_mapping').get().n,
          programCount: db.prepare('SELECT COUNT(*) AS n FROM guide_program').get().n,
        };
        if (
          report.closedSql.quickCheck !== 'ok' ||
          report.closedSql.foreignKeyViolations ||
          report.closedSql.channelCount !== 1 ||
          report.closedSql.mappingCount !== 1 ||
          report.closedSql.programCount !== 2
        )
          fail('Closed SQL proof mismatch');
      } catch {
        fail('Closed SQL proof unavailable');
      } finally {
        db?.close();
      }
    }
    report.finishedUtc = new Date().toISOString();
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        status: report.status,
        directory,
        binarySha256: binaryHash,
        ownedPid: app?.pid,
        ordinary: report.cleanup.ordinary,
        checks: report.checks.length,
      }),
    );
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runGuideMapHydration();
