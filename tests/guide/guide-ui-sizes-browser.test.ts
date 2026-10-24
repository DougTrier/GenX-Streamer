/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Guide screen in a real browser: screen sizes, force reload, agenda
 * activation and Map hydration.
 */
import { expect, it } from 'vitest';
import { readStylesheet } from '../support/stylesheet';
import { useGuideUiBrowser, fixture, dispose, open } from './guide-ui-browser.fixture';

useGuideUiBrowser();

for (const size of [
  // Dense right-panel rows on a TV: at least fifteen channels at once, like a
  // set-top guide (the picture sits above the channel list instead).
  // Twelve rows fill the TV guide (owner request, October 19, 2026).
  { width: 960, height: 540, enlarged: false, deviceKind: 'tv', completeRows: 12 },
  // Twelve rows fill the TV guide (owner request, October 19, 2026).
  { width: 1280, height: 720, enlarged: false, deviceKind: 'tv', completeRows: 12 },
  { width: 854, height: 432, enlarged: false, deviceKind: 'personal', completeRows: 3 },
  { width: 320, height: 640, enlarged: true, deviceKind: 'personal', completeRows: 0 },
  { width: 390, height: 844, enlarged: true, deviceKind: 'personal', completeRows: 0 },
  { width: 640, height: 360, enlarged: true, deviceKind: 'personal', completeRows: 0 },
]) {
  // The Guide sits in the right panel beside the channel list: the grid needs
  // a panel of at least PANEL_AGENDA_WIDTH, which an 854-wide screen lacks.
  it(`normal Guide uses the real shell with readable ${size.width < 900 ? 'agenda' : 'grid'} ${size.width}x${size.height}`, async () => {
    const page = await fixture(false, true);
    try {
      await page.setViewportSize(size);
      await page.addStyleTag({
        content: (
          await Promise.all(
            [
              'style',
              'management',
              'guide',
              'guide-timeline',
              'responsive',
              'in-app-select',
              'modal-viewport',
              'guide-panel',
              // The TV's compact-control rules, which once made cells spill.
              ...(size.deviceKind === 'tv' ? ['tv-density'] : []),
            ].map((name) => readStylesheet(`src/ui/${name}.css`)),
          )
        ).join('\n'),
      });
      await page.addScriptTag({
        content: `
        await window.guide.dispose();
        const app=document.getElementById('guide');app.id='app';app.dataset.deviceKind=${JSON.stringify(size.deviceKind)};
        GuideUI.createShell(app);
        app.dataset.guidePanel='open';app.dataset.compactView='watch';
        document.getElementById('primary-view-host').hidden=false;
        document.getElementById('cast-button').hidden=true;
        const saved=Array.from({length:31},(_,i)=>({id:'channel'+i,sourceId:'catalog',name:'A complete long channel name '+i+' (1080p)',category:'Sports'}));
        host.presentation='page';host.channels=()=>saved;host.selectedChannel=()=>saved[0];
        host.mappings=async()=>saved.slice(0,3).map((c,i)=>({...mapping,appChannelId:c.id,xmltvChannelId:'xml'+i}));
        const agenda=${JSON.stringify(size.width < 900)};
        const listing=(id,title,startMs,stopMs,ordinal)=>({catalogSourceId:'catalog',appChannelId:id,guideSourceId:'guide',xmltvChannelId:'xml'+saved.findIndex(c=>c.id===id),title,startMs,stopMs,ordinal,description:'Complete controlled listing details',categories:[{text:'Sports'}]});
        host.query=async q=>{calls.queries.push(q);return {programs:agenda?[listing(q.appChannelIds[0],'Readable current programme',instant-1000,instant+100000,0),listing(q.appChannelIds[0],'Upcoming programme with complete title',instant+200000,instant+300000,1)]:[],nextCursor:null,sourceRevision:1,databaseRevision:1};};
        if(agenda)host.summary=async q=>({...q,catalogRevision:'1',databaseRevision:1,mappingStatus:'mapped',mapping:{catalogSourceId:'catalog',appChannelId:q.appChannelId,guideSourceId:'guide',xmltvChannelId:'xml'+saved.findIndex(c=>c.id===q.appChannelId)},sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-1000,endMs:instant+300000},cacheStatus:'current',currentStatus:'current',nextStatus:'next',current:{title:'Readable current programme',startMs:instant-1000,stopMs:instant+100000},next:{title:'Upcoming programme with complete title',startMs:instant+200000,stopMs:instant+300000}});

        window.guide=GuideUI.mountGuide(document.getElementById('primary-view-host'),host);
        window.removeGuideRemote=GuideUI.installRemoteNavigation();
        await window.guide.open();
      `,
        type: 'module',
      });
      const agenda = size.width < 900;
      if (agenda)
        await page
          .getByRole('button', { name: 'Readable current programme', exact: true })
          .waitFor();
      else {
        await page.locator('.gx-timeline-row').first().waitFor();
        await page.locator('.gx-timeline-status[data-state="ready"]').waitFor();
      }
      if (size.enlarged) {
        await page.evaluate(() => {
          const sizes = [...document.querySelectorAll<HTMLElement>('#app, #app *')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
      }
      expect(await page.getByRole('button', { name: 'Guide view', exact: true }).isVisible()).toBe(
        false,
      );
      expect(
        await page
          .locator('.guide-feedback [role="status"]:not([aria-label="Guide update"])')
          .getAttribute('aria-label'),
      ).toContain('3 of 31 channels linked');
      expect(await page.locator('.gx-timeline-status').textContent()).not.toContain('GMT');
      if (agenda && size.enlarged)
        await expect
          .poll(() => page.locator('.gx-timeline').getAttribute('data-agenda-compact'))
          .toBe('true');
      const controls = page.getByRole('button', { name: 'Guide controls', exact: true });
      if (agenda && (await controls.isVisible())) await controls.click();
      for (const label of [
        'All channels',
        'Favorites',
        'Now',
        'Find program guides',
        'Close guide',
      ]) {
        // The channel row beside the guide has its own Favorites button.
        const target = page
          .locator('.guide-dialog')
          .getByRole('button', { name: label, exact: true });
        await target.scrollIntoViewIfNeeded();
        // Touch screens need 44 px targets; a TV uses its 34 px remote size.
        const minimum = size.deviceKind === 'tv' ? 34 : 44;
        expect(
          await target.evaluate((node, minimum) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= minimum &&
              r.width >= minimum &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }, minimum),
          label,
        ).toBe(true);
      }
      if (agenda && (await controls.isVisible())) await controls.click();
      const first = agenda
        ? page.locator('.gx-agenda-channel')
        : page.locator('.gx-timeline-channel').first();
      await first.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
      expect(await first.textContent()).toContain('A complete long channel name 0');
      if (!agenda) {
        const geometry = await page.locator('.gx-timeline-viewport').evaluate((node) => {
          const v = node.getBoundingClientRect();
          return [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
            const r = row.getBoundingClientRect();
            return r.top >= v.top && r.bottom <= v.bottom;
          }).length;
        });
        expect(geometry).toBeGreaterThanOrEqual(size.completeRows);
        // Every toolbar control, Close included, is on screen: on the Sansui TV
        // the toolbar ran off the right edge and Close was out of the remote's
        // reach (October 19, 2026).
        const offscreen = await page.locator('.gx-timeline-toolbar').evaluateAll((toolbars) =>
          toolbars
            .filter((toolbar) => toolbar.getBoundingClientRect().width > 0)
            .flatMap((toolbar) => {
              const box = toolbar.getBoundingClientRect();
              const problems =
                toolbar.scrollWidth > toolbar.clientWidth + 1
                  ? [`toolbar scrolls ${toolbar.scrollWidth}>${toolbar.clientWidth}`]
                  : [];
              for (const control of toolbar.querySelectorAll('button, input')) {
                if (!control.getClientRects().length) continue;
                const r = control.getBoundingClientRect();
                if (
                  r.left < box.left - 0.5 ||
                  r.right > Math.min(box.right, innerWidth) + 0.5 ||
                  r.top < 0 ||
                  r.bottom > innerHeight
                )
                  problems.push(control.textContent || control.getAttribute('aria-label') || '?');
              }
              return problems;
            }),
        );
        expect(offscreen, `${size.width}x${size.height}`).toEqual([]);
        // Every programme box fits inside its row (no spilling into the next).
        const spill = await page.locator('.gx-timeline-row').evaluateAll((rows) =>
          rows.flatMap((row) => {
            const r = row.getBoundingClientRect();
            return [...row.querySelectorAll('.gx-timeline-cell, .gx-timeline-channel')]
              .map((cell) => cell.getBoundingClientRect())
              .filter((c) => c.top < r.top - 1 || c.bottom > r.bottom + 1)
              .map((c) => `${Math.round(c.height)}>${Math.round(r.height)}`);
          }),
        );
        expect(spill).toEqual([]);
        expect(await first.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap');
        await page.screenshot({
          path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-post-back-geometry/normal-page-${size.width}x${size.height}.png`,
        });
        if (size.width === 854) {
          expect(
            await page
              .locator('.gx-timeline-row')
              .first()
              .evaluate((node) => node.getBoundingClientRect().height),
          ).toBe(64);
          await page.getByRole('button', { name: 'All channels', exact: true }).focus();
          for (let step = 0; step < 8; step++) {
            await page.keyboard.press('Tab');
            expect(
              await page.evaluate(() => {
                const node = document.activeElement;
                // Toolbar controls are buttons plus the Guide search field.
                if (!(node instanceof HTMLButtonElement || node instanceof HTMLInputElement))
                  return false;
                const r = node.getBoundingClientRect();
                return (
                  r.width >= 44 &&
                  r.height >= 44 &&
                  r.left >= 0 &&
                  r.right <= innerWidth &&
                  r.top >= 0 &&
                  r.bottom <= innerHeight &&
                  node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
                );
              }),
            ).toBe(true);
          }
          expect(
            await page
              .getByRole('button', { name: 'Close guide', exact: true })
              .evaluate((node) => node === document.activeElement),
          ).toBe(true);
          await first.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
        }
      }
      if (!agenda) {
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ===
            'A complete long channel name 1 (1080p)',
        );
      } else {
        await first.scrollIntoViewIfNeeded();
        expect(await first.evaluate((node) => node.getBoundingClientRect().height >= 44)).toBe(
          true,
        );
        expect(await first.getAttribute('aria-label')).toBe(
          'Browse guide channel: A complete long channel name 0 (1080p)',
        );
        expect(await page.locator('.gx-timeline-axis').isVisible()).toBe(false);
        const watchChannel = page.getByRole('button', {
          name: 'Watch channel: A complete long channel name 0 (1080p)',
          exact: true,
        });
        await watchChannel.scrollIntoViewIfNeeded();
        if (size.width === 320)
          expect(
            await first.evaluate((node) => node.getBoundingClientRect().width >= innerWidth / 2),
          ).toBe(true);
        expect(
          await watchChannel.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
        const current = page.getByRole('button', {
          name: 'Readable current programme',
          exact: true,
        });
        await current.scrollIntoViewIfNeeded();
        expect(
          await current.evaluate((n) => {
            const r = n.getBoundingClientRect(),
              v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.width >= 44 &&
              r.left >= v.left &&
              r.right <= v.right &&
              r.top >= v.top &&
              r.bottom <= v.bottom &&
              n.scrollWidth <= n.clientWidth &&
              [...n.querySelectorAll<HTMLElement>('strong,.gx-agenda-time')].every((element) => {
                const bounds = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                return (
                  bounds.top >= r.top &&
                  bounds.bottom <= r.bottom &&
                  bounds.left >= r.left &&
                  bounds.right <= r.right &&
                  [...range.getClientRects()].every(
                    (text) =>
                      text.top >= bounds.top &&
                      text.bottom <= bounds.bottom &&
                      text.left >= bounds.left &&
                      text.right <= bounds.right,
                  )
                );
              }) &&
              n.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  Math.max(v.top, Math.min(v.bottom - 1, r.y + r.height / 2)),
                ),
              )
            );
          }),
        ).toBe(true);
        expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
        expect(
          await page.evaluate(
            () =>
              document.querySelector<HTMLVideoElement>('video')!.paused &&
              // The channel list stays beside the right-panel Guide.
              !document.querySelector<HTMLElement>('.workspace')!.hidden &&
              Reflect.get(window, 'calls').watch.length === 0 &&
              (Reflect.get(window, 'discoveryCalls') || 0) === 0,
          ),
        ).toBe(true);
        await first.click();
        expect(await page.locator('.gx-agenda-channel-option').count()).toBeLessThanOrEqual(8);
        expect(await page.getByRole('button', { name: 'More channels', exact: true }).count()).toBe(
          0,
        );
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await expect.poll(() => first.textContent()).toContain('A complete long channel name 1');
        await current.focus();
        await page.keyboard.press('ArrowDown');
        const upcoming = page.getByRole('button', {
          name: 'Upcoming programme with complete title',
          exact: true,
        });
        expect(await upcoming.evaluate((n) => n === document.activeElement)).toBe(true);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
        expect(
          await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
        ).toBe(0);
        await page.keyboard.press('Escape');
        expect(await upcoming.evaluate((n) => n === document.activeElement)).toBe(true);
        if (size.width === 640 && size.enlarged) {
          expect(await upcoming.locator('strong').textContent()).toBe(
            'Upcoming programme with complete title',
          );
          expect(await upcoming.locator('.gx-agenda-time').textContent()).toMatch(/\S.+ – \S.+/);
          await page.screenshot({
            path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-post-back-diagnostic/upcoming-640x360.png`,
          });
          const metrics = await upcoming.evaluate((node) => {
            const target = node.getBoundingClientRect();
            const viewport = node.closest('.gx-timeline-viewport')!.getBoundingClientRect();
            const navigation = document.querySelector('.gx-agenda-header')!.getBoundingClientRect();
            const elements = [
              node.querySelector<HTMLElement>('strong')!,
              node.querySelector<HTMLElement>('.gx-agenda-time')!,
            ];
            const inside = (r: DOMRect, outer: DOMRect) =>
              r.top >= outer.top &&
              r.bottom <= outer.bottom &&
              r.left >= outer.left &&
              r.right <= outer.right;
            return {
              focused: node === document.activeElement,
              minTarget: target.width >= 44 && target.height >= 44,
              targetInside: inside(target, viewport),
              navigationClear: target.top >= navigation.bottom,
              screenInside:
                target.top >= 0 &&
                target.bottom <= innerHeight &&
                target.left >= 0 &&
                target.right <= innerWidth,
              children: elements.map((element) => {
                const r = element.getBoundingClientRect();
                return {
                  inside: inside(r, target),
                  nonempty: r.width > 0 && r.height > 0,
                  notClipped: (() => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return (
                      element.scrollWidth <= element.clientWidth &&
                      element.scrollHeight <= element.clientHeight &&
                      [...range.getClientRects()].every((text) => inside(text, r))
                    );
                  })(),
                  rect: r.toJSON(),
                  client: [element.clientWidth, element.clientHeight],
                  scroll: [element.scrollWidth, element.scrollHeight],
                  textRects: (() => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return [...range.getClientRects()].map((r) => r.toJSON());
                  })(),
                };
              }),
              hit: node.contains(
                document.elementFromPoint(
                  target.x + target.width / 2,
                  target.y + target.height / 2,
                ),
              ),
              target: target.toJSON(),
              viewport: viewport.toJSON(),
              navigation: navigation.toJSON(),
            };
          });
          expect(metrics).toMatchObject({
            focused: true,
            minTarget: true,
            targetInside: true,
            navigationClear: true,
            screenInside: true,
            hit: true,
            children: [
              { inside: true, nonempty: true, notClipped: true },
              { inside: true, nonempty: true, notClipped: true },
            ],
          });
        }
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-real-guide-agenda/normal-page-${size.width}x${size.height}.png`,
        });
      }
      await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .waitFor({ state: 'visible' });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'removeGuideRemote')?.());
      await dispose(page);
    }
  });
}
it('Guide force reload applies favorite metadata by saved source identity without tuning', async () => {
  const page = await fixture(false, true);
  try {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'favoriteChannels', [
        { id: 'a', sourceId: 'catalog', name: 'Same channel name', favorite: false },
        { id: 'b', sourceId: 'other-catalog', name: 'Same channel name', favorite: true },
      ]);
      host.channels = () => Reflect.get(window, 'favoriteChannels');
      host.selectedChannel = () => host.channels()[0];
      host.mappings = async () =>
        host.channels().map((c: { id: string; sourceId: string }) => ({
          appChannelId: c.id,
          catalogSourceId: c.sourceId,
          guideSourceId: 'guide',
          xmltvChannelId: 'xml-' + c.id,
        }));
      host.query = async (query: unknown) => {
        Reflect.get(window, 'calls').queries.push(query);
        return { programs: [], nextCursor: null, sourceRevision: 1, databaseRevision: 1 };
      };
      await Reflect.get(window, 'guide').open();
    });
    await page.locator('.gx-timeline-row').nth(1).waitFor();
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(
      JSON.parse(
        (await page.locator('.gx-timeline-row').getAttribute('data-channel-key')) ?? 'null',
      ).slice(0, 2),
    ).toEqual(['b', 'other-catalog']);
    const beforeEmptyQueries = await page.evaluate(
      () => Reflect.get(window, 'calls').queries.length,
    );
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').map((c: { favorite: boolean }) => ({
          ...c,
          favorite: false,
        })),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.locator('.gx-timeline-status').textContent())
      .toBe('No favorite channels. Choose All to browse saved channels.');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-now').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(
      beforeEmptyQueries,
    );
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await page.locator('.gx-timeline-row').nth(1).waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).not.toContain(
      'No favorite channels',
    );
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').map((c: { id: string }) => ({
          ...c,
          favorite: c.id === 'b',
        })),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').filter((c: { id: string }) => c.id !== 'b'),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.locator('.gx-timeline-status').textContent())
      .toBe('No favorite channels. Choose All to browse saved channels.');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-now').count()).toBe(0);
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(
      await page.evaluate(() => ({
        watch: Reflect.get(window, 'calls').watch.length,
        revision: Reflect.get(window, 'catalogRevision'),
      })),
    ).toEqual({ watch: 0, revision: '1' });
  } finally {
    await dispose(page);
  }
});
for (const unmapped of [false, true]) {
  for (const activation of ['click', 'Enter']) {
    it(`agenda deliberate channel ${activation} plays current saved identity without requiring EPG, mapped=${!unmapped}`, async () => {
      const page = await fixture(false, true);
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.evaluate((missing) => {
          if (missing) Reflect.set(window, 'mode', 'unmapped');
          Reflect.get(window, 'guide').open();
        }, unmapped);
        const chooser = page.locator('.gx-agenda-channel');
        await chooser.waitFor();
        await chooser.focus();
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        await chooser.click();
        await page.locator('.gx-agenda-channel-option').first().click();
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        if (unmapped) {
          expect(await page.locator('.gx-agenda-listing[data-program-key]').count()).toBe(0);
          expect(
            await page.getByRole('button', { name: 'Schedule details', exact: true }).count(),
          ).toBe(1);
        }
        const watch = page.getByRole('button', { name: 'Watch channel: FOX Chicago', exact: true });
        await watch.scrollIntoViewIfNeeded();
        expect(
          await watch.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
        if (activation === 'Enter') {
          await watch.focus();
          await page.keyboard.press('Enter');
        } else await watch.click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length))
          .toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch[0])).toEqual({
          id: 'fox',
          sourceId: 'catalog',
          name: 'FOX Chicago',
        });
        await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false);
      } finally {
        await dispose(page);
      }
    });
  }
}
it('agenda channel activation rechecks saved identity and refuses a removed channel', async () => {
  const page = await fixture(false, true);
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'guide').open();
    });
    const watch = page.getByRole('button', { name: 'Watch channel: FOX Chicago', exact: true });
    await watch.waitFor();
    await page.evaluate(() => {
      Reflect.get(window, 'host').channels = () => [];
    });
    await watch.click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Guide action failed');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
  } finally {
    await dispose(page);
  }
});
it('explicit Map reports durable connection before optional targeted hydration; opening is read-only', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.set(window, 'hydrateCalls', 0);
      Reflect.get(window, 'host').mapAndHydrate = async (
        mapping: unknown,
        _signal: AbortSignal,
        saved: () => void,
      ) => {
        Reflect.set(window, 'hydrateCalls', Reflect.get(window, 'hydrateCalls') + 1);
        Reflect.get(window, 'calls').mapping.push(mapping);
        saved();
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseHydration', resolve));
        return { status: 'saved-but-failed', published: false };
      };
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'hydrateCalls'))).toBe(0);
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').mapping.length))
      .toBe(1);
    await expect
      .poll(() => page.getByRole('dialog').textContent())
      .toContain('Guide connection saved. Checking its schedule');
    await page.evaluate(() => Reflect.get(window, 'releaseHydration')());
    await expect
      .poll(() => page.getByRole('dialog').textContent())
      .toContain('Guide connection saved. Its schedule could not be updated');
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});
it('Map hydration suspension aborts and joins original acquisition before cleanup', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'host').mapAndHydrate = async (
        mapping: unknown,
        signal: AbortSignal,
        saved: () => void,
      ) => {
        Reflect.get(window, 'calls').mapping.push(mapping);
        Reflect.set(window, 'hydrationSignal', signal);
        saved();
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseHydration', resolve));
        return { status: 'canceled', published: false };
      };
      Reflect.get(window, 'host').settleMappingHydration = async () => {
        Reflect.set(window, 'cleanupEntered', true);
      };
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'hydrationSignal'));
    await page.evaluate(() => {
      Reflect.set(window, 'suspensionDone', false);
      void Reflect.get(window, 'guide')
        .suspend()
        .then(() => Reflect.set(window, 'suspensionDone', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'hydrationSignal').aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'suspensionDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupEntered') ?? false)).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseHydration')());
    await page.waitForFunction(() => Reflect.get(window, 'suspensionDone'));
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupEntered'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').mapping.length)).toBe(1);
  } finally {
    await dispose(page);
  }
});
it('unconfirmed mapping cleanup prevents successful Guide close and remains retryable', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => {
      Reflect.get(window, 'host').settleMappingHydration = async () => {
        throw new Error('controlled cleanup failure');
      };
    });
    expect(
      await page.evaluate(async () => {
        try {
          await Reflect.get(window, 'guide').close();
          return 'closed';
        } catch {
          return 'retained';
        }
      }),
    ).toBe('retained');
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    await page.evaluate(() => {
      Reflect.get(window, 'host').settleMappingHydration = async () => {};
    });
    await page.evaluate(() => Reflect.get(window, 'guide').close());
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
