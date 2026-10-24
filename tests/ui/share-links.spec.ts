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
        // Which copy this is (a read, not a viewer's choice): Windows unless the test says.
        if (command === 'app_identity')
          return Promise.resolve(
            answers.app_identity ?? {
              version: '0.1.0',
              platform: 'Windows',
              architecture: 'x86_64',
              build: 'release',
              signers: [],
              official: false,
              split: false,
            },
          );
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
              ended: null,
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
    'https://dougtrier.github.io/GenX-Streamer/get/',
  );
  await dialog.getByRole('button', { name: 'Send the download link' }).click();
  await expect(dialog.getByRole('button', { name: 'Send the Windows ZIP link' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Send the app file' }).click();
  await expect(dialog.locator('.send-app-status')).toContainText('several parts');
  expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([
    {
      command: 'share_text',
      args: {
        title: 'GenX Streamer',
        text: 'Get GenX Streamer, a free TV app for Windows and Android: https://dougtrier.github.io/GenX-Streamer/get/',
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

const androidIdentity = {
  version: '0.1.0',
  platform: 'Android',
  architecture: 'aarch64',
  build: 'development',
  signers: ['ab'.repeat(32)],
  official: false,
  split: false,
};

test.describe('on Android', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140' });
  test('Send app sends the app phone to phone with one line for the receiver', async ({ page }) => {
    await fixture(page, 'send-app-android');
    await page.goto('/send-app-android');
    await nativeRecorder(page, {
      share_app_file: { shown: true },
      app_identity: { ...androidIdentity, official: true, build: 'release' },
    });
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
  test('a development copy offers the link and QR code, never its own APK', async ({ page }) => {
    await fixture(page, 'send-app-android-dev');
    await page.goto('/send-app-android-dev');
    await nativeRecorder(page, { app_identity: androidIdentity });
    const dialog = await mountSendApp(page);
    await expect(dialog.locator('.send-app-development')).toBeVisible();
    await expect(dialog.locator('.send-app-file')).toBeHidden();
    await expect(dialog.locator('.send-app-nearby')).toBeHidden();
    await dialog.getByRole('button', { name: 'Show QR code' }).click();
    await expect(
      dialog.getByRole('img', { name: 'Code to open the GenX Streamer download page' }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send the download link' })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([]);
  });
});

test('Share with everyone nearby shows a code for the local download, live counts, and Stop', async ({
  page,
}) => {
  await fixture(page, 'send-app-nearby');
  await page.goto('/send-app-nearby');
  const url = 'http://192.168.1.20:8080/482913';
  const running = {
    active: true,
    url,
    expiresInMs: 600_000,
    visitors: 0,
    downloads: 0,
    completed: 0,
    ended: null,
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
  // Short enough to type with a TV remote.
  await expect(nearby.locator('.nearby-address')).toHaveText('192.168.1.20:8080/482913');
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

test('Share with everyone nearby says why a session ended early', async ({ page }) => {
  await fixture(page, 'send-app-nearby-ended');
  await page.goto('/send-app-nearby-ended');
  await nativeRecorder(page, {});
  await page.evaluate(() =>
    Reflect.set(window, '__nearby', {
      active: false,
      url: null,
      expiresInMs: 0,
      visitors: 0,
      downloads: 0,
      completed: 0,
      ended: 'guesses',
    }),
  );
  const dialog = await mountSendApp(page);
  await expect(dialog.locator('.nearby-status')).toHaveText(
    'Sharing stopped: someone kept trying wrong codes. Start again for a new code.',
  );
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

test('About shows which copy this is and its checksum on request', async ({ page }) => {
  await fixture(page, 'identity-fixture');
  await page.goto('/identity-fixture');
  await nativeRecorder(page, {
    app_identity: androidIdentity,
    app_checksum: { sha256: 'cd'.repeat(32), bytes: 52_000_000 },
  });
  await page.evaluate(async () => {
    const modulePath = '/src/ui/settings/about-identity.ts';
    const { mountAboutIdentity } = await import(modulePath);
    mountAboutIdentity(document.getElementById('app')!).load();
  });
  const app = page.locator('#app');
  await expect(app.locator('.about-identity-summary')).toHaveText(
    'GenX Streamer 0.1.0 · Android (aarch64) · Development build',
  );
  await expect(app.locator('.about-identity-signer')).toHaveText(
    `Signing certificate SHA-256: ${Array(32).fill('AB').join(':')}`,
  );
  await expect(app.locator('.about-identity-status')).toHaveText(
    'Development build: not signed with the GenX Streamer release key.',
  );
  // The checksum is computed only when asked.
  expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([]);
  await page.getByRole('button', { name: 'Show checksum' }).click();
  await expect(app.locator('.about-identity-sha')).toHaveText(
    `SHA-256 of this copy’s file: ${'cd'.repeat(32)}`,
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
    'https://dougtrier.github.io/GenX-Streamer/get/',
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

const getPage = pathToFileURL(path.resolve('site/get/index.html')).href;
const release = (assets: { name: string; digest?: string; url?: string }[]) => ({
  tag_name: 'v1.2.0',
  draft: false,
  prerelease: false,
  assets: assets.map((asset) => ({
    name: asset.name,
    digest: asset.digest ?? `sha256:${'ab'.repeat(32)}`,
    browser_download_url:
      asset.url ??
      `https://github.com/DougTrier/GenX-Streamer/releases/download/v1.2.0/${asset.name}`,
  })),
});
const files = [
  { name: 'GenX-Streamer-1.2.0-Android.apk' },
  { name: 'GenX-Streamer-1.2.0-Windows-x64-portable.zip' },
  { name: 'GenX-Streamer-1.2.0-Windows-x64.exe' },
  { name: 'SHA256SUMS' },
];
async function openGetPage(page: Page, answer: unknown, status = 200, query = '') {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(answer) }),
  );
  await page.goto(`${getPage}${query}`);
}

test.describe('the download page on an Android phone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140' });
  test('offers the Android app with its requirements and checksum, and never downloads by itself', async ({
    page,
  }) => {
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.url()));
    await openGetPage(page, release(files));
    await expect(page.locator('h1')).toHaveText('GenX Streamer 1.2.0 for Android');
    await expect(page.locator('#status')).toContainText('looks like Android');
    await expect(page.locator('#requirements')).toContainText('Android 7.0 or newer on ARM');
    await expect(
      page.getByRole('link', { name: 'Download GenX-Streamer-1.2.0-Android.apk' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/DougTrier/GenX-Streamer/releases/download/v1.2.0/GenX-Streamer-1.2.0-Android.apk',
    );
    await expect(page.locator('#sha')).toHaveText('ab'.repeat(32));
    // The other platform stays reachable when detection is wrong; extras are not offered.
    await expect(page.locator('#list li')).toHaveText([
      'GenX-Streamer-1.2.0-Windows-x64-portable.zip',
    ]);
    expect(downloads).toEqual([]);
  });

  test('chooses Windows when asked explicitly', async ({ page }) => {
    await openGetPage(page, release(files), 200, '?for=windows');
    await expect(page.locator('h1')).toHaveText('GenX Streamer 1.2.0 for Windows');
    await expect(page.locator('#status')).toHaveText('This is the download for your device.');
  });
});

test.describe('the download page on an iPhone', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  test('says there is no build for it rather than offering one that cannot run', async ({
    page,
  }) => {
    await openGetPage(page, release(files));
    await expect(page.locator('#status')).toHaveText(
      'GenX Streamer is not available for iPhone, iPad or Mac yet.',
    );
    await expect(page.locator('#pick')).toBeHidden();
  });
});

test('the download page on Windows offers the portable ZIP, and only official files', async ({
  page,
}) => {
  await openGetPage(
    page,
    release([
      { name: 'GenX-Streamer-1.2.0-Windows-x64-portable.zip', url: 'https://example.com/fake.zip' },
      { name: 'GenX-Streamer-1.2.0-Android.apk', digest: '' },
    ]),
  );
  // Neither file is official (wrong address, no digest): nothing is offered.
  await expect(page.locator('#status')).toHaveText(
    'The latest release has no Windows download yet.',
  );
  await expect(page.locator('#others')).toBeHidden();
  await openGetPage(page, release(files));
  await expect(page.locator('h1')).toHaveText('GenX Streamer 1.2.0 for Windows');
  await expect(page.locator('#guidance')).toContainText('More info, then Run anyway');
});

test('the download page says plainly when there is no public release yet', async ({ page }) => {
  await openGetPage(page, { message: 'Not Found' }, 404);
  await expect(page.locator('#status')).toHaveText(
    'No public release of GenX Streamer was found yet.',
  );
});
