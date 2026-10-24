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

const newer = {
  installed: '1.0.0',
  newer: true,
  latest: {
    version: '1.1.0',
    title: 'GenX Streamer 1.1.0',
    notes: 'Performance improvements.\n<b>Bug fixes</b> and new features.',
    published: '2026-11-02T18:00:00Z',
    releasePage: 'https://github.com/DougTrier/GenX-Streamer/releases/tag/v1.1.0',
    bytes: 48_000_000,
  },
};

/**
 * Mounts the Updates section with the native commands recorded; each
 * command's answer is set by the test, and update_download emits progress
 * the way the native layer does.
 */
async function mount(page: Page, answers: Record<string, unknown>) {
  await page.route('**/update-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main id="app"></main></body></html>',
    }),
  );
  await page.goto('/update-fixture');
  await page.evaluate(async (answers) => {
    let id = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const calls: unknown[] = [];
    Reflect.set(window, '__calls', calls);
    Reflect.set(window, '__restarts', 0);
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
    const emit = (event: string, payload: unknown) =>
      (listeners.get(event) ?? []).forEach((handler) =>
        callbacks.get(handler)?.({ event, id: 1, payload }),
      );
    Reflect.set(window, '__TAURI_INTERNALS__', {
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++id, callback);
        return id;
      },
      unregisterCallback: (callback: number) => callbacks.delete(callback),
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'plugin:event|listen') {
          listeners.set(String(args.event), [
            ...(listeners.get(String(args.event)) ?? []),
            Number(args.handler),
          ]);
          return id;
        }
        if (command.startsWith('plugin:')) return null;
        calls.push({ command, args });
        if (command === 'update_download') {
          emit('update-progress', { received: 24_000_000, total: 48_000_000 });
          emit('update-progress', { received: 48_000_000, total: 48_000_000 });
        }
        const answer = answers[command];
        if (typeof answer === 'string' && answer.startsWith('reject:'))
          throw answer.slice('reject:'.length);
        return answer;
      },
    });
    const modulePath = '/src/ui/settings/about-update.ts';
    const { mountAboutUpdate } = await import(modulePath);
    mountAboutUpdate(document.getElementById('app')!, {
      restart: () => Reflect.set(window, '__restarts', Reflect.get(window, '__restarts') + 1),
    });
  }, answers);
}
const calls = (page: Page) =>
  page.evaluate(() =>
    (Reflect.get(window, '__calls') as { command: string }[]).map((c) => c.command),
  );

test('nothing is checked until asked, and each step is its own choice', async ({ page }) => {
  await mount(page, {
    update_check: newer,
    update_download: { version: '1.1.0', bytes: 48_000_000, verified: true },
    update_install: { installerOpened: false, restartRequired: true },
    update_restart: null,
  });
  const app = page.locator('#app');
  await expect(app).toContainText(
    'Updates are always optional. GenX Streamer will never update without your permission.',
  );
  expect(await calls(page)).toEqual([]);
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(app.locator('.about-update-heading')).toHaveText('Update available');
  await expect(app.locator('.about-update-installed')).toHaveText('1.0.0');
  await expect(app.locator('.about-update-available')).toHaveText('1.1.0');
  // Release notes are text, not markup.
  await expect(app.locator('.about-update-notes')).toHaveText(
    'Performance improvements.\n<b>Bug fixes</b> and new features.',
  );
  expect(await app.locator('.about-update-notes b').count()).toBe(0);
  expect(await calls(page)).toEqual(['update_check']);
  await page.getByRole('button', { name: 'Download update' }).click();
  await expect(app.locator('.about-update-heading')).toHaveText('Version 1.1.0 is downloaded');
  await expect(app.locator('.about-update-status')).toContainText('matches the official release');
  expect(await calls(page)).toEqual(['update_check', 'update_download']);
  await page.getByRole('button', { name: 'Install update' }).click();
  await expect(app.locator('.about-update-heading')).toHaveText('Version 1.1.0 is installed');
  expect(await page.evaluate(() => Reflect.get(window, '__restarts'))).toBe(0);
  await page.getByRole('button', { name: 'Restart now' }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__restarts'))).toBe(1);
  expect(await calls(page)).toEqual([
    'update_check',
    'update_download',
    'update_install',
    'update_restart',
  ]);
});

test('Not now leaves everything as it was; up to date says so', async ({ page }) => {
  await mount(page, { update_check: newer });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('.about-update-result')).toBeHidden();
  expect(await calls(page)).toEqual(['update_check']);
  await page.evaluate(() => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__');
    const original = internals.invoke;
    internals.invoke = (command: string, args: unknown) =>
      command === 'update_check'
        ? Promise.resolve({
            ...{ installed: '1.1.0', newer: false },
            latest: {
              version: '1.1.0',
              title: 'GenX Streamer 1.1.0',
              notes: '',
              published: null,
              releasePage: null,
              bytes: 0,
            },
          })
        : original(command, args);
  });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.locator('.about-update-status')).toHaveText(
    'GenX Streamer is up to date (version 1.1.0).',
  );
});

test('failures are explained plainly and change nothing', async ({ page }) => {
  for (const [code, text] of [
    ['update-offline', 'GitHub could not be reached. GenX Streamer keeps working as it is'],
    ['update-no-release', 'No public GenX Streamer release was found on GitHub yet.'],
    ['update-rate-limited', 'GitHub is limiting requests right now.'],
    ['some private detail: C:\\Users\\x', 'Checking for updates did not work this time.'],
  ] as const) {
    await mount(page, { update_check: `reject:${code}` });
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.locator('.about-update-status')).toContainText(text);
    await expect(page.locator('.about-update-status')).not.toContainText('Users');
  }
  await mount(page, {
    update_check: newer,
    update_download: 'reject:update-digest-mismatch',
  });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByRole('button', { name: 'Download update' }).click();
  await expect(page.locator('.about-update-status')).toHaveText(
    'The download did not match the official release, so it was deleted. Nothing was changed.',
  );
  // The choice is offered again; nothing was installed.
  await expect(page.getByRole('button', { name: 'Download update' })).toBeEnabled();
  expect(await calls(page)).toEqual(['update_check', 'update_download']);
});

test('on Android, a differently signed update is refused with what to do', async ({ page }) => {
  await mount(page, {
    update_check: newer,
    update_download: { version: '1.1.0', bytes: 48_000_000, verified: true },
    update_install: 'reject:update-signature-mismatch',
  });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByRole('button', { name: 'Download update' }).click();
  await page.getByRole('button', { name: 'Install update' }).click();
  await expect(page.locator('.about-update-status')).toContainText(
    'signed differently from your installed copy',
  );
  expect(await page.evaluate(() => Reflect.get(window, '__restarts'))).toBe(0);
});
