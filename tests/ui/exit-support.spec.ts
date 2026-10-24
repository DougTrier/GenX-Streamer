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

test('Exit joins the native request, suppresses duplicates, and permits retry after redacted failure', async ({
  page,
}) => {
  await page.route('**/exit-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="exit">Exit app</button><p role="status"></p>',
    }),
  );
  await page.goto('/exit-fixture');
  await page.evaluate(async () => {
    Reflect.set(window, '__exitCalls', 0);
    const modulePath = '/src/ui/exit.ts';
    const { mountExit } = await import(modulePath);
    mountExit(document.querySelector('button')!, {
      native: () => true,
      request: () => {
        Reflect.set(window, '__exitCalls', Reflect.get(window, '__exitCalls') + 1);
        return new Promise((_resolve, reject) => Reflect.set(window, '__rejectExit', reject));
      },
      notice: (message: string) => {
        document.querySelector('p')!.textContent = message;
      },
    });
  });
  await page.getByRole('button', { name: 'Exit app' }).click();
  await expect(page.locator('#exit')).toBeDisabled();
  await page.locator('#exit').evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => Reflect.get(window, '__exitCalls'))).toBe(1);
  await page.evaluate(() => Reflect.get(window, '__rejectExit')(new Error('private-url-secret')));
  await expect(page.getByRole('status')).toHaveText('Closing could not start. Try Exit app again.');
  await expect(page.locator('body')).not.toContainText('private-url-secret');
  await page.getByRole('button', { name: 'Exit app' }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__exitCalls'))).toBe(2);
});
