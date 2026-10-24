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

import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, completed = false, failModal = false) {
  await page.route('**/resume-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><button id="opener">Choose video</button>',
    }),
  );
  await page.goto('/resume-fixture');
  await page.evaluate(
    async ({ completed, failModal }) => {
      const path = '/src/ui/archive-resume.ts';
      const { chooseArchiveResume } = await import(path);
      const controller = new AbortController();
      const state = { controller, result: null as string | null };
      Reflect.set(window, 'resumeFixture', state);
      document.querySelector<HTMLButtonElement>('#opener')!.focus();
      if (failModal)
        HTMLDialogElement.prototype.showModal = () => {
          throw Error('Fixture attachment failure');
        };
      void chooseArchiveResume(
        '<img src=x onerror=alert(1)>',
        65123,
        controller.signal,
        completed,
      ).then((choice: string) => {
        state.result = choice;
      });
    },
    { completed, failModal },
  );
}

test('explicit Resume is focused, title is text and choice disposes the dialog', async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByRole('button', { name: 'Resume from 1:05' })).toBeFocused();
  await expect(page.locator('dialog p')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('dialog img')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBeNull();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBe('resume');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('#opener')).toBeFocused();
});

test('Escape and selection cancellation never implicitly resume', async ({ page }) => {
  await mount(page);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBe('cancel');
  await mount(page);
  await page.evaluate(() => Reflect.get(window, 'resumeFixture').controller.abort());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBe('cancel');
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('completed media offers Watch again rather than seeking to the end', async ({ page }) => {
  await mount(page, true);
  await expect(page.getByRole('button', { name: 'Watch again', exact: true })).toBeFocused();
  await expect(page.locator('[data-resume-choice="resume"]')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBe('restart');
});

test('failed modal attachment cancels and removes its transient owner', async ({ page }) => {
  await mount(page, false, true);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'resumeFixture').result))
    .toBe('cancel');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('#opener')).toBeFocused();
});
