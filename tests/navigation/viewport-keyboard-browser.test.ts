import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let browser: Browser, code: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'viewport-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:viewport')) return '\0viewport';
        },
        load(id) {
          if (id === '\0viewport')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))};export {installViewport} from ${JSON.stringify(resolve('src/ui/viewport.ts'))};`;
        },
      },
    ],
    build: { write: false, lib: { entry: 'virtual:viewport', name: 'Fixture', formats: ['iife'] } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  css = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'responsive',
        'fullscreen',
        'modal-viewport',
        'genxtra',
        'media-results',
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
it('native main-search overlap bounds actual 854x432 layout, retains focus and restores after Back without stale resurrection', async () => {
  const page = await browser.newPage({ viewport: { width: 854, height: 432 } });
  try {
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.25 });
      const viewport = Object.assign(new EventTarget(), { height: 432, offsetTop: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      Reflect.set(window, 'ownedViewport', viewport);
      const fixture = Reflect.get(window, 'Fixture'),
        app = document.querySelector<HTMLElement>('#app')!;
      fixture.createShell(app);
      app.setAttribute('data-device-kind', 'handheld');
      app.setAttribute('data-content-library', 'genxtra');
      document.querySelector<HTMLElement>('#genxtra-browse-filters')!.hidden = false;
      document.querySelector<HTMLElement>('#clear-search')!.hidden = false;
      const speech = document.createElement('button');
      speech.className = 'speech-search-button';
      speech.setAttribute('aria-label', 'Speak search');
      document.querySelector('#speech-control')!.append(speech);
      Reflect.set(window, 'retainedVideo', document.querySelector('video'));
      Reflect.set(window, 'removeViewport', fixture.installViewport(app));
    });
    await page.locator('#search').focus();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 587,
            overlapPx: 533,
            webViewHeightPx: 972,
            sequence: 2,
          },
        }),
      ),
    );
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.classList.contains('keyboard-open')))
      .toBe(true);
    const height = (972 - 533) / 2.25;
    const actual = await page.evaluate(() => {
      const app = document.querySelector<HTMLElement>('#app')!,
        field = document.querySelector('#search')!,
        a = app.getBoundingClientRect(),
        f = field.getBoundingClientRect();
      return {
        height: a.height,
        visible: parseFloat(app.style.getPropertyValue('--visible-viewport-height')),
        focused: document.activeElement === field,
        fieldInside: f.top >= a.top && f.bottom <= a.bottom,
        viewHidden: getComputedStyle(document.querySelector('.view')!).display === 'none',
        bodyScroll: document.documentElement.scrollHeight > innerHeight + 1,
        visibleActions: [
          ...document.querySelectorAll<HTMLElement>(
            '#clear-search,.speech-search-button,#genxtra-browse-filters select',
          ),
        ]
          .filter((n) => n.getClientRects().length)
          .map((n) => {
            const r = n.getBoundingClientRect(),
              hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              inside: r.top >= a.top && r.bottom <= a.bottom,
              width: r.width,
              height: r.height,
              hit: n === hit || n.contains(hit),
            };
          }),
        retainedVideo: document.querySelector('video') === Reflect.get(window, 'retainedVideo'),
      };
    });
    expect(actual.height).toBeCloseTo(height, 1);
    expect(actual.visible).toBeCloseTo(height, 4);
    expect(actual.focused).toBe(true);
    expect(actual.fieldInside).toBe(true);
    expect(actual.viewHidden).toBe(true);
    expect(actual.bodyScroll).toBe(false);
    expect(actual.retainedVideo).toBe(true);
    expect(actual.visibleActions.length).toBeGreaterThanOrEqual(2);
    expect(
      actual.visibleActions.every(
        (action) => action.inside && action.width >= 44 && action.height >= 44 && action.hit,
      ),
    ).toBe(true);
    // Some Androids also resize; the same obstruction must not be counted twice.
    await page.evaluate((height) => {
      const v = Reflect.get(window, 'ownedViewport');
      v.height = height;
      v.dispatchEvent(new Event('resize'));
    }, height);
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.getBoundingClientRect().height))
      .toBeCloseTo(height, 1);
    await page.evaluate(() => {
      const v = Reflect.get(window, 'ownedViewport');
      v.height = 432;
      v.dispatchEvent(new Event('resize'));
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: false,
            bottomPx: 0,
            overlapPx: 0,
            webViewHeightPx: 972,
            sequence: 3,
          },
        }),
      );
    });
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.classList.contains('keyboard-open')))
      .toBe(false);
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.getBoundingClientRect().height))
      .toBeCloseTo(432, 1);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 587,
            overlapPx: 533,
            webViewHeightPx: 972,
            sequence: 2,
          },
        }),
      ),
    );
    expect(await page.locator('#app').evaluate((n) => n.classList.contains('keyboard-open'))).toBe(
      false,
    );
    // Orientation/width changes use the newly delivered physical inset frame,
    // rather than the previous landscape height or an obsolete sequence.
    await page.setViewportSize({ width: 412, height: 915 });
    await page.evaluate(() => {
      const v = Reflect.get(window, 'ownedViewport');
      v.height = 915;
      v.dispatchEvent(new Event('resize'));
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 654,
            overlapPx: 600,
            webViewHeightPx: 2058,
            sequence: 4,
          },
        }),
      );
    });
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.getBoundingClientRect().height))
      .toBeCloseTo((2058 - 600) / 2.25, 1);
    expect(await page.locator('#app').evaluate((n) => n.classList.contains('keyboard-open'))).toBe(
      true,
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: false,
            bottomPx: 0,
            overlapPx: 0,
            webViewHeightPx: 2058,
            sequence: 5,
          },
        }),
      ),
    );
    await expect
      .poll(() => page.locator('#app').evaluate((n) => n.getBoundingClientRect().height))
      .toBeCloseTo(915, 1);
    await page.evaluate(() => Reflect.get(window, 'removeViewport')());
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 587,
            overlapPx: 533,
            webViewHeightPx: 972,
            sequence: 6,
          },
        }),
      ),
    );
    expect(await page.locator('#app').evaluate((n) => n.style.height)).toBe('');
  } finally {
    await page.close();
  }
});
it('native modal overlap bounds its own viewport while preserving the underlying player layout', async () => {
  const page = await browser.newPage({ viewport: { width: 854, height: 432 } });
  try {
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.25 });
      const fixture = Reflect.get(window, 'Fixture'),
        app = document.querySelector('#app')!;
      fixture.createShell(app);
      app.setAttribute('data-device-kind', 'handheld');
      Reflect.set(window, 'removeViewport', fixture.installViewport(app));
      const modal = document.createElement('dialog');
      modal.innerHTML = '<input aria-label="Owned modal input"><button>Done</button>';
      app.append(modal);
      modal.showModal();
      modal.querySelector('input')!.focus();
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 587,
            overlapPx: 533,
            webViewHeightPx: 972,
            sequence: 1,
          },
        }),
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains('viewport-keyboard-open')),
      )
      .toBe(true);
    expect(
      await page
        .locator('#app')
        .evaluate((n) => ({ main: n.classList.contains('keyboard-open'), height: n.style.height })),
    ).toEqual({ main: false, height: '' });
    expect(
      await page.evaluate(() =>
        parseFloat(
          document.documentElement.style.getPropertyValue('--modal-visible-viewport-height'),
        ),
      ),
    ).toBeCloseTo((972 - 533) / 2.25, 4);
    await page.evaluate(() => Reflect.get(window, 'removeViewport')());
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--modal-visible-viewport-height'),
      ),
    ).toBe('');
  } finally {
    await page.close();
  }
});
for (const size of [
  { width: 960, height: 540, visible: 300 },
  { width: 320, height: 640, visible: 320 },
])
  it(`keyboard contracts the ${size.width}px app without scrolling the whole page`, async () => {
    const page = await browser.newPage({ viewport: size });
    try {
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      await page.evaluate(({ height }) => {
        const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0 });
        Reflect.set(window, 'ownedViewport', viewport);
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        const fixture = Reflect.get(window, 'Fixture');
        fixture.createShell(document.querySelector('#app'));
        Reflect.set(
          window,
          'removeViewport',
          fixture.installViewport(document.querySelector('#app')),
        );
      }, size);
      await page.locator('#search').focus();
      await page.evaluate((height) => {
        const viewport = Reflect.get(window, 'ownedViewport');
        viewport.height = height;
        viewport.dispatchEvent(new Event('resize'));
        window.scrollTo(0, 300);
      }, size.visible);
      await expect
        .poll(() =>
          page.locator('#app').evaluate((node) => Math.round(node.getBoundingClientRect().height)),
        )
        .toBe(size.visible);
      const state = await page.evaluate(() => {
        const app = document.querySelector('#app')!,
          input = document.querySelector('#search')!,
          list = document.querySelector('#channel-list')!;
        const a = app.getBoundingClientRect(),
          i = input.getBoundingClientRect(),
          l = list.getBoundingClientRect();
        return {
          keyboard: app.classList.contains('keyboard-open'),
          scroll: scrollY,
          inputInside: i.top >= a.top && i.bottom <= a.bottom,
          listInside: l.top >= a.top && l.bottom <= a.bottom,
          focused: input === document.activeElement,
        };
      });
      expect(state).toEqual({
        keyboard: true,
        scroll: 0,
        inputInside: true,
        listInside: true,
        focused: true,
      });
      // An adjustResize provider can also shrink innerHeight: original height is retained.
      await page.evaluate((height) => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
        window.dispatchEvent(new Event('resize'));
      }, size.visible);
      await expect
        .poll(() =>
          page.locator('#app').evaluate((node) => node.classList.contains('keyboard-open')),
        )
        .toBe(true);
      // Import playlist now lives in Settings. This shell-only fixture supplies
      // the modal transitions normally owned by main, without bypassing visibility.
      await page.locator('#settings-button').click();
      await page.evaluate(() => {
        (document.querySelector('#settings-dialog') as HTMLDialogElement).showModal();
      });
      await page.locator('#import-button').click();
      await page.evaluate(() => {
        (document.querySelector('#settings-dialog') as HTMLDialogElement).close();
        (document.querySelector('#import-dialog') as HTMLDialogElement).showModal();
      });
      // Source entry is deliberately disclosed beneath the primary zero-input Scan action.
      expect(await page.locator('#custom-source-options').getAttribute('open')).toBeNull();
      await page.locator('#custom-source-options > summary').click();
      expect(await page.locator('#playlist-url').isVisible()).toBe(true);
      await page.locator('#playlist-url').focus();
      const dialog = await page.locator('#import-dialog').evaluate((node) => {
        const d = node.getBoundingClientRect(),
          close = node.querySelector('[data-close]')!.getBoundingClientRect();
        return {
          bounded: d.bottom <= Reflect.get(window, 'ownedViewport').height,
          closeInside: close.top >= d.top && close.bottom <= d.bottom,
        };
      });
      expect(dialog).toEqual({ bounded: true, closeInside: true });
      await page.evaluate(({ height }) => {
        (document.querySelector('#import-dialog') as HTMLDialogElement).close();
        (document.activeElement as HTMLElement).blur();
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
        const viewport = Reflect.get(window, 'ownedViewport');
        viewport.height = height;
        viewport.dispatchEvent(new Event('resize'));
      }, size);
      await expect
        .poll(() =>
          page.locator('#app').evaluate((node) => node.classList.contains('keyboard-open')),
        )
        .toBe(false);
      expect(
        await page
          .locator('#app')
          .evaluate((node) => Math.round(node.getBoundingClientRect().height)),
      ).toBe(size.height);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'removeViewport')?.());
      await page.close();
    }
  });

for (const kind of ['guide', 'website', 'location', 'settings'] as const)
  it(`bounds the external ${kind} modal and reachable controls in a panned 960x300 viewport`, async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    try {
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      await page.evaluate((kind) => {
        const viewport = Object.assign(new EventTarget(), { height: 540, offsetTop: 0 });
        Reflect.set(window, 'ownedViewport', viewport);
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        const fixture = Reflect.get(window, 'Fixture');
        const app = document.querySelector<HTMLElement>('#app')!;
        fixture.createShell(app);
        document.documentElement.style.setProperty('--viewport-top', '11px', 'important');
        document.documentElement.style.setProperty('--visible-viewport-height', '499px');
        app.style.setProperty('--viewport-top', '9px');
        Reflect.set(window, 'removeViewport', fixture.installViewport(app));
        const dialog = document.createElement('dialog');
        dialog.id = kind === 'settings' ? 'settings-dialog-external' : 'outside-modal';
        dialog.className =
          kind === 'guide'
            ? 'guide-dialog'
            : kind === 'website'
              ? 'website-discovery-dialog'
              : kind === 'location'
                ? 'location-dialog'
                : '';
        if (kind === 'settings') {
          app.querySelector('#settings-dialog')!.remove();
          dialog.id = 'settings-dialog';
        }
        const bodyClass =
          kind === 'guide' ? 'guide-body' : kind === 'website' ? 'website-body' : '';
        const bodyAttrs =
          kind === 'location'
            ? 'id="geography-controls"'
            : kind === 'settings'
              ? 'data-settings-panel="sources"'
              : `class="${bodyClass}"`;
        const innerClass =
          kind === 'guide' ? 'guide-sources-panel' : kind === 'website' ? 'website-setup' : '';
        const content = `<label>Text field<input id="outside-input"/></label><div style="height:1000px">Long source form</div><button id="inside-tail">Last form action</button>`;
        dialog.innerHTML = `<header class="dialog-head"><h2>Owned modal</h2><button id="outside-close">Close</button></header><section ${bodyAttrs}>${innerClass ? `<section class="${innerClass}">${content}</section>` : content}</section><footer class="settings-footer"><button id="outside-footer">Done</button></footer>`;
        document.body.append(dialog);
        dialog.showModal();
        // Contract before focusing: no resize event follows the external focus.
        viewport.height = 300;
        viewport.offsetTop = 37;
        viewport.dispatchEvent(new Event('resize'));
      }, kind);
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue('--visible-viewport-height'),
          ),
        )
        .toBe('300px');
      await page.locator('#outside-input').focus();
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains('viewport-keyboard-open'),
          ),
        )
        .toBe(true);
      const bounds = await page.locator('dialog[open]').evaluate((dialog) => {
        const d = dialog.getBoundingClientRect();
        const c = dialog.querySelector('#outside-close')!.getBoundingClientRect();
        const f = dialog.querySelector('#outside-footer')!.getBoundingClientRect();
        const body =
          dialog.querySelector('.website-setup, .guide-sources-panel') ??
          dialog.querySelector('section')!;
        return {
          outside: !document.querySelector('#app')!.contains(dialog),
          top: d.top,
          bottom: d.bottom,
          closeInside: c.top >= d.top && c.bottom <= d.bottom,
          footerInside: f.top >= d.top && f.bottom <= d.bottom,
          bodyScrollable: body.scrollHeight > body.clientHeight && body.clientHeight > 0,
        };
      });
      expect(bounds.outside).toBe(true);
      expect(bounds.top).toBeGreaterThanOrEqual(37);
      expect(bounds.bottom).toBeLessThanOrEqual(337);
      expect(bounds.closeInside).toBe(true);
      expect(bounds.footerInside).toBe(true);
      expect(bounds.bodyScrollable).toBe(true);
      await page.locator('#inside-tail').focus();
      const tail = await page.locator('#inside-tail').evaluate((node) => {
        const r = node.getBoundingClientRect(),
          d = node.closest('dialog')!.getBoundingClientRect();
        return r.top >= d.top && r.bottom <= d.bottom;
      });
      expect(tail).toBe(true);
      await page.evaluate(() => {
        const viewport = Reflect.get(window, 'ownedViewport');
        viewport.height = 280;
        viewport.offsetTop = 50;
        viewport.dispatchEvent(new Event('scroll'));
      });
      await expect
        .poll(() => page.locator('dialog[open]').evaluate((n) => n.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(330);
      await page.evaluate(() => Reflect.get(window, 'removeViewport')());
      expect(
        await page.evaluate(() => ({
          top: document.documentElement.style.getPropertyValue('--viewport-top'),
          priority: document.documentElement.style.getPropertyPriority('--viewport-top'),
          height: document.documentElement.style.getPropertyValue('--visible-viewport-height'),
          appTop: (document.querySelector('#app') as HTMLElement).style.getPropertyValue(
            '--viewport-top',
          ),
          keyboard: document.documentElement.classList.contains('viewport-keyboard-open'),
        })),
      ).toEqual({
        top: '11px',
        priority: 'important',
        height: '499px',
        appTop: '9px',
        keyboard: false,
      });
      await page.evaluate(() => {
        const viewport = Reflect.get(window, 'ownedViewport');
        viewport.height = 200;
        viewport.dispatchEvent(new Event('resize'));
        document.querySelector<HTMLElement>('#outside-input')!.focus();
      });
      await page.waitForTimeout(40);
      expect(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue('--visible-viewport-height'),
        ),
      ).toBe('499px');
    } finally {
      await page.evaluate(() => Reflect.get(window, 'removeViewport')?.());
      await page.close();
    }
  });
