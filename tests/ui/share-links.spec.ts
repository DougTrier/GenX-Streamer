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
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args: unknown) => {
        calls.push({ command, args });
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

test('About sends the download link and the installed app through the native share sheet', async ({
  page,
}) => {
  await fixture(page, 'about-share-fixture');
  await page.goto('/about-share-fixture');
  await nativeRecorder(page, {
    share_text: { shown: true },
    share_app_file: 'reject:share-app-split',
  });
  await page.evaluate(async () => {
    const modulePath = '/src/ui/settings/about-share.ts';
    const { mountAboutShare } = await import(modulePath);
    Reflect.set(window, '__dispose', mountAboutShare(document.getElementById('app')!));
  });
  const app = page.locator('#app');
  await expect(app).toContainText('Share GenX Streamer');
  // A desktop (Windows) app: the app file goes through Windows' share.
  await expect(app.locator('.about-share-guidance')).toContainText('unknown publisher');
  await page.getByRole('button', { name: 'Send the download link' }).click();
  await page.getByRole('button', { name: 'Send the app file' }).click();
  await expect(app.locator('.about-share-status')).toContainText('several parts');
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
});

test.describe('on Android', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140' });
  test('About offers the app phone to phone with one line for the receiver', async ({ page }) => {
    await fixture(page, 'about-share-android');
    await page.goto('/about-share-android');
    await nativeRecorder(page, { share_app_file: { shown: true } });
    await page.evaluate(async () => {
      const modulePath = '/src/ui/settings/about-share.ts';
      const { mountAboutShare } = await import(modulePath);
      mountAboutShare(document.getElementById('app')!);
    });
    await expect(page.locator('.about-share-guidance')).toHaveText(
      'On their phone: open the received file and, when asked, allow Files or Quick Share to install apps.',
    );
    await page.getByRole('button', { name: 'Send the app (Quick Share, Bluetooth)' }).click();
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
