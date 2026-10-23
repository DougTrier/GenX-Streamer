import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { expect, test } from '@playwright/test';
import { resourceKinds, type ResourceOwnerSnapshot } from '../../src/playback/resource-owners';

test('background bridge shows recovery explanation and requires explicit Resume', async ({
  page,
}) => {
  // Controlled browser bridge fixture: this does not prove Android OS lifecycle.
  const requests: Array<{ release: () => void; settled: Promise<void>; cleanupFailed: boolean }> =
    [];
  let closing = false;
  const owners = () =>
    page.evaluate(() => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__') as ResourceOwnerSnapshot);
  const releasedOwners = async () => {
    const snapshot = await owners();
    return Object.fromEntries(
      [
        'controllerEngines',
        'browserEngines',
        'controllerTimers',
        'initializationWaits',
        'nativeLoads',
        'nativeCancels',
      ].map((kind) => [kind, snapshot.counts[kind as keyof typeof snapshot.counts]]),
    );
  };
  const released = {
    controllerEngines: 0,
    browserEngines: 0,
    controllerTimers: 0,
    initializationWaits: 0,
    nativeLoads: 0,
    nativeCancels: 0,
  };
  let baseline: ResourceOwnerSnapshot | undefined;
  await page.route('https://fixture.invalid/**', async (route) => {
    let release!: () => void;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const request = { release, settled, cleanupFailed: false };
    requests.push(request);
    if (closing) release();
    try {
      // Hold headers until the test explicitly releases this owned operation.
      // Backgrounding cancels the real fetch; no malformed manifest is returned.
      await held;
      await route.abort('aborted').catch(() => {
        if (!route.request().failure() && !page.isClosed()) request.cleanupFailed = true;
      });
    } finally {
      finish();
    }
  });
  try {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const descriptor = await page.evaluate(() => {
      const property = Object.getOwnPropertyDescriptor(window, '__GENX_PLAYBACK_OWNERS__');
      const snapshot = Reflect.get(window, '__GENX_PLAYBACK_OWNERS__');
      return {
        getter: typeof property?.get,
        setter: typeof property?.set,
        enumerable: property?.enumerable,
        configurable: property?.configurable,
        frozen:
          Object.isFrozen(snapshot) &&
          Object.values(snapshot)
            .filter((value) => typeof value === 'object')
            .every((value) => Object.isFrozen(value)),
        keys: Object.keys(snapshot).sort(),
        countKeys: Object.keys(snapshot.counts).sort(),
        safeValues:
          !JSON.stringify(snapshot).includes('://') &&
          Object.values(snapshot).every((value) => typeof value !== 'function'),
      };
    });
    expect(descriptor).toEqual({
      getter: 'function',
      setter: 'undefined',
      enumerable: false,
      configurable: false,
      frozen: true,
      keys: ['acquired', 'counts', 'coveredDomains', 'highWater', 'released', 'schemaVersion'],
      countKeys: [...resourceKinds].sort(),
      safeValues: true,
    });
    baseline = await owners();
    await openPlaylistImport(page);
    await page.locator('#playlist-file').setInputFiles({
      name: 'background-fixture.m3u',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '#EXTM3U\n#EXTINF:-1,Background channel\nhttps://fixture.invalid/stream\n',
      ),
    });
    await saveReviewedSource(page);
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    await page.locator('.channel').first().click();
    await expect.poll(() => requests.length).toBe(1);
    expect((await owners()).counts).toMatchObject({ controllerEngines: 1, browserEngines: 1 });
    await expect(page.locator('#playback-status')).toHaveText('Connecting…');
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await expect.poll(releasedOwners).toEqual(released);
    expect((await owners()).counts).toMatchObject({
      controllerListeners: baseline.counts.controllerListeners,
      decodedObservers: baseline.counts.decodedObservers,
    });
    await expect(page.locator('#player-overlay')).toBeVisible();
    await expect(page.locator('#overlay-message')).toHaveText(
      'Playback paused in the background. Resume reconnects to this channel.',
    );
    await expect(page.locator('#pause-button')).toHaveText('Resume');
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await expect(page.locator('#overlay-message')).toContainText('paused in the background');
    await page.locator('#pause-button').click();
    await expect(page.locator('#overlay-message')).not.toContainText('paused in the background');
    await expect.poll(() => requests.length).toBe(2);
    expect((await owners()).counts).toMatchObject({ controllerEngines: 1, browserEngines: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
    await expect(page.locator('#overlay-message')).toContainText('paused in the background');
    await expect.poll(releasedOwners).toEqual(released);
    await page.locator('#remove-channel').click();
    await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
    await expect(page.locator('#overlay-message')).not.toContainText('paused in the background');
    await expect.poll(releasedOwners).toEqual(released);
    expect((await owners()).counts).toMatchObject({
      controllerListeners: baseline.counts.controllerListeners,
      decodedObservers: baseline.counts.decodedObservers,
    });
  } finally {
    try {
      if (!page.isClosed()) {
        // Abort the real playback owner before freeing intercepted headers, so a
        // failed assertion cannot turn fixture release into an automatic retry.
        await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
        await expect.poll(releasedOwners).toEqual(released);
      }
    } finally {
      closing = true;
      for (const request of requests) request.release();
      await page.unrouteAll({ behavior: 'wait' });
      await Promise.all(requests.map((request) => request.settled));
      expect(requests.every((request) => !request.cleanupFailed)).toBe(true);
    }
  }
});
