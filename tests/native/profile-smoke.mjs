import { saveCompletedSourceScan } from '../../scripts/scan-save-helper.mjs';
/* global window */
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

if (process.argv.length !== 4)
  throw new Error('Usage: profile-smoke explicit-executable profile-root');
const executableInput = path.resolve(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3]);
const directory = path.resolve(
  'artifacts/media-profiles',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'tmg-tv.exe');
await copyFile(executableInput, executable);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = hash(await readFile(executable));
const fixtureBytes = await readFile(path.join(fixtureRoot, 'generation.json'));
if (fixtureBytes.length > 1048576) throw new Error('Fixture receipt too large');
const fixture = JSON.parse(fixtureBytes);
if (fixture.profiles?.length !== 3 || fixture.totalBytes > 64 * 1024 * 1024)
  throw new Error('Invalid profile receipt');
for (const profile of fixture.profiles) {
  if (!['720p30', '1080p30', '1080p60'].includes(profile.id) || profile.files?.length !== 11)
    throw new Error('Invalid profile identity');
  for (const file of profile.files) {
    if (!/^[\w.-]+\.(?:ts|mp4|m4s|m3u8)$/.test(file.name))
      throw new Error('Invalid fixture filename');
    const bytes = await readFile(path.join(fixtureRoot, profile.id, file.name));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error('Fixture bytes changed');
  }
}
const report = {
  schemaVersion: 1,
  status: 'FAIL',
  scope:
    'Windows actual H264/AAC HD profile decode; not endurance, audio observation, Android or P08 acceptance',
  started: new Date().toISOString(),
  sha256,
  executableInput,
  fixtureReceiptSha256: hash(fixtureBytes),
  fixture,
  checks: [],
  cleanup: {},
};
const servers = [];
let catalog, app, browser;
try {
  for (const profile of fixture.profiles)
    servers.push(await startFixtureServer({ mediaDirectory: path.join(fixtureRoot, profile.id) }));
  const entries = fixture.profiles.flatMap((profile, index) =>
    ['TS', 'fMP4'].map((format) => ({
      ...profile,
      format,
      title: `Owned ${profile.id} ${format}`,
      url: `${servers[index].url}/media/${format === 'TS' ? 'index' : 'fmp4'}.m3u8`,
    })),
  );
  catalog = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
    response.end(
      '#EXTM3U\n' + entries.map((entry) => `#EXTINF:-1,${entry.title}\n${entry.url}\n`).join(''),
    );
  });
  await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: path.join(directory, 'data'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.on('error', () => {
    report.launchFailed = true;
  });
  let endpoint;
  for (let n = 0; n < 200; n++) {
    if (app.exitCode !== null || report.launchFailed)
      throw new Error('Application exited before readiness');
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('WebView readiness deadline');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`http://127.0.0.1:${catalog.address().port}/catalog`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toContainText('6 channels');
  const sample = () =>
    page.locator('#video').evaluate((video) => ({
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
      paused: video.paused,
    }));
  for (const entry of entries) {
    report.activeProfile = { id: entry.id, format: entry.format };
    await page.getByRole('button', { name: new RegExp(entry.title) }).click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    await expect.poll(async () => (await sample()).time, { timeout: 15000 }).toBeGreaterThan(2);
    const first = await sample();
    await page.waitForTimeout(700);
    const last = await sample();
    report.checks.push({ id: entry.id, format: entry.format, first, last });
    if (
      first.width !== entry.width ||
      first.height !== entry.height ||
      last.frames <= first.frames ||
      last.time <= first.time + 0.1 ||
      last.paused
    )
      throw new Error('Expected profile did not advance decoded frames/time');
  }
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('request_exit'));
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (app && app.exitCode === null)
    await Promise.race([
      new Promise((resolve) => app.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  const forced = !!app && app.exitCode === null;
  if (forced) {
    app.kill();
    await new Promise((resolve) => app.once('exit', resolve));
  }
  if (catalog) {
    catalog.closeAllConnections();
    await new Promise((resolve) => catalog.close(resolve));
  }
  for (const server of servers) await server.close();
  report.cleanup = {
    confirmed: !!app && app.exitCode === 0 && !forced,
    forced,
    exitCode: app?.exitCode ?? null,
    fixture: servers.map((server) => {
      const { activeSockets, activeResponses, timers } = server.stats();
      return { activeSockets, activeResponses, timers };
    }),
  };
  if (
    !report.cleanup.confirmed ||
    report.cleanup.fixture.some(
      (stats) => stats.activeSockets || stats.activeResponses || stats.timers,
    ) ||
    hash(await readFile(executable)) !== sha256
  ) {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, directory, error: report.error }));
}
