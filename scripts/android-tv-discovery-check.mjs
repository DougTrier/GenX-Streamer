/* global window, document -- callbacks execute only inside the installed TV WebView. */
// Installed Android TV check for the discovery milestone. Refuses every serial except
// the designated TV. Never installs, uninstalls, clears data or scans the user's
// library: it launches, reads, exercises read-only native commands and Settings,
// exits normally, then compares logical user data before and after.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execute = promisify(execFile);
const SERIAL = process.env.GENX_APPROVED_TV_SERIAL ?? '';
if (!SERIAL) throw new Error('Set GENX_APPROVED_TV_SERIAL to the approved TV.');
const PACKAGE = 'com.tmg.tv';
const adbPath = process.env.ADB ?? 'adb';
const serial = process.argv[2];
const expectedApk = process.argv.find((a) => a.startsWith('--apk-sha256='))?.slice(13);
const before = process.argv.find((a) => a.startsWith('--before='))?.slice(9);
if (serial !== SERIAL) throw new Error(`Refusing serial ${serial}; only ${SERIAL} is allowed.`);
if (!expectedApk || !/^[a-f0-9]{64}$/.test(expectedApk)) throw new Error('--apk-sha256 required.');
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    })
  ).stdout.trim();
const directory = path.resolve(
  'artifacts/android-tv-discovery',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  scope:
    'Installed physical Android TV (Sansui NGamer, Android 14 ARMv7): startup, preserved user data, read-only discovery commands, Settings control, Guide view and ordinary exit. No library-changing search on the user profile.',
  serial,
  started: new Date().toISOString(),
  status: 'FAIL',
  checks: [],
  observations: {},
  evidenceDirectory: directory,
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page, forwarded;
const counts = (file) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const n = (sql) => database.prepare(sql).get().n;
    return {
      channels: n('SELECT COUNT(*) AS n FROM channel'),
      removed: n('SELECT COUNT(*) AS n FROM removed'),
      favorites: database
        .prepare('SELECT id FROM favorite ORDER BY ordinal')
        .all()
        .map((r) => r.id),
      sources: n('SELECT COUNT(*) AS n FROM source'),
      guideSources: n('SELECT COUNT(*) AS n FROM guide_source'),
      guideMappings: n('SELECT COUNT(*) AS n FROM guide_mapping'),
      integrity: database.prepare('PRAGMA quick_check').get().quick_check,
    };
  } finally {
    database.close();
  }
};
const archiveCounts = (file) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      titles: database.prepare('SELECT COUNT(*) AS n FROM archive_title_v1').get().n,
      bookmarks: database.prepare('SELECT COUNT(*) AS n FROM archive_bookmark_v1').get().n,
      integrity: database.prepare('PRAGMA quick_check').get().quick_check,
    };
  } finally {
    database.close();
  }
};
const pull = async (remote, local) => {
  const { stdout } = await execute(
    adbPath,
    ['-s', serial, 'exec-out', 'run-as', PACKAGE, 'cat', remote],
    {
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024,
      timeout: 600000,
    },
  );
  await writeFile(local, stdout);
};
const pid = async () => (await adb('shell', 'pidof', PACKAGE).catch(() => '')).trim();
try {
  const attach = process.argv.includes('--attach');
  if ((await pid()) && !attach)
    throw new Error('The app is already running; pass --attach to check this instance.');
  const apkPath = (await adb('shell', 'pm', 'path', PACKAGE))
    .replace(/^package:/, '')
    .split('\n')[0];
  report.installedApkSha256 = (await adb('shell', 'sha256sum', apkPath)).split(/\s/)[0];
  if (report.installedApkSha256 !== expectedApk)
    throw new Error('Installed APK is not the expected build.');
  report.checks.push('Installed APK matches the expected build');
  // Wake the display: a sleeping TV pauses WebView animation frames.
  await adb('shell', 'input', 'keyevent', '224');
  if (!(await pid())) await adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  let processId = '';
  for (let i = 0; i < 100 && !processId; i++) {
    processId = await pid();
    if (!processId) await wait(300);
  }
  if (!processId) throw new Error('The app process did not start.');
  const launched = Date.now();
  let port = '';
  for (let i = 0; i < 60 && !port; i++) {
    port = await adb(
      'forward',
      'tcp:0',
      `localabstract:webview_devtools_remote_${processId}`,
    ).catch(() => '');
    if (!port) await wait(500);
  }
  if (!port) throw new Error('The installed WebView debugging socket was not available.');
  forwarded = port;
  // The DevTools socket accepts connections a moment after the process appears.
  for (let i = 0; i < 40 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
    if (!browser) await wait(1500);
  }
  if (!browser)
    throw new Error('The installed WebView debugging endpoint did not accept a connection.');
  for (let i = 0; i < 60 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('tauri') || candidate.url().startsWith('http'));
    if (!page) await wait(500);
  }
  if (!page) throw new Error('No installed application WebView page.');
  page.setDefaultTimeout(30000);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 120000 });
  report.observations.readyAfterMs = Date.now() - launched;
  report.observations.deviceKind = await page.locator('#app').getAttribute('data-device-kind');
  report.observations.channelCountText = await page.locator('#channel-count').textContent();
  report.checks.push('Installed UI ready on the user profile');
  const invoke = (command, args) =>
    page.evaluate(
      ([name, values]) =>
        window.__TAURI_INTERNALS__
          .invoke(name, values)
          .then((value) => ({ ok: true, value }))
          .catch((error) => ({ ok: false, error: String(error) })),
      [command, args],
    );
  const pack = await invoke('guide_pack_suggestions', {});
  report.observations.packSuggestions = pack.ok ? pack.value : pack.error;
  if (!pack.ok) throw new Error(`Pack suggestions failed: ${pack.error}`);
  report.checks.push(`Publisher guide suggestions for the saved catalog: ${pack.value.length}`);
  const series = await invoke('series_identity_lookup', {
    query: 'Don Knotts',
    requestId: 'tv-series',
  });
  report.observations.series = series.ok
    ? {
        shows: series.value.shows.length,
        person: series.value.person?.name ?? null,
        personShows: series.value.person?.shows.map((s) => s.name) ?? [],
      }
    : series.error;
  if (series.ok) report.checks.push('TVmaze series lookup on Android');
  const directoryUrl = 'https://api.github.com/repositories/157616880';
  const first = await invoke('inspect_source_directory', {
    url: directoryUrl,
    requestId: 'tv-dir-1',
  });
  const second = await invoke('inspect_source_directory', {
    url: directoryUrl,
    requestId: 'tv-dir-2',
  });
  report.observations.directory = {
    first: first.ok ? first.value.cache : first.error,
    second: second.ok ? second.value.cache : second.error,
  };
  if (first.ok && (!second.ok || second.value.cache !== 'fresh-cache'))
    throw new Error('Repeated directory read did not reuse the native cache on Android.');
  report.checks.push('GitHub directory read behaved as cached or rate-limited on Android');
  // Guide view renders. Guide belongs to Live TV; GenXtra disables it by design.
  report.observations.restoredLibrary =
    (await page.locator('#genxtra-button').getAttribute('aria-pressed')) === 'true'
      ? 'genxtra'
      : 'live';
  await page.locator('#live-tv-button').dispatchEvent('click');
  await expect(page.locator('#guide-button')).toBeEnabled();
  await page.locator('#guide-button').dispatchEvent('click');
  await wait(4000);
  report.observations.guideText = (
    await page
      .locator('main')
      .innerText()
      .catch(() => '')
  ).slice(0, 600);
  // Screenshots need painted frames; a sleeping display is recorded, not fatal.
  await page
    .screenshot({ path: path.join(directory, 'guide.png'), timeout: 10000 })
    .catch(() => undefined);
  await page
    .locator('#live-tv-button')
    .dispatchEvent('click', {}, { timeout: 10000 })
    .catch(() => undefined);
  // Settings control (TV layout bounds).
  await page.locator('#settings-button').dispatchEvent('click');
  await page.locator('#settings-section').dispatchEvent('click');
  await page.locator('[data-settings-section="advanced"]').dispatchEvent('click');
  await page
    .locator('#settings-dialog details', {
      has: page.locator('summary', { hasText: 'Discovery providers' }),
    })
    .evaluate((details) => {
      details.open = true;
    });
  const control = page.locator('#export-guide-grabber');
  await control.evaluate((node) => node.scrollIntoView({ block: 'nearest' }));
  await expect(control).toBeVisible();
  const bounds = await page.evaluate(() => {
    const dialog = document.getElementById('settings-dialog').getBoundingClientRect();
    const button = document.getElementById('export-guide-grabber').getBoundingClientRect();
    return {
      inside: button.left >= dialog.left && button.right <= dialog.right,
      width: button.width,
    };
  });
  if (!bounds.inside) throw new Error('Grabber export control is clipped on the TV.');
  report.observations.guideStatus = await page
    .locator('#settings-dialog p', { hasText: 'Program guides:' })
    .first()
    .textContent()
    .catch(() => null);
  await page
    .screenshot({ path: path.join(directory, 'settings-advanced.png'), timeout: 10000 })
    .catch(() => undefined);
  await page.locator('[data-close="settings-dialog"]').first().dispatchEvent('click');
  report.checks.push('Settings grabber control visible within the TV dialog');
  // Leave the user's last library exactly as it was found.
  if (report.observations.restoredLibrary === 'genxtra') {
    await page.locator('#genxtra-button').dispatchEvent('click');
    await expect(page.locator('#genxtra-button')).toHaveAttribute('aria-pressed', 'true');
    report.checks.push('Restored the GenXtra library selection found at launch');
  }
  report.status = 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 })
      .catch(() => undefined);
} finally {
  if (page && !page.isClosed()) {
    report.exitRequested = true;
    void page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'))
      .catch(() => undefined);
  }
  let gone = false;
  for (let i = 0; i < 120 && !gone; i++) {
    gone = !(await pid());
    if (!gone) await wait(500);
  }
  report.ordinaryExit = gone;
  if (!gone) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  await browser?.close().catch(() => undefined);
  if (forwarded) await adb('forward', '--remove', `tcp:${forwarded}`).catch(() => undefined);
  try {
    const after = path.join(directory, 'after');
    await mkdir(path.join(after, 'archive-library-v1'), { recursive: true });
    await pull('genx.sqlite3', path.join(after, 'genx.sqlite3'));
    await pull(
      'archive-library-v1/archive.sqlite3',
      path.join(after, 'archive-library-v1', 'archive.sqlite3'),
    );
    report.after = {
      main: counts(path.join(after, 'genx.sqlite3')),
      archive: archiveCounts(path.join(after, 'archive-library-v1', 'archive.sqlite3')),
    };
    if (before) {
      report.before = {
        main: counts(path.join(before, 'genx.sqlite3')),
        archive: archiveCounts(path.join(before, 'archive-library-v1', 'archive.sqlite3')),
      };
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      report.preservation = {
        channels: report.before.main.channels === report.after.main.channels,
        removed: report.before.main.removed === report.after.main.removed,
        favorites: same(report.before.main.favorites, report.after.main.favorites),
        sources: report.before.main.sources === report.after.main.sources,
        guideMappingsNotReduced:
          report.after.main.guideMappings >= report.before.main.guideMappings,
        archiveTitles: report.before.archive.titles === report.after.archive.titles,
        archiveBookmarks: report.before.archive.bookmarks === report.after.archive.bookmarks,
        integrity: report.after.main.integrity === 'ok' && report.after.archive.integrity === 'ok',
      };
      if (Object.values(report.preservation).some((value) => !value)) {
        report.status = 'FAIL';
        process.exitCode = 1;
      }
    }
  } catch (error) {
    report.preservationError = error instanceof Error ? error.message : String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const summary = {
    status: report.status,
    error: report.error,
    checks: report.checks,
    preservation: report.preservation,
    directory,
  };
  console.log(JSON.stringify(summary, null, 2));
}
