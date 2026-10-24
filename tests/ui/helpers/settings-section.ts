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

/** Follow the same inline section choices as a user. */
export async function chooseSettingsSection(page: Page, section: string): Promise<void> {
  const control = page.getByRole('button', { name: 'Settings section', exact: true });
  await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await page.locator(`button[data-settings-section="${section}"]`).click();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`section[data-settings-panel="${section}"]`)).toBeVisible();
}
