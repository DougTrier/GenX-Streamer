import { test, expect } from '@playwright/test';
import { chooseSettingsSection } from './helpers/settings-section';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
});

test('section choices stay inside the one Settings dialog and preserve every section', async ({
  page,
}) => {
  const dialog = page.locator('#settings-dialog');
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  await expect(dialog.locator('select#settings-section')).toHaveCount(0);
  for (const section of [
    'sources',
    'advanced',
    'preferences',
    'data',
    'migration',
    'discovery',
    'sharing',
  ]) {
    await control.click();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(dialog.locator('#settings-section-choices')).toBeVisible();
    await expect(dialog.locator('section[data-settings-panel]:visible')).toHaveCount(0);
    await dialog.locator(`button[data-settings-section="${section}"]`).click();
    await expect(control).toBeFocused();
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.locator('section[data-settings-panel]:visible')).toHaveCount(1);
    await expect(dialog.locator(`section[data-settings-panel="${section}"]`)).toBeVisible();
  }
});

test('keyboard choices and Escape collapse first, then close Settings and restore its invoker', async ({
  page,
}) => {
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  await control.click();
  await page.keyboard.press('End');
  await expect(page.locator('button[data-settings-section="sharing"]')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('section[data-settings-panel="preferences"]')).toBeVisible();
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(control).toBeFocused();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
  await page.locator('#settings-button').click();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('section[data-settings-panel="preferences"]')).toBeVisible();
});

test('native Back cancellation collapses only the inline chooser before closing Settings', async ({
  page,
}) => {
  await chooseSettingsSection(page, 'data');
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  await control.click();
  // Exercise the exact cancellable dialog boundary used by the native Back handler.
  const first = await page
    .locator('#settings-dialog')
    .evaluate((dialog) => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(first).toBe(false);
  await expect(control).toBeFocused();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  const second = await page.locator('#settings-dialog').evaluate((dialog) => {
    const allowed = dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    if (allowed) (dialog as HTMLDialogElement).close();
    return allowed;
  });
  expect(second).toBe(true);
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
});

for (const size of [
  { width: 320, height: 640 },
  { width: 640, height: 360 },
]) {
  test(`inline chooser contains 200% text at ${size.width}x${size.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.getByRole('button', { name: 'Settings section', exact: true }).click();
    const dialog = page.locator('#settings-dialog');
    await expect(page.locator('#settings-section-choices')).toBeVisible();
    const geometry = await dialog.evaluate((element) => {
      const choices = element.querySelector<HTMLElement>('#settings-section-choices')!;
      const bounds = element.getBoundingClientRect();
      const box = choices.getBoundingClientRect();
      return {
        outerScroll: element.scrollHeight - element.clientHeight,
        top: box.top,
        bottom: box.bottom,
        dialogTop: bounds.top,
        dialogBottom: bounds.bottom,
      };
    });
    expect(geometry.outerScroll).toBeLessThanOrEqual(1);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.dialogTop);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.dialogBottom);
    for (const id of ['settings-section', 'exit-button']) {
      const bounds = await page.locator(`#${id}`).boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await page.locator('button[data-settings-section="sharing"]').scrollIntoViewIfNeeded();
    await expect(page.locator('button[data-settings-section="sharing"]')).toBeInViewport();
    await testInfo.attach(`inline-chooser-${size.width}x${size.height}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Settings section', exact: true })).toBeFocused();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#settings-button')).toBeFocused();
  });
}

test('D-pad leaves the closed selector without opening choices; OK explicitly opens them', async ({
  page,
}) => {
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  // Choosing a section restores actual user focus to the closed selector.
  await chooseSettingsSection(page, 'discovery');
  await expect(control).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('section[data-settings-panel="discovery"]')).toBeVisible();
  await expect(control).not.toBeFocused();
  await control.click();
  await page.keyboard.press('Escape');
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('button[data-settings-section="discovery"]')).toBeFocused();
});
