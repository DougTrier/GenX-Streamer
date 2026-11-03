/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readStylesheet } from '../support/stylesheet';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stream-buffer-fixture',
        resolveId: (id) => (id.endsWith('virtual:stream-buffer') ? '\0stream-buffer' : undefined),
        load: (id) =>
          id === '\0stream-buffer'
            ? [
                'ui/shell/shell',
                'ui/shell/remote-navigation',
                'ui/player/stream-buffer-controls',
                'ui/player/fullscreen-presentation',
                'ui/player/video-quality',
              ]
                .map((name) => `export * from ${JSON.stringify(resolve(`src/${name}.ts`))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      lib: { entry: 'virtual:stream-buffer', name: 'StreamBufferUI', formats: ['iife'] },
    },
  });
  const built = Array.isArray(result) ? result[0] : result;
  if (!('output' in built)) throw new Error('Expected an in-memory browser fixture build.');
  const output = built.output;
  const chunk = output.find((row) => row.type === 'chunk');
  if (!chunk) throw new Error('Browser fixture chunk missing.');
  bundle = chunk.code;
  const main = await readFile('src/main.ts', 'utf8');
  const imports = [...main.matchAll(/^import '(\.\/ui\/[^']+\.css)';/gm)];
  const moduleCss = output
    .flatMap((row) =>
      row.type === 'asset' && row.fileName.endsWith('.css') ? [String(row.source)] : [],
    )
    .join('\n');
  css =
    moduleCss +
    '\n' +
    (await Promise.all(imports.map((row) => readStylesheet(resolve('src', row[1]))))).join('\n');
  browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
});
afterAll(async () => {
  if (browser) {
    try {
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  }
});

async function mount(
  width = 960,
  height = 540,
  remoteNavigation = false,
  font?: string,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent('<!doctype html><main id="app"></main>');
  await page.addStyleTag({
    content: font
      ? css.replace(
          /url\([^)]*RobotoCondensed-Variable\.ttf[^)]*\)/g,
          `url(data:font/ttf;base64,${font})`,
        )
      : css,
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate((remoteNavigation) => {
    const api = Reflect.get(window, 'StreamBufferUI');
    const root = document.getElementById('app')!;
    api.createShell(root);
    root.dataset.deviceKind = 'tv';
    root.dataset.ready = 'true';
    const state = {
      generation: 1,
      state: 'playing',
      external: false,
      selection: { id: 'channel-1', name: 'Fixture channel', url: 'https://example.com/one.m3u8' },
      telemetry: {
        capability: 'controlled',
        mode: 'manual',
        targetSeconds: 10,
        bufferedSeconds: 8,
        incomingBitsPerSecond: 1200000,
      },
    };
    const calls: unknown[] = [],
      saved: unknown[] = [],
      notices: string[] = [];
    const fixture = {
      state,
      calls,
      saved,
      notices,
      holdKey: false,
      failSave: false,
      holdSave: false,
      rollbackFails: false,
      releaseKey: () => {},
      releaseSave: () => {},
      controls: null as unknown,
      fullscreen: null as unknown,
      removeNavigation: () => {},
    };
    fixture.controls = api.mountStreamBufferControls(root, {
      current: () => structuredClone(state),
      key: async () => {
        if (fixture.holdKey) await new Promise<void>((resolve) => (fixture.releaseKey = resolve));
        return 'a'.repeat(64);
      },
      apply: async (preference: { mode: 'auto' | 'manual'; targetSeconds?: number }) => {
        calls.push(preference);
        if (fixture.rollbackFails && calls.length > 1) return false;
        state.telemetry.mode = preference.mode;
        state.telemetry.targetSeconds = preference.targetSeconds ?? 3;
        return true;
      },
      save: async (key: string, preference: unknown) => {
        if (fixture.holdSave) await new Promise<void>((resolve) => (fixture.releaseSave = resolve));
        if (fixture.failSave) throw new Error('Fixture write failure');
        saved.push({ key, preference });
      },
      notice: (message: string) => notices.push(message),
    });
    fixture.fullscreen = api.installFullscreenPresentation(root);
    if (remoteNavigation) {
      // A representative Quality control occupies the real shipping slot;
      // focus movement belongs entirely to the production remote navigator.
      const quality = document.createElement('button');
      quality.type = 'button';
      quality.id = 'fixture-quality';
      quality.className = 'video-quality-button';
      quality.textContent = 'Auto · 720p ▴';
      document.getElementById('video-quality')!.append(quality);
      fixture.removeNavigation = api.installRemoteNavigation();
    }
    Reflect.set(window, 'fixture', fixture);
  }, remoteNavigation);
  return page;
}
async function close(page: Page) {
  try {
    await page.evaluate(async () => {
      const f = Reflect.get(window, 'fixture');
      f.removeNavigation();
      await f.controls.dispose();
      f.fullscreen.dispose();
    });
  } finally {
    await page.close();
  }
}

it('shows measured kbps and buffer, and applies one saved target despite cloned snapshots', async () => {
  const page = await mount();
  try {
    const footer = page.locator('#stream-buffer-footer');
    await browserExpect(footer).toContainText('1,200 kbps');
    await browserExpect(footer).toContainText('8.0s / Target 10s');
    await footer.locator('[data-buffer-action="more"]').click({ position: { x: 3, y: 12 } });
    await browserExpect(footer).toContainText('Target 11s');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').saved)).toEqual([
      { key: 'a'.repeat(64), preference: { mode: 'manual', targetSeconds: 11 } },
    ]);
    await footer.locator('[data-buffer-action="less"]').click({ position: { x: 3, y: 12 } });
    await browserExpect(footer).toContainText('Target 10s');
    await footer.locator('[data-buffer-action="auto"]').click({ position: { x: 3, y: 12 } });
    await browserExpect(footer.locator('[data-buffer-action="auto"]')).toBeDisabled();
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').saved.at(-1).preference),
    ).toEqual({ mode: 'auto' });
  } finally {
    await close(page);
  }
});

it('refuses a held old-channel edit after selection changes and restores a failed save', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => (Reflect.get(window, 'fixture').holdKey = true));
    await page.locator('#stream-buffer-footer [data-buffer-action="more"]').click();
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.state.generation++;
      f.state.selection.id = 'channel-2';
      f.state.selection.url = 'https://example.com/two.m3u8';
      f.releaseKey();
    });
    await browserExpect(
      page.locator('#stream-buffer-footer .stream-buffer-controls'),
    ).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.holdKey = false;
      f.failSave = true;
    });
    await page.locator('#stream-buffer-footer [data-buffer-action="more"]').click();
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText('Target 10s');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
      { mode: 'manual', targetSeconds: 11 },
      { mode: 'manual', targetSeconds: 10 },
    ]);
  } finally {
    await close(page);
  }
});

it('keeps unknown delivery distinct from measured zero and disables opaque external controls', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.state.telemetry.incomingBitsPerSecond = null;
      f.controls.render();
    });
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText('— kbps');
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.state.telemetry.incomingBitsPerSecond = 0;
      f.controls.render();
    });
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText('0 kbps');
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.state.external = true;
      f.controls.render();
    });
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText(
      'Buffer managed by the external player',
    );
    await browserExpect(
      page.locator('#stream-buffer-footer [data-buffer-action="more"]'),
    ).toBeDisabled();
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
  } finally {
    await close(page);
  }
});

it('does not claim restoration after a rejected rollback acknowledgement', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.failSave = true;
      f.rollbackFails = true;
    });
    await page.locator('#stream-buffer-footer [data-buffer-action="more"]').click();
    await browserExpect(
      page.locator('#stream-buffer-footer .stream-buffer-controls'),
    ).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').notices)).toEqual([
      'The buffer setting could not be saved or restored. Retry the change when playback is ready.',
    ]);
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText('Target 11s');
  } finally {
    await close(page);
  }
});

it('keeps a late failed save and rollback notice away from the next channel', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.holdSave = true;
      f.failSave = true;
    });
    await page.locator('#stream-buffer-footer [data-buffer-action="more"]').click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'fixture').calls.length))
      .toBe(1);
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.state.generation++;
      f.state.selection.id = 'new-channel';
      f.state.selection.url = 'https://example.com/new.m3u8';
      f.state.telemetry.targetSeconds = 5;
      f.releaseSave();
    });
    await browserExpect(
      page.locator('#stream-buffer-footer .stream-buffer-controls'),
    ).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
      { mode: 'manual', targetSeconds: 11 },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').notices)).toEqual([]);
    await browserExpect(page.locator('#stream-buffer-footer')).toContainText('Target 5s');
  } finally {
    await close(page);
  }
});

it('mirrors fullscreen targets and follows existing pointer/key control visibility', async () => {
  const page = await mount(832, 397);
  try {
    await page.clock.install();
    await page.evaluate(() => Reflect.get(window, 'fixture').fullscreen.set(true));
    const mirror = page.locator('.stream-buffer-fullscreen');
    await browserExpect(mirror).toBeVisible();
    await mirror.locator('[data-buffer-action="less"]').click();
    await browserExpect(mirror).toContainText('Target 9s');
    await page.clock.fastForward(3100);
    expect(await page.locator('.dock').evaluate((node) => (node as HTMLElement).inert)).toBe(true);
    await browserExpect(mirror).not.toBeVisible();
    await page.mouse.move(300, 100);
    await browserExpect(mirror).toBeVisible();
    expect(await page.locator('.dock').evaluate((node) => (node as HTMLElement).inert)).toBe(false);
    const box = await mirror.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(833);
  } finally {
    await close(page);
  }
});

it.each([false, true])(
  'remote arrows leave the buffer meter and reach Auto without changing the target (fullscreen=%s)',
  async (fullscreen) => {
    const page = await mount(960, 540, true);
    try {
      if (fullscreen)
        await page.evaluate(() => Reflect.get(window, 'fixture').fullscreen.set(true));
      const panel = page.locator(
        fullscreen ? '.stream-buffer-fullscreen' : '#stream-buffer-footer',
      );
      const quality = page.locator('#fixture-quality');
      const meter = panel.locator('.stream-buffer-meter');
      const less = panel.locator('[data-buffer-action="less"]');
      const more = panel.locator('[data-buffer-action="more"]');
      const auto = panel.locator('[data-buffer-action="auto"]');
      await browserExpect(panel).toBeVisible();
      const enterMeter = async () => {
        if (fullscreen) {
          // The fullscreen dock is one horizontal row in shipping TV CSS.
          await page.keyboard.press('ArrowRight');
          await browserExpect(less).toBeFocused();
          await page.keyboard.press('ArrowRight');
        } else await page.keyboard.press('ArrowDown');
        await browserExpect(meter).toBeFocused();
      };
      await quality.focus();
      await enterMeter();
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
      await page.keyboard.press('ArrowRight');
      await browserExpect(more).toBeFocused({ timeout: 500 });
      await page.keyboard.press('ArrowRight');
      await browserExpect(auto).toBeFocused();
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
      if (fullscreen) {
        for (const previous of [more, meter, less, quality]) {
          await page.keyboard.press('ArrowLeft');
          await browserExpect(previous).toBeFocused();
        }
      } else {
        await page.keyboard.press('ArrowUp');
        await browserExpect(quality).toBeFocused();
      }
      await enterMeter();
      await page.keyboard.press('ArrowLeft');
      await browserExpect(less).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await browserExpect(meter).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await browserExpect(more).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await browserExpect(auto).toBeFocused();
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').saved)).toEqual([]);
      await page.keyboard.press('Enter');
      await browserExpect(auto).toBeDisabled();
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
        { mode: 'auto' },
      ]);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'fixture').saved))
        .toEqual([{ key: 'a'.repeat(64), preference: { mode: 'auto' } }]);
      // Pointer activation remains available on the same dedicated arrow.
      await more.click();
      await browserExpect(panel).toContainText('Target 4s');
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
        { mode: 'auto' },
        { mode: 'manual', targetSeconds: 4 },
      ]);
      await browserExpect(meter).toHaveAttribute(
        'aria-label',
        'Stream buffer. Use the arrow buttons to adjust the target.',
      );
    } finally {
      await close(page);
    }
  },
);

/** The complete selected-stream shell, including controls absent from the sparse unit fixture. */
async function mountFullControls(width: number, height: number, device: 'personal' | 'tv') {
  const font = (
    await readFile('assets/fonts/roboto-condensed/RobotoCondensed-Variable.ttf')
  ).toString('base64');
  const page = await mount(width, height, true, font);
  try {
    await page.evaluate(
      async ({ device }) => {
        await document.fonts.load('14px "GenX UI"');
        await document.fonts.ready;
        const root = document.getElementById('app')!;
        root.dataset.deviceKind = device;
        document.getElementById('playback-status')!.textContent = 'Playing';
        const f = Reflect.get(window, 'fixture');
        for (const id of [
          'pause-button',
          'replay-button',
          'captions-button',
          'favorite-button',
          'share-channel',
          'remove-channel',
        ]) {
          const button = document.getElementById(id) as HTMLButtonElement;
          button.disabled = false;
          button.hidden = false;
        }
        document.getElementById('fixture-quality')!.remove();
        const removeQuality = Reflect.get(window, 'StreamBufferUI').installVideoQuality(
          document.querySelector('video'),
          document.getElementById('video-quality'),
          {
            read: () => ({
              auto: true,
              currentLevel: null,
              availableLevelCount: 1,
              levelsTruncated: false,
              availableLevels: [{ index: 0, height: 720, bitrate: 1000000 }],
            }),
            set: () => true,
          },
        );
        const removeNavigation = f.removeNavigation;
        f.removeNavigation = () => {
          removeNavigation();
          removeQuality();
        };
        document.getElementById('fullscreen-button')!.addEventListener('click', () => {
          const active = !root.classList.contains('viewing-fullscreen');
          f.fullscreen.set(active);
          document.getElementById('fullscreen-button')!.textContent = active
            ? 'Exit full screen'
            : 'Full screen';
        });
      },
      { font, device },
    );
    return page;
  } catch (error) {
    await close(page);
    throw error;
  }
}

it.each([
  { width: 833, height: 469, device: 'personal' as const },
  { width: 736, height: 414, device: 'personal' as const },
  { width: 960, height: 540, device: 'tv' as const },
  { width: 390, height: 844, device: 'personal' as const },
])('keeps the complete fullscreen HUD readable at $width×$height ($device)', async (viewport) => {
  const page = await mountFullControls(viewport.width, viewport.height, viewport.device);
  try {
    await page.locator('#fullscreen-button').click();
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.stream-buffer-fullscreen')!;
      const box = (element: Element) => {
        const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      const elements = [
        ...document.querySelectorAll<HTMLElement>('.dock button:not([hidden])'),
        panel.querySelector<HTMLElement>('.stream-buffer-meter')!,
      ].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !element.closest('[hidden],[inert]');
      });
      return {
        fontLoaded: document.fonts.check('14px "GenX UI"'),
        panel: box(panel),
        status: (() => {
          const element = document.getElementById('playback-status')!;
          const rect = box(element);
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            rect,
            visible:
              !!hit &&
              (element === hit || element.contains(hit) || hit === element.closest('.dock')),
          };
        })(),
        controls: elements.map((element) => {
          const rect = box(element);
          const words: { word: string; rects: ReturnType<typeof box>[] }[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, match.index!);
              range.setEnd(node, match.index! + match[0].length);
              words.push({
                word: match[0],
                rects: [...range.getClientRects()].map((r) => ({
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                  right: r.right,
                  bottom: r.bottom,
                })),
              });
            }
          }
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            id: element.id || element.dataset.bufferAction || element.className,
            label: element.textContent,
            rect,
            words,
            hit: !!hit && (element === hit || element.contains(hit)),
          };
        }),
      };
    });
    expect(geometry.fontLoaded).toBe(true);
    expect(geometry.status.visible, JSON.stringify(geometry.status)).toBe(true);
    expect(geometry.status.rect.y).toBeGreaterThanOrEqual(0);
    expect(geometry.status.rect.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(geometry.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining([
        'pause-button',
        'replay-button',
        'mute-button',
        'fullscreen-button',
        'captions-button',
        'video-quality-button',
        'less',
        'more',
        'auto',
        'stream-buffer-meter',
      ]),
    );
    if (viewport.device === 'personal')
      expect(geometry.controls.map((control) => control.id)).toEqual(
        expect.arrayContaining(['dock-cast', 'favorite-button', 'share-channel']),
      );
    for (const control of geometry.controls) {
      // The owner's explicit TV-density policy keeps existing playback buttons
      // compact at 34px; personal controls and the fullscreen meter retain 44px.
      const compactTv = viewport.device === 'tv' && control.id !== 'stream-buffer-meter';
      expect(control.rect.width, JSON.stringify(control)).toBeGreaterThanOrEqual(
        compactTv ? 33.5 : 43.5,
      );
      expect(control.rect.height, JSON.stringify(control)).toBeGreaterThanOrEqual(
        compactTv ? 33.5 : 43.5,
      );
      expect(control.rect.x, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
      expect(control.rect.y, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
      expect(control.rect.right, JSON.stringify(control)).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(control.rect.bottom, JSON.stringify(control)).toBeLessThanOrEqual(
        viewport.height + 0.5,
      );
      expect(control.hit, JSON.stringify(control)).toBe(true);
      for (const word of control.words) {
        // Multiword labels may wrap naturally; individual words must never become vertical letters.
        expect(word.rects.length, JSON.stringify(control)).toBe(1);
        for (const rect of word.rects) {
          expect(rect.x, JSON.stringify(control)).toBeGreaterThanOrEqual(control.rect.x - 0.5);
          expect(rect.right, JSON.stringify(control)).toBeLessThanOrEqual(control.rect.right + 0.5);
          expect(rect.y, JSON.stringify(control)).toBeGreaterThanOrEqual(control.rect.y - 0.5);
          expect(rect.bottom, JSON.stringify(control)).toBeLessThanOrEqual(
            control.rect.bottom + 0.5,
          );
        }
      }
      if (!['less', 'more', 'auto', 'stream-buffer-meter'].includes(control.id)) {
        const overlapWidth =
          Math.min(control.rect.right, geometry.panel.right) -
          Math.max(control.rect.x, geometry.panel.x);
        const overlapHeight =
          Math.min(control.rect.bottom, geometry.panel.bottom) -
          Math.max(control.rect.y, geometry.panel.y);
        expect(overlapWidth > 0.5 && overlapHeight > 0.5, JSON.stringify(control)).toBe(false);
      }
    }
    // The real fixed-position Quality menu must escape the scrolling dock's
    // clip while its final item remains reachable by the remote.
    const quality = page.getByRole('button', { name: 'Video quality', exact: true });
    await quality.click();
    const menu = page.getByRole('menu', { name: 'Available video quality' });
    await browserExpect(menu).toBeVisible();
    await page.keyboard.press('End');
    await browserExpect(menu.locator('button').last()).toBeFocused();
    expect(
      await menu
        .locator('button')
        .last()
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return (
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight &&
            !!hit &&
            (element === hit || element.contains(hit))
          );
        }),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await browserExpect(menu).not.toBeVisible();
    await browserExpect(quality).toBeFocused();
  } finally {
    await close(page);
  }
});

it.each([false, true])(
  'keeps personal panel arrows focus-only and permits global escape (fullscreen=%s)',
  async (fullscreen) => {
    const page = await mountFullControls(833, 469, 'personal');
    try {
      if (fullscreen) await page.locator('#fullscreen-button').click();
      const panel = page.locator(
        fullscreen ? '.stream-buffer-fullscreen' : '#stream-buffer-footer',
      );
      const meter = panel.locator('.stream-buffer-meter');
      const less = panel.locator('[data-buffer-action="less"]');
      const more = panel.locator('[data-buffer-action="more"]');
      const auto = panel.locator('[data-buffer-action="auto"]');
      await panel.evaluate((element) => {
        const events: { key: string; prevented: boolean }[] = [];
        Reflect.set(window, 'panelKeyEvents', events);
        element.addEventListener('keydown', (event) => {
          const key = event as KeyboardEvent;
          events.push({ key: key.key, prevented: key.defaultPrevented });
        });
      });
      // Start once inside the panel; every subsequent move is a real remote key.
      await meter.focus();
      for (const next of [more, auto]) {
        await page.keyboard.press('ArrowRight');
        await browserExpect(next).toBeFocused();
      }
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').saved)).toEqual([]);
      for (const previous of [more, meter, less]) {
        await page.keyboard.press('ArrowLeft');
        await browserExpect(previous).toBeFocused();
      }
      for (const next of [meter, more, auto]) {
        await page.keyboard.press('ArrowRight');
        await browserExpect(next).toBeFocused();
      }
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').saved)).toEqual([]);
      await page.keyboard.press('Enter');
      await browserExpect(auto).toBeDisabled();
      await browserExpect(meter).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await browserExpect(more).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await browserExpect(auto).not.toBeFocused();
      expect(await page.evaluate(() => Reflect.get(window, 'panelKeyEvents').at(-1))).toEqual({
        key: 'ArrowRight',
        prevented: false,
      });
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
        { mode: 'auto' },
      ]);
      // An edge without a geometric neighbour need not move, but remains unconsumed.
      // Up still belongs to global navigation and reaches the surrounding dock.
      if (await more.evaluate((element) => element === document.activeElement))
        await page.keyboard.press('ArrowUp');
      await expect
        .poll(() =>
          page.evaluate(
            (selector) => {
              const active = document.activeElement;
              return !!active && !document.querySelector(selector)!.contains(active);
            },
            fullscreen ? '.stream-buffer-fullscreen' : '#stream-buffer-footer',
          ),
        )
        .toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').calls)).toEqual([
        { mode: 'auto' },
      ]);
    } finally {
      await close(page);
    }
  },
);
