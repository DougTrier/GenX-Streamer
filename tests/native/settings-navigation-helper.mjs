import { expect } from '@playwright/test';

/** Exercise the in-application Settings menu; never use an OS select popup. */
export async function chooseSettingsSection(page, section) {
  if (
    !['sources', 'advanced', 'preferences', 'data', 'migration', 'discovery', 'sharing'].includes(
      section,
    )
  )
    throw new Error('Unknown Settings section.');
  const dialog = page.locator('#settings-dialog');
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole('button', { name: 'Settings section', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const choice = dialog.locator(`button[data-settings-section="${section}"]`);
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.locator(`[data-settings-panel="${section}"]`)).toBeVisible();
}

/** Open Settings > Sources > Import from whatever state the app is in. */
export async function openSourceImport(page) {
  const importButton = page.locator('#import-button');
  if (!(await importButton.isVisible())) {
    if (!(await page.locator('#settings-dialog').isVisible()))
      await page.locator('#settings-button').click();
    await chooseSettingsSection(page, 'sources');
  }
  await importButton.click();
}
