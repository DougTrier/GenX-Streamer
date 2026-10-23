import { chooseSettingsSection } from './helpers/settings-section';
import { test, expect, type Page } from '@playwright/test';
async function mount(page: Page) {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => {
    const inputPath = '/src/discovery/page-input.ts';
    const uiPath = '/src/ui/website-discovery.ts';
    const { createPageInput } = await import(inputPath);
    const { mountWebsiteDiscovery } = await import(uiPath);
    const input = createPageInput();
    const container = document.createElement('section');
    document.body.append(container);
    const calls: Array<{ url: string; label: string; allowHttp: boolean }> = [];
    const mounted = mountWebsiteDiscovery(container, {
      inspect: (url: string, allowHttp: boolean, signal: AbortSignal) =>
        input.inspect(url, allowHttp, signal),
      reviewSource: (url: string, label: string, allowHttp: boolean) => {
        calls.push({ url, label, allowHttp });
      },
    });
    Reflect.set(window, 'websiteFixture', { calls, mounted, input });
    mounted.open();
  });
}

test('source finder explains review, prefills without scanning and returns focus after Back', async ({
  page,
}) => {
  let requests = 0;
  await page.route('https://prefill.invalid/**', (route) => {
    requests++;
    return route.fulfill({ body: '<a href="/catalog">Possible source</a>' });
  });
  await mount(page);
  const dialog = page.getByRole('dialog', { name: 'Find sources on a website', exact: true });
  await dialog.getByRole('button', { name: 'Close source finder', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Find sources', exact: true });
  await trigger.click();
  await page.evaluate(() =>
    Reflect.get(window, 'websiteFixture').mounted.open('https://prefill.invalid/page'),
  );
  await expect(dialog.getByLabel('Website URL', { exact: true })).toHaveValue(
    'https://prefill.invalid/page',
  );
  await expect(dialog).toContainText('Select a source, review its channels, and Save');
  await expect(dialog).toContainText('Only this page is scanned; linked pages are not crawled.');
  await expect(dialog.getByRole('heading')).toHaveText('Find sources');
  expect(requests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.evaluate(async () => {
    await Reflect.get(window, 'websiteFixture').mounted.dispose();
    await Reflect.get(window, 'websiteFixture').input.cancel();
  });
});
test('real browser input and worker produce paged inert references and explicit source draft handoff', async ({
  page,
}) => {
  let subresources = 0;
  await page.route('**/fixture-script', (route) => {
    subresources++;
    return route.fulfill({ body: 'window.websiteExecuted=true;' });
  });
  await page.route('**/fixture-image', (route) => {
    subresources++;
    return route.fulfill({ body: '' });
  });
  await page.route('**/website-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><script src="/fixture-script"></script><img src="/fixture-image"><script>window.websiteExecuted=true</script>${Array.from({ length: 55 }, (_, n) => `<a href="/source-${n}?token=keep#fragment">Provider ${n}</a>`).join('')}</html>`,
    }),
  );
  await mount(page);
  const dialog = page.getByRole('dialog', { name: 'Find sources on a website' });
  await dialog
    .getByLabel('Website URL', { exact: true })
    .fill('http://127.0.0.1:1420/website-fixture');
  await dialog.getByRole('checkbox', { name: /Allow unencrypted HTTP/ }).check();
  await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('55 possible sources found');
  await expect(dialog.getByLabel('Possible sources').locator('li')).toHaveCount(50);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 640 });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const scroll = await dialog
      .getByLabel('Possible sources')
      .evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight }));
    expect(scroll.height).toBeGreaterThan(0);
    expect(scroll.scroll).toBeGreaterThan(scroll.height);
  }
  expect(subresources).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, 'websiteExecuted'))).toBeUndefined();
  expect(await page.evaluate(() => Reflect.get(window, 'websiteFixture').calls)).toEqual([]);
  await dialog.getByLabel('Source finding action').selectOption('next');
  await dialog.getByRole('button', { name: 'Run action' }).click();
  await expect(dialog.getByLabel('Possible sources').locator('li')).toHaveCount(5);
  await dialog.getByLabel('Select source Provider 54', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Review selected source', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'websiteFixture').calls)).toEqual([
    { url: 'http://127.0.0.1:1420/source-54?token=keep', label: 'Provider 54', allowHttp: true },
  ]);
  await page.evaluate(async () => {
    await Reflect.get(window, 'websiteFixture').mounted.dispose();
    await Reflect.get(window, 'websiteFixture').input.cancel();
  });
});
test('unsupported script-only pages show actionable results and changed input invalidates reviewed choices', async ({
  page,
}) => {
  await page.route('**/website-empty', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><script>fetch("/hidden-stream")</script></html>',
    }),
  );
  await page.route('**/website-one', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><a href="/explicit-source">Source</a></html>',
    }),
  );
  await mount(page);
  const dialog = page.getByRole('dialog', { name: 'Find sources on a website' });
  await dialog
    .getByLabel('Website URL', { exact: true })
    .fill('http://127.0.0.1:1420/website-empty');
  await dialog.getByRole('checkbox', { name: /Allow unencrypted HTTP/ }).check();
  await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('explicit source URL');
  await expect(dialog.locator('button[aria-label="Review selected source"]')).toBeDisabled();
  await dialog.getByLabel('Website URL', { exact: true }).fill('http://127.0.0.1:1420/website-one');
  await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
  await dialog.getByLabel('Select source Source', { exact: true }).check();
  await expect(
    dialog.getByRole('button', { name: 'Review selected source', exact: true }),
  ).toBeEnabled();
  await dialog.getByLabel('Source finding action').selectOption('rescan');
  await dialog.getByRole('button', { name: 'Run action' }).click();
  await dialog.getByRole('checkbox', { name: /Allow unencrypted HTTP/ }).uncheck();
  await expect(dialog.locator('button[aria-label="Review selected source"]')).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, 'websiteFixture').calls)).toEqual([]);
});
test('application Settings hands a selected website reference to source scan without publishing channels', async ({
  page,
}) => {
  await page.route('**/website-app', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><a href="/source-app?token=keep">Reviewed provider</a></html>',
    }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await chooseSettingsSection(page, 'discovery');
  await page
    .locator('[data-settings-panel="discovery"]')
    .getByRole('button', { name: 'Find sources', exact: true })
    .click();
  const website = page.getByRole('dialog', { name: 'Find sources on a website' });
  await website
    .getByLabel('Website URL', { exact: true })
    .fill('http://127.0.0.1:1420/website-app');
  await website.getByRole('checkbox', { name: /Allow unencrypted HTTP/ }).check();
  await website.getByRole('button', { name: 'Scan website', exact: true }).click();
  await website.getByLabel('Select source Reviewed provider', { exact: true }).check();
  await website.getByRole('button', { name: 'Review selected source', exact: true }).click();
  await expect(website).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  await expect(page.locator('#source-status')).toHaveText('0 playlists saved');
});
