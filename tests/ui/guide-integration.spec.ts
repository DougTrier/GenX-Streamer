import { openGuideProgramSearch, seedSavedSearchChannels } from './helpers/search-workflows';
import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 960, height: 540 },
  { width: 320, height: 640 },
]) {
  test(`one voice search belongs inside the full-width channel search at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    if (await page.getByLabel('Viewing panel').isVisible())
      await page.getByLabel('Viewing panel').selectOption('channels');
    const input = page.locator('#search');
    expect(
      await input.evaluate((node) =>
        Math.abs(
          node.getBoundingClientRect().width - node.parentElement!.getBoundingClientRect().width,
        ),
      ),
    ).toBeLessThan(1);
    await expect(page.locator('.search-controls #speech-control button')).toHaveAccessibleName(
      'Voice search',
    );
    await expect(page.locator('#speech-control button svg')).toHaveAttribute('aria-hidden', 'true');
    expect(
      await page.locator('#speech-control button').evaluate((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.width >= 44 &&
          r.height >= 44 &&
          r.left >= 0 &&
          r.top >= 0 &&
          r.right <= innerWidth &&
          r.bottom <= innerHeight &&
          node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) &&
          node.closest('.search-controls')?.querySelector('#search') !== null
        );
      }),
    ).toBe(true);
    await expect(page.locator('.search-controls #speech-control')).toHaveCount(1);
    await expect(page.locator('.speech-search-button')).toHaveCount(1);
    expect(
      await input.evaluate((node) => {
        const style = getComputedStyle(node);
        return (
          node.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight)
        );
      }),
    ).toBeGreaterThan(0);
  });
}

test('short TV layout keeps a complete guided channel row visible while searching at minimum panel width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'fixture.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '#EXTM3U\n#EXTINF:-1 tvg-id="CBS.us@HD" group-title="Sports",CBS Sports Golazo Network (720p)\nhttps://fixture.invalid/cbs\n',
    ),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  const divider = page.locator('#divider');
  await divider.focus();
  // Each key saves asynchronously; await its actual applied width before the next key.
  for (let index = 0; index < 18; index++) {
    const current = Number(await divider.getAttribute('aria-valuenow'));
    expect(Number.isFinite(current) && current >= 240 && current <= 600).toBe(true);
    await divider.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', String(Math.max(240, current - 20)));
    if (current <= 260) break;
  }
  await expect(divider).toHaveAttribute('aria-valuenow', '240');
  // Browser dimensions alone do not identify a television. Set the CSS fixture
  // after the desktop divider setup; Android capability detection is separate.
  await page.locator('#app').evaluate((root) => {
    root.dataset.deviceKind = 'tv';
  });
  await page.locator('#search').fill('CBS');
  await expect(page.locator('#search-programs')).toBeVisible();
  await expect(page.locator('#compact-filter')).toBeHidden();
  // One channel row: the categories are one button beside Favs, Loc & Sort and Guide.
  await expect(page.locator('#category-button')).toBeVisible();
  await expect(page.locator('.filters')).toBeHidden();
  const tops = await page
    .locator('.sidehead > :is(button, summary, details):visible')
    .evaluateAll(
      (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().top))).size,
    );
  expect(tops).toBe(1);
  const row = page.locator('.channel');
  await row.focus();
  expect(
    await row.evaluate((node) => {
      const r = node.getBoundingClientRect(),
        list = node.closest('#channel-list')!.getBoundingClientRect();
      return (
        r.height >= 44 &&
        r.top >= list.top &&
        r.bottom <= list.bottom &&
        node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      );
    }),
  ).toBe(true);
});

test('native Back honors a modal owner that still has work to settle', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  const dialog = page.locator('#settings-dialog');
  await dialog.evaluate((node) => {
    node.addEventListener('cancel', (event) => event.preventDefault(), { once: true });
    window.dispatchEvent(new Event('native-back-requested'));
  });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('native-back-requested')));
  await expect(dialog).not.toBeVisible();
});

test('shared saved-channel search stays in the left pane and Enter never tunes or acquires', async ({
  page,
}) => {
  let acquisitions = 0;
  await page.route('https://**', (route) => {
    acquisitions++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await seedSavedSearchChannels(page);
  const title = await page.locator('#watch-title').textContent();
  await page.locator('#search').fill('Chicago Bears');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('#channel-list .channel strong')).toHaveText(['Chicago Bears TV']);
  await expect(page.locator('#primary-view-host')).toBeHidden();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.locator('#live-tv-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#search')).toHaveValue('Chicago Bears');
  expect(await page.locator('#watch-title').textContent()).toBe(title);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  expect(acquisitions).toBe(0);
  await page.locator('#clear-search').click();
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await expect(page.locator('#channel-list')).toBeFocused();
});

test('guide controls remain reachable on a narrow phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const overflow = await page
    .locator('.topbar')
    .evaluate((bar) => bar.scrollWidth > bar.clientWidth);
  expect(overflow).toBe(false);
  // On a phone the Guide is in the Channels panel, beside the channels it covers.
  if (!(await page.locator('#guide-button').isVisible()))
    await page.locator('#compact-view').selectOption('channels');
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide' });
  await expect(guide).toBeVisible();
  const fits = await guide.evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth;
  });
  expect(fits).toBe(true);
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click();
});

for (const size of [
  { width: 320, height: 640 },
  { width: 960, height: 540 },
]) {
  test(`Guide program search remains reachable without tuning at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    let acquisitions = 0;
    await page.route('https://**', (route) => {
      acquisitions++;
      return route.abort();
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await seedSavedSearchChannels(page);
    const title = await page.locator('#watch-title').textContent();
    await page.locator('#search').fill('Chicago Bears');
    const { guide, input } = await openGuideProgramSearch(page, 'Chicago Bears');
    await expect(input).toHaveValue('Chicago Bears');
    const action = guide.getByRole('button', { name: 'Search programs', exact: true });
    const close = guide.getByRole('button', { name: 'Close guide', exact: true });
    for (const control of [input, action, close]) {
      await control.scrollIntoViewIfNeeded();
      expect(
        await control.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return (
            r.width >= 44 &&
            r.height >= 44 &&
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            (hit === node || (!!hit && node.contains(hit)))
          );
        }),
      ).toBe(true);
    }
    expect(await page.locator('#watch-title').textContent()).toBe(title);
    await expect(page.locator('#video')).toHaveJSProperty('paused', true);
    expect(acquisitions).toBe(0);
    await close.click();
    await expect(guide).not.toBeVisible();
    await expect(page.locator('#search')).toHaveValue('Chicago Bears');
    await expect(page.locator('#channel-list .channel strong')).toHaveText(['Chicago Bears TV']);
  });
}
