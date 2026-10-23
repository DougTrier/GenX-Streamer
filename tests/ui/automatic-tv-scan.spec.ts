import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { configureControlledDiscoveryProviders } from './helpers/source-scan';
import { openPlaylistImport } from './helpers/source-scan';
import { canonicalRecords, saveReviewedSource } from './helpers/source-scan';
import { expect, test, type Page } from '@playwright/test';

const providers = [
  'https://iptv-org.github.io/iptv/index.m3u',
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
] as const;
const playlist = (...names: string[]) =>
  '#EXTM3U\n' +
  names
    .map(
      (name) =>
        `#EXTINF:-1 group-title="Fixture",${name}\nhttps://${name.toLowerCase()}.fixture.invalid/feed\n`,
    )
    .join('');
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
async function prepare(page: Page) {
  // Published endpoints are intercepted; no public availability/decode claim.
  await page.route('https://iptv-org.github.io/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await installOnlineDirectoryFixture(page, providers);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await configureControlledDiscoveryProviders(page);
}
async function openAutomatic(page: Page) {
  await expect(page.locator('#search')).toHaveValue('');
  if (!(await page.locator('#search-programs').isVisible()))
    await page.locator('#compact-view').selectOption('channels');
  await page.locator('#search-programs').focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('#inline-source-scan');
  await expect(panel).toBeVisible();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  return panel;
}

test('zero-input Scan uses explicitly configured controlled providers and saves only responding channels automatically across reload', async ({
  page,
}) => {
  const requests: string[] = [],
    sources: string[] = [];
  for (const [index, url] of providers.entries())
    await page.route(url, (route) => {
      sources.push(url);
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: index === 0 ? playlist('ReadyOne', 'Denied') : playlist('ReadyTwo'),
      });
    });
  await page.route(/^https:\/\/(readyone|readytwo|denied)\.fixture\.invalid\/feed$/, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: route.request().url().includes('denied') ? 403 : 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: media,
    });
  });
  await prepare(page);
  const baseline = await canonicalRecords(page);
  const dialog = await openAutomatic(page);
  await expect(dialog.getByRole('status')).toHaveText('2 channels saved.');
  expect(sources).toEqual([...providers]);
  expect(requests).toHaveLength(3);
  const saved = await canonicalRecords(page);
  expect(saved[0]).not.toEqual(baseline[0]);
  const catalog = JSON.parse(String(saved[0])) as {
    channels: { name: string }[];
    sources: unknown[];
  };
  expect(catalog.channels.map((c) => c.name).sort()).toEqual(['ReadyOne', 'ReadyTwo']);
  expect(catalog.sources).toHaveLength(2);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await canonicalRecords(page)).toEqual(saved);
  await expect(page.locator('.channel strong')).toHaveText(['ReadyOne', 'ReadyTwo']);
  expect(requests).toHaveLength(3);
});

test('Cancel a held automatic response check joins it without saving any late channel', async ({
  page,
}) => {
  await page.route(providers[0], (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: playlist('Held') }),
  );
  await page.route(providers[1], (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  let release!: () => void,
    finish!: () => void,
    canceled = false,
    entered = 0;
  const held = new Promise<void>((r) => (release = r)),
    settled = new Promise<void>((r) => (finish = r));
  await page.route('https://held.fixture.invalid/feed', async (route) => {
    entered++;
    try {
      await held;
      await route
        .fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: media })
        .catch((error) => {
          if (!canceled && !route.request().failure()) throw error;
        });
    } finally {
      finish();
    }
  });
  try {
    await prepare(page);
    const baseline = await canonicalRecords(page),
      dialog = await openAutomatic(page);
    await expect.poll(() => entered).toBe(1);
    expect(await canonicalRecords(page)).toEqual(baseline);
    canceled = true;
    await page.locator('#inline-scan-stop').click();
    release();
    await settled;
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    await expect(dialog.getByRole('alert')).toContainText('retained');
    expect(await canonicalRecords(page)).toEqual(baseline);
    await expect(page.locator('#channel-count')).toHaveText('0 channels');
  } finally {
    canceled = true;
    release();
  }
});

test('all suggested source failures retain the previously saved catalog and preferences', async ({
  page,
}) => {
  let failed = 0;
  for (const url of providers)
    await page.route(url, (route) => {
      failed++;
      return route.fulfill({ status: 503, body: 'Unavailable' });
    });
  await prepare(page);
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'retained.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist('Retained')),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  const baseline = await canonicalRecords(page);
  const dialog = await openAutomatic(page);
  await expect(dialog.getByRole('status')).toContainText('Saved channels are ready');
  await expect(page.locator('#inline-scan-continue')).toBeHidden();
  await expect(page.locator('#inline-scan-rescan')).toBeVisible();
  expect(failed).toBe(0);
  expect(await canonicalRecords(page)).toEqual(baseline);
  await page.locator('#inline-scan-rescan').click();
  await expect.poll(() => failed).toBe(2);
  await expect(dialog.getByRole('status')).toHaveText(
    'No channels were collected. Nothing was added.',
  );
  await expect(dialog.getByRole('alert')).toHaveText(
    '0 channels collected. 2 of 2 sources could not be read. Your saved channels were retained. Select Rescan to retry.',
  );
  await expect(page.locator('#inline-scan-stop')).toBeHidden();
  expect(await canonicalRecords(page)).toEqual(baseline);
  await expect(page.locator('.channel strong')).toHaveText('Retained');
  await page.locator('#inline-scan-rescan').click();
  await expect.poll(() => failed).toBe(4);
  await expect(dialog.getByRole('alert')).toContainText('2 of 2 sources could not be read');
  expect(await canonicalRecords(page)).toEqual(baseline);
});

test('partial source failure adds responding channels and keeps the incomplete collection visible', async ({
  page,
}) => {
  await page.route(providers[0], (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: playlist('ReadyOne') }),
  );
  await page.route(providers[1], (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.route('https://readyone.fixture.invalid/feed', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: media }),
  );
  await prepare(page);
  const dialog = await openAutomatic(page);
  await expect(dialog.getByRole('status')).toHaveText('1 channel saved.');
  await expect(dialog.getByRole('alert')).toContainText(
    '1 channels collected. 1 of 2 sources could not be read. Your saved channels were retained. Select Rescan to retry.',
  );
  const saved = await canonicalRecords(page);
  expect(
    JSON.parse(String(saved[0])).channels.map((channel: { name: string }) => channel.name),
  ).toEqual(['ReadyOne']);
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await canonicalRecords(page)).toEqual(saved);
});
