// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserServer,
} from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readStylesheet } from '../support/stylesheet';
import { releaseBrowserLogPipesAfterExit } from '../support/browser-process-exit';
import { prepareFileChooser } from '../support/file-chooser-ready';

let browser: Browser, server: BrowserServer, bundle: string, css: string;
let pipes: ReturnType<typeof releaseBrowserLogPipesAfterExit>;
beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'settings-remote-readiness',
        resolveId: (id) => (id.endsWith('virtual:settings-ready') ? '\0settings-ready' : undefined),
        load: (id) =>
          id === '\0settings-ready'
            ? [
                'shell/shell',
                'shell/remote-navigation',
                'settings/settings-navigation',
                'settings/about',
              ]
                .map((name) => `export * from ${JSON.stringify(resolve(`src/ui/${name}.ts`))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:settings-ready', name: 'SettingsReady', formats: ['iife'] },
    },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing settings fixture output');
  const chunk = output.output.find((value) => value.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing settings fixture code');
  bundle = chunk.code;
  css = (
    await Promise.all(
      ['style', 'management', 'responsive', 'modal-viewport', 'about', 'tv-density'].map((name) =>
        readStylesheet(`src/ui/${name}.css`),
      ),
    )
  ).join('\n');
  for (const font of [
    'yellowtail/Yellowtail-Regular.ttf',
    'roboto-condensed/RobotoCondensed-Variable.ttf',
  ])
    css = css.replace(
      `../../assets/fonts/${font}`,
      `data:font/ttf;base64,${(await readFile(`assets/fonts/${font}`)).toString('base64')}`,
    );
  server = await chromium.launchServer({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  pipes = releaseBrowserLogPipesAfterExit(server.process());
  browser = await chromium.connect(server.wsEndpoint());
});
afterAll(async () => {
  try {
    expect(browser.contexts()).toHaveLength(0);
    pipes.arm();
  } finally {
    try {
      await server.close();
    } finally {
      pipes.dispose();
    }
  }
  expect(server.process().exitCode).toBe(0);
  expect(server.process().signalCode).toBeNull();
});

async function mount(width = 833, height = 397) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await prepareFileChooser(page);
  } catch (error) {
    await page.close();
    throw error;
  }
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, 'nativeCommands', []);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string) => {
        Reflect.get(window, 'nativeCommands').push(command);
        if (command === 'plugin:app|version') return Promise.resolve('0.1.23');
        if (command === 'app_identity')
          return Promise.resolve({
            version: '0.1.23',
            versionCode: 1023,
            platform: 'Android',
            architecture: 'aarch64',
            build: 'release',
            official: true,
            split: false,
            signers: ['a'.repeat(64)],
          });
        if (command === 'app_checksum')
          return new Promise((resolve, reject) => {
            Reflect.set(window, 'resolveChecksum', resolve);
            Reflect.set(window, 'rejectChecksum', reject);
          });
        return Promise.reject(new Error('Unexpected native operation'));
      },
    });
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async (television) => {
    const api = Reflect.get(window, 'SettingsReady');
    const app = document.getElementById('app')!;
    api.createShell(app);
    app.dataset.deviceKind = television ? 'tv' : 'handheld';
    const settings = document.getElementById('settings-dialog') as HTMLDialogElement;
    document
      .getElementById('settings-button')!
      .addEventListener('click', () => settings.showModal());
    settings.querySelector('[data-close]')!.addEventListener('click', () => settings.close());
    Reflect.set(window, 'importedFiles', 0);
    for (const input of document.querySelectorAll<HTMLInputElement>('.file-button input'))
      input.addEventListener('change', () => {
        // A canceled chooser supplies no import work; no application data is loaded.
        if (input.files?.length)
          Reflect.set(window, 'importedFiles', Reflect.get(window, 'importedFiles') + 1);
      });
    Reflect.set(window, 'settingsOwners', [
      api.mountSettingsNavigation(settings),
      api.installRemoteNavigation(),
      api.mountAbout(document.body, document.getElementById('about-button')),
    ]);
    await document.fonts.ready;
  }, width === 960);
  await page.locator('#settings-button').focus();
  await page.keyboard.press('Enter');
  await browserExpect(page.locator('#settings-dialog')).toBeVisible();
  return page;
}

async function dispose(page: Awaited<ReturnType<typeof mount>>) {
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'resolveChecksum')?.({ sha256: 'a'.repeat(64), bytes: 10 });
      for (const remove of Reflect.get(window, 'settingsOwners').reverse()) remove();
    });
  } finally {
    await page.close();
  }
}

for (const completion of ['success', 'failure-after-back'] as const)
  it(`hands checksum focus to Close before disabling and never steals it on ${completion}`, async () => {
    const page = await mount();
    try {
      await page.locator('#about-button').focus();
      await page.keyboard.press('Enter');
      const checksum = page.locator('.about-identity-checksum');
      const close = page.getByRole('button', { name: 'Close about', exact: true });
      await browserExpect(checksum).toBeVisible();
      await checksum.focus();
      await page.keyboard.press('Enter');
      await browserExpect(checksum).toBeDisabled();
      await browserExpect(close).toBeFocused();
      if (completion === 'success') {
        await page.keyboard.press('ArrowDown');
        const guide = page.getByRole('tab', { name: 'Quick Guide' });
        await browserExpect(guide).toBeFocused();
        await page.evaluate(() =>
          Reflect.get(window, 'resolveChecksum')({ sha256: 'a'.repeat(64), bytes: 10 }),
        );
        await browserExpect(checksum).toBeEnabled();
        await browserExpect(guide).toBeFocused();
        await page.keyboard.press('Escape');
      } else {
        await page.keyboard.press('Escape');
        await browserExpect(page.locator('#about-button')).toBeFocused();
        await page.evaluate(() =>
          Reflect.get(window, 'rejectChecksum')(new Error('Controlled failure')),
        );
        await browserExpect(checksum).toBeEnabled();
      }
      await browserExpect(page.locator('#about-dialog')).not.toBeVisible();
      await browserExpect(page.locator('#settings-dialog')).toBeVisible();
      await browserExpect(page.locator('#about-button')).toBeFocused();
    } finally {
      await dispose(page);
    }
  });

for (const [width, height] of [
  [960, 540],
  [833, 397],
])
  for (const [section, steps, inputId, exportId] of [
    ['preferences', 2, 'settings-file', 'export-button'],
    ['data', 3, 'backup-file', 'backup-export'],
  ] as const)
    it(`reaches ${inputId} by DPAD and preserves native chooser/cancel at ${width}x${height}`, async () => {
      const page = await mount(width, height);
      try {
        await page.keyboard.press('ArrowDown');
        await browserExpect(page.locator('#settings-section')).toBeFocused();
        await page.keyboard.press('Enter');
        for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await browserExpect(page.locator(`[data-settings-panel="${section}"]`)).toBeVisible();
        await page.keyboard.press('ArrowDown');
        await browserExpect(page.locator(`#${exportId}`)).toBeFocused();
        const input = page.locator(`#${inputId}`);
        // At compact widths the controls wrap; Down reaches the visible next row.
        const label = input.locator('..');
        const importBox = await label.boundingBox();
        const exportBox = await page.locator(`#${exportId}`).boundingBox();
        if (!importBox || !exportBox) throw new Error('Missing visible backup controls');
        await page.keyboard.press(
          importBox.y >= exportBox.y + exportBox.height / 2 ? 'ArrowDown' : 'ArrowRight',
        );
        await browserExpect(input).toBeFocused();
        const geometry = await input.evaluate((node) => {
          const r = node.getBoundingClientRect(),
            label = node.parentElement!,
            box = label.getBoundingClientRect();
          const panel = node.closest('[data-settings-panel]')!.getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            labelHeight: box.height,
            match:
              Math.abs(r.x - box.x) <= 2 &&
              Math.abs(r.y - box.y) <= 2 &&
              Math.abs(r.width - box.width) <= 2 &&
              Math.abs(r.height - box.height) <= 2,
            contained: box.top >= panel.top && box.bottom <= panel.bottom + 1,
            outline: getComputedStyle(label).outlineStyle,
          };
        });
        expect(geometry.width).toBeGreaterThan(40);
        expect(geometry.labelHeight).toBeGreaterThanOrEqual(40);
        expect(geometry.height).toBeGreaterThanOrEqual(geometry.labelHeight - 2);
        expect(geometry.match).toBe(true);
        expect(geometry.contained).toBe(true);
        expect(geometry.outline).not.toBe('none');
        expect(await input.inputValue()).toBe('');
        let choosers = 0;
        page.on('filechooser', () => choosers++);
        const keyboardChooser = page.waitForEvent('filechooser', { timeout: 2000 });
        await page.keyboard.press('Enter');
        await (await keyboardChooser).setFiles([]);
        expect(choosers).toBe(1);
        expect(await input.inputValue()).toBe('');
        const pointerChooser = page.waitForEvent('filechooser', { timeout: 2000 });
        await label.click();
        await (await pointerChooser).setFiles([]);
        expect(choosers).toBe(2);
        expect(await page.evaluate(() => Reflect.get(window, 'importedFiles'))).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'nativeCommands'))).toEqual([
          'plugin:app|version',
        ]);
        await page.keyboard.press('Escape');
        await browserExpect(page.locator('#settings-dialog')).not.toBeVisible();
        await browserExpect(page.locator('#settings-button')).toBeFocused();
      } finally {
        await dispose(page);
      }
    });
