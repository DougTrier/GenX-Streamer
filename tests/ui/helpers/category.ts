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
