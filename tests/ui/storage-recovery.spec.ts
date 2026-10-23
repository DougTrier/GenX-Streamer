import { expect, test, type Page } from '@playwright/test';

type Mode = 'windows' | 'busy' | 'environment' | 'android' | 'browser' | 'malformed';
async function mount(page: Page, mode: Mode = 'windows') {
  await page.route('**/storage-recovery-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"><link rel="stylesheet" href="/src/ui/guide.css"><link rel="stylesheet" href="/src/ui/responsive.css"></head><body></body></html>',
    }),
  );
  await page.goto('/storage-recovery-fixture');
  await page.evaluate(async (kind) => {
    const modulePath = '/src/ui/storage-recovery.ts';
    const { mountStorageRecovery } = (await import(
      modulePath
    )) as typeof import('../../src/ui/storage-recovery');
    const fixture = {
      choices: [] as string[],
      retries: 0,
      exits: 0,
      pendingChoice: null as (() => void) | null,
      holdChoice: false,
      failChoice: false,
      failRetry: false,
      disposeOnRetry: false,
      mounted: null as ReturnType<typeof mountStorageRecovery> | null,
    };
    fixture.mounted = mountStorageRecovery({
      status: async () =>
        kind === 'malformed'
          ? ({
              platform: 'windows',
              available: 'yes',
            } as unknown as import('../../src/ui/storage-recovery').StorageRecoveryStatus)
          : {
              platform: kind === 'environment' || kind === 'busy' ? 'windows' : kind,
              available: kind === 'windows' || kind === 'busy',
              state: 'failed',
              errorCategory: kind === 'busy' ? 'busy' : undefined,
              explicitEnvironment: kind === 'environment',
            },
      choose: async (path) => {
        fixture.choices.push(path);
        if (fixture.holdChoice)
          await new Promise<void>((resolve) => {
            fixture.pendingChoice = resolve;
          });
        if (fixture.failChoice) throw new Error('fixture directory refused');
        return { dataMode: 'explicit-directory', restartPersistent: true };
      },
      retry: async () => {
        fixture.retries++;
        if (fixture.failRetry) throw new Error('fixture storage failure');
        if (fixture.disposeOnRetry) fixture.mounted?.dispose();
      },
      exit: async () => {
        fixture.exits++;
      },
    });
    Reflect.set(window, 'storageFixture', fixture);
  }, mode);
  await expect(page.getByRole('dialog', { name: 'Saved data needs attention' })).toBeVisible();
}

async function counts(page: Page) {
  return page.evaluate(() => {
    const fixture = Reflect.get(window, 'storageFixture');
    return { choices: fixture.choices, retries: fixture.retries, exits: fixture.exits };
  });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => Reflect.get(window, 'storageFixture')?.mounted?.dispose());
});

test('explicit writable Windows directory choice retries only after committed receipt', async ({
  page,
}) => {
  await mount(page);
  await page.getByLabel('Writable data folder').fill('C:\\Fixture Data');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await counts(page)).toEqual({ choices: ['C:\\Fixture Data'], retries: 1, exits: 0 });
});

test('failed folder choice preserves recovery and existing-data guidance; explicit retry is available', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'storageFixture').failChoice = true;
  });
  await page.getByLabel('Writable data folder').fill('C:\\Refused Fixture');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Previous data remains intact');
  expect((await counts(page)).retries).toBe(0);
  await page.getByRole('button', { name: 'Retry saved data' }).click();
  expect((await counts(page)).retries).toBe(1);
});

test('malformed initial status exposes safe retry without offering a directory mutation', async ({
  page,
}) => {
  await mount(page, 'malformed');
  await expect(page.getByRole('status')).toContainText('status is unavailable');
  await expect(page.getByLabel('Writable data folder')).toBeHidden();
  await page.getByRole('button', { name: 'Retry saved data' }).click();
  expect(await counts(page)).toEqual({ choices: [], retries: 1, exits: 0 });
});

test('locked library offers retry guidance without implying corruption or changing its folder', async ({
  page,
}) => {
  await mount(page, 'busy');
  await expect(page.getByRole('status')).toContainText('Saved data is in use.');
  await expect(page.getByRole('status')).toContainText('Your library has not been replaced.');
  await expect(page.getByLabel('Writable data folder')).toBeHidden();
  await page.evaluate(() => {
    Reflect.get(window, 'storageFixture').failRetry = true;
  });
  await page.getByRole('button', { name: 'Retry saved data' }).click();
  await expect(page.getByRole('status')).toContainText('Close other apps using this library');
  await expect(page.getByRole('status')).not.toContainText('choose another');
  await expect(page.getByRole('button', { name: 'Retry saved data' })).toBeEnabled();
  expect(await counts(page)).toEqual({ choices: [], retries: 1, exits: 0 });
});

test('Retry failure remains actionable and successful host initialization removes recovery', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'storageFixture').failRetry = true;
  });
  await page.getByRole('button', { name: 'Retry saved data' }).click();
  await expect(page.getByRole('status')).toContainText('still could not open');
  await expect(page.getByRole('button', { name: 'Retry saved data' })).toBeEnabled();
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'storageFixture');
    fixture.failRetry = false;
    fixture.disposeOnRetry = true;
  });
  await page.getByRole('button', { name: 'Retry saved data' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await counts(page)).retries).toBe(2);
});

test('explicit environment location refuses a silently substituted directory', async ({ page }) => {
  await mount(page, 'environment');
  await expect(page.getByRole('status')).toContainText('TMG_DATA_DIR');
  await expect(page.getByLabel('Writable data folder')).toBeHidden();
  expect((await counts(page)).choices).toEqual([]);
});

for (const mode of ['android', 'browser'] as const) {
  test(`${mode} recovery retains platform guidance and no Windows directory chooser`, async ({
    page,
  }) => {
    await mount(page, mode);
    await expect(page.getByRole('status')).toContainText(
      mode === 'android' ? 'Do not clear its data' : 'close other GenX Streamer tabs',
    );
    await expect(page.getByLabel('Writable data folder')).toBeHidden();
    if (mode === 'browser')
      await expect(page.getByRole('button', { name: 'Exit app' })).toBeHidden();
    else await expect(page.getByRole('button', { name: 'Exit app' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry saved data' }).click();
    expect((await counts(page)).retries).toBe(1);
  });
}

test('repeated submitted form keeps a single pending directory owner', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'storageFixture').holdChoice = true;
  });
  await page.getByLabel('Writable data folder').fill('C:\\Owned Fixture');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.locator('.storage-recovery-dialog form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  expect(await counts(page)).toEqual({ choices: ['C:\\Owned Fixture'], retries: 0, exits: 0 });
  await page.evaluate(() => Reflect.get(window, 'storageFixture').pendingChoice());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await counts(page)).retries).toBe(1);
});

for (const end of ['exit', 'dispose'] as const) {
  test(`${end} during pending choice prevents late retry from an obsolete UI`, async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
      Reflect.get(window, 'storageFixture').holdChoice = true;
    });
    await page.getByLabel('Writable data folder').fill('C:\\Pending Fixture');
    await page.getByRole('button', { name: 'Use this folder' }).click();
    if (end === 'exit') await page.getByRole('button', { name: 'Exit app' }).click();
    else await page.evaluate(() => Reflect.get(window, 'storageFixture').mounted.dispose());
    await page.evaluate(async () => {
      Reflect.get(window, 'storageFixture').pendingChoice();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect((await counts(page)).retries).toBe(0);
    expect((await counts(page)).exits).toBe(end === 'exit' ? 1 : 0);
  });
}

test('Escape cannot dismiss startup recovery into an inert viewing shell', async ({ page }) => {
  await mount(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await counts(page)).toEqual({ choices: [], retries: 0, exits: 0 });
});

for (const size of [
  { width: 320, height: 640 },
  { width: 640, height: 360 },
]) {
  test(`storage recovery ${size.width}x${size.height} 200% text keeps footer reachable and form internally scrollable`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await mount(page);
    const dialog = page.getByRole('dialog');
    await expect(page.getByLabel('Writable data folder')).toBeVisible();
    await dialog.evaluate((element) => {
      const snapshot = [element, ...element.querySelectorAll<HTMLElement>('*')].map((node) => ({
        node: node as HTMLElement,
        font: Number.parseFloat(getComputedStyle(node).fontSize),
      }));
      for (const { node, font } of snapshot) node.style.fontSize = `${font * 2}px`;
    });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    expect(
      await dialog.evaluate(
        (element) =>
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1,
      ),
    ).toBe(false);
    for (const name of ['Retry saved data', 'Exit app']) {
      const button = page.getByRole('button', { name });
      const issues = await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          outside: box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight,
          clipped:
            text.left < box.left - 1 ||
            text.right > box.right + 1 ||
            text.top < box.top - 1 ||
            text.bottom > box.bottom + 1,
          hit: !!hit && element.contains(hit),
        };
      });
      expect(issues).toEqual({ outside: false, clipped: false, hit: true });
    }
    await page.getByLabel('Writable data folder').fill('C:\\Enlarged Fixture');
    await page.getByRole('button', { name: 'Use this folder' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Use this folder' }).click();
    await expect(dialog).toHaveCount(0);
  });
}
