/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expect as ui, type Page } from '@playwright/test';
import { closePhonePage, preparePhoneFixture } from '../support/phone-surface-fixture';

const phase = process.env.GENX_PHONE_REMOTE_PHASE ?? 'current';
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid compact remote evidence phase');
let fixture: Awaited<ReturnType<typeof preparePhoneFixture>>;
beforeAll(async () => {
  fixture = await preparePhoneFixture();
});
afterAll(async () => {
  await fixture?.close();
});

async function settle(page: Page) {
  await page.evaluate(async () => Reflect.get(window, 'fixture').settle());
}

async function evidence(page: Page, name: string) {
  const directory = `artifacts/phone-portrait-testing/compact-remote/${phase}`;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
  const facts = await page.evaluate(() => {
    const node = document.getElementById('retry-button')!;
    const box = node.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      root: { ...document.getElementById('app')!.dataset },
      focus: document.activeElement?.id || document.activeElement?.className,
      retry: {
        hidden: node.hidden,
        visible: node.checkVisibility(),
        rect: [box.x, box.y, box.width, box.height],
        centerOwn: node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        ),
        hits: [
          [box.x + box.width / 2, box.y + box.height / 2],
          [box.x + box.width / 2, box.y + 2],
          [box.right - 2, box.y + box.height / 2],
          [box.x + box.width / 2, box.bottom - 2],
          [box.x + 2, box.y + box.height / 2],
        ].map(([x, y]) => node.contains(document.elementFromPoint(x, y))),
      },
    };
  });
  await writeFile(`${directory}/${name}.json`, JSON.stringify(facts, null, 2), 'utf8');
  return facts;
}

for (const [width, height] of [
  [390, 844],
  [833, 397],
]) {
  it(`routes a continuous compact remote journey through Search, rows and Watch at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height, { ordinary: true, rowActions: true });
    try {
      // One initial remote entry; every following transition is an actual key.
      await page.locator('#local-button').focus();
      await page.keyboard.press('ArrowDown');
      await ui(page.locator('#phone-filter-button')).toBeFocused();
      await page.keyboard.press('Enter');
      await ui(page.locator('#phone-filter-close')).toBeFocused();
      await page.keyboard.press('Enter');
      await ui(page.locator('#phone-filter-button')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      const first = page.locator('#channel-list button[data-channel="fixture-0"]');
      await ui(first).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await ui(
        page.locator('[data-channel-id="fixture-0"][data-channel-action="manage"]'),
      ).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await ui(
        page.locator('[data-channel-id="fixture-0"][data-channel-action="favorite"]'),
      ).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await ui(first).toBeFocused();
      await page.keyboard.press('Enter');
      await settle(page);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').actions)).toEqual([
        { select: 'fixture-0' },
      ]);
      await page.keyboard.press('ArrowLeft');
      await evidence(page, `${width}x${height}-row-left`);
      await ui(page.locator('#phone-watch-button')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await ui(page.locator('#phone-filter-button')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await ui(first).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await ui(page.locator('#phone-filter-button')).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await ui(page.locator('#phone-watch-button')).toBeFocused();
      await page.keyboard.press('Enter');
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'watch');
      await ui(page.locator('#phone-browse-button')).toBeFocused();
      await page.keyboard.press('Escape');
      await ui(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
      await ui(page.locator('#phone-watch-button')).toBeFocused();
    } finally {
      await closePhonePage(page);
    }
  });

  it(`keeps long NFL summary, Clear and Guide on their logical remote row at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height);
    try {
      await page.locator('#phone-filter-button').click();
      await page.locator('#compact-filter').selectOption('sports');
      await page
        .locator('#phone-filter-dialog')
        .getByLabel('Sport', { exact: true })
        .selectOption('american-football');
      await page
        .locator('#phone-filter-dialog')
        .getByLabel('League', { exact: true })
        .selectOption('nfl');
      await page.locator('#search').fill('NFL');
      await page.locator('#search').press('Enter');
      await ui(page.locator('#phone-filter-button')).toBeFocused();
      await ui(page.locator('#phone-filter-summary')).toContainText('American Football');
      const actual: string[] = [];
      // The sheet restores the real opener. Nothing focuses a control between
      // these arrows: a wide summary must not redirect the remote into nav.
      for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
        await page.keyboard.press(key);
        actual.push(await page.evaluate(() => document.activeElement?.id ?? ''));
      }
      await evidence(page, `${width}x${height}-logical-bar`);
      await writeFile(
        `artifacts/phone-portrait-testing/compact-remote/${phase}/${width}x${height}-bar-keys.json`,
        JSON.stringify({
          viewport: [width, height],
          keys: ['Right', 'Right', 'Left', 'Left'],
          actual,
        }),
        'utf8',
      );
      expect(actual).toEqual([
        'phone-clear-filters',
        'guide-button',
        'phone-clear-filters',
        'phone-filter-button',
      ]);
    } finally {
      await closePhonePage(page);
    }
  });

  it(`paints usable Watch playback controls at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height);
    try {
      // Actual selection/dock owners expose Watch. This fixture omits main.ts,
      // so its Expand callback projects the same class, copy and pressed state
      // onto the existing shipping button; the full CSS owns both layouts.
      await page.locator('#channel-rows .channel').first().click();
      await page.locator('#phone-watch-button').click();
      await page.evaluate(() => {
        const root = document.getElementById('app')!;
        const expand = document.getElementById('expand-button')!;
        expand.addEventListener('click', () => {
          const next = !root.classList.contains('expanded');
          root.classList.toggle('expanded', next);
          expand.textContent = next ? 'Show channels' : 'Expand';
          expand.setAttribute('aria-pressed', String(next));
        });
      });
      for (const presentation of ['watch', 'expanded'] as const) {
        if (presentation === 'expanded') {
          await page.locator('#expand-button').click();
          await settle(page);
          await ui(page.locator('#app')).toHaveClass(/expanded/);
          await ui(page.locator('#expand-button')).toHaveText('Show channels');
        }
        const controls = [];
        for (const id of ['pause-button', 'mute-button', 'expand-button', 'fullscreen-button']) {
          const button = page.locator('#' + id);
          await button.focus(); // The real focus owner reveals its bounded rail.
          controls.push(
            await button.evaluate((node) => {
              const b = node as HTMLElement,
                r = b.getBoundingClientRect(),
                s = getComputedStyle(b);
              const range = document.createRange();
              range.selectNodeContents(b);
              const copy = range.getBoundingClientRect();
              const opaque = (color: string) =>
                color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
              const svg = (value: string) =>
                /url\([^)]*(?:\.svg|data:image\/svg\+xml)/i.test(value);
              const pseudo = ['::before', '::after'].map((part) => {
                const style = getComputedStyle(b, part);
                return {
                  display: style.display,
                  content: style.content,
                  glyph:
                    style.display !== 'none' &&
                    opaque(style.color) &&
                    parseFloat(style.fontSize) >= 12 &&
                    !['none', 'normal', '""', "''"].includes(style.content),
                  svg:
                    style.display !== 'none' &&
                    parseFloat(style.width) >= 12 &&
                    parseFloat(style.height) >= 12 &&
                    (svg(style.maskImage) || svg(style.backgroundImage)),
                };
              });
              return {
                id: b.id,
                text: b.textContent,
                rect: [r.x, r.y, r.width, r.height],
                fontSize: parseFloat(s.fontSize),
                readableText:
                  parseFloat(s.fontSize) >= 12 &&
                  opaque(s.color) &&
                  copy.width > 0 &&
                  copy.height > 0 &&
                  copy.left >= r.left - 0.5 &&
                  copy.right <= r.right + 0.5 &&
                  copy.top >= r.top - 0.5 &&
                  copy.bottom <= r.bottom + 0.5,
                svg: svg(s.backgroundImage),
                pseudo,
                hits: [
                  [r.x + r.width / 2, r.y + r.height / 2],
                  [r.x + 2, r.y + r.height / 2],
                  [r.right - 2, r.y + r.height / 2],
                  [r.x + r.width / 2, r.y + 2],
                  [r.x + r.width / 2, r.bottom - 2],
                ].map(([x, y]) => b.contains(document.elementFromPoint(x, y))),
              };
            }),
          );
        }
        const directory = `artifacts/phone-portrait-testing/compact-remote/${phase}`;
        await mkdir(directory, { recursive: true });
        await writeFile(
          `${directory}/${width}x${height}-${presentation}-paint.json`,
          JSON.stringify(controls, null, 2),
          'utf8',
        );
        await page.screenshot({
          path: `${directory}/${width}x${height}-${presentation}-paint.png`,
        });
        for (const control of controls) {
          expect(control.rect[2], control.id).toBeGreaterThanOrEqual(44);
          expect(control.rect[3], control.id).toBeGreaterThanOrEqual(44);
          expect(control.hits, control.id).toEqual([true, true, true, true, true]);
          expect(
            control.readableText || control.svg || control.pseudo.some((p) => p.glyph || p.svg),
            control.id + ' must paint readable copy or an actual icon, not only a gradient button',
          ).toBe(true);
        }
      }
      await page.locator('#expand-button').click();
      await ui(page.locator('#app')).not.toHaveClass(/expanded/);
      await page.locator('#phone-browse-button').click();
      await ui(page.locator('#phone-watch-button')).toBeFocused();
      await ui(page.locator('.watch-card > .dock')).toBeHidden();
    } finally {
      await closePhonePage(page);
    }
  });
}

it('removes the real failed-picture Retry from Browse focus and retains it in Watch', async () => {
  const page = await fixture.mountPage(833, 397, { ordinary: true, playing: true });
  try {
    await page.evaluate(() => {
      // Render the same failed-state flags as player-view.ts onto createShell's
      // actual picture artwork and Retry; no fake navigation target is added.
      const overlay = document.getElementById('player-overlay')!;
      overlay.hidden = false;
      overlay.dataset.art = 'failed';
      overlay.querySelector<HTMLImageElement>('.picture-image')!.src = Reflect.get(
        window,
        'Portrait',
      ).PICTURE_ART.failed;
      document.getElementById('overlay-title')!.textContent = 'Could not connect';
      document.getElementById('overlay-message')!.textContent =
        'Try this stream again, or choose another channel.';
      document.getElementById('retry-button')!.hidden = false;
      document.getElementById('picture-resume')!.hidden = true;
      document.getElementById('playback-status')!.textContent = 'Unable to play';
      document.getElementById('pause-button')!.setAttribute('disabled', '');
    });
    const before = await evidence(page, 'failed-browse');
    expect(before.retry.visible, 'the tiny failed thumbnail must not offer a focus target').toBe(
      false,
    );
    await page.locator('#local-button').focus();
    await page.keyboard.press('ArrowDown');
    await ui(page.locator('#phone-filter-button')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await ui(page.locator('#phone-watch-button')).toBeFocused();
    await page.keyboard.press('Enter');
    await ui(page.locator('#phone-browse-button')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await ui(page.locator('#retry-button')).toBeFocused();
    const after = await evidence(page, 'failed-watch');
    expect(after.retry.visible).toBe(true);
    expect(after.retry.centerOwn).toBe(true);
    expect(after.retry.rect[2]).toBeGreaterThanOrEqual(44);
    expect(after.retry.rect[3]).toBeGreaterThanOrEqual(44);
    expect(after.retry.hits).toEqual([true, true, true, true, true]);
    await page.keyboard.press('Escape');
    await ui(page.locator('#phone-watch-button')).toBeFocused();
    await ui(page.locator('#retry-button')).toBeHidden();
  } finally {
    await closePhonePage(page);
  }
});

it('keeps the visible list anchor on opener Down and leaves editor/modal keys to their owners', async () => {
  const page = await fixture.mountPage(833, 397, { ordinary: true });
  try {
    await page.locator('#channel-list button[data-channel="fixture-0"]').focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    const anchor = await page.locator('#channel-list').evaluate((node) => node.scrollTop);
    expect(anchor).toBeGreaterThan(0);
    await page.locator('#phone-filter-button').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#channel-list').evaluate((node) => node.scrollTop)).toBe(anchor);
    expect(
      await page.evaluate(() => document.activeElement?.closest('#channel-list') !== null),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-channel')),
    ).not.toBe('fixture-0');
    await page.locator('#phone-filter-button').focus();
    await page.keyboard.press('Enter');
    const search = page.locator('#search');
    // Pointer entry owns native caret editing; D-pad entry deliberately keeps
    // the app's existing remote edit mode until the user chooses to edit.
    await search.click();
    await search.fill('public');
    await search.press('End');
    await search.press('ArrowLeft');
    await ui(search).toBeFocused();
    expect(await search.evaluate((node) => (node as HTMLInputElement).selectionStart)).toBe(5);
    await search.press('Enter');
    await ui(page.locator('#phone-filter-button')).toBeFocused();
    await page.locator('#settings-button').click();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#settings-dialog'))).toBe(
      true,
    );
    await ui(page.locator('#phone-watch-button')).not.toBeFocused();
  } finally {
    await closePhonePage(page);
  }
});

it('leaves native Back to an expanded presentation owner before returning Watch to channels', async () => {
  const page = await fixture.mountPage(833, 397);
  try {
    await page.locator('#channel-rows .channel').first().click();
    await page.locator('#phone-watch-button').click();
    const result = await page.evaluate(() => {
      const root = document.getElementById('app')!;
      // This fixture does not mount main.ts's Expand button owner. Seed its
      // exact presentation flag, then observe the real phone capture handler
      // before a later presentation owner. This tests priority, not main's
      // separate implementation of Expanded/Back.
      root.classList.add('expanded');
      const events: { prevented: boolean; view: string | undefined; expanded: boolean }[] = [];
      const presentationBack = (event: Event) => {
        events.push({
          prevented: event.defaultPrevented,
          view: root.dataset.phoneView,
          expanded: root.classList.contains('expanded'),
        });
        if (!event.defaultPrevented && root.classList.contains('expanded')) {
          root.classList.remove('expanded');
          event.preventDefault();
        }
      };
      window.addEventListener('native-back-requested', presentationBack);
      window.dispatchEvent(new Event('native-back-requested', { cancelable: true }));
      const first = { view: root.dataset.phoneView, expanded: root.classList.contains('expanded') };
      window.dispatchEvent(new Event('native-back-requested', { cancelable: true }));
      const second = {
        view: root.dataset.phoneView,
        expanded: root.classList.contains('expanded'),
      };
      window.removeEventListener('native-back-requested', presentationBack);
      return { events, first, second };
    });
    expect(result.events[0]).toEqual({ prevented: false, view: 'watch', expanded: true });
    expect(result.first).toEqual({ view: 'watch', expanded: false });
    expect(result.events[1]).toEqual({ prevented: true, view: 'browse', expanded: false });
    expect(result.second).toEqual({ view: 'browse', expanded: false });
    await ui(page.locator('#phone-watch-button')).toBeFocused();
  } finally {
    await closePhonePage(page);
  }
});
