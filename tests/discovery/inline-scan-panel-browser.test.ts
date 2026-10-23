import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/inline-scan-panel.ts', formats: ['iife'], name: 'Panel' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing panel bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing panel entry');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
// The panel markup exactly as src/ui/shell.ts renders it.
const markup =
  '<section id="inline-source-scan" class="inline-source-scan" aria-label="Channel discovery" hidden><p id="inline-scan-status" role="status"></p><p id="inline-scan-error" role="alert" hidden></p><div class="inline-scan-actions"><button id="inline-scan-stop" type="button" hidden>Stop</button><button id="inline-scan-continue" type="button" hidden>Continue</button><button id="inline-scan-refresh" type="button" hidden>Refresh</button><button id="inline-scan-rescan" type="button" hidden>Rescan</button></div></section>';
const base = {
  schemaVersion: 1,
  generation: 1,
  pendingPublications: 0,
  responded: 0,
  lastFailure: 'none',
  query: '',
  presentation: 'inline',
  error: '',
  scopeRefusal: null,
};
const finished = {
  ...base,
  phase: 'completed',
  busy: false,
  total: 19250,
  checked: 19250,
  published: 8740,
  canContinue: false,
  savedSummary: 'completed',
  status:
    'Saved scan finished | 19250 of 19250 checked | 8740 saved. Select Refresh to look for new channels, or Rescan to check everything again.',
};
const unfinished = {
  ...base,
  phase: 'paused',
  busy: false,
  total: 18091,
  checked: 7074,
  published: 3678,
  canContinue: true,
  savedSummary: 'unfinished',
  status: 'Saved scan | 7074 of 18091 checked | 3678 saved.',
};
const running = { ...unfinished, phase: 'checking', busy: true, savedSummary: undefined };
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(markup);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    Reflect.set(
      window,
      'panel',
      Reflect.get(window, 'Panel').mountInlineScanPanel(document, () => false),
    );
  });
  return page;
}
const state = (page: Page) =>
  page.evaluate(() => {
    const visible = (id: string) => !document.getElementById(id)!.hidden;
    return {
      panel: visible('inline-source-scan'),
      buttons: [
        'inline-scan-stop',
        'inline-scan-continue',
        'inline-scan-refresh',
        'inline-scan-rescan',
        'inline-scan-close',
      ]
        .filter(visible)
        .map((id) => document.getElementById(id)!.textContent),
    };
  });
const render = (page: Page, progress: object) =>
  page.evaluate((p) => Reflect.get(window, 'panel').render(p), progress);

it('a finished saved scan is not shown at startup; the magnifier shows Refresh, Rescan and Close', async () => {
  const page = await fixture();
  try {
    await render(page, finished);
    expect(await state(page)).toMatchObject({ panel: false });
    await page.evaluate(() => Reflect.get(window, 'panel').reveal());
    await render(page, finished);
    expect(await state(page)).toEqual({ panel: true, buttons: ['Refresh', 'Rescan', 'Close'] });
    await page.click('#inline-scan-close');
    expect(await state(page)).toMatchObject({ panel: false });
    // Later progress of the same finished state stays closed.
    await render(page, finished);
    expect(await state(page)).toMatchObject({ panel: false });
  } finally {
    await page.close();
  }
});

it('an unfinished scan offers Finish scan, Rescan and Close; Close hides it until asked or a scan runs', async () => {
  const page = await fixture();
  try {
    await render(page, unfinished);
    expect(await state(page)).toEqual({
      panel: true,
      buttons: ['Finish scan', 'Rescan', 'Close'],
    });
    await page.click('#inline-scan-close');
    await render(page, unfinished);
    expect(await state(page)).toMatchObject({ panel: false });
    expect(await page.evaluate(() => Reflect.get(window, 'panel').reopen())).toBe(true);
    expect(await state(page)).toEqual({
      panel: true,
      buttons: ['Finish scan', 'Rescan', 'Close'],
    });
    await page.click('#inline-scan-close');
    // A running scan always shows its progress and Stop, without Close.
    await render(page, running);
    expect(await state(page)).toEqual({ panel: true, buttons: ['Stop'] });
  } finally {
    await page.close();
  }
});

it('reopen does nothing for a finished or never-run scan', async () => {
  const page = await fixture();
  try {
    expect(await page.evaluate(() => Reflect.get(window, 'panel').reopen())).toBe(false);
    await render(page, finished);
    expect(await page.evaluate(() => Reflect.get(window, 'panel').reopen())).toBe(false);
    expect(await state(page)).toMatchObject({ panel: false });
  } finally {
    await page.close();
  }
});

// Refresh builds on a finished scan's checks. A saved scan that cannot
// continue (seen on the Sansui, October 21, 2026) offers Rescan only.
it('a saved scan that cannot continue offers Rescan, never Refresh', async () => {
  const page = await fixture();
  try {
    await render(page, {
      ...unfinished,
      phase: 'failed',
      canContinue: false,
      error: 'Saved scan progress is unavailable for Finish scan.',
      status:
        'Previous saved scan | 10607 of 12113 checked | 733 saved. This saved scan cannot continue. Select Rescan to check sources again.',
    });
    expect(await state(page)).toEqual({ panel: true, buttons: ['Rescan', 'Close'] });
  } finally {
    await page.close();
  }
});
// The Slow list (owner design, October 21, 2026): its background check says so.
it('the Slow list check names itself while it runs, with Stop', async () => {
  const page = await fixture();
  try {
    await render(page, { ...running, slowPass: true, total: 40, checked: 3, published: 1 });
    expect(await state(page)).toEqual({ panel: true, buttons: ['Stop'] });
    expect(await page.textContent('#inline-scan-status')).toBe(
      'Slow channels, in the background · 3 of 40 checked · 1 saved (33%) · measuring pace…',
    );
  } finally {
    await page.close();
  }
});

// Owner request (October 21, 2026): the panel says which kind of scan runs,
// how many it saved, its pace and the time left.
it('a running scan shows its kind, saved share, pace and time left', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(markup);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      Reflect.set(window, 'clock', 0);
      Reflect.set(
        window,
        'panel',
        Reflect.get(window, 'Panel').mountInlineScanPanel(
          document,
          () => false,
          () => Reflect.get(window, 'clock'),
        ),
      );
    });
    const at = async (ms: number, progress: object) => {
      await page.evaluate((ms) => Reflect.set(window, 'clock', ms), ms);
      await render(page, progress);
      return page.textContent('#inline-scan-status');
    };
    const rescan = { ...running, scanKind: 'rescan', total: 19053, generation: 4 };
    expect(await at(0, { ...rescan, checked: 100, published: 80 })).toBe(
      'Rescan · 100 of 19,053 checked · 80 saved (80%) · measuring pace…',
    );
    expect(await at(60_000, { ...rescan, checked: 220, published: 180 })).toBe(
      'Rescan · 220 of 19,053 checked · 180 saved (82%) · 120 a minute · about 2 h 37 min left',
    );
    // A Refresh says so, so it cannot be taken for a Rescan.
    expect(
      await at(61_000, {
        ...running,
        scanKind: 'refresh',
        generation: 5,
        total: 4762,
        checked: 10,
        published: 4,
      }),
    ).toBe('Refresh · 10 of 4,762 checked · 4 saved (40%) · measuring pace…');
  } finally {
    await page.close();
  }
});
