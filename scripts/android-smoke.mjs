import { saveCompletedSourceScan } from './scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from './fixture-server.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const serial = process.argv[2] ?? 'emulator-5556';
const cycles = Number(process.argv[3] ?? 0);
if (!Number.isInteger(cycles) || cycles < 0 || cycles > 50)
  throw new Error('Lifecycle cycles must be an integer from 0 to 50.');
const physical = process.argv.includes('--physical-approved');
if (
  physical
    ? serial !== (process.env.GENX_APPROVED_FLIP_SERIAL ?? '')
    : !/^emulator-\d+$/.test(serial)
)
  throw new Error('Select an emulator or the explicitly approved Retroid Pocket Flip 2.');
const adbPath =
  process.env.TMG_ADB ?? path.join(process.env.LOCALAPPDATA, 'Android/SDK/platform-tools/adb.exe');
const execute = promisify(execFile);
const adb = async (...args) =>
  (
    await execute(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const directory = path.resolve(
  'artifacts/android-smoke',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  scope: `Installed Android ${physical ? 'physical Retroid Pocket Flip 2' : 'emulator'} debug playback and lifecycle`,
  serial,
  status: 'FAIL',
  started: new Date().toISOString(),
  checks: [],
};
const fixtures = await startFixtureServer();
const title = `Emulator fixture ${Date.now()}`;
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/plain');
  response.end(
    `#EXTM3U\n#EXTINF:-1 tvg-id="android-ts" group-title="Sports",${title} TS\n${fixtures.url}/hls/master.m3u8\n#EXTINF:-1 tvg-id="android-fmp4" group-title="News",${title} fMP4\n${fixtures.url}/media/fmp4.m3u8\n#EXTINF:-1 tvg-id="android-live" group-title="Sports",${title} Live\n${fixtures.url}/hls/live.m3u8\n`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ports = [new URL(fixtures.url).port, String(server.address().port)];
let browser;
let forwardedPort;
try {
  report.device = await adb('shell', 'getprop', 'ro.build.fingerprint');
  report.model = await adb('shell', 'getprop', 'ro.product.model');
  if (physical && report.model.replaceAll(' ', '_') !== 'Retroid_Pocket_Flip2')
    throw new Error('The approved physical device identity does not match.');
  report.abi = await adb('shell', 'getprop', 'ro.product.cpu.abi');
  const installed = (await adb('shell', 'pm', 'path', 'com.tmg.tv'))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
    .trim();
  if (!installed || !/^\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(installed))
    throw new Error('No valid installed GenX Streamer APK path.');
  report.apkSha256 = (await adb('shell', 'sha256sum', installed)).split(/\s/)[0];
  await adb('shell', 'input', 'keyevent', '224');
  await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const pid = await adb('shell', 'pidof', 'com.tmg.tv');
  if (!/^\d+$/.test(pid)) throw new Error('GenX Streamer emulator process is unavailable.');
  forwardedPort = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwardedPort}`, {
        timeout: 1000,
        noDefaults: true,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!browser) throw new Error('Android WebView debugging endpoint did not become ready.');
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('No installed application WebView.');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#storage-status')).not.toContainText('Browser development preview');
  // Browser callback executes in the Android WebView, not the Node process.
  // eslint-disable-next-line no-undef
  report.webview = await page.evaluate(() => navigator.userAgent);
  report.checks.push('Installed native UI and storage ready');
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(`http://127.0.0.1:${ports[1]}/configured-source`);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 20000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 20000 });
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  for (const suffix of ['TS', 'fMP4']) {
    await page.locator('#search').fill(`${title} ${suffix}`);
    await page.locator('.channel').first().click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    await expect
      .poll(() => page.locator('#video').evaluate((video) => video.currentTime), { timeout: 15000 })
      .toBeGreaterThan(1);
    const decoded = await page.locator('#video').evaluate((video) => ({
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
    }));
    if (decoded.frames < 2) {
      decoded.presentedFrameEvidence = await page.locator('#video').evaluate(
        (video) =>
          new Promise((resolve) => {
            if (typeof video.requestVideoFrameCallback !== 'function') {
              resolve(null);
              return;
            }
            let callback;
            const frames = [];
            const finish = () => {
              clearTimeout(deadline);
              if (callback !== undefined) video.cancelVideoFrameCallback(callback);
              resolve(frames);
            };
            const observe = (_now, metadata) => {
              frames.push({
                frames: metadata.presentedFrames,
                mediaTime: metadata.mediaTime,
                videoTime: video.currentTime,
              });
              if (frames.length >= 3) finish();
              else callback = video.requestVideoFrameCallback(observe);
            };
            const deadline = setTimeout(finish, 5000);
            callback = video.requestVideoFrameCallback(observe);
          }),
      );
    }
    report.checks.push({ media: suffix, decoded });
    const presented = decoded.presentedFrameEvidence;
    const actualFramesAdvanced =
      presented?.length >= 2 &&
      presented.at(-1).frames > presented[0].frames &&
      presented.at(-1).videoTime > presented[0].videoTime;
    if (decoded.width !== 320 || (decoded.frames < 2 && !actualFramesAdvanced))
      throw new Error('Android decoder frame evidence is missing.');
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await page.locator('#pause-button').click();
    await expect(page.locator('#playback-status')).toHaveText('Playing');
  }
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('Exit full screen');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.locator('#fullscreen-button')).toHaveText('Full screen');
  report.checks.push('Android system fullscreen and Back synchronization');
  if (cycles) {
    await page.locator('#search').fill(`${title} Live`);
    await page.locator('.channel').first().click();
    await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
    report.lifecycleCycles = 0;
    for (let cycle = 0; cycle < cycles; cycle++) {
      await adb('shell', 'input', 'keyevent', '3');
      await expect(page.locator('#playback-status')).toHaveText('Paused', { timeout: 10000 });
      await adb('shell', 'am', 'start', '-n', 'com.tmg.tv/.MainActivity');
      // eslint-disable-next-line no-undef -- This callback executes inside the Android WebView.
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await expect(page.locator('#playback-status')).toHaveText('Paused');
      await page.locator('#pause-button').click();
      await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20000 });
      report.lifecycleCycles++;
    }
    report.checks.push(
      `${cycles} actual Android Home/resume cycles; explicit playback resume required`,
    );
  }
  await page.screenshot({ path: path.join(directory, 'android-player.png') });
  const captured = await execute(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  });
  await writeFile(path.join(directory, 'android-screen.png'), captured.stdout);
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (forwardedPort)
    await adb('forward', '--remove', `tcp:${forwardedPort}`).catch(() => undefined);
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(() => undefined);
  await fixtures.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
