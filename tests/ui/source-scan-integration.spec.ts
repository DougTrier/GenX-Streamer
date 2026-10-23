import { openPlaylistImport } from './helpers/source-scan';
import { canonicalRecords } from './helpers/source-scan';
import { test, expect } from '@playwright/test';

const playlist =
  '#EXTM3U\n#EXTINF:-1 tvg-id="fox" group-title="News",FOX Chicago\nhttps://fixture.invalid/fox\n#EXTINF:-1 tvg-id="sports" group-title="Sports",Sports Fixture\nhttps://fixture.invalid/sports\n';

test('a large multi-origin scan checks four channels together and publishes every admitted result only on Save', async ({
  page,
}) => {
  const count = 121;
  const catalog =
    '#EXTM3U\n' +
    Array.from(
      { length: count },
      (_, index) =>
        `#EXTINF:-1 tvg-id="large-${index}" group-title="Fixture",Channel ${index}\nhttps://channel-${index}.fixture.invalid/feed\n`,
    ).join('');
  let entered = 0,
    active = 0,
    peak = 0;
  let release!: () => void;
  const firstBatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://fixture.invalid/large', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: catalog }),
  );
  await page.route(/^https:\/\/channel-\d+\.fixture\.invalid\/feed$/, async (route) => {
    entered++;
    active++;
    peak = Math.max(peak, active);
    try {
      await firstBatch;
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
      });
    } finally {
      active--;
    }
  });
  try {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const baseline = await canonicalRecords(page);
    await openPlaylistImport(page);
    await page.locator('#playlist-url').fill('https://fixture.invalid/large');
    await page.locator('#playlist-url').press('Enter');
    const review = page.getByRole('dialog', { name: 'Review source scan' });
    const save = review.getByRole('button', { name: 'Save selected channels', exact: true });
    await expect.poll(() => entered).toBe(4);
    expect(peak).toBe(4);
    await expect(review.locator('button[aria-label="Save selected channels"]')).toBeDisabled();
    expect(await canonicalRecords(page)).toEqual(baseline);
    release();
    await expect(save).toBeEnabled();
    expect(entered).toBe(count);
    expect(peak).toBe(4);
    expect(await canonicalRecords(page)).toEqual(baseline);
    await save.click();
    await expect(review.getByRole('status')).toHaveText('Selected channels saved.');
    await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
    await expect(page.locator('#channel-count')).toHaveText(`${count} channels`);
    await page.reload();
    await expect(page.locator('#channel-count')).toHaveText(`${count} channels`);
  } finally {
    release();
  }
});
test('Scan automatically selects responding channels and Save survives reload without individual checkboxes', async ({
  page,
}) => {
  await page.route('https://fixture.invalid/source', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: playlist }),
  );
  await page.route('https://fixture.invalid/fox', (route) =>
    route.fulfill({ status: 403, body: 'Denied' }),
  );
  await page.route('https://fixture.invalid/sports', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const baseline = await canonicalRecords(page);
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill('https://fixture.invalid/source');
  await page.locator('#playlist-url').press('Enter');
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(review).toBeVisible();
  expect(await canonicalRecords(page)).toEqual(baseline);
  await expect(
    review.getByRole('button', { name: 'Save selected channels', exact: true }),
  ).toBeEnabled();
  await expect(review.getByLabel('Candidate channels')).toContainText('Sports Fixture');
  await expect(review.getByLabel('Candidate channels')).not.toContainText('FOX Chicago');
  await expect(review.getByRole('checkbox')).toHaveCount(0);
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  expect(await canonicalRecords(page)).toEqual(baseline);
  await review.getByRole('button', { name: 'Save selected channels', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText('Selected channels saved.');
  const saved = await canonicalRecords(page);
  expect(BigInt(String(saved[3]))).toBe(BigInt(String(baseline[3] ?? '0')) + 1n);
  await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('.channel strong')).toHaveText('Sports Fixture');
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
});

test('Enter and a completed URL scan are nondurable until explicit Save, including after reload', async ({
  page,
}) => {
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('https://fixture.invalid/unsaved', async (route) => {
    requests++;
    entered = true;
    await held;
    await route
      .fulfill({ status: 200, contentType: 'text/plain', body: playlist })
      .catch(() => undefined);
  });
  await page.route(/^https:\/\/fixture\.invalid\/(fox|sports)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  try {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const baseline = await canonicalRecords(page);
    await openPlaylistImport(page);
    await page.locator('#playlist-url').fill('https://fixture.invalid/unsaved');
    await page.locator('#playlist-url').press('Enter');
    const review = page.getByRole('dialog', { name: 'Review source scan' });
    await expect(review).toBeVisible();
    await expect.poll(() => entered).toBe(true);
    expect(await canonicalRecords(page)).toEqual(baseline);
    release();
    await expect(
      review.getByRole('button', { name: 'Save selected channels', exact: true }),
    ).toBeEnabled();
    expect(await canonicalRecords(page)).toEqual(baseline);
    await expect(page.locator('#channel-count')).toHaveText('0 channels');
    await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    expect(await canonicalRecords(page)).toEqual(baseline);
    await expect(page.locator('#channel-count')).toHaveText('0 channels');
    expect(requests).toBe(1);
  } finally {
    release();
  }
});
