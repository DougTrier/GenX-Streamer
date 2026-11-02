// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { fixture, useTimelineBrowser } from './timeline-browser.fixture';

useTimelineBrowser();

it('a blocked first read leaves ordered channel controls and independently ready later listings usable', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      Reflect.set(window, 'activeReads', 0);
      Reflect.set(window, 'peakReads', 0);
      Reflect.set(window, 'refreshDone', false);
      host.channelActivate = () =>
        Reflect.set(window, 'watches', Reflect.get(window, 'watches') + 1);
      host.query = async (query: unknown, signal: AbortSignal) => {
        const id = (query as { appChannelIds: string[] }).appChannelIds[0];
        Reflect.set(window, 'activeReads', Reflect.get(window, 'activeReads') + 1);
        Reflect.set(
          window,
          'peakReads',
          Math.max(Reflect.get(window, 'peakReads'), Reflect.get(window, 'activeReads')),
        );
        try {
          if (id === 'c0')
            await new Promise<void>((resolve) => Reflect.set(window, 'releaseFirst', resolve));
          else await new Promise((resolve) => setTimeout(resolve, 10));
          return await original(query, signal);
        } finally {
          Reflect.set(window, 'activeReads', Reflect.get(window, 'activeReads') - 1);
        }
      };
      void Reflect.get(window, 'owner')
        .setForeground(true)
        .then(() => Reflect.set(window, 'refreshDone', true));
    });
    const rows = page.locator('.gx-timeline-row');
    await rows.nth(7).waitFor();
    await expect.poll(() => rows.nth(1).locator('.gx-timeline-cell').count()).toBe(2);
    expect(await rows.nth(0).locator('.gx-timeline-track').getAttribute('aria-busy')).toBe('true');
    expect(await rows.nth(0).locator('.gx-timeline-cell').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'refreshDone'))).toBe(false);
    const later = rows.nth(1).locator('.gx-timeline-channel');
    await later.click();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    await later.focus();
    await page.evaluate(() => Reflect.set(window, 'retainedLabel', document.activeElement));
    expect(await page.evaluate(() => Reflect.get(window, 'peakReads'))).toBeLessThanOrEqual(4);
    await page.evaluate(() => Reflect.get(window, 'releaseFirst')());
    await page.waitForFunction(() => Reflect.get(window, 'refreshDone') === true);
    await expect.poll(() => rows.nth(0).locator('.gx-timeline-cell').count()).toBe(2);
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'retainedLabel')),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'retainedLabel').isConnected)).toBe(true);
    const order = await rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: JSON.parse((node as HTMLElement).dataset.channelKey!)[0],
        top: parseFloat((node as HTMLElement).style.top),
      })),
    );
    expect(order.map((row) => row.id)).toEqual(order.map((_, index) => `c${index}`));
    expect(order.every((row, index) => index === 0 || row.top > order[index - 1]!.top)).toBe(true);
    expect(await page.locator('.gx-timeline-track[aria-busy="true"]').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'peakReads'))).toBeLessThanOrEqual(4);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'releaseFirst')?.());
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('suspension joins all four retained reads, starts no queued read and rejects their obsolete rows', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      Reflect.set(window, 'retainedReads', []);
      Reflect.set(window, 'startedReads', 0);
      host.query = async (query: unknown, signal: AbortSignal) => {
        Reflect.set(window, 'startedReads', Reflect.get(window, 'startedReads') + 1);
        await new Promise<void>((resolve) =>
          Reflect.get(window, 'retainedReads').push({ signal, resolve }),
        );
        return original(query, signal);
      };
      void Reflect.get(window, 'owner').setForeground(true);
    });
    await page.waitForFunction(() => Reflect.get(window, 'retainedReads').length === 4);
    await page.evaluate(() => {
      Reflect.set(window, 'drained', false);
      void Reflect.get(window, 'owner')
        .suspend()
        .then(() => Reflect.set(window, 'drained', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'drained'))).toBe(false);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'retainedReads').every(
          (read: { signal: AbortSignal }) => read.signal.aborted,
        ),
      ),
    ).toBe(true);
    await page.evaluate(() =>
      Reflect.get(window, 'retainedReads').forEach((read: { resolve(): void }) => read.resolve()),
    );
    await page.waitForFunction(() => Reflect.get(window, 'drained') === true);
    expect(await page.evaluate(() => Reflect.get(window, 'startedReads'))).toBe(4);
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
  } finally {
    await page.evaluate(() =>
      Reflect.get(window, 'retainedReads')?.forEach((read: { resolve(): void }) => read.resolve()),
    );
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('a later SQL refusal is visible before a held first read settles and cannot become a ready empty guide', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      Reflect.set(window, 'refreshDone', false);
      host.query = async (query: { appChannelIds: string[] }, signal: AbortSignal) => {
        if (query.appChannelIds[0] === 'c0')
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseFirst', resolve));
        if (query.appChannelIds[0] === 'c1') throw new Error('controlled-stale-sql-revision');
        return original(query, signal);
      };
      void Reflect.get(window, 'owner')
        .setForeground(true)
        .then(() => Reflect.set(window, 'refreshDone', true));
    });
    await page
      .getByText('Guide could not refresh. Choose Now to retry.', { exact: true })
      .waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'refreshDone'))).toBe(false);
    expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).toBeNull();
    await page.evaluate(() => Reflect.get(window, 'releaseFirst')());
    await page.waitForFunction(() => Reflect.get(window, 'refreshDone') === true);
    expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).toBeNull();
    expect(
      await page
        .getByText('Guide could not refresh. Choose Now to retry.', { exact: true })
        .isVisible(),
    ).toBe(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'releaseFirst')?.());
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('a concurrent SQL failure remains a cleanup failure when an earlier read reports cancellation first', async () => {
  const page = await fixture(false);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.query;
      Reflect.set(window, 'retainedReads', []);
      host.query = async (query: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) =>
          Reflect.get(window, 'retainedReads').push({ resolve, reject }),
        );
        return original(query, signal);
      };
      void Reflect.get(window, 'owner')
        .setForeground(true)
        .catch((error: Error) => Reflect.set(window, 'startError', error.message));
    });
    await page.waitForFunction(() => Reflect.get(window, 'retainedReads').length === 4);
    await page.evaluate(() => {
      Reflect.set(window, 'drained', false);
      void Reflect.get(window, 'owner')
        .suspend()
        .then(
          () => Reflect.set(window, 'drained', true),
          (error: Error) => {
            Reflect.set(window, 'cleanupFailure', error.message);
            Reflect.set(window, 'drained', true);
          },
        );
      const reads = Reflect.get(window, 'retainedReads');
      reads[0].reject(new DOMException('controlled cancellation', 'AbortError'));
      reads[1].reject(new Error('controlled stale SQL refusal'));
      reads[2].resolve();
      reads[3].resolve();
    });
    await page.waitForFunction(() => Reflect.get(window, 'drained') === true);
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupFailure'))).toContain(
      'cancellation could not finish',
    );
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    const disposal = await page.evaluate(async () => {
      try {
        await Reflect.get(window, 'owner').dispose();
        return 'incorrectly accepted';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(disposal).toContain('cancellation could not finish');
  } finally {
    await page.close();
  }
});
