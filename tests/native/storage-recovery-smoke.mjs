import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const source = path.resolve(process.argv[2] ?? 'src-tauri/target/debug/tmg-tv.exe');
const directory = path.resolve(
  'artifacts/native-storage-recovery',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const executable = path.join(directory, 'GenX-recovery-fixture.exe');
await copyFile(source, executable);
await writeFile(path.join(directory, 'tmg-portable.flag'), 'explicit portable fixture\n');
const blockingData = path.join(directory, 'data');
await writeFile(blockingData, 'fixture file blocking directory creation');
const selected = path.join(directory, 'selected-data');
const moved = path.join(directory, 'temporarily-unavailable-data');
const key = createHash('sha256')
  .update(executable.replaceAll('/', '\\').toLowerCase())
  .digest('hex');
if (!process.env.APPDATA) throw new Error('Expected Windows application-config root absent');
const bookmark = path.join(process.env.APPDATA, 'com.tmg.tv', 'storage-choices', `${key}.json`);
const report = {
  status: 'FAIL',
  scope: 'Packaged Windows initial storage recovery; owned fixtures only',
  executable,
  sha256: createHash('sha256')
    .update(await readFile(source))
    .digest('hex'),
  started: new Date().toISOString(),
  checks: [],
};
let app, browser, page;
let bookmarkCreated = false;
let movedData = false;

async function rejection(command, args, pattern) {
  let reason;
  try {
    await invoke(command, args);
  } catch (error) {
    reason = String(error);
  }
  if (!reason || !pattern.test(reason)) throw new Error(`Expected ${command} refusal absent`);
  return reason;
}
/* eslint-disable no-undef -- IPC executes in the actual packaged WebView. */
function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
/* eslint-enable no-undef */
async function launch(extraEnvironment = {}) {
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = { ...process.env };
  delete env.TMG_DATA_DIR;
  Object.assign(env, extraEnvironment, {
    WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'WebView'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  });
  app = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' });
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.exitCode !== null) throw new Error('Owned app exited before WebView readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const info = await response.json();
        endpoint = info.webSocketDebuggerUrl;
        report.webview = info.Browser;
        break;
      }
    } catch {
      /* Startup is bounded. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Owned WebView unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
}
async function close() {
  if (page && app?.exitCode === null) {
    await Promise.race([
      invoke('request_exit').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  await browser?.close().catch(() => undefined);
  browser = page = null;
  if (app?.exitCode === null)
    await Promise.race([
      new Promise((resolve) => app.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  if (app?.exitCode === null) {
    app.kill();
    throw new Error('Owned native shutdown unconfirmed');
  }
  app = null;
}
async function ownedMove(from, to) {
  const prefix = directory.toLowerCase() + path.sep;
  if (![from, to].every((value) => path.resolve(value).toLowerCase().startsWith(prefix)))
    throw new Error('Fixture move escaped artifact directory');
  await rename(from, to);
}

try {
  try {
    await lstat(bookmark);
    throw new Error('Fixture bookmark unexpectedly preexists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await launch();
  const dialog = page.getByRole('dialog', { name: 'Saved data needs attention' });
  await expect(dialog).toBeVisible({ timeout: 20000 });
  const initial = await invoke('storage_recovery_status');
  expect(initial).toMatchObject({
    platform: 'windows',
    available: true,
    state: 'failed',
    explicitEnvironment: false,
  });
  report.initial = initial;
  report.relativeRefusal = await rejection(
    'choose_storage_directory',
    { path: 'relative-folder' },
    /storage-choice-invalid-location/,
  );
  await dialog.getByRole('textbox', { name: 'Writable data folder' }).fill(selected);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const remembered = JSON.parse(await readFile(bookmark, 'utf8'));
  expect(remembered).toEqual({ schemaVersion: 1, executableKey: key, directory: selected });
  bookmarkCreated = true;
  const preferences = {
    schemaVersion: 1,
    sources: [],
    favorites: [],
    removedChannels: [],
    volume: 0.25,
    muted: true,
    panelWidth: 300,
  };
  await invoke('write_record', { name: 'preferences', contents: JSON.stringify(preferences) });
  report.healthyRefusal = await rejection(
    'choose_storage_directory',
    { path: path.join(directory, 'never-created') },
    /storage-healthy-switch-refused/,
  );
  expect(await readFile(blockingData, 'utf8')).toBe('fixture file blocking directory creation');
  report.checks.push(
    'Actual recovery form explicitly activates writable fixture; blocked portable data retained; healthy switching refused',
  );
  await page.screenshot({ path: path.join(directory, 'recovered.png') });
  await close();

  await launch();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect((await invoke('runtime_info')).dataMode).toBe('explicit-directory');
  expect(JSON.parse((await invoke('read_record_pair')).preferences)).toMatchObject({
    volume: 0.25,
    muted: true,
  });
  report.checks.push(
    'Same executable location restart honors bookmark before unusable portable directory and preserves canonical preferences',
  );
  await close();

  await ownedMove(selected, moved);
  movedData = true;
  await launch();
  await expect(page.getByRole('dialog', { name: 'Saved data needs attention' })).toBeVisible({
    timeout: 20000,
  });
  expect(await invoke('storage_recovery_status')).toMatchObject({
    available: true,
    state: 'failed',
  });
  report.missingDestination = await rejection(
    'read_record_pair',
    {},
    /storage-choice-directory-unavailable/,
  );
  report.checks.push(
    'Unavailable remembered destination fails explicitly without silently creating a replacement or falling back',
  );
  await close();
  await ownedMove(moved, selected);
  movedData = false;

  await launch({ TMG_DATA_DIR: path.join(directory, 'environment-data') });
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await invoke('storage_recovery_status')).toMatchObject({
    available: false,
    state: 'healthy',
    explicitEnvironment: true,
  });
  report.environmentRefusal = await rejection(
    'choose_storage_directory',
    { path: selected },
    /storage-explicit-environment-restart-required/,
  );
  report.checks.push(
    'Explicit environment overrides remembered choice and refuses ineffective directory selection',
  );
  await close();
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.message ?? error);
} finally {
  try {
    await close();
  } catch (error) {
    report.status = 'FAIL';
    report.cleanupError = String(error);
  }
  try {
    if (movedData) await ownedMove(moved, selected);
    if (bookmarkCreated) {
      const meta = await lstat(bookmark);
      const saved = JSON.parse(await readFile(bookmark, 'utf8'));
      if (meta.isSymbolicLink() || saved.executableKey !== key || saved.directory !== selected) {
        report.status = 'FAIL';
        report.cleanupError = 'Owned bookmark identity changed; deletion refused';
      } else {
        await unlink(bookmark);
        report.ownedBookmarkRemoved = true;
      }
    }
  } catch (error) {
    report.status = 'FAIL';
    report.cleanupError = String(error);
  }
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
if (report.status !== 'PASS') process.exitCode = 1;
