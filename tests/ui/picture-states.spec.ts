import { openPlaylistImport, saveReviewedSource } from './helpers/source-scan';
import { expect, test } from '@playwright/test';

// Actual bundled application and player; the stream address never answers
// (aborted), so playback really fails. Proves which artwork each picture state
// shows; it does not prove native decoders.
test('the picture shows the play, opening and could-not-connect screens, and its Retry works', async ({
  page,
}) => {
  let requests = 0;
  await page.route('https://media.invalid/**', async (route) => {
    requests++;
    // Held a moment, as a slow network would, so the connecting state is observable.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.abort().catch(() => {});
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const overlay = page.locator('#player-overlay');
  const art = () => overlay.locator('.picture-image').getAttribute('src');
  // Nothing playing: the play screen, its words in a caption.
  await expect(overlay).toHaveAttribute('data-art', 'play');
  expect(await art()).toMatch(/genx-play-display/);
  await expect(page.locator('#overlay-title')).toBeVisible();
  await expect(page.locator('#retry-button')).toBeHidden();

  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'states.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from('#EXTM3U\n#EXTINF:-1,Unreachable News\nhttps://media.invalid/news.m3u8\n'),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 30000 });
  if (await page.locator('#compact-view').isVisible())
    await page.locator('#compact-view').selectOption('channels');
  await page.locator('.channel').first().click();

  // While a channel connects, Pause stays usable (disabling it moved the
  // remote's focus to Mute on the Sansui when resuming).
  await expect(page.locator('#playback-status')).toHaveText(/Connecting/);
  await expect(page.locator('#pause-button')).toBeEnabled();
  // Opening: the buffering screen with the channel's status, until it fails.
  await expect
    .poll(async () => overlay.getAttribute('data-art'), { timeout: 30000 })
    .toMatch(/buffering|failed/);
  await expect(overlay).toHaveAttribute('data-art', 'failed', { timeout: 60000 });
  expect(await art()).toMatch(/genx-could-not-connect-display/);
  await expect(page.locator('#overlay-title')).toBeVisible();
  // The painted TRY AGAIN… is the real Retry: inside the artwork, on its lower middle.
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  const [box, frame] = await Promise.all([
    retry.boundingBox(),
    overlay.locator('.picture-art').boundingBox(),
  ]);
  expect(box && frame).toBeTruthy();
  const centerX = (box!.x + box!.width / 2 - frame!.x) / frame!.width;
  const centerY = (box!.y + box!.height / 2 - frame!.y) / frame!.height;
  expect(centerX).toBeCloseTo(0.501, 2);
  expect(centerY).toBeCloseTo(0.829, 2);
  expect(await retry.evaluate((node) => getComputedStyle(node).color)).toBe('rgba(0, 0, 0, 0)');
  const before = requests;
  await retry.click();
  await expect.poll(() => requests, { timeout: 30000 }).toBeGreaterThan(before);
});
