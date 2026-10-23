import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

/** The real shell and stylesheets: where the Guide, the picture and the list sit. */
let browser: Browser, code: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'guide-panel-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:shell')) return '\0shell';
        },
        load(id) {
          if (id === '\0shell')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:shell', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  styles = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
        'account-vod',
        'guide-panel',
      ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function shell(width: number, height: number, tv: boolean): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: code });
  await page.evaluate((tv) => {
    const app = document.getElementById('app')!;
    Reflect.get(window, 'Fixture').createShell(app);
    app.dataset.deviceKind = tv ? 'tv' : 'desktop';
    app.style.setProperty('--sidebar', '360px');
    document.getElementById('channel-rows')!.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<button class="channel">Channel ${i}</button>`,
    ).join('');
    document.getElementById('list-empty')!.hidden = true;
    document.getElementById('player-overlay')!.hidden = true;
    const host = document.getElementById('primary-view-host')!;
    host.innerHTML = '<section class="fixture-guide" style="flex:1">Guide</section>';
  }, tv);
  return page;
}
const open = (page: Page, idle: boolean) =>
  page.evaluate((idle) => {
    const app = document.getElementById('app')!;
    app.dataset.guidePanel = 'open';
    app.dataset.playerIdle = String(idle);
    document.getElementById('primary-view-host')!.hidden = false;
  }, idle);
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        shown: r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden',
      };
    });

for (const size of [
  { width: 1280, height: 720, tv: false },
  { width: 960, height: 540, tv: true },
])
  it(`while something plays, the picture moves top-left and the Guide fills the right side ${size.width}x${size.height}`, async () => {
    const page = await shell(size.width, size.height, size.tv);
    try {
      await open(page, false);
      const [list, card, screen, view, host, channels] = await Promise.all([
        box(page, '.browser'),
        box(page, '.watch-card'),
        box(page, '.watch-card > .screen'),
        box(page, '.view'),
        box(page, '#primary-view-host'),
        box(page, '#channel-list'),
      ]);
      // The picture sits at the top of the channel column, at the column's width.
      expect(card.shown).toBe(true);
      expect(card.left).toBeGreaterThanOrEqual(list.left - 1);
      expect(card.right).toBeLessThanOrEqual(list.right + 1);
      expect(card.top - list.top).toBeLessThan(24);
      expect(screen.width).toBeGreaterThan(list.width * 0.8);
      expect(Math.abs(screen.width / screen.height - 16 / 9)).toBeLessThan(0.05);
      // Search and filters are covered (the Guide has its own); the list follows.
      expect((await box(page, '.search-controls')).shown).toBe(false);
      expect((await box(page, '.browse-options')).shown).toBe(false);
      expect(channels.shown).toBe(true);
      expect(channels.top).toBeGreaterThanOrEqual(card.bottom - 1);
      // The Guide has the whole right side.
      expect(host.top - view.top).toBeLessThan(28);
      expect(host.height).toBeGreaterThan(view.height - 48);
      expect(host.left).toBeGreaterThanOrEqual(view.left - 1);
    } finally {
      await page.close();
    }
  });

it('with nothing playing there is no picture box and the channel column is unchanged', async () => {
  const page = await shell(1280, 720, false);
  try {
    await open(page, true);
    expect((await box(page, '.watch-card')).shown).toBe(false);
    expect((await box(page, '.search-controls')).shown).toBe(true);
    expect((await box(page, '.browse-options')).shown).toBe(true);
  } finally {
    await page.close();
  }
});

it('closing the Guide returns the picture to the right side', async () => {
  const page = await shell(1280, 720, false);
  try {
    await open(page, false);
    await page.evaluate(() => {
      document.getElementById('app')!.dataset.guidePanel = 'closed';
      document.getElementById('primary-view-host')!.hidden = true;
    });
    const [list, card] = await Promise.all([box(page, '.browser'), box(page, '.watch-card')]);
    expect(card.left).toBeGreaterThan(list.right);
    expect((await box(page, '.search-controls')).shown).toBe(true);
  } finally {
    await page.close();
  }
});

it('the channel row buttons line up: Favs, Loc & Sort and Guide share one row', async () => {
  const page = await shell(1280, 720, false);
  try {
    const tops = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.sidehead button, .sidehead summary')]
        .filter((n) => n.getClientRects().length)
        .map((n) => {
          const r = n.getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        }),
    );
    expect(tops.length).toBe(3);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
  }
});
