import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/scan-screensaver.ts', formats: ['iife'], name: 'Saver' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing screensaver bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing screensaver entry');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
const css = readFileSync('src/ui/scan-screensaver.css', 'utf8');
/** A page with the screensaver on a controlled clock and switchable state. */
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><main><button id="action">Act</button></main>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = { t: 0, scanning: true, viewing: false, actions: 0, r: 0.1 };
    Reflect.set(window, 'state', state);
    // The app's own key handling, which the waking key must not reach.
    document.addEventListener('keydown', () => state.actions++);
    Reflect.set(
      window,
      'saver',
      Reflect.get(window, 'Saver').mountScanScreensaver(document, {
        scanActive: () => state.scanning,
        viewing: () => state.viewing,
        status: () => `Rescan · ${state.t / 1000} s`,
        now: () => state.t,
        random: () => (state.r = (state.r + 0.37) % 1),
        timer: false,
      }),
    );
    // The app looks every second; the first look is at the start.
    Reflect.get(window, 'saver').tick();
  });
  return page;
}
const at = (page: Page, seconds: number) =>
  page.evaluate((s) => {
    Reflect.get(window, 'state').t = s * 1000;
    Reflect.get(window, 'saver').tick();
    const overlay = document.getElementById('scan-screensaver')!;
    const line = overlay.querySelector('p')!;
    return {
      showing: !overlay.hidden,
      visible: getComputedStyle(overlay).display !== 'none',
      text: line.textContent,
      where: `${line.style.left},${line.style.top}`,
    };
  }, seconds);

// Owner rule (October 22, 2026): only during a long scan with no activity.
it('appears after five idle minutes of a scan, shows progress and moves', async () => {
  const page = await fixture();
  try {
    expect((await at(page, 299)).showing).toBe(false);
    const shown = await at(page, 300);
    expect(shown).toMatchObject({ showing: true, visible: true, text: 'Rescan · 300 s' });
    expect((await at(page, 329)).where).toBe(shown.where);
    expect((await at(page, 330)).where).not.toBe(shown.where);
  } finally {
    await page.close();
  }
});

it('never appears without a scan, or while something plays', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => (Reflect.get(window, 'state').scanning = false));
    expect((await at(page, 3600)).showing).toBe(false);
    await page.evaluate(() => {
      const state = Reflect.get(window, 'state');
      state.scanning = true;
      state.viewing = true;
    });
    expect((await at(page, 7200)).showing).toBe(false);
    // Playback stops: idle counts from then, not from the scan's start.
    await page.evaluate(() => (Reflect.get(window, 'state').viewing = false));
    expect((await at(page, 7201)).showing).toBe(false);
    expect((await at(page, 7501)).showing).toBe(true);
  } finally {
    await page.close();
  }
});

it('the first key only wakes the screen; the next one reaches the app', async () => {
  const page = await fixture();
  try {
    expect((await at(page, 300)).showing).toBe(true);
    await page.keyboard.press('Enter');
    expect((await at(page, 301)).showing).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'state').actions)).toBe(0);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'state').actions)).toBe(1);
    // Input restarts the idle wait.
    expect((await at(page, 590)).showing).toBe(false);
    expect((await at(page, 601)).showing).toBe(true);
  } finally {
    await page.close();
  }
});

it('goes away by itself when the scan ends', async () => {
  const page = await fixture();
  try {
    expect((await at(page, 300)).showing).toBe(true);
    await page.evaluate(() => (Reflect.get(window, 'state').scanning = false));
    expect((await at(page, 301)).showing).toBe(false);
  } finally {
    await page.close();
  }
});
