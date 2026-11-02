// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { fixture, useTimelineBrowser } from './timeline-browser.fixture';
useTimelineBrowser();

it('catalog batches retain usable drawn rows and coalesce catch-up until the latest inventory can finish', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      Reflect.set(window, 'inventoryCalls', 0);
      Reflect.set(window, 'refreshDone', false);
      host.channelActivate = () =>
        Reflect.set(window, 'watches', Reflect.get(window, 'watches') + 1);
      host.listedChannels = async () => {
        const count = Reflect.get(window, 'inventoryCalls') + 1;
        Reflect.set(window, 'inventoryCalls', count);
        const revision = Reflect.get(window, 'revision');
        if (count === 2)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseInventory', resolve));
        return {
          catalogRevision: revision,
          databaseRevision: 1,
          channels: Reflect.get(window, 'channels').map(
            (c: { id: string; sourceId: string; xmltvChannelId: string }) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: 'g',
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            }),
          ),
        };
      };
      let first = true;
      host.query = async (query: { appChannelIds: string[] }, signal: AbortSignal) => {
        if (first && query.appChannelIds[0] === 'c0') {
          first = false;
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseFirst', resolve));
        }
        return original(query, signal);
      };
      void Reflect.get(window, 'owner')
        .setForeground(true)
        .then(() => Reflect.set(window, 'refreshDone', true));
    });
    const row = page.locator('.gx-timeline-row').nth(1),
      label = row.locator('.gx-timeline-channel');
    await expect.poll(() => row.locator('.gx-timeline-cell').count()).toBe(2);
    await label.focus();
    await page.evaluate(() => {
      Reflect.set(window, 'retainedLabel', document.activeElement);
      const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
      viewport.scrollTop = 100;
      Reflect.set(window, 'savedScroll', viewport.scrollTop);
      Reflect.set(window, 'revision', '2');
      Reflect.get(window, 'releaseFirst')();
    });
    await page.waitForFunction(() => typeof Reflect.get(window, 'releaseInventory') === 'function');
    expect(await page.evaluate(() => Reflect.get(window, 'retainedLabel').isConnected)).toBe(true);
    expect(await row.locator('.gx-timeline-cell').count()).toBe(2);
    await label.click();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    await page.evaluate(() => {
      Reflect.set(
        window,
        'savedScroll',
        document.querySelector<HTMLElement>('.gx-timeline-viewport')!.scrollTop,
      );
      Reflect.set(window, 'revision', '3');
      Reflect.set(window, 'revision', '4');
      Reflect.set(window, 'revision', '5');
    });
    expect(await page.evaluate(() => Reflect.get(window, 'inventoryCalls'))).toBe(2);
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'retainedLabel')),
    ).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseInventory')());
    await page.waitForFunction(() => Reflect.get(window, 'refreshDone') === true);
    expect(await page.evaluate(() => Reflect.get(window, 'inventoryCalls'))).toBe(3);
    expect(await page.locator('.gx-timeline-track[aria-busy="true"]').count()).toBe(0);
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'retainedLabel')),
    ).toBe(true);
    expect(await page.locator('.gx-timeline-viewport').evaluate((node) => node.scrollTop)).toBe(
      await page.evaluate(() => Reflect.get(window, 'savedScroll')),
    );
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'releaseFirst')?.();
      Reflect.get(window, 'releaseInventory')?.();
    });
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('a first-open inventory racing catalog publication recovers automatically without reopening', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'inventoryCalls', 0);
      host.listedChannels = async () => {
        const count = Reflect.get(window, 'inventoryCalls') + 1;
        Reflect.set(window, 'inventoryCalls', count);
        const revision = Reflect.get(window, 'revision');
        if (count === 1) {
          Reflect.set(window, 'revision', '2');
        }
        return {
          catalogRevision: revision,
          databaseRevision: 1,
          channels: Reflect.get(window, 'channels').map(
            (c: { id: string; sourceId: string; xmltvChannelId: string }) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: 'g',
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            }),
          ),
        };
      };
      void Reflect.get(window, 'owner').setForeground(true);
    });
    await expect
      .poll(() => page.locator('.gx-timeline-row .gx-timeline-cell').count())
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => Reflect.get(window, 'inventoryCalls'))).toBe(2);
    expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).toBe('ready');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('an explicit scope change during catch-up clears old rows and blocks their controls', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      let first = true;
      host.channelActivate = () =>
        Reflect.set(window, 'watches', Reflect.get(window, 'watches') + 1);
      host.query = async (query: { appChannelIds: string[] }, signal: AbortSignal) => {
        if (first && query.appChannelIds[0] === 'c0') {
          first = false;
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseFirst', resolve));
        }
        return original(query, signal);
      };
      void Reflect.get(window, 'owner').setForeground(true);
    });
    const row = page.locator('.gx-timeline-row').nth(1);
    await expect.poll(() => row.locator('.gx-timeline-cell').count()).toBe(2);
    await row.locator('.gx-timeline-channel').focus();
    await page.evaluate(() => {
      Reflect.set(window, 'oldCountryControl', document.activeElement);
      Reflect.set(window, 'revision', '2');
      Reflect.get(window, 'releaseFirst')();
    });
    // The internal catch-up has entered its bounded quiet interval.
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').filter((c: { id: string }) => c.id === 'c50'),
      );
      Reflect.set(window, 'revision', '3');
      void Reflect.get(window, 'owner').refresh();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'oldCountryControl').isConnected)).toBe(
      false,
    );
    await page.evaluate(() => Reflect.get(window, 'oldCountryControl').click());
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['Channel 50']);
    expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).toBe('ready');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'releaseFirst')?.());
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('suspension clears the coalesced catch-up timer and joins its owned retry', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      host.listedChannels = async () => {
        const revision = Reflect.get(window, 'revision');
        Reflect.set(window, 'revision', '2');
        return { catalogRevision: revision, databaseRevision: 1, channels: [] };
      };
      void Reflect.get(window, 'owner').setForeground(true);
    });
    await page.waitForFunction(() => Reflect.get(window, 'timelineTimers').size > 0);
    await page.evaluate(() => Reflect.get(window, 'owner').suspend());
    expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(0);
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
