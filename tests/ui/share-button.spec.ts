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
import { openPlaylistImport, saveReviewedSource } from './helpers/source-scan';

test('the Share button sits with the channel actions and waits for something shareable', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const share = page.locator('.channel-actions').getByRole('button', { name: 'Share' });
  await expect(share).toBeVisible();
  // Nothing is playing yet: nothing to share, and no share card or sheet opened.
  await expect(share).toBeDisabled();
  await expect(page.locator('#share-card')).not.toBeVisible();
});

test('Share sends "Watch <name> on GenX Streamer: <link>" with only the channel and its public stream', async ({
  page,
}) => {
  // Nothing leaves the test: streams are refused, the share sheet is recorded.
  await page.route('https://**', (route) => route.abort());
  await page.addInitScript(() => {
    const shared: unknown[] = [];
    Reflect.set(window, '__shared', shared);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: unknown) => {
        shared.push(data);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'share.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="news" group-title="News",News 24',
        'https://cdn.example.com/news24/index.m3u8',
        '',
      ].join('\n'),
    ),
  });
  await saveReviewedSource(page, 1);
  await page.getByRole('button', { name: /^News 24 · News/ }).click();
  await expect(page.locator('#watch-title')).toHaveText('News 24');
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await expect(share).toBeEnabled();
  await share.click();
  // The card: a code to scan, the link to copy, and Send.
  const card = page.getByRole('dialog', { name: 'Share News 24' });
  await expect(card.getByRole('img', { name: 'Code to scan for this link' })).toBeVisible();
  const link =
    'https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=News+24&s=https%3A%2F%2Fcdn.example.com%2Fnews24%2Findex.m3u8';
  await expect(card.getByRole('textbox', { name: 'Share link' })).toHaveValue(link);
  await card.getByRole('button', { name: 'Send…' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__shared')))
    .toEqual([{ title: 'News 24', text: `Watch News 24 on GenX Streamer: ${link}` }]);
});

test('Settings offers Send app to a friend in its header, opening every way to send GenX', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  const settings = page.locator('#settings-dialog');
  const send = settings
    .locator('.dialog-head')
    .getByRole('button', { name: 'Send app to a friend' });
  await expect(send).toBeVisible();
  await send.click();
  const dialog = page.getByRole('dialog', { name: 'Pass It Along' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Too rad to keep to yourself.');
  // The browser preview has no app file to send; the link options remain.
  await expect(dialog.getByRole('button', { name: 'Send the download link' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Download link' })).toHaveValue(
    'https://github.com/DougTrier/GenX-Streamer/releases/latest',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeVisible();
});

for (const width of [360, 1280])
  test(`the Settings header keeps its title, Send app and Close on one row at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.locator('#settings-button').click();
    const head = page.locator('#settings-dialog .dialog-head');
    const boxes = await Promise.all(
      [
        head.locator('h2'),
        head.locator('#send-app-button'),
        head.getByRole('button', { name: 'Close settings' }),
      ].map((locator) => locator.boundingBox()),
    );
    const [title, send, close] = boxes.map((box) => box!);
    expect(send.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(close.x).toBeGreaterThanOrEqual(send.x + send.width);
    expect(Math.abs(send.y + send.height / 2 - (close.y + close.height / 2))).toBeLessThan(8);
    const headBox = (await head.boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(headBox.x + headBox.width + 1);
  });
