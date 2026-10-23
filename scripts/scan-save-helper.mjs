import { expect } from '@playwright/test';

// URL setup exercises the ordinary automatic Scan followed by explicit Save.
// This does not establish decoder health; callers retain their decode assertions.
export async function saveCompletedSourceScan(page, timeout = 20000) {
  const review = page.getByRole('dialog', { name: 'Review source scan', exact: true });
  await expect(review).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Scan configured sources', exact: true }),
  ).toBeEnabled({ timeout });
  const save = review.getByRole('button', { name: 'Save selected channels', exact: true });
  await expect(save).toBeEnabled({ timeout });
  await save.click();
  await expect(review.getByRole('status')).toHaveText('Selected channels saved.', { timeout });
  await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await expect(review).not.toBeVisible();
}

// Synthetic local catalog setup only: deliberately preserves negative-media and
// decoder-health baselines without claiming the automatic URL Scan was tested.
export async function importFixtureCatalogFile(page, fixtureUrl, timeout = 20000) {
  const admitted = new URL(fixtureUrl);
  if (
    admitted.protocol !== 'http:' ||
    admitted.hostname !== '127.0.0.1' ||
    admitted.username ||
    admitted.password ||
    admitted.hash
  )
    throw new Error('Only an owned loopback catalog fixture is admitted.');
  const response = await fetch(fixtureUrl, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Controlled catalog fixture unavailable.');
  if (!response.body) throw new Error('Controlled catalog fixture body missing.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) throw new Error('Controlled catalog fixture too large.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  await page.locator('#playlist-file').setInputFiles({
    name: 'owned-controlled-catalog.m3u',
    mimeType: 'application/x-mpegurl',
    buffer: Buffer.concat(chunks, size),
  });
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout });
  const review = page.getByRole('dialog', { name: 'Review source scan', exact: true });
  await expect(review).toBeVisible({ timeout });
  const save = review.getByRole('button', { name: 'Save selected channels', exact: true });
  await expect(save).toBeEnabled({ timeout });
  await save.click();
  await expect(review.getByRole('status')).toHaveText('Selected channels saved.', { timeout });
  await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await expect(review).not.toBeVisible({ timeout });
}
