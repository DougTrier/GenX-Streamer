import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';

/** The real shell and stylesheets, with and without the premium button sheet. */
const SHEETS = [
  'style',
  'management',
  'guide',
  'guide-timeline',
  'responsive',
  'in-app-select',
  'modal-viewport',
  'genxtra',
  'fullscreen',
  'tv-density',
  'account-vod',
  'guide-panel',
];
let browser: Browser, code: string, base: string, premium: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'premium-buttons-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:shell')) return '\0shell';
        },
        load(id) {
          if (id === '\0shell')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))};
export {mountLocationDialog} from ${JSON.stringify(resolve('src/ui/settings-navigation.ts'))};`;
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
  base = (await Promise.all(SHEETS.map((name) => readFile(`src/ui/${name}.css`, 'utf8'))))
    .join('\n')
    .replaceAll("url('../../assets/genx-synthwave.svg')", 'none');
  premium = await readFile('src/ui/premium-buttons.css', 'utf8');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

const LAYOUTS = [
  { width: 960, height: 540, tv: true },
  { width: 1280, height: 720, tv: false },
  { width: 1920, height: 1080, tv: false },
  { width: 412, height: 915, tv: false },
];

async function shell(layout: { width: number; height: number; tv: boolean }, styled: boolean) {
  const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: styled ? `${base}\n${premium}` : base });
  await page.addScriptTag({ content: code });
  await page.evaluate((tv) => {
    const app = document.getElementById('app')!;
    Reflect.get(window, 'Fixture').createShell(app);
    app.dataset.deviceKind = tv ? 'tv' : 'desktop';
    for (const button of app.querySelectorAll('button')) button.disabled = false;
  }, layout.tv);
  return page;
}

/** Every visible control's box, by a stable description. */
const boxes = (page: Awaited<ReturnType<typeof shell>>) =>
  page.evaluate(() => {
    const out: Record<string, number[]> = {};
    document.querySelectorAll<HTMLElement>('#app :is(button, summary)').forEach((node, index) => {
      // The badge and Loc & Sort (marker swapped for padding) are sized on purpose.
      if (node.closest('#genxtra-button, .sidehead summary')) return;
      const box = node.getBoundingClientRect();
      if (!box.width) return;
      // The library row spaces its items evenly, so there only sizes must hold.
      const spaced = !!node.closest('.sidehead');
      out[`${index}:${node.id || node.className || node.textContent}`] = (
        spaced ? [box.width, box.height] : [box.left, box.top, box.width, box.height]
      ).map((n) => Math.round(n * 10) / 10);
    });
    return out;
  });

describe('premium buttons', () => {
  for (const layout of LAYOUTS)
    it(`paint only: no control moves or changes size at ${layout.width}x${layout.height}${layout.tv ? ' TV' : ''}`, async () => {
      const plain = await shell(layout, false);
      const styled = await shell(layout, true);
      try {
        const before = await boxes(plain);
        expect(Object.keys(before).length).toBeGreaterThan(10);
        expect(await boxes(styled)).toEqual(before);
        // Loc & Sort still fits its row, with its label inside.
        const fit = await styled.evaluate(() => {
          const summary = document.querySelector('.sidehead summary')!.getBoundingClientRect();
          const row = document.querySelector('.sidehead')!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('.sidehead summary')!);
          const text = range.getBoundingClientRect();
          return (
            summary.left >= row.left - 0.5 &&
            summary.right <= row.right + 0.5 &&
            text.left >= summary.left &&
            text.right <= summary.right
          );
        });
        expect(fit).toBe(true);
      } finally {
        await plain.close();
        await styled.close();
      }
    });

  it('normal, selected and focused look clearly different', async () => {
    const page = await shell({ width: 1280, height: 720, tv: false }, true);
    try {
      const look = (id: string) =>
        page.evaluate((id) => {
          const style = getComputedStyle(document.getElementById(id)!);
          return {
            edge: style.borderTopColor,
            glow: style.boxShadow,
            fill: style.backgroundImage,
          };
        }, id);
      const normal = await look('paid-tv-button');
      const selected = await look('live-tv-button'); // Free TV starts selected
      expect(normal.fill).toContain('linear-gradient');
      expect(selected.edge).not.toBe(normal.edge);
      expect(selected.fill).not.toBe(normal.fill);
      expect(selected.glow).toContain('rgba(255, 95, 207');
      // Keyboard focus, as the remote moves it: Tab from Free TV to Paid TV.
      await page.focus('#live-tv-button');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('paid-tv-button');
      await page.waitForTimeout(300); // the 0.15s state transition
      const focused = await look('paid-tv-button');
      expect(focused.edge).toBe('rgb(166, 245, 255)');
      expect(focused.glow).toContain('rgba(41, 217, 255');
      expect(focused.glow).not.toBe(normal.glow);
      // A quiet tab is see-through until chosen.
      const tab = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('[data-filter="news"]')!);
        return { fill: style.backgroundImage, edge: style.borderTopColor };
      });
      expect(tab).toEqual({ fill: 'none', edge: 'rgba(0, 0, 0, 0)' });
    } finally {
      await page.close();
    }
  });

  it('every control icon is a bundled Lucide file that follows the control state', async () => {
    const page = await shell({ width: 1280, height: 720, tv: false }, true);
    try {
      const icons = await page.evaluate(() => {
        const mask = (node: Element, pseudo?: string) =>
          getComputedStyle(node, pseudo).getPropertyValue('mask-image');
        const out: Record<string, string> = {};
        for (const id of ['live-tv-button', 'paid-tv-button', 'cast-button', 'settings-button'])
          out[id] = mask(document.querySelector(`#${id} .nav-icon`)!);
        for (const id of ['pause-button', 'vod-stop', 'mute-button', 'fullscreen-button'])
          out[id] = mask(document.getElementById(id)!, '::before');
        const pause = document.getElementById('pause-button')!;
        pause.dataset.icon = 'play';
        out.resume = mask(pause, '::before');
        document.getElementById('mute-button')!.setAttribute('aria-pressed', 'true');
        out.muted = mask(document.getElementById('mute-button')!, '::before');
        return out;
      });
      const file = (value: string) => /icons\/lucide\/([a-z0-9-]+)\.svg/.exec(value)?.[1];
      expect(Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, file(v)]))).toEqual({
        'live-tv-button': 'tv',
        'paid-tv-button': 'tv-minimal-play',
        'cast-button': 'cast',
        'settings-button': 'settings',
        'pause-button': 'pause',
        'vod-stop': 'square',
        'mute-button': 'volume-2',
        'fullscreen-button': 'fullscreen',
        resume: 'play',
        muted: 'volume-x',
      });
    } finally {
      await page.close();
    }
  });

  it('the GenXtra badge fills its button, which keeps its name and shows text if the artwork fails', async () => {
    for (const layout of LAYOUTS) {
      const page = await shell(layout, true);
      try {
        const read = () =>
          page.evaluate(() => {
            const button = document.getElementById('genxtra-button')!;
            const label = button.querySelector<HTMLElement>('.genxtra-label')!;
            const badge = button
              .querySelector<HTMLElement>('.genxtra-badge')!
              .getBoundingClientRect();
            const free = document.getElementById('live-tv-button')!.getBoundingClientRect();
            const box = button.getBoundingClientRect();
            return {
              name: button.getAttribute('aria-label'),
              label: getComputedStyle(label).display,
              badgeHeight: badge.height,
              buttonHeight: box.height,
              freeHeight: free.height,
              inside: badge.left >= box.left - 0.5 && badge.right <= box.right + 0.5,
            };
          });
        // The fixture cannot serve the artwork, so start from a loaded badge.
        await page.evaluate(() => {
          const button = document.getElementById('genxtra-button')!;
          delete button.dataset.badge;
          button.querySelector<HTMLImageElement>('.genxtra-badge')!.hidden = false;
        });
        const loaded = await read();
        expect(loaded).toMatchObject({ name: 'GenXtra', label: 'none', inside: true });
        // Wider screens: the premium badge stands about 10% taller than its
        // neighbours. Phones: Free TV, Paid TV and GenXtra are one size (owner,
        // October 23, 2026). Either way it fills its own button, with nothing
        // overhanging it.
        const ratio = loaded.badgeHeight / loaded.freeHeight;
        expect(ratio).toBeGreaterThanOrEqual(layout.width < 700 ? 0.99 : 1.08);
        expect(ratio).toBeLessThanOrEqual(layout.width < 700 ? 1.01 : 1.12);
        expect(loaded.buttonHeight - loaded.badgeHeight).toBeGreaterThanOrEqual(0);
        expect(loaded.buttonHeight - loaded.badgeHeight).toBeLessThanOrEqual(2);
        await page.evaluate(() => {
          document.getElementById('genxtra-button')!.dataset.badge = 'failed';
        });
        expect((await read()).label).not.toBe('none');
      } finally {
        await page.close();
      }
    }
  });
});

describe('icon-only header buttons', () => {
  for (const layout of LAYOUTS)
    it(`Cast, Settings and the globe keep their icons at ${layout.width}x${layout.height}${layout.tv ? ' TV' : ''}`, async () => {
      const page = await shell(layout, true);
      try {
        const shown = await page.evaluate(() => {
          // As local-streams.ts adds it: an icon-only globe button.
          const globe = document.createElement('button');
          globe.id = 'local-button';
          globe.setAttribute('aria-label', 'Radio and web');
          const icon = document.createElement('img');
          icon.className = 'nav-icon local-globe';
          icon.alt = '';
          globe.append(icon);
          document.getElementById('cast-button')!.before(globe);
          return Object.fromEntries(
            ['cast-button', 'settings-button', 'local-button'].map((id) => {
              const node = document.querySelector<HTMLElement>(`#${id} .nav-icon`)!;
              return [
                id,
                getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0,
              ];
            }),
          );
        });
        expect(shown).toEqual({
          'cast-button': true,
          'settings-button': true,
          'local-button': true,
        });
      } finally {
        await page.close();
      }
    });
});

describe('the channel row', () => {
  for (const layout of LAYOUTS)
    it(`Favs, VOD, Loc & Sort and Guide line up at ${layout.width}x${layout.height}${layout.tv ? ' TV' : ''}`, async () => {
      const page = await shell(layout, true);
      try {
        const rows = await page.evaluate(() => {
          // As in the app: Paid TV adds VOD, and Loc & Sort becomes the dialog button.
          const vod = document.createElement('button');
          vod.id = 'vod-button';
          vod.className = 'row-filter';
          vod.textContent = 'VOD';
          document.querySelector('.sidehead [data-filter="favorites"]')!.after(vod);
          Reflect.get(window, 'Fixture').mountLocationDialog(
            document.getElementById('geography-controls')!,
          );
          return [
            ...document.querySelectorAll<HTMLElement>(
              '.sidehead :is([data-filter="favorites"], #vod-button, .location-trigger, #guide-button)',
            ),
          ].map((node) => {
            const box = node.getBoundingClientRect();
            return { name: node.textContent, top: box.top, bottom: box.bottom };
          });
        });
        expect(rows.map((row) => row.name)).toEqual(['Favs', 'VOD', 'Loc & Sort', 'Guide']);
        for (const row of rows) {
          expect(Math.abs(row.top - rows[0]!.top), `${row.name} top`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(row.bottom - rows[0]!.bottom), `${row.name} bottom`).toBeLessThanOrEqual(
            0.5,
          );
        }
      } finally {
        await page.close();
      }
    });
});

it('every icon the stylesheets name is bundled with its licence', async () => {
  const css = (
    await Promise.all(
      ['premium-buttons', 'responsive'].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
    )
  ).join('\n');
  const names = [...css.matchAll(/assets\/icons\/lucide\/([a-z0-9-]+)\.svg/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(15);
  for (const name of new Set(names)) {
    const svg = await readFile(`assets/icons/lucide/${name}.svg`, 'utf8');
    expect(svg).toContain('@license lucide-static v1.51.0 - ISC');
  }
  expect((await stat('assets/icons/lucide/LICENSE')).size).toBeGreaterThan(500);
  expect((await stat('assets/genxtra-badge-display.png')).size).toBeLessThan(150_000);
});
