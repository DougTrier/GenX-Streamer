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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readStylesheetSync } from '../support/stylesheet';

let browser: Browser;
let code: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'settings-fixture',
        resolveId: (id) => (id.endsWith('virtual:settings-fixture') ? '\0settings-fixture' : null),
        load: (id) =>
          id === '\0settings-fixture'
            ? `export {createShell} from '${process.cwd().replaceAll('\\', '/')}/src/ui/shell.ts'; export {mountSettingsNavigation} from '${process.cwd().replaceAll('\\', '/')}/src/ui/settings-navigation.ts'; export {mountAutomaticGuideUpdates} from '${process.cwd().replaceAll('\\', '/')}/src/ui/automatic-guide-updates.ts';`
            : null,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:settings-fixture', formats: ['iife'], name: 'SettingsFixture' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing settings fixture');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing settings code');
  code = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(initial?: boolean) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.setContent(
    `<style>${readStylesheetSync('src/ui/style.css')}${readStylesheetSync('src/ui/responsive.css')}</style><div id="app"></div>`,
  );
  await page.addScriptTag({ content: code });
  await page.evaluate((value) => {
    const api = Reflect.get(window, 'SettingsFixture');
    api.createShell(document.getElementById('app'));
    Reflect.set(window, 'savedValues', []);
    Reflect.set(
      window,
      'toggle',
      api.mountAutomaticGuideUpdates(document.getElementById('settings-dialog'), {
        ...(value === undefined ? {} : { automaticGuideUpdates: value }),
        save: (requested: boolean) => {
          Reflect.get(window, 'savedValues').push(requested);
          return new Promise<void>((resolve, reject) => {
            Reflect.set(window, 'releaseSave', resolve);
            Reflect.set(window, 'rejectSave', reject);
          });
        },
      }),
    );
    api.mountSettingsNavigation(document.getElementById('settings-dialog'));
    (document.getElementById('settings-dialog') as HTMLDialogElement).showModal();
  }, initial);
  return page;
}
async function advanced(page: Page) {
  await page.getByRole('button', { name: 'Settings section', exact: true }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByLabel('Update program guides automatically').waitFor({ state: 'visible' });
}
it('Advanced navigation exposes default-on checkbox; actual save ACK controls persisted display', async () => {
  const page = await fixture();
  try {
    const input = page.getByLabel('Update program guides automatically');
    expect(await input.isVisible()).toBe(false);
    await advanced(page);
    expect(await input.isChecked()).toBe(true);
    const bounds = await input.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        inside:
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.inside).toBe(true);
    expect(
      await page
        .getByText('You can still refresh program guides manually in Program guide settings.')
        .isVisible(),
    ).toBe(true);
    await input.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => Reflect.get(window, 'savedValues').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'savedValues'))).toEqual([false]);
    expect(await input.isDisabled()).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseSave')());
    await page.getByText('Program guide preference saved.', { exact: true }).waitFor();
    expect(await input.isDisabled()).toBe(false);
    expect(await input.isChecked()).toBe(false);
    expect(await page.locator('dialog[open]').count()).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'toggle').update(true));
    expect(await input.isChecked()).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'savedValues'))).toEqual([false]);
  } finally {
    await page.close();
  }
});
it('failed persistence restores last acknowledged value and never exposes raw errors', async () => {
  const page = await fixture(false);
  try {
    await advanced(page);
    const input = page.getByLabel('Update program guides automatically');
    await input.check();
    await page.waitForFunction(() => typeof Reflect.get(window, 'rejectSave') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'rejectSave')(new Error('secret https://account.invalid/credentials')),
    );
    await page
      .getByText('The preference could not be saved. Try again when ready.', { exact: true })
      .waitFor();
    expect(await input.isChecked()).toBe(false);
    expect(await page.locator('#settings-dialog').textContent()).not.toContain('credentials');
  } finally {
    await page.close();
  }
});
it('dispose joins actual pending save and removes its controls only after settlement', async () => {
  const page = await fixture();
  try {
    await advanced(page);
    await page.getByLabel('Update program guides automatically').uncheck();
    await page.waitForFunction(() => typeof Reflect.get(window, 'releaseSave') === 'function');
    await page.evaluate(() => {
      Reflect.set(window, 'disposed', false);
      Reflect.get(window, 'toggle')
        .dispose()
        .then(() => Reflect.set(window, 'disposed', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposed'))).toBe(false);
    expect(await page.locator('#automatic-guide-updates').count()).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'releaseSave')());
    await page.waitForFunction(() => Reflect.get(window, 'disposed') === true);
    expect(await page.locator('#automatic-guide-updates').count()).toBe(0);
  } finally {
    await page.close();
  }
});
