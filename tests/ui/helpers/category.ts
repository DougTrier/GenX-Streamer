import { expect, type Page } from '@playwright/test';

/**
 * Chooses a channel category as the layout offers it: TV and Windows fold
 * All | Movies | News | Sports into one button in the channel row
 * (category-menu.ts); phones keep the "All channels" menu.
 */
export async function chooseCategory(page: Page, name: 'All' | 'Movies' | 'News' | 'Sports') {
  const trigger = page.locator('#category-button');
  if (await trigger.isVisible()) {
    await trigger.click();
    await expect(page.locator('.filters')).toBeVisible();
  }
  await page.locator('.filters').getByRole('button', { name, exact: true }).click();
}
