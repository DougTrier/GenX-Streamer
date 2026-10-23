import { saveCompletedSourceScan } from './scan-save-helper.mjs';
import { chromium, expect } from '@playwright/test';
import { startFixtureServer } from './fixture-server.mjs';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
for (let i = 0; i < args.length; i += 2)
  if (
    !['--duration', '--exe', '--interval', '--profile-root', '--profile-id'].includes(args[i]) ||
    !args[i + 1]
  )
    throw new Error(
      'Usage: windows-soak --duration seconds --exe path --interval seconds [--profile-root directory --profile-id 720p30|1080p30|1080p60]',
    );
const duration = Number(option('--duration', '7200'));
const interval = Number(option('--interval', '5'));
if (
  !Number.isFinite(duration) ||
  duration < 10 ||
  duration > 86400 ||
  !Number.isFinite(interval) ||
  interval < 1 ||
  interval > 10
)
  throw new Error('Duration must be 10..86400 seconds; sample interval 1..10 seconds.');
if (process.platform !== 'win32') throw new Error('Windows native soak requires Windows.');
const exe = path.resolve(option('--exe', 'src-tauri/target/debug/tmg-tv.exe'));
const directory = path.resolve(
  'artifacts/windows-soak',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const data = path.join(directory, 'data');
await mkdir(data, { recursive: true });
const profileRoot = option('--profile-root', undefined);
const profileId = option('--profile-id', undefined);
if (!!profileRoot !== !!profileId) throw new Error('Profile root and ID must be provided together');
if (profileId && !['720p30', '1080p30', '1080p60'].includes(profileId))
  throw new Error('Unknown profile ID');
const receiptBytes = await readFile(
  profileRoot
    ? path.join(path.resolve(profileRoot), 'generation.json')
    : 'tests/fixtures/media/generation.json',
);
if (receiptBytes.length > 1048576) throw new Error('Fixture receipt exceeds 1 MiB');
const receipt = JSON.parse(receiptBytes);
const profile = profileId ? receipt.profiles?.find((item) => item.id === profileId) : undefined;
if (
  profileId &&
  (!profile || profile.files?.length !== 11 || receipt.totalBytes > 64 * 1024 * 1024)
)
  throw new Error('Invalid profile receipt');
const mediaDirectory = profileRoot ? path.join(path.resolve(profileRoot), profileId) : undefined;
if (profile) {
  for (const file of profile.files) {
    if (!/^[\w.-]+\.(?:ts|mp4|m4s|m3u8)$/.test(file.name))
      throw new Error('Invalid fixture filename');
    const bytes = await readFile(path.join(mediaDirectory, file.name));
    if (
      bytes.length !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('Profile fixture bytes changed');
  }
}
const expectedWidth = profile?.width ?? 320;
const expectedHeight = profile?.height ?? 180;
const report = {
  scope: 'Windows native continuous live HLS decode; not Android/release acceptance',
  status: 'FAIL',
  started: new Date().toISOString(),
  executable: exe,
  executableSha256: createHash('sha256')
    .update(await readFile(exe))
    .digest('hex'),
  requestedSeconds: duration,
  sampleIntervalSeconds: interval,
  fixtureSeed: receipt.fixtureSeed,
  encoder: receipt.encoderVersion ?? receipt.version,
  fixtureReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
  profile: profile
    ? {
        id: profile.id,
        width: profile.width,
        height: profile.height,
        fps: profile.fps,
        videoKbps: profile.videoKbps,
        audioKbps: profile.audioKbps,
        h264Profile: profile.profile,
        level: profile.level,
      }
    : { id: 'original-320x180' },
  platform: { platform: process.platform, node: process.version },
  samples: 0,
  memoryAcceptance: 'Device memory budgets not defined; measurements only',
};
const fixture = await startFixtureServer(mediaDirectory ? { mediaDirectory } : {});
const catalogServer = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/x-mpegurl');
  response.end(
    `#EXTM3U\n#EXTINF:-1 tvg-id="live-soak" group-title="Sports",Owned Live Soak\n${fixture.url}/hls/live.m3u8\n`,
  );
});
await new Promise((resolve) => catalogServer.listen(0, '127.0.0.1', resolve));
const catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/catalog.m3u`;
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let app, browser, session, initial, final, playbackStart;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
  });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  app = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TMG_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --autoplay-policy=no-user-gesture-required`,
    },
  });
  let launchError;
  app.on('error', (error) => {
    launchError = error;
  });
  let endpoint;
  for (let i = 0; i < 200; i++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`App exited before readiness (${app.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const info = await response.json();
        endpoint = info.webSocketDebuggerUrl;
        report.webview = info.Browser;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!endpoint) throw new Error('Native WebView debug endpoint did not become ready.');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No native app WebView page.');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await page.locator('#import-button').click();
  await page.locator('#allow-http').check();
  await page.locator('#playlist-url').fill(catalogUrl);
  await page.locator('#load-button').click();
  await saveCompletedSourceScan(page, 30000);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 30_000 });
  if ((await page.locator('#mute-button').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#mute-button').click();
  await page.getByRole('button', { name: /Owned Live Soak/ }).click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 20_000 });
  session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const browserSession = await browser.newBrowserCDPSession();
  async function sample() {
    const decoded = await page.locator('#video').evaluate((video) => {
      const quality = video.getVideoPlaybackQuality();
      return {
        mediaTime: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        frames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
        paused: video.paused,
        readyState: video.readyState,
        bufferedRanges: video.buffered.length,
        bufferedSeconds: video.buffered.length
          ? video.buffered.end(video.buffered.length - 1) - video.currentTime
          : 0,
      };
    });
    const metrics = await session.send('Performance.getMetrics');
    const processInfo = await browserSession.send('SystemInfo.getProcessInfo');
    const targetInfo = await browserSession.send('Target.getTargets');
    const processTypes = new Map(
      processInfo.processInfo.map((process) => [process.id, process.type]),
    );
    const metricValue = (name) =>
      metrics.metrics.find((metric) => metric.name === name)?.value ?? null;
    const ids = [
      ...new Set(
        [app.pid, ...processInfo.processInfo.map((process) => process.id)].filter(
          (id) => Number.isSafeInteger(id) && id > 0,
        ),
      ),
    ].slice(0, 32);
    // Read memory only for this app and its CDP-identified WebView processes.
    const processMemory = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@((Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue) | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,HandleCount) | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      ).trim() || '[]',
    );
    const snapshot = {
      at: new Date().toISOString(),
      elapsedSeconds: (Date.now() - playbackStart) / 1000,
      state: await page.locator('#playback-status').textContent(),
      failureMessage: await page.locator('#overlay-message').textContent(),
      decoded,
      heapBytes: metricValue('JSHeapUsedSize'),
      // Aggregate CDP observations are not counts of GenX-owned engine resources.
      rendererMetrics: {
        nodes: metricValue('Nodes'),
        eventListeners: metricValue('JSEventListeners'),
        documents: metricValue('Documents'),
      },
      targetCounts: {
        worker: targetInfo.targetInfos.filter((target) => target.type === 'worker').length,
        sharedWorker: targetInfo.targetInfos.filter((target) => target.type === 'shared_worker')
          .length,
        serviceWorker: targetInfo.targetInfos.filter((target) => target.type === 'service_worker')
          .length,
      },
      processes: (Array.isArray(processMemory) ? processMemory : [processMemory]).map(
        (process) => ({
          ...process,
          cdpType: process.Id === app.pid ? 'native-app' : (processTypes.get(process.Id) ?? null),
        }),
      ),
      fixture: fixture.stats(),
    };
    delete snapshot.fixture.requests; // Bounded server counters, no repeated request history in samples.
    await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(snapshot) + '\n');
    report.samples++;
    return snapshot;
  }
  playbackStart = Date.now();
  report.playbackStarted = new Date(playbackStart).toISOString();
  initial = await sample();
  let lastFrames = initial.decoded.frames;
  let lastProgress = Date.now();
  while (Date.now() - playbackStart < duration * 1000) {
    await sleep(Math.min(interval * 1000, duration * 1000 - (Date.now() - playbackStart)));
    if (interrupted) throw new Error('Soak interrupted; requested duration incomplete.');
    if (app.exitCode !== null) throw new Error(`Native app exited during soak (${app.exitCode}).`);
    final = await sample();
    if (final.decoded.frames > lastFrames) {
      lastFrames = final.decoded.frames;
      lastProgress = Date.now();
    }
    if (final.decoded.paused || ['Unable to play', 'Paused', 'Player closed'].includes(final.state))
      throw new Error(`Playback interrupted: ${final.state}.`);
    if (Date.now() - lastProgress > 20_000)
      throw new Error('Decoded frames stalled for more than 20 seconds.');
    if (final.decoded.width !== expectedWidth || final.decoded.height !== expectedHeight)
      throw new Error('Decoded fixture dimensions lost.');
    if (
      final.fixture.activeSockets > 16 ||
      final.fixture.activeResponses > 16 ||
      final.fixture.timers > 0
    )
      throw new Error('Fixture request resources exceeded bounded live-stream limit.');
  }
  report.observedPlaybackSeconds = (Date.now() - playbackStart) / 1000;
  report.first = initial;
  report.last = final;
  if (
    !final ||
    final.decoded.frames <= initial.decoded.frames + 24 ||
    final.fixture.liveManifests < 3
  )
    throw new Error('Insufficient decoded live progress or playlist refresh evidence.');
  report.fullTwoHourRun = duration >= 7200 && report.observedPlaybackSeconds >= 7200;
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  report.first = initial;
  report.last = final;
  process.exitCode = 1;
} finally {
  if (playbackStart && report.observedPlaybackSeconds === undefined)
    report.observedPlaybackSeconds = (Date.now() - playbackStart) / 1000;
  if (browser) await browser.close().catch(() => undefined);
  if (app && app.exitCode === null) {
    app.kill();
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), sleep(5000)]);
  }
  report.nativeAppExited = app ? app.exitCode !== null || app.signalCode !== null : true;
  if (!report.nativeAppExited) {
    report.status = 'FAIL';
    report.error = 'Owned native process did not exit after cleanup.';
    process.exitCode = 1;
  }
  await fixture.close();
  catalogServer.closeAllConnections();
  await new Promise((resolve) => catalogServer.close(resolve));
  report.fixtureAfterClose = fixture.stats();
  delete report.fixtureAfterClose.requests;
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        directory,
        error: report.error,
        observedPlaybackSeconds: report.observedPlaybackSeconds,
        fullTwoHourRun: report.fullTwoHourRun,
      },
      null,
      2,
    ),
  );
}
