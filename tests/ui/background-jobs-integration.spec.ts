import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { expect, test, type Page } from '@playwright/test';

const playlist = (name: string) =>
  `#EXTM3U\n#EXTINF:-1 tvg-id="fixture",${name}\nhttps://media.invalid/stream\n`;

async function persistedCatalog(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tmg-tv', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Fixture could not read existing storage.'));
    });
    try {
      const text = await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction('records', 'readonly');
        const request = transaction.objectStore('records').get('catalog');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(new Error('Fixture read transaction failed.'));
      });
      if (text == null) return { sources: 0, names: [] as string[] };
      if (typeof text !== 'string') throw new Error('Fixture catalog record is not text.');
      const catalog = JSON.parse(text) as { sources: unknown[]; channels: { name: string }[] };
      return {
        sources: catalog.sources.length,
        names: catalog.channels.map((channel) => channel.name).sort(),
      };
    } finally {
      database.close();
    }
  });
}

for (const lifecycle of ['native-event', 'visibility-event'] as const) {
  test(`${lifecycle} cancels pending source acquisition without publication or automatic foreground retry`, async ({
    page,
  }) => {
    // Shared browser event integration only: not Android OS/battery evidence.
    const operations: Array<{ release(): void; settled: Promise<void> }> = [];
    let requests = 0;
    let active = 0;
    let highWater = 0;
    let closing = false;
    let canceledFirstRequest = false;
    await page.route('https://fixture.invalid/background-source', async (route) => {
      const ordinal = ++requests;
      active++;
      highWater = Math.max(highWater, active);
      let release!: () => void;
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      operations.push({ release, settled });
      if (closing || ordinal > 1) release();
      try {
        await held;
        await route
          .fulfill({
            status: 200,
            contentType: 'text/plain',
            headers: { 'access-control-allow-origin': '*' },
            body: playlist(ordinal === 1 ? 'Obsolete late channel' : 'Explicit retry channel'),
          })
          .catch((error: unknown) => {
            // An aborted real fetch can no longer accept its controlled late response.
            if (
              !(ordinal === 1 && canceledFirstRequest) &&
              !route.request().failure() &&
              !closing &&
              !page.isClosed()
            )
              throw error;
          });
      } finally {
        active--;
        finish();
      }
    });
    await page.route('https://media.invalid/stream', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
      }),
    );
    try {
      await page.goto('/');
      await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
      await openPlaylistImport(page);
      await page.locator('#playlist-file').setInputFiles({
        name: 'saved-source.m3u',
        mimeType: 'text/plain',
        buffer: Buffer.from(playlist('Saved channel')),
      });
      await saveReviewedSource(page);
      await expect(page.locator('#import-dialog')).not.toBeVisible();
      const baseline = await persistedCatalog(page);
      expect(baseline).toEqual({ sources: 1, names: ['Saved channel'] });
      await openPlaylistImport(page);
      await page.locator('#playlist-url').fill('https://fixture.invalid/background-source');
      await page.locator('#load-button').click();
      await expect.poll(() => requests).toBe(1);
      await page.evaluate((lifecycle) => {
        if (lifecycle === 'visibility-event') {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          window.dispatchEvent(new Event('native-app-background'));
          window.dispatchEvent(new Event('native-app-background'));
        }
      }, lifecycle);
      const review = page.getByRole('dialog', { name: 'Review source scan' });
      await expect(review.getByRole('status')).toHaveText(
        'Operation canceled while the app was in the background. Reviewed choices retained; retry when ready.',
      );
      canceledFirstRequest = true;
      operations[0].release();
      await operations[0].settled;
      expect(await persistedCatalog(page)).toEqual(baseline);
      await expect(page.locator('.channel strong')).toHaveText('Saved channel');
      await page.evaluate((lifecycle) => {
        if (lifecycle === 'visibility-event') {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.dispatchEvent(new Event('visibilitychange'));
        } else window.dispatchEvent(new Event('native-app-foreground'));
      }, lifecycle);
      // The completed read and UI assertion are explicit asynchronous barriers;
      // foreground has no registered action that may start acquisition.
      expect(await persistedCatalog(page)).toEqual(baseline);
      await expect(
        review.getByRole('button', { name: 'Scan configured sources', exact: true }),
      ).toBeEnabled();
      expect(requests).toBe(1);
      expect(active).toBe(0);
      await review.getByRole('button', { name: 'Scan configured sources', exact: true }).click();
      await expect(
        review.getByRole('button', { name: 'Save selected channels', exact: true }),
      ).toBeEnabled();
      expect(await persistedCatalog(page)).toEqual(baseline);
      await saveReviewedSource(page);
      await expect(page.locator('#channel-count')).toHaveText('2 channels');
      expect(await persistedCatalog(page)).toEqual({
        sources: 2,
        names: ['Explicit retry channel', 'Saved channel'],
      });
      expect(requests).toBe(2);
      expect(highWater).toBe(1);
      await page.reload();
      await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
      await expect(page.locator('#channel-count')).toHaveText('2 channels');
      await expect(page.getByText('Obsolete late channel', { exact: true })).toHaveCount(0);
      expect(requests).toBe(2);
    } finally {
      closing = true;
      for (const operation of operations) operation.release();
      await Promise.all(operations.map((operation) => operation.settled));
    }
  });
}
