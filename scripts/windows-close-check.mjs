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

/* global window -- references occur only inside owned WebView evaluate callbacks. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const exe = path.resolve(process.argv[2] ?? '');
const expected = process.argv[3];
if (!/^[a-f0-9]{64}$/.test(expected ?? ''))
  throw new Error('Exact expected binary SHA-256 required.');
const actual = createHash('sha256')
  .update(await readFile(exe))
  .digest('hex');
if (actual !== expected) throw new Error('Binary hash mismatch.');
const directory = path.resolve(
  'artifacts/close-faults',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const report = {
  status: 'FAIL',
  executable: exe,
  sha256: actual,
  cases: [],
  scope:
    'Packaged Windows injected acknowledgment faults and real startup storage failure; not battery or whole-process acceptance',
};
let app, browser, page;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch(name) {
  const data = path.join(directory, name);
  await mkdir(data, { recursive: true });
  if (name === 'startup-failure')
    await writeFile(path.join(data, 'genx.sqlite3'), 'Owned invalid SQLite fixture');
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
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
  app.on('error', (error) => {
    report.launchError = error.message;
  });
  let endpoint;
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error('App exited before startup.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        endpoint = (await response.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await wait(100);
  }
  if (!endpoint) throw new Error('Debug endpoint startup deadline.');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools:'));
  if (!page) throw new Error('App page unavailable.');
  page.setDefaultTimeout(10000);
  if (name === 'startup-failure')
    await expect(page.locator('.storage-recovery-dialog')).toBeVisible();
  else await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
}
async function exited() {
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) return app.exitCode;
    await wait(100);
  }
  throw new Error('Owned app did not exit.');
}
async function closeConnection() {
  await browser?.close();
  browser = undefined;
  page = undefined;
  app = undefined;
}
try {
  const cases = ['startup-failure', 'missing-ack-retry', 'failed-ack-retry', 'missing-ack-force'];
  const selected = process.argv.find((value) => value.startsWith('--case='))?.slice(7);
  if (selected && !cases.includes(selected)) throw new Error('Unknown close fixture.');
  report.caseSelection = selected ?? 'all';
  for (const name of selected ? [selected] : cases) {
    await launch(name);
    const item = { name, status: 'FAIL' };
    report.cases.push(item);
    if (name !== 'startup-failure')
      await page.evaluate(
        (mode) => {
          const internal = window.__TAURI_INTERNALS__;
          const original = internal.invoke.bind(internal);
          window.__GENX_CLOSE_FIXTURE__ = { original, mode, tokens: [], results: [] };
          // Tauri's immutable invoke function must not be overwritten. Its documented
          // debug callback Map lets this fixture hold only the close notification.
          if (!(internal.callbacks instanceof Map) || !internal.callbacks.size)
            throw new Error('Debug close-delivery fixture unavailable.');
          for (const [id, callback] of internal.callbacks) {
            internal.callbacks.set(id, (event) => {
              const fixture = window.__GENX_CLOSE_FIXTURE__;
              if (event?.event === 'native-close-starting') {
                fixture.tokens.push({ ...event.payload });
                if (fixture.mode === 'missing') return;
                if (fixture.mode === 'failed') {
                  void original('acknowledge_cleanup', { ...event.payload, result: 'failed' });
                  return;
                }
              }
              return callback(event);
            });
          }
        },
        name === 'failed-ack-retry' ? 'failed' : 'missing',
      );
    const started = Date.now();
    await page.evaluate(() => {
      window.__GENX_EXIT_RESULT__ = null;
      void window.__TAURI_INTERNALS__.invoke('request_exit').then(
        () => (window.__GENX_EXIT_RESULT__ = 'resolved'),
        () => (window.__GENX_EXIT_RESULT__ = 'rejected'),
      );
    });
    if (name === 'startup-failure') {
      // Even unavailable saved data must not prevent coordinated shutdown.
      item.exitCode = await exited();
      if (item.exitCode !== 0) throw new Error('Startup failure close exit was not zero.');
    } else {
      await expect(page.locator('#close-dialog')).toBeVisible({ timeout: 7000 });
      item.blockedAfterMs = Date.now() - started;
      if (app.exitCode !== null) throw new Error('Unconfirmed cleanup exited the process.');
      await page.waitForFunction(() => window.__GENX_EXIT_RESULT__ === 'rejected');
      await page.keyboard.press('Escape');
      await expect(page.locator('#close-dialog')).toBeVisible();
      item.token = await page.evaluate(() => window.__GENX_CLOSE_FIXTURE__.tokens[0]);
      if (
        !/^close-[a-f0-9]{32}$/.test(item.token?.requestId) ||
        !Number.isSafeInteger(item.token.generation)
      )
        throw new Error('Exact native cleanup ticket missing.');
      item.obsoleteAckRejected = await page.evaluate(async () => {
        const fixture = window.__GENX_CLOSE_FIXTURE__;
        try {
          await fixture.original('acknowledge_cleanup', {
            ...fixture.tokens[0],
            generation: fixture.tokens[0].generation + 1,
            result: 'drained',
          });
          return false;
        } catch {
          return true;
        }
      });
      if (!item.obsoleteAckRejected) throw new Error('Invalid acknowledgment accepted.');
      if (name === 'missing-ack-force') {
        item.forced = true;
        await page.locator('#close-force').click();
      } else {
        await page.evaluate(() => {
          window.__GENX_CLOSE_FIXTURE__.mode = 'normal';
        });
        await page.locator('#close-retry').click();
      }
      item.exitCode = await exited();
      if (item.exitCode !== 0) throw new Error('Close fixture exit was not zero.');
    }
    item.status = 'PASS';
    await closeConnection();
  }
  report.status = 'PASS';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) {
    report.fixtureEmergencyForce = true;
    // Only this script's isolated app/data may be forced after the failed fixture.
    try {
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('force_exit'));
    } catch {}
    try {
      await exited();
    } catch {
      app.kill();
      await exited().catch(() => {});
    }
  }
  await browser?.close().catch(() => {});
  report.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, directory, error: report.error }, null, 2));
}
