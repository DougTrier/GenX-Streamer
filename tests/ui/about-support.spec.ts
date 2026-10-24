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

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('Native About uses platform version, refuses repeated pending clicks, and redacts opener errors', async ({
  page,
}) => {
  await page.route('**/about-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main id="app"><button id="about-button">About</button></main></body></html>',
    }),
  );
  await page.goto('/about-fixture');
  await page.evaluate(async () => {
    Reflect.set(window, 'isTauri', true);
    const calls: unknown[] = [];
    Reflect.set(window, '__supportCalls', calls);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args: unknown) => {
        if (command === 'plugin:app|version') return Promise.resolve('7.8.9');
        // This copy's details (a read when About opens, not a support link).
        if (command === 'app_identity') return Promise.reject('identity-unavailable');
        calls.push({ command, args });
        return new Promise((_resolve, reject) => Reflect.set(window, '__rejectSupport', reject));
      },
    });
    const modulePath = '/src/ui/settings/about.ts';
    const { mountAbout } = await import(modulePath);
    Reflect.set(
      window,
      '__disposeAbout',
      mountAbout(document.getElementById('app')!, document.getElementById('about-button')!),
    );
  });
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#about-version')).toHaveText('Version 7.8.9');
  await page.locator('.about-licenses > summary').click();
  const fontNotices = page.locator('.about-font-licenses details');
  await expect(fontNotices).toHaveCount(2);
  for (const [index, file] of [
    [0, 'assets/fonts/roboto-condensed/OFL.txt'],
    [1, 'assets/fonts/yellowtail/LICENSE.txt'],
  ] as const) {
    const disclosure = fontNotices.nth(index);
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('pre')).toBeVisible();
    await expect(disclosure.locator('pre')).toHaveText(readFileSync(file, 'utf8'));
    await disclosure.locator('summary').click();
  }
  await page.getByRole('button', { name: 'Buy Me a Coffee', exact: true }).click();
  await page.getByRole('button', { name: 'GitHub Sponsors', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toEqual([
    { command: 'open_donation', args: { target: 'coffee' } },
  ]);
  await page.evaluate(() =>
    Reflect.get(window, '__rejectSupport')(new Error('private-secret-url')),
  );
  await expect(page.getByRole('status')).toHaveText(
    'Could not open your browser. Visit https://www.buymeacoffee.com/dougtrier',
  );
  await expect(page.locator('body')).not.toContainText('private-secret-url');
  await page.getByRole('button', { name: 'GitHub Sponsors', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toHaveLength(2);
  await page.evaluate(() => {
    Reflect.get(window, '__disposeAbout')();
    Reflect.get(window, '__rejectSupport')(new Error('late-private-error'));
  });
  await expect(page.locator('#about-dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('late-private-error');
});
