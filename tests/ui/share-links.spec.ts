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
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fixture = (page: Page, name: string) =>
  page.route(`**/${name}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main id="app"></main></body></html>',
    }),
  );

/** The native command layer as a recorder: each command's answer is set by the test. */
async function nativeRecorder(page: Page, answers: Record<string, unknown>) {
  await page.evaluate((answers) => {
    const calls: unknown[] = [];
    Reflect.set(window, '__calls', calls);
    Reflect.set(window, 'isTauri', true);
    let callback = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    Reflect.set(window, '__nearbyChanged', () =>
      callbacks.forEach((handler) =>
        handler({ event: 'nearby-share-changed', id: 1, payload: null }),
      ),
    );
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
    Reflect.set(window, '__TAURI_INTERNALS__', {
      transformCallback: (handler: (event: unknown) => void) => {
        callbacks.set(++callback, handler);
        return callback;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: (command: string, args: unknown) => {
        if (command.startsWith('plugin:')) return Promise.resolve(callback);
        // Status reads are the card refreshing itself, not a viewer's choice.
        if (command === 'nearby_status') {
          const status = Reflect.get(window, '__nearby');
          return Promise.resolve(
            status ?? {
              active: false,
              url: null,
              expiresInMs: 0,
              visitors: 0,
              downloads: 0,
              completed: 0,
            },
          );
        }
        calls.push({ command, args });
        // A stopped session reads back as stopped, as the native layer reports it.
        if (command === 'nearby_stop') Reflect.set(window, '__nearby', undefined);
        const answer = answers[command];
        return typeof answer === 'string' && answer.startsWith('reject:')
          ? Promise.reject(answer.slice('reject:'.length))
          : Promise.resolve(answer);
      },
    });
  }, answers);
}

test('the share card shows a shared name as text and runs nothing until a choice is made', async ({
  page,
}) => {
  await fixture(page, 'share-card-fixture');
  await page.goto('/share-card-fixture');
  await page.evaluate(async () => {
    const modulePath = '/src/ui/sharing/share-card.ts';
    const { mountShareCard } = await import(modulePath);
    const ran: string[] = [];
    Reflect.set(window, '__ran', ran);
    const card = mountShareCard(document.getElementById('app')!, async () => true);
    Reflect.set(window, '__card', card);
    card.show({
      title: '<img src=x onerror="window.__injected=1"> was shared with you',
      message: 'A free channel. Choose Play to watch it now.',
      actions: [
        { label: 'Play', run: () => ran.push('play') },
        { label: 'Add to favorites', run: () => ran.push('favorite') },
      ],
    });
  });
  const card = page.getByRole('dialog');
  await expect(card).toBeVisible();
  await expect(card.locator('h2')).toHaveText(
    '<img src=x onerror="window.__injected=1"> was shared with you',
  );
  expect(await card.locator('h2 img').count()).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, '__injected'))).toBeUndefined();
  expect(await page.evaluate(() => Reflect.get(window, '__ran'))).toEqual([]);
  // Play is ready for OK on a remote, but only choosing it runs it.
  await expect(card.getByRole('button', { name: 'Play' })).toBeFocused();
  await card.getByRole('button', { name: 'Add to favorites' }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__ran'))).toEqual(['favorite']);
  // Where no share sheet exists, the link is shown to copy.
  await page.evaluate(() =>
    Reflect.get(window, '__card').show({
      title: 'Share News 24',
      link: 'https://dougtrier.github.io/GenX-Streamer/watch/#v=1',
    }),
  );
  await expect(card.getByRole('textbox', { name: 'Share link' })).toHaveValue(
    'https://dougtrier.github.io/GenX-Streamer/watch/#v=1',
  );
  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(card.locator('.share-card-message')).toHaveText('Link copied.');
});

/** Mounts the Send app page with its Settings opener, as the app does. */
async function mountSendApp(page: Page) {
  await page.evaluate(async () => {
    const opener = document.createElement('button');
    opener.id = 'send-app-button';
    opener.textContent = 'Send app to a friend';
    document.getElementById('app')!.append(opener);
    const modulePath = '/src/ui/settings/send-app.ts';
    const { mountSendApp } = await import(modulePath);
    Reflect.set(window, '__dispose', mountSendApp(document.getElementById('app')!, [opener]));
  });
  await page.getByRole('button', { name: 'Send app to a friend' }).click();
  return page.getByRole('dialog', { name: 'Pass It Along' });
}

test('Send app offers the app file, the download link and a copy, each through the native share', async ({
  page,
}) => {
  await fixture(page, 'send-app-fixture');
  await page.goto('/send-app-fixture');
  await nativeRecorder(page, {
    share_text: { shown: true },
    share_app_file: 'reject:share-app-split',
  });
  const dialog = await mountSendApp(page);
  await expect(dialog).toBeVisible();
  // A desktop (Windows) app: the app file goes through Windows' share.
  await expect(dialog.getByRole('heading', { name: 'Send the app file' })).toBeVisible();
  await expect(dialog).toContainText('unknown publisher');
  await expect(dialog.getByRole('button', { name: 'Send the app file' })).toBeFocused();
  await expect(dialog.getByRole('textbox', { name: 'Download link' })).toHaveValue(
    'https://github.com/DougTrier/GenX-Streamer/releases/latest',
  );
  await dialog.getByRole('button', { name: 'Send the download link' }).click();
  await dialog.getByRole('button', { name: 'Send the app file' }).click();
  await expect(dialog.locator('.send-app-status')).toContainText('several parts');
  expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([
    {
      command: 'share_text',
      args: {
        title: 'GenX Streamer',
        text: 'Get GenX Streamer, a free TV app for Windows and Android: https://github.com/DougTrier/GenX-Streamer/releases/latest',
      },
    },
    {
      command: 'share_app_file',
      args: {
        title: 'GenX Streamer',
        text: expect.stringContaining('More info, then Run anyway'),
      },
    },
  ]);
  await dialog.getByRole('button', { name: 'Close send app' }).click();
  await expect(dialog).toBeHidden();
});

test.describe('on Android', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140' });
  test('Send app sends the app phone to phone with one line for the receiver', async ({ page }) => {
    await fixture(page, 'send-app-android');
    await page.goto('/send-app-android');
    await nativeRecorder(page, { share_app_file: { shown: true } });
    const dialog = await mountSendApp(page);
    await expect(
      dialog.getByRole('heading', { name: 'Send the app, phone to phone' }),
    ).toBeVisible();
    await expect(dialog.locator('.send-app-file .send-app-guidance')).toHaveText(
      'On their phone: open the received file and, when asked, allow Files or Quick Share to install apps.',
    );
    await dialog.getByRole('button', { name: 'Send the app', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__calls')))
      .toEqual([
        {
          command: 'share_app_file',
          args: {
            title: 'GenX Streamer',
            text: expect.stringContaining('allow Files or Quick Share'),
          },
        },
      ]);
  });
});

test('Share with everyone nearby shows a code for the local download, live counts, and Stop', async ({
  page,
}) => {
  await fixture(page, 'send-app-nearby');
  await page.goto('/send-app-nearby');
  const url = 'http://192.168.1.20:49152/q1w2e3r4t5y6u7i8o9p0aa/';
  const running = {
    active: true,
    url,
    expiresInMs: 600_000,
    visitors: 0,
    downloads: 0,
    completed: 0,
  };
  await nativeRecorder(page, { nearby_start: running, nearby_stop: null });
  const dialog = await mountSendApp(page);
  const nearby = dialog.locator('.send-app-nearby');
  await expect(nearby.getByRole('heading', { name: 'Share with everyone nearby' })).toBeVisible();
  // Nothing is served until the viewer starts it.
  expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([]);
  await nearby.getByRole('button', { name: 'Start sharing nearby' }).click();
  await expect(
    nearby.getByRole('img', { name: 'Code to download GenX Streamer nearby' }),
  ).toBeVisible();
  await expect(nearby.getByRole('textbox', { name: 'Nearby download address' })).toHaveValue(url);
  await expect(nearby.locator('.nearby-counts')).toContainText(
    '0 connected · 0 downloads · 10:00 left',
  );
  await page.evaluate((status) => {
    Reflect.set(window, '__nearby', { ...status, visitors: 3, downloads: 2, completed: 2 });
    Reflect.get(window, '__nearbyChanged')();
  }, running);
  await expect(nearby.locator('.nearby-counts')).toContainText('3 connected · 2 downloads');
  await expect(nearby.locator('.nearby-cheer')).toHaveText(
    'Totally tubular! 2 friends are ready to rock.',
  );
  await nearby.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(nearby.getByRole('button', { name: 'Start sharing nearby' })).toBeVisible();
  await expect(nearby.locator('.nearby-active')).toBeHidden();
  expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([
    { command: 'nearby_start', args: {} },
    { command: 'nearby_stop', args: {} },
  ]);
});

test('Share with everyone nearby explains why it cannot start', async ({ page }) => {
  await fixture(page, 'send-app-nearby-off');
  await page.goto('/send-app-nearby-off');
  await nativeRecorder(page, { nearby_start: 'reject:nearby-no-network' });
  const dialog = await mountSendApp(page);
  await dialog.getByRole('button', { name: 'Start sharing nearby' }).click();
  await expect(dialog.locator('.nearby-status')).toHaveText(
    'Connect this device to Wi-Fi first. Friends join the same Wi-Fi to download it.',
  );
});

const sharePage = pathToFileURL(path.resolve('site/watch/index.html')).href;

test('the web page names what was shared and opens GenX Streamer with the same details', async ({
  page,
}) => {
  const fields = new URLSearchParams({
    v: '1',
    c: 'ch',
    n: 'News 24 <b>bold</b>',
    s: 'https://cdn.example.com/live.m3u8',
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${sharePage}#${fields}`);
  // The script ran under the page's own CSP hash, and the name is text.
  await expect(page.locator('h1')).toHaveText('News 24 <b>bold</b> was shared with you');
  expect(await page.locator('h1 b').count()).toBe(0);
  await expect(page.getByRole('link', { name: 'Open in GenX Streamer' })).toHaveAttribute(
    'href',
    `genx://watch?${fields}`,
  );
  await expect(page.getByRole('link', { name: 'Get GenX Streamer' })).toHaveAttribute(
    'href',
    'https://github.com/DougTrier/GenX-Streamer/releases/latest',
  );
  // Nothing from the shared link is fetched: only the page and its icon.
  expect(requests.every((url) => url.startsWith('file:'))).toBe(true);
});

test('the web page shows only the plain download page for an invalid link', async ({ page }) => {
  for (const fragment of [
    '',
    'v=2&c=ch&n=x&s=https%3A%2F%2Fa.example.com%2Fa.m3u8',
    'v=1&c=ch&n=x&s=javascript%3Aalert(1)',
    'v=1&c=gx&n=x&t=nothex',
    'v=1&c=ch&n=x&s=https%3A%2F%2Fa.example.com%2Fa.m3u8&evil=1',
  ]) {
    await page.goto(`${sharePage}#${fragment}`);
    await expect(page.locator('h1')).toHaveText('GenX Streamer');
    await expect(page.getByRole('link', { name: 'Open in GenX Streamer' })).toBeHidden();
  }
});
