import { expect, type Page } from '@playwright/test';

/** Follow the same inline section choices as a user. */
export async function chooseSettingsSection(page: Page, section: string): Promise<void> {
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await page.locator(`button[data-settings-section="${section}"]`).click();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`section[data-settings-panel="${section}"]`)).toBeVisible();
}
