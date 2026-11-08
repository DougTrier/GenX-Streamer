/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expect as ui, type Page } from '@playwright/test';
import { closePhonePage, preparePhoneFixture } from '../support/phone-surface-fixture';

const phase = process.env.GENX_PHONE_SURFACE_PHASE ?? 'current';
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid phone surface evidence phase');

let fixture: Awaited<ReturnType<typeof preparePhoneFixture>>;
beforeAll(async () => {
  fixture = await preparePhoneFixture();
});
afterAll(async () => {
  await fixture?.close();
});

async function settle(page: Page) {
  await page.evaluate(async () => {
    await Reflect.get(window, 'fixture').settle();
  });
}

async function captureSurface(page: Page, name: string) {
  const directory = `artifacts/phone-portrait-testing/surface-matrix/${phase}`;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
  const facts = await page.evaluate(() => {
    const result: Record<string, unknown> = {
      viewport: [innerWidth, innerHeight],
      root: { ...document.getElementById('app')!.dataset },
    };
    for (const selector of [
      '.view',
      '.browser',
      '#channel-list',
      '.watch-card',
      '#screen',
      '#account-vod',
      '#vod-gallery',
      '.vod-play',
      '.gx-timeline-toolbar',
      '[aria-label="Close guide"]',
    ]) {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      const parent = node.parentElement!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(node);
      const copy = text.getBoundingClientRect();
      result[selector] = {
        rect: [r.x, r.y, r.width, r.height],
        visible: node.checkVisibility(),
        parent: [parent.x, parent.y, parent.width, parent.height],
        client: [node.clientWidth, node.clientHeight],
        copy: [copy.x, copy.y, copy.width, copy.height],
        centerHit: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      };
    }
    return result;
  });
  await writeFile(`${directory}/${name}.json`, JSON.stringify(facts, null, 2));
}

async function readableNavigation(page: Page) {
  for (const id of [
    'live-tv-button',
    'paid-tv-button',
    'genxtra-button',
    'local-button',
    'cast-button',
    'settings-button',
  ]) {
    await page.locator('#' + id).focus();
    const actual = await page.locator('#' + id).evaluate((node) => {
      const el = node as HTMLElement,
        r = el.getBoundingClientRect(),
        style = getComputedStyle(el);
      const owner = el.closest<HTMLElement>('.top-actions')!;
      const frame = owner.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        font: parseFloat(style.fontSize),
        color: style.color,
        text: el.innerText.trim() || getComputedStyle(el, '::after').content.replaceAll('"', ''),
        contained: r.left >= frame.left - 0.5 && r.right <= frame.left + owner.clientWidth + 0.5,
        visibleHeight: innerHeight,
      };
    });
    expect(actual.width, id).toBeGreaterThanOrEqual(44);
    expect(actual.height, id).toBeGreaterThanOrEqual(44);
    expect(
      actual.font,
      id + ' must retain readable text, not only a valid box',
    ).toBeGreaterThanOrEqual(13);
    expect(actual.color, id).not.toBe('rgba(0, 0, 0, 0)');
    expect(actual.text, id).not.toMatch(/^(|none|normal)$/);
    expect(actual.contained, id + ' focus must reveal the complete label').toBe(true);
    expect(actual.top, id).toBeGreaterThanOrEqual(0);
    expect(actual.bottom, id).toBeLessThanOrEqual(actual.visibleHeight);
  }
}

async function realCards(page: Page, surface: 'live' | 'archive' = 'live') {
  return page.evaluate((surface) => {
    const owner = document.querySelector<HTMLElement>(
      surface === 'archive' ? '#genxtra-library' : '#channel-list',
    )!;
    const list = owner.getBoundingClientRect(),
      browser = owner.closest<HTMLElement>('.browser')!.getBoundingClientRect();
    const footerNode = document.querySelector<HTMLElement>('.app-signoff')!;
    const footer = footerNode.getBoundingClientRect();
    const footerTop = footerNode.checkVisibility() && footer.height > 0 ? footer.top : innerHeight;
    const top = Math.max(0, list.top, browser.top),
      bottom = Math.min(innerHeight, list.bottom, browser.bottom, footerTop);
    const selector = surface === 'archive' ? '.gx-archive-title-button' : '.channel';
    const rows = [...owner.querySelectorAll<HTMLElement>(selector)].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        text: node.innerText,
        width: r.width,
        height: r.height,
        top: r.top,
        bottom: r.bottom,
        complete: r.width > 0 && r.height >= 44 && r.top >= top - 0.5 && r.bottom <= bottom + 0.5,
      };
    });
    return {
      top,
      bottom,
      height: bottom - top,
      rows,
      complete: rows.filter((row) => row.complete).length,
      outer:
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight + 1,
    };
  }, surface);
}

for (const [width, height] of [
  [320, 640],
  [360, 780],
  [390, 844],
  [412, 915],
]) {
  it(`keeps real Free/Paid mock and GenXtra content reachable at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height);
    try {
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
      await readableNavigation(page);
      for (const surface of ['free', 'paid'] as const) {
        await page.locator(surface === 'paid' ? '#paid-tv-button' : '#live-tv-button').click();
        await settle(page);
        await ui
          .poll(() => page.locator('#channel-rows .channel').count())
          .toBeGreaterThanOrEqual(2);
        const cards = await realCards(page);
        expect(cards.outer).toBe(true);
        expect(cards.complete, surface + ' actual row bodies').toBeGreaterThanOrEqual(2);
        expect(cards.rows[0].text).toContain('Boston College');
        await page.locator('#phone-filter-button').click();
        await page.locator('#search').fill('NFL');
        await ui(page.locator('#search')).toBeFocused();
        await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
        await page.getByRole('button', { name: 'Show channels', exact: true }).click();
        await ui(page.locator('#phone-filter-dialog')).toBeHidden();
        await ui(page.locator('#phone-filter-summary')).toContainText('NFL');
        await ui(page.locator('#channel-list')).toBeVisible();
        await page.locator('#phone-filter-summary').click();
        await page.locator('#clear-search').click();
        await ui(page.locator('#search')).toHaveValue('');
        await page.getByRole('button', { name: 'Show channels', exact: true }).click();
      }
      await page.locator('#genxtra-button').click();
      await ui(page.locator('.gx-archive-title-button')).toHaveCount(6);
      await page.locator('#phone-filter-button').click();
      const archiveSheet = page.locator('#phone-filter-dialog');
      await ui(
        archiveSheet.getByRole('combobox', { name: 'GenXtra content', exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await ui(
        archiveSheet.getByRole('combobox', { name: 'GenXtra source-listed decade', exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.getByRole('button', { name: 'Show channels', exact: true }).click();
      const archive = await realCards(page, 'archive');
      expect(archive.complete, 'real archive title buttons').toBeGreaterThanOrEqual(2);
      expect(archive.outer).toBe(true);
      await page.locator('.gx-archive-title-button').first().click();
      await ui(page.locator('.gx-archive-file-row')).toHaveCount(1);
      const fileAction = page.locator('.gx-archive-file-button');
      await fileAction.focus();
      await ui(fileAction).toBeInViewport({ ratio: 1 });
      const fileBox = await fileAction.boundingBox();
      expect(fileBox!.width).toBeGreaterThanOrEqual(44);
      expect(fileBox!.height).toBeGreaterThanOrEqual(44);
      if (height > width) {
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#archive-details')!.dataset.playbackActive = 'true';
          document.querySelector<HTMLElement>('#app')!.dataset.playerIdle = 'false';
        });
        await page.locator('#phone-watch-button').click();
        const picture = await page.locator('.watch-card > .screen').boundingBox();
        expect(picture?.height ?? 0, 'active archive picture in Watch').toBeGreaterThan(120);
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#archive-details')!.dataset.playbackActive = 'false';
          document.querySelector<HTMLElement>('#app')!.dataset.playerIdle = 'true';
        });
        await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
        await ui(fileAction).toBeVisible();
      }
      await page.locator('#live-tv-button').click();
      await settle(page);
      await ui(page.locator('#channel-list')).toBeVisible();
    } finally {
      await closePhonePage(page);
    }
  });
}

it('owns Filters, native IME and Back without losing scope or hiding the active field at 360x640', async () => {
  const page = await fixture.mountPage(360, 640);
  try {
    await page.evaluate(() =>
      Reflect.set(window, 'originalBrowseOptions', document.querySelector('.browse-options')),
    );
    await page.locator('#phone-filter-button').click();
    const sheet = page.locator('#phone-filter-dialog');
    await ui(sheet).toBeVisible();
    await sheet.locator('#compact-filter').selectOption('sports');
    await sheet
      .getByRole('combobox', { name: 'Sport', exact: true })
      .selectOption('american-football');
    await sheet.getByRole('combobox', { name: 'League', exact: true }).selectOption('nfl');
    await page.keyboard.press('Escape');
    await ui(sheet).toBeHidden();
    await ui(page.locator('#phone-filter-button')).toBeFocused();
    // Native dialog visibility/focus changes precede its asynchronous close event.
    // Join the actual node-return condition rather than sampling before that callback.
    await ui
      .poll(() =>
        page.evaluate(
          () =>
            Reflect.get(window, 'originalBrowseOptions') ===
            document.querySelector('.browser > .browse-options'),
        ),
      )
      .toBe(true);
    await ui(page.locator('#compact-filter')).toHaveCount(1);
    await ui(page.locator('#phone-filter-summary')).toContainText('NFL');
    await page.locator('#phone-filter-summary').click();
    await page.locator('#search').fill('NFL');
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: true,
            bottomPx: 300,
            overlapPx: 300,
            webViewHeightPx: 640,
            sequence: 1,
          },
        }),
      ),
    );
    await ui(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await ui(page.locator('#app')).not.toHaveClass(/keyboard-open/);
    await ui(page.locator('#search')).toBeFocused();
    await ui(page.locator('#search')).toBeInViewport({ ratio: 1 });
    await ui(page.locator('#clear-search')).toBeInViewport({ ratio: 1 });
    await ui(page.getByRole('button', { name: 'Show channels', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: false,
            bottomPx: 0,
            overlapPx: 0,
            webViewHeightPx: 640,
            sequence: 2,
          },
        }),
      ),
    );
    await ui(page.locator('#app')).not.toHaveClass(/keyboard-open/);
    await ui(page.locator('#search')).toHaveValue('NFL');
    await page.locator('#search').press('Enter');
    await ui(sheet).toBeHidden();
    await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
    const before = await page.locator('#channel-list').evaluate((node) => node.scrollTop);
    await page.locator('#phone-filter-button').click();
    await sheet.getByRole('button', { name: 'Location and sort', exact: true }).click();
    const location = page.getByRole('dialog', { name: 'Location and sort', exact: true });
    await ui(location).toBeVisible();
    await page.keyboard.press('Escape');
    await ui(location).toBeHidden();
    await ui(sheet).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new Event('native-back-requested', { cancelable: true })),
    );
    await ui(sheet).toBeHidden();
    await ui(page.locator('#phone-filter-button')).toBeFocused();
    expect(await page.locator('#channel-list').evaluate((node) => node.scrollTop)).toBe(before);
  } finally {
    await closePhonePage(page);
  }
});

it('Clear uses the actual active-library reset and retains the other live tab', async () => {
  const page = await fixture.mountPage(390, 844);
  try {
    await page.locator('#phone-filter-button').click();
    const sheet = page.locator('#phone-filter-dialog');
    await sheet.locator('#compact-filter').selectOption('sports');
    await sheet
      .getByRole('combobox', { name: 'Sport', exact: true })
      .selectOption('american-football');
    await sheet.getByRole('combobox', { name: 'League', exact: true }).selectOption('nfl');
    await sheet.locator('#search').fill('NFL');
    await sheet.getByRole('button', { name: 'Location and sort', exact: true }).click();
    const location = page.getByRole('dialog', { name: 'Location and sort', exact: true });
    await location.locator('button[data-code="US"]').click();
    await location
      .getByRole('combobox', { name: 'Channel sort', exact: true })
      .selectOption('name');
    await location.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Show channels', exact: true }).click();
    await page.locator('#paid-tv-button').click();
    await settle(page);
    await page.locator('#phone-filter-button').click();
    await sheet.locator('#compact-filter').selectOption('news');
    await sheet.locator('#search').fill('Public');
    await page.getByRole('button', { name: 'Show channels', exact: true }).click();
    await page.locator('#live-tv-button').click();
    await settle(page);
    await ui(page.locator('#search')).toHaveValue(/^nfl$/i);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await ui(sheet).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').cb.getBrowseState())).toEqual({
      filter: 'all',
      query: '',
      sportsFacet: {},
      geography: {},
      sort: 'source',
    });
    await page.locator('#paid-tv-button').click();
    await settle(page);
    await ui(page.locator('#search')).toHaveValue(/^public$/i);
    await ui(page.locator('#compact-filter')).toHaveValue('news');
    await page.locator('#live-tv-button').click();
    await settle(page);
    await ui(page.locator('#search')).toHaveValue('');
    await page.locator('#genxtra-button').click();
    await page.locator('#phone-filter-button').click();
    await sheet.getByRole('combobox', { name: 'GenXtra content', exact: true }).selectOption('tv');
    await sheet
      .getByRole('combobox', { name: 'GenXtra source-listed decade', exact: true })
      .selectOption('2020');
    await sheet.locator('#search').fill('Readable');
    await page.getByRole('button', { name: 'Show channels', exact: true }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await ui(page.locator('#search')).toHaveValue('');
    await ui(page.locator('#genxtra-kind-select')).toHaveValue('all');
    await ui(page.locator('#genxtra-decade-select')).toHaveValue('all');
  } finally {
    await closePhonePage(page);
  }
});

for (const [width, height] of [
  [570, 320],
  [320, 480],
]) {
  it(`keeps a complete rich card and its own scrolling reachable at ${width}x${height}`, async () => {
    if (width === 570) {
      const ordinary = await fixture.mountPage(width, height, { ordinary: true });
      try {
        expect((await realCards(ordinary)).complete).toBeGreaterThanOrEqual(2);
      } finally {
        await closePhonePage(ordinary);
      }
    }
    const page = await fixture.mountPage(width, height);
    try {
      if (width === 570) {
        const browser = await page.locator('.browser').boundingBox();
        expect(browser!.width).toBeGreaterThanOrEqual(width - 16);
      }
      const cards = await realCards(page);
      expect(cards.complete).toBeGreaterThanOrEqual(1);
      expect(cards.outer).toBe(true);
      await page.locator('#channel-rows .channel').nth(1).focus();
      await page.keyboard.press('ArrowDown');
      const scroller = await page.locator('#channel-list').evaluate((node) => ({
        top: node.scrollTop,
        height: node.clientHeight,
        total: node.scrollHeight,
      }));
      expect(scroller.height).toBeGreaterThan(0);
      expect(scroller.total).toBeGreaterThan(scroller.height);
      expect(scroller.top).toBeGreaterThan(0);
      await ui(page.getByRole('button', { name: 'Clear filters', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await page.locator('#phone-filter-button').click();
      await ui(page.getByRole('button', { name: 'Show channels', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await page.keyboard.press('Escape');
      await ui(page.locator('#channel-list')).toBeVisible();
    } finally {
      await closePhonePage(page);
    }
  });
}

it('keeps explicit Watch reversible and Guide, Web and Settings actions reachable', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    await page.locator('#phone-watch-button').click();
    await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'watch');
    await ui(page.locator('#screen')).toBeVisible();
    await ui(page.locator('#phone-browse-button')).toBeInViewport({ ratio: 1 });
    await page.evaluate(() =>
      window.dispatchEvent(new Event('native-back-requested', { cancelable: true })),
    );
    await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
    await page.locator('#guide-button').click();
    const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
    await ui(guide).toBeVisible();
    const close = guide.getByRole('button', { name: 'Close guide', exact: true });
    await close.focus();
    await ui(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await ui(guide).toBeHidden();
    await ui(page.locator('#guide-button')).toBeFocused();
    await page.locator('#local-button').click();
    await ui(page.locator('#local-streams')).toBeVisible();
    await ui(
      page.getByRole('textbox', { name: 'Area code or ZIP code', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page
      .locator('#local-streams')
      .getByRole('button', { name: 'Websites', exact: true })
      .click();
    const address = page.getByRole('textbox', { name: 'Website address or search', exact: true });
    await address.fill('https://phone.fixture.invalid/not-opened');
    await ui(address).toBeFocused();
    await ui(address).toBeInViewport({ ratio: 1 });
    await ui(
      page.locator('#local-streams').getByRole('button', { name: 'Go', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.locator('#live-tv-button').click();
    await ui(page.locator('#local-streams')).toBeHidden();
    await page.locator('#settings-button').click();
    const settings = page.locator('#settings-dialog');
    await ui(settings).toBeVisible();
    await ui(settings).toBeInViewport({ ratio: 1 });
    const closeSettings = settings.getByRole('button', { name: 'Close settings', exact: true });
    await ui(closeSettings).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await ui(settings).toBeHidden();
    await ui(page.locator('#channel-list')).toBeVisible();
  } finally {
    await closePhonePage(page);
  }
});

for (const [width, height] of [
  [390, 844],
  [833, 397],
]) {
  it(`keeps Watch and Pause pointer targets clear during live presentation at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height);
    try {
      // Actual ChannelBrowser selection enters the same dock presentation owner
      // installed by ShellSetup; no decoder or remote stream is started here.
      await page.locator('#channel-rows .channel').first().click();
      await settle(page);
      await ui(page.locator('#app')).toHaveAttribute('data-play-mode', 'live');
      await ui(page.locator('#app')).toHaveAttribute('data-player-idle', 'false');
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
      const facts = await page.evaluate(() => {
        const controls = ['phone-watch-button', 'phone-pause-button'].map((id) => {
          const node = document.getElementById(id) as HTMLButtonElement;
          const r = node.getBoundingClientRect();
          const points = [
            ['center', r.x + r.width / 2, r.y + r.height / 2],
            ['left', r.x + 2, r.y + r.height / 2],
            ['right', r.right - 2, r.y + r.height / 2],
            ['top', r.x + r.width / 2, r.top + 2],
            ['bottom', r.x + r.width / 2, r.bottom - 2],
          ] as const;
          return {
            id,
            visible: node.checkVisibility(),
            disabled: node.disabled,
            rect: [r.x, r.y, r.width, r.height],
            hits: points.map(([point, x, y]) => {
              const hit = document.elementFromPoint(x, y);
              return {
                point,
                own: node.contains(hit),
                hit: hit?.id || hit?.className || hit?.tagName || null,
              };
            }),
          };
        });
        const dock = document.querySelector<HTMLElement>('.watch-card > .dock')!;
        const r = dock.getBoundingClientRect();
        return {
          root: { ...document.getElementById('app')!.dataset },
          controls,
          dock: {
            display: getComputedStyle(dock).display,
            rect: [r.x, r.y, r.width, r.height],
          },
        };
      });
      const directory = `artifacts/phone-portrait-testing/surface-matrix/${phase}`;
      await mkdir(directory, { recursive: true });
      const name = `${width}x${height}-live-presentation-targets`;
      await writeFile(`${directory}/${name}.json`, JSON.stringify(facts, null, 2));
      await page.screenshot({ path: `${directory}/${name}.png` });
      for (const control of facts.controls) {
        expect(control.visible, control.id).toBe(true);
        expect(control.disabled, control.id).toBe(false);
        expect(control.rect[2], control.id).toBeGreaterThanOrEqual(44);
        expect(control.rect[3], control.id).toBeGreaterThanOrEqual(44);
        for (const hit of control.hits) {
          expect(hit.own, `${control.id} ${hit.point} intercepted by ${hit.hit}`).toBe(true);
        }
      }
      await page.locator('#phone-watch-button').click();
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'watch');
      const dockCopy = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.watch-card > .dock button')]
          .filter((button) => button.checkVisibility())
          .map((button) => {
            const bounds = button.getBoundingClientRect();
            const texts = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            const paint = [];
            while (texts.nextNode()) {
              const node = texts.currentNode;
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of range.getClientRects()) {
                if (r.width === 0 || r.height === 0) continue;
                paint.push({
                  text: node.textContent,
                  contained:
                    r.left >= bounds.left - 0.5 &&
                    r.right <= bounds.right + 0.5 &&
                    r.top >= bounds.top - 0.5 &&
                    r.bottom <= bounds.bottom + 0.5,
                });
              }
            }
            return {
              id: button.id || button.className,
              height: bounds.height,
              width: bounds.width,
              paint,
            };
          }),
      );
      expect(dockCopy.length).toBeGreaterThanOrEqual(4);
      for (const button of dockCopy) {
        expect(button.width, button.id).toBeGreaterThanOrEqual(44);
        expect(button.height, button.id).toBeGreaterThanOrEqual(44);
        for (const text of button.paint)
          expect(text.contained, `${button.id} painted text: ${text.text}`).toBe(true);
      }
      await page.locator('#phone-browse-button').click();
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
      await ui(page.locator('#phone-watch-button')).toBeFocused();
    } finally {
      await closePhonePage(page);
    }
  });
}

it('keeps Paid movie filters, title actions and return to channels usable on portrait', async () => {
  const page = await fixture.mountPage(390, 844);
  try {
    await page.locator('#paid-tv-button').click();
    await settle(page);
    await page.locator('#phone-filter-button').click();
    await page.getByRole('button', { name: 'Video On Demand', exact: true }).click();
    await ui(page.locator('#phone-filter-dialog')).toBeHidden();
    await settle(page);
    await captureSurface(page, '390x844-paid-gallery');
    await ui(page.locator('#account-vod')).toBeVisible();
    await ui(page.locator('#vod-gallery')).toBeVisible();
    const movie = page.locator('.vod-title').first();
    await ui(movie).toBeVisible();
    await movie.focus();
    await ui(movie).toBeInViewport({ ratio: 1 });
    const play = page.locator('.vod-play');
    await ui(play).toBeInViewport({ ratio: 1 });
    const box = await play.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Back to channels', exact: true }).click();
    await ui(page.locator('#vod-gallery')).toBeHidden();
    await ui(page.locator('#channel-list')).toBeVisible();
  } finally {
    await closePhonePage(page);
  }
});

it('keeps saved scan actions above the scrollable channel list on a phone', async () => {
  const page = await fixture.mountPage(697, 330);
  try {
    const panel = page.locator('#inline-source-scan');
    await panel.evaluate((element) => {
      element.innerHTML =
        '<p>Saved scan | 665 of 1669 checked | 56 saved.</p><div class="inline-scan-actions"><button>Finish scan</button><button>Rescan</button><button>Close</button></div>';
      (element as HTMLElement).hidden = false;
    });
    for (const label of ['Finish scan', 'Rescan', 'Close']) {
      await panel.getByRole('button', { name: label }).click({ trial: true });
    }
    const scan = (await panel.boundingBox())!;
    const channels = (await page.locator('#channel-list').boundingBox())!;
    expect(scan.y + scan.height).toBeLessThanOrEqual(channels.y);
    expect(channels.height).toBeGreaterThan(0);
  } finally {
    await closePhonePage(page);
  }
});

it('keeps phone Watch and buffer buttons reachable near their edges', async () => {
  const page = await fixture.mountPage(360, 640, { playing: true });
  try {
    await page.locator('#phone-watch-button').click();
    const buttons = await page
      .locator(
        '.watch-card .dock button:visible:enabled, #stream-buffer-footer button:visible:enabled',
      )
      .all();
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      for (const position of [
        { x: 3, y: bounds.height / 2 },
        { x: bounds.width - 3, y: bounds.height / 2 },
        { x: bounds.width / 2, y: 3 },
        { x: bounds.width / 2, y: bounds.height - 3 },
      ])
        await button.click({ position, trial: true });
    }
  } finally {
    await closePhonePage(page);
  }
});

it('acknowledged fullscreen keeps the large picture and controls, then restores browsing', async () => {
  const page = await fixture.mountPage(360, 640, { playing: true });
  try {
    await page.locator('#phone-watch-button').focus();
    await page.evaluate(() => Reflect.get(window, 'fixture').fullscreen.set(true));
    await ui(page.locator('#app')).toHaveClass(/viewing-fullscreen/);
    const screen = await page.locator('#screen').boundingBox();
    expect(screen!.width).toBeGreaterThanOrEqual(340);
    expect(screen!.height).toBeGreaterThanOrEqual(320);
    const exit = page.locator('#fullscreen-button');
    await exit.focus();
    await ui(exit).toBeInViewport({ ratio: 1 });
    await ui(page.locator('.stream-buffer-fullscreen')).toBeVisible();
    const dock = await page.locator('.dock').evaluate((element) => {
      const buttons = [...element.querySelectorAll<HTMLElement>('button')].filter((button) =>
        button.checkVisibility(),
      );
      const buffer = element.querySelector<HTMLElement>('.stream-buffer-meter')!;
      return {
        horizontalOverflow: element.scrollWidth > element.clientWidth,
        buttonHeights: [...new Set(buttons.map((button) => button.offsetHeight))],
        buttonsHitNearEdges: buttons
          .filter((button) => !button.matches(':disabled'))
          .every((button) => {
            const rect = button.getBoundingClientRect();
            return [rect.left + 3, rect.right - 3].every((x) =>
              [rect.top + 3, rect.bottom - 3].every((y) =>
                button.contains(document.elementFromPoint(x, y)),
              ),
            );
          }),
        bufferHeight: buffer.offsetHeight,
        bufferTextWrap: getComputedStyle(buffer.querySelector('.stream-buffer-readout')!)
          .whiteSpace,
      };
    });
    expect(dock).toEqual({
      horizontalOverflow: false,
      buttonHeights: [44],
      buttonsHitNearEdges: true,
      bufferHeight: 24,
      bufferTextWrap: 'nowrap',
    });
    await page.evaluate(() => Reflect.get(window, 'fixture').fullscreen.set(false));
    await ui(page.locator('#app')).not.toHaveClass(/viewing-fullscreen/);
    await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
    await ui(page.locator('#phone-watch-button')).toBeFocused();
    expect((await realCards(page)).complete).toBeGreaterThanOrEqual(2);
  } finally {
    await closePhonePage(page);
  }
});

for (const [width, height, deviceKind] of [
  [640, 360, 'personal'],
  [833, 397, 'personal'],
  [854, 432, 'personal'],
  [960, 540, 'personal'],
  [960, 540, 'tv'],
] as const) {
  it(`keeps handheld/TV browsing available at ${width}x${height} ${deviceKind}`, async () => {
    const page = await fixture.mountPage(width, height, { deviceKind, playing: true });
    try {
      if (deviceKind === 'personal') {
        await page.locator('#phone-filter-button').click();
        const sheet = page.locator('#phone-filter-dialog');
        await sheet.locator('#compact-filter').selectOption('sports');
        await sheet
          .getByRole('combobox', { name: 'Sport', exact: true })
          .selectOption('american-football');
        await sheet.locator('#search').fill('NFL');
        await page.getByRole('button', { name: 'Show channels', exact: true }).click();
        await ui(sheet).toBeHidden();
      } else {
        await page.evaluate(() => {
          const f = Reflect.get(window, 'fixture');
          f.choose('sports');
          f.cb.setSportsFacet({ sport: 'american-football' });
          const input = document.getElementById('search') as HTMLInputElement;
          input.value = 'NFL';
          input.dispatchEvent(new Event('input'));
        });
      }
      await settle(page);
      await ui(page.locator('#channel-list')).toBeVisible();
      if (width === 640 && deviceKind === 'personal') {
        const browser = await page.locator('.browser').boundingBox();
        expect(browser!.width).toBeGreaterThanOrEqual(width - 16);
      }
      await ui(page.locator('#search')).toHaveValue('NFL');
      const cards = await realCards(page);
      const evidence = `artifacts/phone-portrait-testing/surface-matrix/${phase}`;
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${width}x${height}-${deviceKind}.png` });
      const composition = await page.evaluate(() => {
        const result: Record<string, unknown> = {
          root: { ...document.getElementById('app')!.dataset },
        };
        for (const selector of [
          '.topbar',
          '.view',
          '.browser',
          '.search-controls',
          '.browse-options',
          '#sports-filters',
          '.sidehead',
          '#channel-list',
          '.app-signoff',
        ]) {
          const node = document.querySelector<HTMLElement>(selector)!;
          const r = node.getBoundingClientRect();
          result[selector] = {
            rect: [r.x, r.y, r.width, r.height],
            visible: node.checkVisibility(),
            scrollTop: node.scrollTop,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
          };
        }
        return result;
      });
      await writeFile(
        `${evidence}/${width}x${height}-${deviceKind}.json`,
        JSON.stringify({ width, height, deviceKind, cards, composition }, null, 2),
      );
      expect(cards.complete, 'actual matched cards above the footer').toBeGreaterThanOrEqual(
        deviceKind === 'tv' ? 1 : 2,
      );
      expect(cards.outer).toBe(true);
      await page.locator('#guide-button').click();
      const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
      await ui(guide).toBeVisible();
      if (width === 640) {
        await settle(page);
        await captureSurface(page, '640x360-guide-open');
        await writeFile(
          `artifacts/phone-portrait-testing/surface-matrix/${phase}/640x360-guide-buttons.json`,
          JSON.stringify(
            await guide.locator('button').evaluateAll((nodes) =>
              nodes.map((node) => ({
                text: node.textContent,
                aria: node.getAttribute('aria-label'),
                visible: (node as HTMLElement).checkVisibility(),
                rect: [
                  node.getBoundingClientRect().x,
                  node.getBoundingClientRect().y,
                  node.getBoundingClientRect().width,
                  node.getBoundingClientRect().height,
                ],
              })),
            ),
            null,
            2,
          ),
        );
      }
      const foldedControls = guide.getByRole('button', { name: 'Guide controls', exact: true });
      if (await foldedControls.isVisible()) {
        const bounds = await foldedControls.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        await foldedControls.click();
      }
      const close = guide.getByRole('button', { name: 'Close guide', exact: true });
      await close.focus();
      await captureSurface(page, `${width}x${height}-${deviceKind}-guide-close`);
      const geometry = await close.evaluate((node) => {
        const r = node.getBoundingClientRect(),
          owner = node.parentElement!,
          frame = owner.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          inside:
            r.x >= Math.max(0, frame.x) - 0.5 &&
            r.right <= Math.min(innerWidth, frame.x + owner.clientWidth) + 0.5 &&
            r.y >= 0 &&
            r.bottom <= innerHeight,
          textInside:
            text.x >= frame.x &&
            text.right <= frame.x + owner.clientWidth &&
            text.y >= r.y &&
            text.bottom <= r.bottom,
          hit: [r.top + 3, r.bottom - 3, r.y + r.height / 2].every((y) =>
            node.contains(document.elementFromPoint(r.x + r.width / 2, y)),
          ),
        };
      });
      // Preserve the explicit compact TV control policy; personal targets stay 44px.
      const minimum = deviceKind === 'tv' ? 34 : 44;
      expect(geometry.width).toBeGreaterThanOrEqual(minimum);
      expect(geometry.height).toBeGreaterThanOrEqual(minimum);
      expect(geometry.inside).toBe(true);
      expect(geometry.textInside).toBe(true);
      expect(geometry.hit).toBe(true);
      await close.click();
      await ui(guide).toBeHidden();
      await ui(page.locator('#guide-button')).toBeFocused();
    } finally {
      await closePhonePage(page);
    }
  });
}
