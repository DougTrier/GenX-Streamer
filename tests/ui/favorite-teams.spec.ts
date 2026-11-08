// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { chooseSettingsSection } from './helpers/settings-section';

test('follows teams at different levels, adds a custom team and keeps its priority after restart', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  const search = page.getByLabel('Search teams');
  for (const [query, name] of [
    ['chicago bears', 'Chicago Bears'],
    ['bradley womens basketball', 'Bradley Braves'],
    ['chicago house semi pro', 'Chicago House AC'],
    ['pekin football', 'Pekin Dragons'],
  ]) {
    await search.fill(query);
    await page.getByRole('button', { name: new RegExp(`^Follow ${name}`) }).click();
    await expect(page.getByRole('list', { name: 'Followed teams' })).toContainText(name);
  }
  await page.getByRole('button', { name: 'Add team manually' }).click();
  await page.getByLabel('Team, school or club name').fill('Central Eagles');
  await page.getByRole('textbox', { name: 'Sport', exact: true }).fill('Girls Volleyball');
  await page.getByLabel('City or region').fill('Springfield, IL');
  await page.getByLabel('Competition level').fill('High school');
  await page.getByLabel('Official schedule URL (optional)').fill('https://school.example/schedule');
  await page.getByRole('button', { name: 'Save team', exact: true }).click();
  const teams = page.getByRole('list', { name: 'Followed teams' });
  await expect(teams.getByRole('listitem')).toHaveCount(5);
  await page.getByRole('button', { name: 'Move up Central Eagles', exact: true }).click();
  await expect(teams.locator('strong')).toHaveText([
    'Chicago Bears',
    'Bradley Braves',
    'Chicago House AC',
    'Central Eagles',
    'Pekin Dragons',
  ]);

  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  await page.getByRole('button', { name: 'View My Teams', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'My Teams', exact: true });
  await expect(view.locator('strong')).toHaveText([
    'Chicago Bears',
    'Bradley Braves',
    'Chicago House AC',
    'Central Eagles',
    'Pekin Dragons',
  ]);
  await expect(view.getByText(/Girls Volleyball.*Springfield, IL.*High school/)).toBeVisible();
  await view.getByRole('button', { name: 'Manage Favorite Teams' }).click();
  await page.getByRole('button', { name: /^Edit Central Eagles/ }).click();
  await expect(page.getByLabel('Official schedule URL (optional)')).toHaveValue(
    'https://school.example/schedule',
  );
  await page.getByLabel('Team, school or club name').fill('Central High Eagles');
  await page.getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(teams).toContainText('Central High Eagles');
  await page.getByRole('button', { name: /^Remove Central High Eagles/ }).click();
  await expect(teams.getByRole('listitem')).toHaveCount(4);
});
