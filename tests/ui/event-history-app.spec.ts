import { test, expect } from '@playwright/test';
import { chooseSettingsSection } from './helpers/settings-section';

for (const viewport of [
  { width: 360, height: 640 },
  { width: 1280, height: 720 },
]) {
  test(`Event history unavailable feedback and close focus at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.locator('#settings-button').click();
    await chooseSettingsSection(page, 'sources');
    await chooseSettingsSection(page, 'advanced');
    const trigger = page.locator('#event-history-button');
    await trigger.click();
    const history = page.getByRole('dialog', { name: 'Event history', exact: true });
    const status = history.getByRole('status');
    await expect(history).toBeVisible();
    await expect(status).toHaveText('Event history could not be read. Retry Refresh.');
    await expect(history.getByRole('list', { name: 'Recent events' }).locator('li')).toHaveCount(0);
    await expect(history).not.toContainText(/https?:\/\/|plugin:|invoke|undefined|TypeError/);
    for (const label of ['Refresh history', 'Clear history', 'Close history']) {
      const button = history.getByRole('button', { name: label, exact: true });
      await expect(button).toBeEnabled();
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    }
    await history.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await expect(status).toHaveText('Event history could not be read. Retry Refresh.');
    await history.getByRole('button', { name: 'Clear history', exact: true }).click();
    await expect(status).toHaveText('Event history could not be cleared. Retry Clear.');
    await history.getByRole('button', { name: 'Close history', exact: true }).click();
    await expect(history).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await expect(history).toBeVisible();
    await expect(status).toHaveText('Event history could not be read. Retry Refresh.');
    await page.keyboard.press('Escape');
    await expect(history).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.locator('#settings-dialog')).toBeVisible();
  });
}
