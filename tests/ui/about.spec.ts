import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const packageInfo = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
});

test('About shows build version and quick guide; Escape returns to its settings opener', async ({
  page,
}) => {
  await page.locator('#settings-button').click();
  await page.locator('#about-button').click();
  const about = page.getByRole('dialog', { name: 'About GenX Streamer', exact: true });
  await expect(about).toBeVisible();
  await expect(about.locator('#about-version')).toHaveText(
    `Version ${packageInfo.version} · Browser development preview`,
  );
  await expect(about).toContainText('Created by Doug Trier.');
  await expect(about).toContainText('If you enjoy the application, please support the project.');
  await expect(about.locator('ol li')).toHaveCount(8);
  expect(await page.locator('#video').evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(about).not.toBeVisible();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#about-button')).toBeFocused();
});

test('Support selects only the verified fixed destinations and never opens a link on mount', async ({
  page,
}) => {
  await page.evaluate(() => {
    Reflect.set(window, '__supportCalls', []);
    window.open = (...args) => {
      (Reflect.get(window, '__supportCalls') as unknown[][]).push(args);
      return null;
    };
  });
  await page.locator('#settings-button').click();
  await page.locator('#about-button').click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toEqual([]);
  const destinations = [
    ['GitHub Sponsors', 'https://github.com/sponsors/dougtrier'],
    ['Buy Me a Coffee', 'https://www.buymeacoffee.com/dougtrier'],
    ['Open Collective', 'https://opencollective.com/trier-os'],
  ];
  for (const [name] of destinations) await page.getByRole('button', { name, exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toEqual(
    destinations.map(([, url]) => [url, '_blank', 'noopener,noreferrer']),
  );
});

for (const viewport of [
  { width: 360, height: 480 },
  { width: 640, height: 360 },
  { width: 1280, height: 800 },
])
  test(`About keeps close and support controls reachable at ${viewport.width}x${viewport.height} with enlarged text`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addStyleTag({ content: 'body { font-size: 200%; } button { font-size: inherit; }' });
    await page.locator('#settings-button').click();
    await page.locator('#about-button').click();
    const dialog = page.locator('#about-dialog');
    const close = dialog.getByRole('button', { name: 'Close about' });
    const closeBounds = await close.boundingBox();
    expect(closeBounds).not.toBeNull();
    expect(closeBounds!.y).toBeGreaterThanOrEqual(0);
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(viewport.height);
    for (const label of ['GitHub Sponsors', 'Buy Me a Coffee', 'Open Collective']) {
      const button = dialog.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await close.click();
    await expect(dialog).not.toBeVisible();
  });
