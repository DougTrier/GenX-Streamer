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

import { expect, test } from '@playwright/test';

test('ZIP settings start blank, preserve leading zeroes across reload and override IP suggestions', async ({
  page,
}) => {
  await page.route('https://api.zippopotam.us/us/00501', (route) =>
    route.fulfill({
      json: { 'country abbreviation': 'US', places: [{ 'state abbreviation': 'NY' }] },
    }),
  );
  await page.route('https://ipapi.co/json/', (route) =>
    route.fulfill({ json: { country_code: 'GB', region_code: 'ENG', ip: '203.0.113.1' } }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await expect(page.getByLabel('ZIP / postal code', { exact: true })).toHaveValue('');
  await page.getByLabel('Region country', { exact: true }).selectOption('US');
  await page.getByLabel('ZIP / postal code', { exact: true }).fill('00501');
  await page.getByRole('button', { name: 'Save region', exact: true }).click();
  await expect(page.locator('#region-settings [role="status"]')).toContainText('US-NY');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await expect(page.getByLabel('ZIP / postal code', { exact: true })).toHaveValue('00501');
  await page.getByRole('button', { name: 'Suggest region from IP', exact: true }).click();
  await expect(page.getByLabel('Region country', { exact: true })).toHaveValue('US');
  await expect(page.getByLabel('ZIP / postal code', { exact: true })).toHaveValue('00501');
  await page.getByRole('button', { name: 'Clear region', exact: true }).click();
  await expect(page.getByLabel('ZIP / postal code', { exact: true })).toHaveValue('');
});

test('an unavailable postal lookup retains the previous region and leaves controls usable', async ({
  page,
}) => {
  await page.route('https://api.zippopotam.us/**', (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await page.getByLabel('Region country', { exact: true }).selectOption('UK');
  await page.getByRole('button', { name: 'Save region', exact: true }).click();
  await expect(page.locator('#region-settings [role="status"]')).toContainText('UK first');
  await page.getByLabel('ZIP / postal code', { exact: true }).fill('bad');
  await page.getByRole('button', { name: 'Save region', exact: true }).click();
  await expect(page.locator('#region-settings [role="status"]')).toContainText(
    'could not be saved',
  );
  await expect(page.getByRole('button', { name: 'Save region', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await expect(page.getByLabel('Region country', { exact: true })).toHaveValue('UK');
  await expect(page.getByLabel('ZIP / postal code', { exact: true })).toHaveValue('');
});
