import { expect, test, type Page } from '@playwright/test';

interface TransferFixture {
  remove: (() => Promise<void>) & { suspend(): Promise<void> };
  release(): void;
  mode: 'normal' | 'capture' | 'commit';
  captures: number;
  commits: number;
  settled: boolean;
  failure: string | null;
  text: string;
  urls: number;
  timers: number;
  failRevoke: boolean;
}
async function mount(page: Page): Promise<void> {
  await page.route('**/transfer-cleanup-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"></head><body><button id="backup-export">Export</button><input id="backup-file" type="file"/><input id="legacy-file" type="file"/><input id="legacy-source-name"/><input id="legacy-allow-http" type="checkbox"/><dialog id="transfer-dialog"><p id="transfer-status" role="status"></p><button id="transfer-apply">Apply</button><button id="transfer-cancel">Cancel</button></dialog></body></html>',
    }),
  );
  await page.goto('/transfer-cleanup-fixture');
  await page.evaluate(async () => {
    const ui = '/src/ui/data-transfer.ts',
      data = '/src/data-transfer/index.ts',
      prefs = '/src/preferences/index.ts';
    const { installDataTransfer } = await import(ui);
    const { createBackup, serializeBackup } = await import(data);
    const { defaultPreferences } = await import(prefs);
    const backup = createBackup(
      { schemaVersion: 1, sources: [], channels: [] },
      defaultPreferences(),
    );
    const fixture: TransferFixture = {
      remove: null!,
      release: () => {},
      mode: 'normal',
      captures: 0,
      commits: 0,
      settled: false,
      failure: null,
      text: serializeBackup(backup),
      urls: 0,
      timers: 0,
      failRevoke: false,
    };
    const urls = new Set<string>(),
      timers = new Set<number>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      fixture.urls = urls.size;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (fixture.failRevoke) {
        fixture.failRevoke = false;
        throw new Error('private fixture error');
      }
      revoke(url);
      urls.delete(url);
      fixture.urls = urls.size;
    };
    const schedule = window.setTimeout.bind(window),
      clear = window.clearTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, duration?: number, ...args: unknown[]) => {
      const id = schedule(handler, duration, ...args);
      if (duration === 1000) {
        timers.add(id);
        fixture.timers = timers.size;
      }
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id) => {
      clear(id);
      if (typeof id === 'number') timers.delete(id);
      fixture.timers = timers.size;
    };
    fixture.remove = installDataTransfer({
      capture: async () => {
        fixture.captures++;
        if (fixture.mode === 'capture')
          await new Promise<void>((resolve) => {
            fixture.release = resolve;
          });
        return backup;
      },
      commit: async () => {
        fixture.commits++;
        if (fixture.mode === 'commit')
          await new Promise<void>((resolve) => {
            fixture.release = resolve;
          });
      },
      busy: () => {},
      available: () => true,
      notice: () => {},
    });
    Reflect.set(window, 'transferCleanupFixture', fixture);
  });
}
async function remove(page: Page) {
  await page.evaluate(() => {
    const f = Reflect.get(window, 'transferCleanupFixture') as TransferFixture;
    f.settled = false;
    f.failure = null;
    void f.remove().then(
      () => {
        f.settled = true;
      },
      (error: unknown) => {
        f.failure = error instanceof Error ? error.message : 'failed';
      },
    );
  });
}

test('transfer disposal waits actual capture settlement and suppresses late export', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).mode = 'capture';
  });
  await page.locator('#backup-export').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
      ),
    )
    .toBe(1);
  await remove(page);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
    ),
  ).toBe(false);
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).urls,
    ),
  ).toBe(0);
  await page.locator('#backup-export').click();
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
    ),
  ).toBe(1);
  await remove(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
});

test('transfer disposal joins a crossed commit and ordinary cancel stays reusable', async ({
  page,
}) => {
  await mount(page);
  const text = await page.evaluate(
    () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).text,
  );
  const file = { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) };
  await page.locator('#backup-file').setInputFiles(file);
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.locator('#transfer-cancel').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  await page.locator('#backup-file').setInputFiles(file);
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).mode = 'commit';
  });
  await page.locator('#transfer-apply').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).commits,
      ),
    )
    .toBe(1);
  await remove(page);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
    ),
  ).toBe(false);
  await expect(page.locator('#transfer-dialog')).toBeVisible();
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).commits,
    ),
  ).toBe(1);
});

test('download cleanup clears its timer, retains failed URL revocation and retries honestly', async ({
  page,
}) => {
  // Freeze the page clock so the one-second revoke cannot race explicit cleanup.
  await page.clock.install();
  await mount(page);
  const download = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  await download;
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).failRevoke = true;
  });
  await remove(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).failure,
      ),
    )
    .toContain('cleanup did not finish');
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).urls,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).timers,
    ),
  ).toBe(0);
  await remove(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).urls,
    ),
  ).toBe(0);
});

test('background suspension joins late capture without exporting and permits only explicit retry', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).mode = 'capture';
  });
  await page.locator('#backup-export').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'transferCleanupFixture') as TransferFixture;
    void fixture.remove.suspend().then(() => {
      fixture.settled = true;
    });
  });
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
    ),
  ).toBe(false);
  await page.locator('#backup-export').click();
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
    ),
  ).toBe(1);
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).urls,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).mode = 'normal';
  });
  const download = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  await download;
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).captures,
    ),
  ).toBe(2);
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).remove(),
  );
});

test('background suspension preserves a completed review and joins its admitted commit', async ({
  page,
}) => {
  await mount(page);
  const text = await page.evaluate(
    () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).text,
  );
  await page.locator('#backup-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).remove.suspend(),
  );
  await expect(page.locator('#transfer-dialog')).toBeVisible();
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.evaluate(() => {
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).mode = 'commit';
  });
  await page.locator('#transfer-apply').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).commits,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'transferCleanupFixture') as TransferFixture;
    void fixture.remove.suspend().then(() => {
      fixture.settled = true;
    });
  });
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
    ),
  ).toBe(false);
  await expect(page.locator('#transfer-dialog')).toBeVisible();
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).settled,
      ),
    )
    .toBe(true);
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  expect(
    await page.evaluate(
      () => (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).commits,
    ),
  ).toBe(1);
  await page.evaluate(() =>
    (Reflect.get(window, 'transferCleanupFixture') as TransferFixture).remove(),
  );
});
