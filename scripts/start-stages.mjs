/* global window, document, performance, Event -- callbacks execute only inside GenX's WebView. */
// Start stage probe: plays channels through GenX's own list, muted, and reads
// window.__GENX_START_TIMING__ for each start (first byte, first decodable frame,
// first visible frame, playback start). Restores the channel, category, search and sound.
// node start-stages.mjs <adb-serial | http://127.0.0.1:<cdp-port>> <plan.json> <out.json> [watchSeconds]
// An http:// target is the Windows app started with WebView2 remote debugging.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('@playwright/test');
const run = promisify(execFile);
const [SERIAL, PLAN, OUT] = process.argv.slice(2);
const WATCH = Number(process.argv[5] || 15);
const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
  .results.filter((r) => !r.error)
  .map(({ filter, name, id }) => ({ filter, name, id }));
const desktop = SERIAL.startsWith('http://');
const adb = async (...a) =>
  desktop
    ? ''
    : (
        await run(process.env.ADB ?? 'adb', ['-s', SERIAL, ...a], {
          windowsHide: true,
          timeout: 90000,
        })
      ).stdout.trim();
let port = null;
if (!desktop) {
  const pid = (await adb('shell', 'pidof com.tmg.tv')).split(/\s+/)[0];
  port = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
}
const browser = await chromium.connectOverCDP(desktop ? SERIAL : `http://127.0.0.1:${port}`);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('tauri.localhost'));
const results = [];
let found;
try {
  found = await page.evaluate(() => ({
    title: document.getElementById('watch-title')?.textContent?.trim() ?? '',
    category: document.getElementById('category-button')?.textContent?.trim() ?? '',
    search: document.getElementById('search')?.value ?? '',
    muted: document.getElementById('mute-button')?.getAttribute('aria-pressed') === 'true',
    status: document.getElementById('playback-status')?.textContent ?? '',
    paid: document.getElementById('paid-tv-button')?.getAttribute('aria-pressed') === 'true',
    timing: typeof window.__GENX_START_TIMING__,
  }));
  console.log('found', JSON.stringify(found));
  if (found.timing !== 'object') throw new Error('this build has no start timing');
  await page.evaluate(async () => {
    const m = document.getElementById('mute-button');
    if (m && m.getAttribute('aria-pressed') !== 'true') m.click();
    // These channels are Paid TV channels.
    const paid = document.getElementById('paid-tv-button');
    if (paid.getAttribute('aria-pressed') !== 'true') {
      paid.click();
      await new Promise((r) => setTimeout(r, 6000));
    }
  });
  for (const item of plan) {
    await adb('shell', 'input keyevent 224').catch(() => undefined);
    const r = await page.evaluate(
      async ({ item, watch }) => {
        const w = (ms) => new Promise((res) => setTimeout(res, ms));
        const s = document.getElementById('search');
        s.value = item.name.slice(0, 40);
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await w(2500);
        // Another device's account has other channel ids: the exact title then.
        const row =
          document.querySelector(`button[data-channel="${item.id}"]`) ??
          [...document.querySelectorAll('.channel-row button[data-channel]')].find((b) =>
            (b.querySelector('.media-result-title')?.textContent ?? '')
              .trim()
              .startsWith(item.name),
          );
        if (!row) return { ...item, error: 'row not found' };
        const v = document.getElementById('video');
        const status = () => document.getElementById('playback-status')?.textContent ?? '';
        const before = window.__GENX_START_TIMING__.length;
        row.click();
        const t0 = performance.now();
        let started = null;
        let startTime = null;
        while (performance.now() - t0 < 30000) {
          await w(100);
          if (status().startsWith('Playing') && v.currentTime > 0) {
            if (startTime === null) startTime = v.currentTime;
            else if (v.currentTime - startTime >= 0.5) {
              started = Math.round(performance.now() - t0);
              break;
            }
          }
        }
        let waits = 0;
        const onWait = () => waits++;
        v.addEventListener('waiting', onWait);
        await w(watch * 1000);
        v.removeEventListener('waiting', onWait);
        const records = window.__GENX_START_TIMING__;
        return {
          ...item,
          advancedHalfSecondMs: started,
          waitsAfterStart: waits,
          newRecords: records.length - before,
          timing: records.at(-1),
          status: status(),
        };
      },
      { item, watch: WATCH },
    );
    console.log(JSON.stringify(r));
    results.push(r);
  }
} finally {
  if (found) {
    await page
      .evaluate(async (f) => {
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        const s = document.getElementById('search');
        if (!f.paid) {
          document.getElementById('live-tv-button').click();
          await w(6000);
        }
        const wanted = /^(all|movies|news|sports)/i.exec(f.category)?.[1]?.toLowerCase() ?? 'all';
        document.getElementById('category-button').click();
        await w(600);
        document.querySelector(`.filters [data-filter="${wanted}"]`)?.click();
        await w(1500);
        document.getElementById('category-button').blur();
        if (f.title) {
          s.value = f.title.slice(0, 40);
          s.dispatchEvent(new Event('input', { bubbles: true }));
          await w(2500);
          const row = [...document.querySelectorAll('.channel-row button[data-channel]')].find(
            (b) => (b.querySelector('.media-result-title')?.textContent ?? '').trim() === f.title,
          );
          row?.click();
          await w(5000);
        }
        s.value = f.search;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await w(1500);
        const m = document.getElementById('mute-button');
        if (m && (m.getAttribute('aria-pressed') === 'true') !== f.muted) m.click();
      }, found)
      .catch(() => undefined);
    console.log(
      'restored',
      JSON.stringify(
        await page
          .evaluate(() => ({
            title: document.getElementById('watch-title')?.textContent?.trim(),
            category: document.getElementById('category-button')?.textContent?.trim(),
            search: document.getElementById('search')?.value,
            muted: document.getElementById('mute-button')?.getAttribute('aria-pressed') === 'true',
          }))
          .catch(() => null),
      ),
    );
  }
  writeFileSync(
    OUT,
    JSON.stringify({ serial: SERIAL, found, watchSeconds: WATCH, results }, null, 1),
  );
  await browser.close().catch(() => undefined);
  if (port) await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined);
}
