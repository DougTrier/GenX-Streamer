import { expect, test, type Page } from '@playwright/test';
async function snapshot(page: Page) {
  return page.evaluate(() => Reflect.get(window, '__GENX_PRIMARY_TRANSITION__'));
}
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
}
// A Guide activation while the guide page is already up (the button is then
// hidden with its channel row) is dispatched: a quick double press before the
// page hides reaches the same transition queue.
async function readyWithHeldGuideRead(page: Page) {
  // Keep browser startup/storage, with the transport installed before bootstrap.
  // Native guide admission uses window.isTauri, not the presence of invoke.
  await page.addInitScript(() => {
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string) => {
        if (command === 'guide_sources') {
          Reflect.set(
            window,
            'primaryGuideReadCount',
            (Reflect.get(window, 'primaryGuideReadCount') ?? 0) + 1,
          );
          return new Promise((resolve) =>
            Reflect.set(window, 'releasePrimaryGuideRead', () => resolve([])),
          );
        }
        if (command === 'guide_mappings') return Promise.resolve([]);
        return Promise.resolve(null);
      },
    });
  });
  await ready(page);
  await page.evaluate(() => Reflect.set(window, 'isTauri', true));
}

test('primary transition observer is immutable, redacted, and reports actual completed page activation', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const host = document.getElementById('primary-view-host')!;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden')!;
    Reflect.set(window, 'observedPrimaryStages', []);
    Object.defineProperty(host, 'hidden', {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value) {
        Reflect.get(window, 'observedPrimaryStages').push(
          Reflect.get(window, '__GENX_PRIMARY_TRANSITION__').stage,
        );
        descriptor.set!.call(this, value);
      },
    });
  });
  expect(
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window, '__GENX_PRIMARY_TRANSITION__')!;
      const value = Reflect.get(window, '__GENX_PRIMARY_TRANSITION__');
      return {
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        setter: descriptor.set === undefined,
        frozen: Object.isFrozen(value),
        keys: Object.keys(value).sort(),
      };
    }),
  ).toEqual({
    enumerable: false,
    configurable: false,
    setter: true,
    frozen: true,
    keys: [
      'activeIntent',
      'closing',
      'documentHidden',
      'errorCount',
      'nativeForeground',
      'pending',
      'queued',
      'reason',
      'requestedIntent',
      'revision',
      'schemaVersion',
      'stage',
    ].sort(),
  });
  await page.locator('#guide-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.guide-dialog[data-primary-page="guide"]')).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).stage).toBe('completed');
  expect(await snapshot(page)).toMatchObject({
    reason: 'none',
    pending: false,
    errorCount: 0,
    nativeForeground: true,
    documentHidden: false,
  });
  expect(await page.evaluate(() => Reflect.get(window, 'observedPrimaryStages'))).toContain(
    'opening',
  );
  await page.locator('#live-tv-button').click();
  await expect.poll(async () => (await snapshot(page)).stage).toBe('completed');
  await expect(page.locator('#primary-view-host')).toBeHidden();
});

test('a superseded intent is explicitly refused after its actual close owner settles', async ({
  page,
}) => {
  await readyWithHeldGuideRead(page);
  await page.locator('#guide-button').click();
  await expect
    .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releasePrimaryGuideRead')))
    .toBe('function');
  await page.locator('#guide-button').dispatchEvent('click');
  await expect.poll(async () => (await snapshot(page)).stage).toBe('closing-guide');
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
  await page.evaluate(() => Reflect.get(window, 'releasePrimaryGuideRead')());
  await expect.poll(async () => (await snapshot(page)).pending).toBe(false);
  expect(await snapshot(page)).toMatchObject({
    stage: 'refused',
    reason: 'superseded',
    errorCount: 0,
  });
  await expect(page.locator('.guide-dialog')).not.toBeVisible();
  await expect(page.locator('.workspace')).toBeVisible();
});

test('held real guide read distinguishes closing owner from queued intent and preserves the queued Guide intent', async ({
  page,
}) => {
  await readyWithHeldGuideRead(page);
  await page.locator('#guide-button').click();
  await expect(page.locator('.guide-dialog[data-primary-page="guide"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releasePrimaryGuideRead')))
    .toBe('function');
  await page.locator('#guide-button').dispatchEvent('click');
  await expect.poll(async () => (await snapshot(page)).stage).toBe('closing-guide');
  const active = (await snapshot(page)).activeIntent;
  await page.locator('#guide-button').dispatchEvent('click');
  const held = await snapshot(page);
  expect(held).toMatchObject({
    stage: 'closing-guide',
    activeIntent: active,
    pending: true,
    queued: true,
    reason: 'none',
  });
  expect(held.requestedIntent).toBeGreaterThan(active);
  await page.evaluate(() => Reflect.get(window, 'releasePrimaryGuideRead')());
  await expect.poll(async () => (await snapshot(page)).pending).toBe(false);
  await expect(page.locator('.guide-dialog[data-primary-page="guide"]')).toBeVisible();
  expect(await snapshot(page)).toMatchObject({ stage: 'completed', errorCount: 0 });
  // The winning ordinary Guide intent owns its fresh read too; settle it before leaving.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'primaryGuideReadCount')))
    .toBe(2);
  await page.evaluate(() => Reflect.get(window, 'releasePrimaryGuideRead')());
  await page.locator('#live-tv-button').click();
  await expect(page.locator('#primary-view-host')).toBeHidden();
});

test('native background refusal and rejected close are distinct fixed reasons without raw diagnostic content', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
  // The backgrounded viewing area is inert; a late activation still reaches the queue.
  await page.locator('#guide-button').dispatchEvent('click');
  await expect.poll(async () => (await snapshot(page)).stage).toBe('refused');
  expect(await snapshot(page)).toMatchObject({
    reason: 'native-background',
    nativeForeground: false,
    documentHidden: false,
    errorCount: 0,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
  await page.locator('#guide-button').click();
  await expect(page.locator('.guide-dialog[data-primary-page="guide"]')).toBeVisible();
  await page.evaluate(() => {
    const original = HTMLDialogElement.prototype.close;
    Reflect.set(window, 'restorePrimaryDialogClose', () => {
      HTMLDialogElement.prototype.close = original;
    });
    HTMLDialogElement.prototype.close = function (...args) {
      if (this.classList.contains('guide-dialog') && this.open)
        throw new Error('https://private.invalid/secret');
      return original.apply(this, args);
    };
  });
  await page.locator('#guide-button').dispatchEvent('click');
  await expect.poll(async () => (await snapshot(page)).stage).toBe('failed');
  expect(await snapshot(page)).toMatchObject({
    reason: 'operation-failed',
    pending: false,
    errorCount: 1,
  });
  expect(JSON.stringify(await snapshot(page))).not.toContain('private.invalid');
  await expect(page.locator('.guide-dialog')).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'restorePrimaryDialogClose')());
  await page.locator('#live-tv-button').click();
  await expect(page.locator('#primary-view-host')).toBeHidden();
  expect((await snapshot(page)).errorCount).toBe(1);
});

test('Watch library intent supersedes a held primary Guide reopen and cannot reopen Guide late', async ({
  page,
}) => {
  await readyWithHeldGuideRead(page);
  await page.locator('#guide-button').click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'primaryGuideReadCount')))
    .toBe(1);
  await page.locator('#guide-button').dispatchEvent('click');
  await expect.poll(async () => (await snapshot(page)).stage).toBe('closing-guide');
  const primary = await snapshot(page);
  await page.locator('#live-tv-button').click();
  // Watch is now owned by switchLibrary, sharing the real primary drain queue.
  // It supersedes primaryIntent without creating another primary transition.
  expect(await snapshot(page)).toMatchObject({
    activeIntent: primary.activeIntent,
    pending: true,
    queued: false,
    stage: 'closing-guide',
  });
  const library = await page.evaluate(() => Reflect.get(window, '__GENX_LIBRARY_TRANSITION__'));
  expect(library).toMatchObject({ pending: true, stage: 'queued' });
  await page.evaluate(() => Reflect.get(window, 'releasePrimaryGuideRead')());
  await expect.poll(async () => (await snapshot(page)).pending).toBe(false);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_LIBRARY_TRANSITION__').pending))
    .toBe(false);
  expect(await snapshot(page)).toMatchObject({
    stage: 'refused',
    reason: 'superseded',
    errorCount: 0,
  });
  await expect(page.locator('#primary-view-host')).toBeHidden();
  await expect(page.locator('.guide-dialog')).not.toBeVisible();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.locator('#live-tv-button')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => Reflect.get(window, 'primaryGuideReadCount'))).toBe(1);
});
