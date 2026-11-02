// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';
useGuideUiBrowser();
async function mounted(timeline = true, holdFirst = false) {
  const page = await fixture(false, timeline);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(
    async ({ timeline, holdFirst }) => {
      await Reflect.get(window, 'guide').dispose();
      const host = Reflect.get(window, 'host');
      const channels = Array.from({ length: 40 }, (_, i) => ({
        id: 'c' + i,
        sourceId: 'catalog',
        name: 'Sports ' + i,
        category: 'Sports',
      }));
      const mappings = channels.slice(0, 39).map((c) => ({
        catalogSourceId: c.sourceId,
        appChannelId: c.id,
        guideSourceId: 'guide',
        xmltvChannelId: c.id,
      }));
      const source = {
        id: 'guide',
        name: 'Guide',
        location: 'https://fixture.invalid/guide',
        kind: 'url',
        allowHttp: false,
        revision: 1,
        updatedMs: 1700000000000,
      };
      let selected: (typeof channels)[number] | null = null;
      Reflect.set(window, 'configurationCalls', { sources: 0, mappings: 0 });
      Reflect.set(window, 'configurationGates', []);
      Reflect.set(window, 'selectionRows', channels);
      Reflect.set(window, 'locationKey', 'US');
      Reflect.set(window, 'firstProgrammeCalls', 0);
      host.presentation = 'page';
      host.enableTimeline = timeline;
      host.channels = () => channels;
      host.selectedChannel = () => selected;
      host.locationScopeKey = () => Reflect.get(window, 'locationKey');
      const gate = async (name: 'sources' | 'mappings') => {
        const calls = Reflect.get(window, 'configurationCalls');
        calls[name]++;
        if (calls[name] > 1)
          await new Promise<void>((resolve) =>
            Reflect.get(window, 'configurationGates').push(resolve),
          );
      };
      host.sources = async () => {
        await gate('sources');
        return [source];
      };
      host.mappings = async () => {
        await gate('mappings');
        return mappings;
      };
      host.query = async (q: { appChannelIds: string[] }) => {
        if (q.appChannelIds[0] === 'c0') {
          Reflect.set(
            window,
            'firstProgrammeCalls',
            Reflect.get(window, 'firstProgrammeCalls') + 1,
          );
          if (holdFirst)
            await new Promise<void>((resolve) =>
              Reflect.set(window, 'releaseFirstProgramme', resolve),
            );
        }
        return {
          programs: q.appChannelIds.map((id) => ({
            catalogSourceId: 'catalog',
            appChannelId: id,
            guideSourceId: 'guide',
            xmltvChannelId: id,
            startMs: 1699999999000,
            stopMs: 1700000100000,
            ordinal: 0,
            title: 'Live ' + id,
            description: 'Sports',
          })),
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        };
      };
      host.watch = async (c: (typeof channels)[number]) => {
        selected = c;
        Reflect.get(window, 'guide').selectedChannelChanged();
        Reflect.set(window, 'tunes', (Reflect.get(window, 'tunes') ?? 0) + 1);
      };
      Reflect.set(window, 'releaseConfiguration', () => {
        for (const resolve of Reflect.get(window, 'configurationGates').splice(0)) resolve();
      });
      Reflect.set(
        window,
        'guide',
        Reflect.get(window, 'GuideUI').mountGuide(document.getElementById('guide'), host),
      );
      await Reflect.get(window, 'guide').open();
    },
    { timeline, holdFirst },
  );
  if (timeline) await page.locator('.gx-timeline-cell').nth(2).waitFor();
  else await page.waitForFunction(() => Reflect.get(window, 'configurationCalls').sources === 1);
  return page;
}
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function close(page: Awaited<ReturnType<typeof mounted>>) {
  await page.evaluate(async () => {
    Reflect.get(window, 'releaseFirstProgramme')?.();
    Reflect.get(window, 'releaseConfiguration')();
    await Reflect.get(window, 'guide').dispose();
  });
  await page.close();
}
it('ordinary page tuning retains ready rows/focus/scroll without reacquiring delayed sources or mappings', async () => {
  const page = await mounted();
  try {
    await page.getByRole('button', { name: 'Sports', exact: true }).click();
    const label = page.locator('.gx-timeline-channel').nth(2);
    await label.focus();
    await page.evaluate(() => {
      Reflect.set(window, 'retainedSelectionLabel', document.activeElement);
      Reflect.set(
        window,
        'retainedSelectionRow',
        document.activeElement?.closest('.gx-timeline-row'),
      );
      document.querySelector<HTMLElement>('.gx-timeline-viewport')!.scrollTop = 15;
    });
    await label.click();
    await page.waitForFunction(() => Reflect.get(window, 'tunes') === 1);
    await page.evaluate(settle);
    // A selection-only canonical notification does not adopt another catalog.
    await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged());
    await page.evaluate(settle);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
    expect(
      await page.evaluate(() => ({
        connected: Reflect.get(window, 'retainedSelectionRow').isConnected,
        focused: document.activeElement === Reflect.get(window, 'retainedSelectionLabel'),
        scroll: document.querySelector('.gx-timeline-viewport')!.scrollTop,
      })),
    ).toEqual({ connected: true, focused: true, scroll: 15 });
    expect(
      await page.getByRole('button', { name: 'Sports', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(await page.locator('.gx-timeline-cell').count()).toBeGreaterThan(0);
  } finally {
    await close(page);
  }
});
it('an unmapped selection keeps the current grid while catalog, location and explicit guide changes still reload', async () => {
  const page = await mounted();
  try {
    await page.evaluate(() =>
      Reflect.get(window, 'host').watch(
        Reflect.get(window, 'selectionRows')[39],
        new AbortController().signal,
      ),
    );
    await page.evaluate(settle);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
    expect(await page.locator('.gx-timeline-row').count()).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: 'Map guide', exact: true }).isVisible()).toBe(
      true,
    );
    for (const kind of ['catalog', 'location', 'guide']) {
      const before = await page.evaluate(() => Reflect.get(window, 'configurationCalls').sources);
      await page.evaluate((kind) => {
        if (kind === 'catalog') Reflect.set(window, 'catalogRevision', '2');
        if (kind === 'location') Reflect.set(window, 'locationKey', 'CA');
        Reflect.get(window, 'guide').catalogChanged(true);
      }, kind);
      await page.waitForFunction(
        (count) => Reflect.get(window, 'configurationCalls').sources === count,
        before + 1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
        sources: before + 1,
        mappings: before + 1,
      });
      await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
      await page.locator('.gx-timeline-cell').nth(2).waitFor();
    }
    await page.evaluate(() =>
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'selectionRows')[39]),
    );
    await page.waitForFunction(() => Reflect.get(window, 'configurationCalls').sources === 5);
    expect(await page.locator('.guide-dialog').evaluate((node) => node.matches(':modal'))).toBe(
      true,
    );
    await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
  } finally {
    await close(page);
  }
});
it('single-channel and advanced presentations keep their selection-specific configuration reload', async () => {
  for (const timeline of [false, true]) {
    const page = await mounted(timeline);
    try {
      if (timeline) {
        await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
        await page.waitForFunction(() => Reflect.get(window, 'configurationCalls').sources === 2);
        await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
        await page.evaluate(settle);
      }
      const before = await page.evaluate(() => Reflect.get(window, 'configurationCalls').sources);
      await page.evaluate(() =>
        Reflect.get(window, 'host').watch(
          Reflect.get(window, 'selectionRows')[1],
          new AbortController().signal,
        ),
      );
      await page.waitForFunction(
        (count) => Reflect.get(window, 'configurationCalls').sources === count,
        before + 1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
        sources: before + 1,
        mappings: before + 1,
      });
      await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
    } finally {
      await close(page);
    }
  }
});

it('tuning a ready row keeps the assembled page model while an earlier programme query is still owned', async () => {
  const page = await mounted(true, true);
  try {
    const label = page.locator('.gx-timeline-channel').nth(2);
    await label.focus();
    await page.evaluate(() => Reflect.set(window, 'pendingRowLabel', document.activeElement));
    await label.click();
    await page.waitForFunction(() => Reflect.get(window, 'tunes') === 1);
    await page.evaluate(settle);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
    expect(
      await page.evaluate(
        () =>
          document.activeElement === Reflect.get(window, 'pendingRowLabel') &&
          Reflect.get(window, 'pendingRowLabel').isConnected,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.gx-timeline-row')
        .first()
        .locator('.gx-timeline-track')
        .getAttribute('aria-busy'),
    ).toBe('true');
    await page.evaluate(() => Reflect.get(window, 'releaseFirstProgramme')());
    await page.locator('.gx-timeline-row').first().locator('.gx-timeline-cell').waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'firstProgrammeCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
  } finally {
    await close(page);
  }
});

it('a held reload and late selection notification cannot reopen or refocus a closed Guide', async () => {
  const page = await mounted();
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged(true));
    await page.waitForFunction(() => Reflect.get(window, 'configurationGates').length === 2);
    await page.evaluate(() => {
      Reflect.set(window, 'closedSelectionGuide', false);
      void Reflect.get(window, 'guide')
        .close()
        .then(() => Reflect.set(window, 'closedSelectionGuide', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'closedSelectionGuide'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
    await page.waitForFunction(() => Reflect.get(window, 'closedSelectionGuide') === true);
    await page.evaluate(async () => {
      const outside = document.createElement('button');
      outside.id = 'after-guide-action';
      outside.textContent = 'Other action';
      document.body.append(outside);
      outside.focus();
      await Reflect.get(window, 'host').watch(
        Reflect.get(window, 'selectionRows')[2],
        new AbortController().signal,
      );
    });
    await page.evaluate(settle);
    expect(await page.locator('.guide-dialog').getAttribute('open')).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('after-guide-action');
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 2,
      mappings: 2,
    });
  } finally {
    await close(page);
  }
});

it('a location change alone revokes selection reuse before its configuration reads settle', async () => {
  const page = await mounted();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'scopeOldRow', document.querySelector('.gx-timeline-row'));
      Reflect.set(window, 'locationKey', 'CA');
      void Reflect.get(window, 'host').watch(
        Reflect.get(window, 'selectionRows')[2],
        new AbortController().signal,
      );
    });
    await page.waitForFunction(() => Reflect.get(window, 'configurationGates').length === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'scopeOldRow').isConnected)).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 2,
      mappings: 2,
    });
    await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
    await page.locator('.gx-timeline-cell').nth(2).waitFor();
  } finally {
    await close(page);
  }
});

it('suspension and replacement notification revoke the page proof even when revisions repeat', async () => {
  const page = await mounted();
  try {
    await page.evaluate(async () => {
      Reflect.set(window, 'replacementOldRow', document.querySelector('.gx-timeline-row'));
      const guide = Reflect.get(window, 'guide');
      await guide.suspend();
      // Root/storage replacement joins foreground owners first. A restored
      // catalog may reuse the same logical revision and location value.
      Reflect.set(window, 'catalogRevision', '1');
      guide.catalogChanged(true);
      await Reflect.get(window, 'host').watch(
        Reflect.get(window, 'selectionRows')[2],
        new AbortController().signal,
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'replacementOldRow').isConnected)).toBe(
      false,
    );
    await page.evaluate(() => Reflect.get(window, 'guide').setForeground(true));
    await page.waitForFunction(() => Reflect.get(window, 'configurationGates').length === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 2,
      mappings: 2,
    });
    await page.evaluate(() => Reflect.get(window, 'releaseConfiguration')());
    await page.locator('.gx-timeline-cell').nth(2).waitFor();
  } finally {
    await close(page);
  }
});

it('tune layout height jitter preserves the focused assembled row without clearing its covered window', async () => {
  const page = await mounted();
  try {
    await page.addStyleTag({
      content:
        '.gx-timeline-viewport{height:307px!important;min-height:0!important;max-height:none!important;flex:none!important}',
    });
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-status')?.getAttribute('data-state') === 'ready',
    );
    await page.evaluate(settle);
    const label = page.locator('.gx-timeline-channel').nth(2);
    await label.focus();
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
      viewport.scrollTop = 15;
      Reflect.set(window, 'jitterLabel', document.activeElement);
      Reflect.set(window, 'jitterRow', document.activeElement?.closest('.gx-timeline-row'));
      Reflect.set(window, 'jitterRemovedRows', 0);
      const content = document.querySelector('.gx-timeline-content')!;
      const observer = new MutationObserver((records) => {
        for (const record of records)
          if (record.target === content)
            for (const removed of record.removedNodes)
              if (removed instanceof HTMLElement && removed.matches('.gx-timeline-row'))
                Reflect.set(
                  window,
                  'jitterRemovedRows',
                  Reflect.get(window, 'jitterRemovedRows') + 1,
                );
      });
      observer.observe(content, { childList: true });
      Reflect.set(window, 'jitterObserver', observer);
      const host = Reflect.get(window, 'host'),
        watch = host.watch;
      host.watch = async (channel: unknown, signal: AbortSignal) => {
        await watch(channel, signal);
        viewport.style.setProperty(
          'height',
          viewport.clientHeight === 307 ? '327px' : '307px',
          'important',
        );
      };
    });
    for (const height of [327, 307, 327, 307]) {
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (height) => document.querySelector('.gx-timeline-viewport')?.clientHeight === height,
        height,
      );
      await page.evaluate(settle);
      expect(
        await page.evaluate(() => ({
          connected: Reflect.get(window, 'jitterRow').isConnected,
          focused: document.activeElement === Reflect.get(window, 'jitterLabel'),
          removedRows: Reflect.get(window, 'jitterRemovedRows'),
          scroll: document.querySelector('.gx-timeline-viewport')!.scrollTop,
        })),
      ).toEqual({ connected: true, focused: true, removedRows: 0, scroll: 15 });
      expect(await page.locator('.gx-timeline-cell').count()).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => Reflect.get(window, 'tunes'))).toBe(4);
    expect(await page.evaluate(() => Reflect.get(window, 'configurationCalls'))).toEqual({
      sources: 1,
      mappings: 1,
    });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'jitterObserver')?.disconnect());
    await close(page);
  }
});

it('an uncovered height and real agenda width change still rebuild a bounded correct layout', async () => {
  const page = await mounted();
  try {
    await page.addStyleTag({
      content:
        '.gx-timeline-viewport{height:307px!important;min-height:0!important;max-height:none!important;flex:none!important}',
    });
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-status')?.getAttribute('data-state') === 'ready',
    );
    await page.evaluate(settle);
    const before = await page.locator('.gx-timeline-row').count();
    await page.evaluate(() => {
      const content = document.querySelector('.gx-timeline-content')!,
        rows = content.querySelectorAll<HTMLElement>('.gx-timeline-row'),
        pitch = parseFloat(
          getComputedStyle(document.querySelector('.gx-timeline')!).getPropertyValue(
            '--gx-row-height',
          ),
        );
      document
        .querySelector<HTMLElement>('.gx-timeline-viewport')!
        .style.setProperty('height', (rows.length + 1) * pitch + 'px', 'important');
    });
    await page.waitForFunction(
      (before) => document.querySelectorAll('.gx-timeline-row').length > before,
      before,
    );
    expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(32);
    expect(await page.locator('.gx-timeline-cell').count()).toBeGreaterThan(0);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator('.gx-timeline[data-layout="agenda"]').waitFor();
    await page.locator('.gx-agenda-listing').first().waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('.gx-timeline[data-layout="timeline"]').waitFor();
    await page.locator('.gx-timeline-cell').first().waitFor();
    expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(32);
  } finally {
    await close(page);
  }
});
