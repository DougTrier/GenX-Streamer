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

import { beforeAll, afterAll, it, expect } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const modules = [
    'shell',
    'settings-navigation',
    'viewport',
    'about',
    'event-history',
    'provider-management',
    'geography-controls',
  ];
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'settings-bounds-fixture',
        resolveId: (id) =>
          id.endsWith('virtual:settings-bounds') ? '\0settings-bounds' : undefined,
        load: (id) =>
          id === '\0settings-bounds'
            ? modules
                .map((name) => `export * from ${JSON.stringify(resolve(`src/ui/${name}.ts`))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      lib: { entry: 'virtual:settings-bounds', name: 'SettingsBounds', formats: ['iife'] },
    },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing settings bounds bundle');
  const chunk = output.output.find((value) => value.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing settings bounds code');
  bundle = chunk.code;
  css = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'responsive',
        'fullscreen',
        'modal-viewport',
        'event-history',
        'genxtra',
        'media-results',
        'tv-density',
      ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
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
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(width = 960, height = 540, scale = 1): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ scale, television }) => {
      const api = Reflect.get(window, 'SettingsBounds');
      const app = document.getElementById('app')!;
      api.createShell(app);
      app.dataset.deviceKind = television ? 'tv' : 'handheld';
      document.documentElement.style.fontSize = `${scale * 16}px`;
      const effects: string[] = [];
      Reflect.set(window, 'settingsEffects', effects);
      const owners: Array<() => unknown> = [
        api.mountSettingsNavigation(document.getElementById('settings-dialog')),
        api.installViewport(app),
      ];
      const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
      document
        .getElementById('settings-button')!
        .addEventListener('click', () => dialog.showModal());
      document
        .getElementById('settings-dialog')!
        .querySelector('[data-close]')!
        .addEventListener('click', () => dialog.close());
      for (let i = 0; i < 18; i++) {
        const row = document.createElement('div');
        row.className = 'source-row';
        const name = document.createElement('span');
        name.textContent = `Source ${i + 1} ${'Long supplied provider label without a natural break_'.repeat(6)}`;
        const remove = document.createElement('button');
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove controlled source ${i + 1}`);
        remove.addEventListener('click', () => effects.push('unexpected-remove'));
        row.append(name, remove);
        document.getElementById('source-list')!.append(row);
      }
      api.mountGeographyControls(document.getElementById('geography-controls'), {
        channels: () => [],
        apply: () => {},
      });
      owners.push(api.mountLocationDialog(document.getElementById('geography-controls')));
      owners.push(api.mountAbout(document.body, document.getElementById('about-button')));
      const history = api.mountEventHistory(document.body, {
        read: async () => {
          throw Error('Controlled unavailable history');
        },
        clear: async () => {
          effects.push('unexpected-clear');
        },
        formatTime: () => 'Controlled time',
      });
      document
        .getElementById('event-history-button')!
        .addEventListener('click', () => history.open());
      owners.push(() => history.dispose());
      const providers = api.mountProviderManagement(
        document.getElementById('provider-management'),
        {
          read: () => ({
            schemaVersion: 1,
            reviewedChannelProviders: Array.from({ length: 5 }, (_, i) => ({
              id: `controlled-${i}`,
              name: `Controlled provider ${i + 1} ${'Long label_'.repeat(12)}`,
              location: `https://fixture.example/list-${i}`,
              provenance: 'https://fixture.example/',
            })),
            reviewedGuideProviders: [],
          }),
          remove: async () => {
            effects.push('unexpected-provider-remove');
            return false;
          },
        },
      );
      owners.push(() => providers.dispose());
      Reflect.set(window, 'settingsOwners', owners);
      await document.fonts.ready;
    },
    { scale, television: width === 960 },
  );
  return page;
}

async function section(page: Page, value: string) {
  await page.locator('#settings-section').click();
  await page.locator(`[data-settings-section="${value}"]`).click();
}

async function actionBounds(page: Page, selector: string, edge: 'start' | 'end') {
  return page.locator(selector).evaluate((node, edge) => {
    const button = node as HTMLElement;
    button.scrollIntoView({ block: edge, inline: 'nearest' });
    const rect = button.getBoundingClientRect();
    const panel = button.closest('[data-settings-panel]')!.getBoundingClientRect();
    const style = getComputedStyle(button);
    const outline =
      style.outlineStyle === 'none'
        ? 0
        : parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    return {
      topGap: rect.top - panel.top,
      bottomGap: panel.bottom - rect.bottom,
      leftGap: rect.left - panel.left,
      rightGap: panel.right - rect.right,
      outline,
      width: rect.width,
      height: rect.height,
      textFits: [
        ...(() => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return range.getClientRects();
        })(),
      ].every(
        (text) =>
          text.left >= rect.left &&
          text.right <= rect.right + 1 &&
          text.top >= rect.top &&
          text.bottom <= rect.bottom + 1,
      ),
      scrollWidth: button.closest('[data-settings-panel]')!.scrollWidth,
      clientWidth: button.closest('[data-settings-panel]')!.clientWidth,
    };
  }, edge);
}

for (const [width, height, scale] of [
  [960, 540, 1],
  [390, 844, 2],
]) {
  it(`keeps Sources and Advanced focused actions plus their outlines inside their scrollport at ${width}x${height}/${scale * 100}%`, async () => {
    const page = await mount(width, height, scale);
    try {
      await page.locator('#settings-button').click();
      for (const selected of ['sources', 'advanced']) {
        await section(page, selected);
        await page.keyboard.press('Tab');
        const target =
          selected === 'sources' ? '#import-button' : '#source-list .source-row:first-child button';
        await browserExpect(page.locator(target).first()).toBeFocused();
        const observed = await actionBounds(page, target, 'start');
        expect(observed.outline).toBeGreaterThan(0);
        expect(observed.topGap).toBeGreaterThanOrEqual(observed.outline);
        expect(observed.leftGap).toBeGreaterThanOrEqual(observed.outline);
        expect(observed.rightGap).toBeGreaterThanOrEqual(observed.outline);
        expect(observed.scrollWidth).toBeLessThanOrEqual(observed.clientWidth + 1);
        if (selected === 'advanced') {
          for (let i = 0; i < 17; i++) await page.keyboard.press('Tab');
          const last = '#source-list .source-row:last-child button';
          await browserExpect(page.locator(last)).toBeFocused();
          const bottom = await actionBounds(page, last, 'end');
          expect(bottom.bottomGap).toBeGreaterThanOrEqual(bottom.outline);
          expect(bottom.width).toBeGreaterThanOrEqual(width === 960 ? 32 : 44);
          expect(bottom.height).toBeGreaterThanOrEqual(width === 960 ? 32 : 44);
          expect(bottom.textFits).toBe(true);
        }
      }
      expect(await page.evaluate(() => Reflect.get(window, 'settingsEffects'))).toEqual([]);
    } finally {
      await page.close();
    }
  });
}

it('audits actual Settings sections, provider actions, import, About, history and Location at 960x540 without mutations', async () => {
  const page = await mount();
  const inventory: Array<{ surface: string; buttons: number; errors: string[] }> = [];
  async function audit(surface: string, selector: string) {
    await page.keyboard.press('Tab');
    const result = await page.locator(selector).evaluate((root) => {
      const errors: string[] = [];
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
        (node) => node.checkVisibility() && !node.disabled,
      );
      for (const button of buttons) {
        button.focus();
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const box = button.getBoundingClientRect();
        const owner = root.getBoundingClientRect();
        const name = button.getAttribute('aria-label') ?? button.textContent ?? 'button';
        if (box.width < 32 || box.height < 32) errors.push(`small:${name}`);
        if (
          box.left < owner.left ||
          box.right > owner.right + 1 ||
          box.top < owner.top ||
          box.bottom > owner.bottom + 1 ||
          box.right > innerWidth + 1 ||
          box.bottom > innerHeight + 1
        )
          errors.push(`outside:${name}`);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!button.contains(hit)) errors.push(`covered:${name}`);
        for (
          let ancestor = button.parentElement;
          ancestor && ancestor !== root;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          if (!/auto|scroll|hidden/.test(style.overflowY)) continue;
          const bounds = ancestor.getBoundingClientRect();
          const buttonStyle = getComputedStyle(button);
          const outline =
            buttonStyle.outlineStyle === 'none'
              ? 0
              : parseFloat(buttonStyle.outlineWidth) +
                Math.max(0, parseFloat(buttonStyle.outlineOffset));
          if (
            box.top - outline < bounds.top - 1 ||
            box.bottom + outline > bounds.bottom + 1 ||
            box.left - outline < bounds.left - 1 ||
            box.right + outline > bounds.right + 1
          )
            errors.push(`scrollport-clips:${name}`);
        }
      }
      return { buttons: buttons.length, errors };
    });
    inventory.push({ surface, ...result });
    expect(result.errors, surface).toEqual([]);
  }
  try {
    await page.locator('#settings-button').click();
    for (const value of [
      'sources',
      'advanced',
      'preferences',
      'data',
      'migration',
      'discovery',
      'sharing',
    ]) {
      await section(page, value);
      await audit(`settings-${value}`, '#settings-dialog');
    }
    await section(page, 'advanced');
    await page.locator('[data-settings-panel="advanced"] details > summary').click();
    await audit('provider-actions', '#settings-dialog');
    await page.evaluate(() =>
      (document.getElementById('settings-dialog') as HTMLDialogElement).close(),
    );
    await page.evaluate(() =>
      (document.getElementById('import-dialog') as HTMLDialogElement).showModal(),
    );
    await page.locator('#custom-source-options > summary').click();
    await audit('import-custom-source', '#import-dialog');
    await page.evaluate(() =>
      (document.getElementById('import-dialog') as HTMLDialogElement).close(),
    );
    await page.locator('#settings-button').click();
    await page.locator('#about-button').click();
    await audit('about', '#about-dialog');
    await page.locator('[aria-label="Close about"]').click();
    await section(page, 'advanced');
    await page.locator('#event-history-button').click();
    await audit('history-unavailable', '.gx-event-history');
    await page.getByRole('button', { name: 'Close history' }).click();
    await page.evaluate(() =>
      (document.getElementById('settings-dialog') as HTMLDialogElement).close(),
    );
    await page.locator('.location-trigger').click();
    await audit('location-empty-catalog', '.location-dialog');
    expect(await page.evaluate(() => Reflect.get(window, 'settingsEffects'))).toEqual([]);
  } finally {
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/settings-secondary-inventory.json',
      JSON.stringify(
        {
          scope:
            'Controlled actual component/cascade geometry; focus only, no saves/removals/network acquisition; not physical remote acceptance',
          inventory,
        },
        null,
        2,
      ),
    );
    await page.close();
  }
});
