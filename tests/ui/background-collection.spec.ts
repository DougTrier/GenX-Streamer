import { expect, test, type Page } from '@playwright/test';

interface Fixture {
  mounted: { suspend(): Promise<void>; open(): void; dispose(): Promise<void> };
  blocked: boolean;
  signal: AbortSignal | null;
  release: () => void;
  settled: boolean;
  calls: number;
}

async function mount(page: Page, kind: 'source' | 'website'): Promise<void> {
  await page.route('**/background-collection-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"><link rel="stylesheet" href="/src/ui/guide.css"><link rel="stylesheet" href="/src/ui/responsive.css"></head><body></body></html>',
    }),
  );
  await page.goto('/background-collection-fixture');
  await page.evaluate(async (kind) => {
    const container = document.createElement('section');
    document.body.append(container);
    const fixture: Fixture = {
      mounted: null!,
      blocked: false,
      signal: null,
      release: () => {},
      settled: false,
      calls: 0,
    };
    const wait = async (signal: AbortSignal) => {
      fixture.signal = signal;
      fixture.calls++;
      if (fixture.blocked)
        await new Promise<void>((resolve) => {
          fixture.release = resolve;
        });
    };
    if (kind === 'source') {
      const path = '/src/ui/source-scan.ts';
      const { mountSourceScan } = await import(path);
      const source = {
        id: 'fixture',
        name: 'Fixture',
        kind: 'url',
        location: 'https://fixture.invalid/list',
      };
      fixture.mounted = mountSourceScan(container, {
        capture: () => ({ revision: '1', sources: [{ source, fingerprint: 'f' }] }),
        revision: () => '1',
        collect: async (_source: unknown, signal: AbortSignal) => {
          await wait(signal);
          return {
            channels: [
              {
                sourceId: 'fixture',
                name: fixture.blocked ? 'Late replacement' : 'Reviewed channel',
                category: 'News',
                urls: ['https://fixture.invalid/media'],
              },
            ],
            warnings: [],
          };
        },
        commit: async (_staged: unknown, _revision: string, signal: AbortSignal) => {
          await wait(signal);
          return { committed: true, revision: '2' };
        },
      });
    } else {
      const path = '/src/ui/website-discovery.ts';
      const { mountWebsiteDiscovery } = await import(path);
      fixture.mounted = mountWebsiteDiscovery(container, {
        inspect: async (_url: string, _allow: boolean, signal: AbortSignal) => {
          await wait(signal);
          return {
            candidates: [
              {
                id: 'reference',
                url: 'https://fixture.invalid/list',
                label: fixture.blocked ? 'Late replacement' : 'Reviewed reference',
                role: 'link',
                pageUrl: 'https://fixture.invalid/page',
              },
            ],
          };
        },
        reviewSource: async () => {},
      });
    }
    Reflect.set(window, 'collectionFixture', fixture);
    fixture.mounted.open();
  }, kind);
}

async function suspend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'collectionFixture') as Fixture;
    fixture.settled = false;
    void fixture.mounted.suspend().then(() => {
      fixture.settled = true;
    });
  });
}

test('source suspension joins canceled acquisition, preserves choices and remains reusable', async ({
  page,
}) => {
  await mount(page, 'source');
  await page.getByRole('button', { name: 'Scan configured sources', exact: true }).click();
  await page.getByText('Advanced', { exact: true }).click();
  const selected = page.getByRole('checkbox', { name: 'Select Reviewed channel', exact: true });
  await selected.check();
  await page.evaluate(() => {
    (Reflect.get(window, 'collectionFixture') as Fixture).blocked = true;
  });
  await page.getByRole('button', { name: 'Scan configured sources', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).calls))
    .toBe(2);
  await suspend(page);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'collectionFixture') as Fixture).signal?.aborted,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).settled),
  ).toBe(false);
  await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).release());
  await expect(selected).toBeChecked();
  await expect(page.getByRole('status').last()).toContainText('background');
  await expect(page.getByText('Late replacement', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    (Reflect.get(window, 'collectionFixture') as Fixture).blocked = false;
  });
  await page.getByRole('button', { name: 'Scan configured sources', exact: true }).click();
  await expect(selected).toBeVisible();
});

test('source suspension waits an active durable save without aborting it', async ({ page }) => {
  await mount(page, 'source');
  await page.getByRole('button', { name: 'Scan configured sources', exact: true }).click();
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Reviewed channel', exact: true }).check();
  await page.evaluate(() => {
    (Reflect.get(window, 'collectionFixture') as Fixture).blocked = true;
  });
  await page.getByRole('button', { name: 'Save selected channels', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).calls))
    .toBe(2);
  await suspend(page);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'collectionFixture') as Fixture).signal?.aborted,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).settled),
  ).toBe(false);
  await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).release());
  await expect(page.getByRole('status').last()).toHaveText('Selected channels saved.');
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).settled))
    .toBe(true);
});

test('website suspension joins late inspection and requires explicit retry', async ({ page }) => {
  await mount(page, 'website');
  const dialog = page.getByRole('dialog', { name: 'Find sources on a website' });
  await dialog.getByLabel('Website URL', { exact: true }).fill('https://fixture.invalid/page');
  await page.evaluate(() => {
    (Reflect.get(window, 'collectionFixture') as Fixture).blocked = true;
  });
  await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).calls))
    .toBe(1);
  await suspend(page);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'collectionFixture') as Fixture).signal?.aborted,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).settled),
  ).toBe(false);
  await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).release());
  await expect(dialog.getByRole('status')).toContainText('background');
  await expect(dialog.getByText('Late replacement', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    (Reflect.get(window, 'collectionFixture') as Fixture).blocked = false;
  });
  expect(
    await page.evaluate(() => (Reflect.get(window, 'collectionFixture') as Fixture).calls),
  ).toBe(1);
  await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1 possible sources found');
});
