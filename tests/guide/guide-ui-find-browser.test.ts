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
 * Guide screen in a real browser: the guide selector, Find, linked channels
 * and the TV layout.
 */
import { expect, it } from 'vitest';
import { readStylesheet } from '../support/stylesheet';
import { useGuideUiBrowser, fixture, dispose, open } from './guide-ui-browser.fixture';

useGuideUiBrowser();

it('closed Guide selector Down leaves for timeline controls; OK opens choices and Back closes choices first', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => document.querySelector('.gx-timeline-channel'));
    await page.evaluate(() => {
      const api = Reflect.get(window, 'GuideUI');
      Reflect.set(
        window,
        'removeGuideRemote',
        api.installRemoteNavigation({ editMode: api.createRemoteEditMode() }),
      );
    });
    const trigger = page.getByRole('button', { name: 'Guide view', exact: true });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.guide-dropdown'))).toBe(
      false,
    );
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    await trigger.focus();
    await page.keyboard.press('Enter');
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('option');
    await page.keyboard.press('Escape');
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole('dialog', { name: 'Program guide' }).isVisible()).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'removeGuideRemote')?.());
    await dispose(page);
  }
});
it('in-app guide dropdown uses bounded options and Escape returns to trigger without closing Guide', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    expect(await page.getByRole('listbox', { name: 'Guide view choices' }).isVisible()).toBe(true);
    await page.keyboard.press('End');
    expect(
      await page
        .getByRole('option', { name: 'Channel mapping', exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog', { name: 'Program guide' }).isVisible()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Guide source task', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Guide source task', exact: true });
    expect(await trigger.getAttribute('aria-controls')).toBeTruthy();
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});
it('Find program guides only discovers, selected HTTP candidate prefills without grant or publication', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() =>
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Regional <img>',
            location: 'http://guide.invalid/feed.xml',
            playlistNames: ['My playlist'],
            allowHttp: false,
            requiresHttpPermission: true,
          },
        ],
        outcomes: [],
      }),
    );
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') || 0)).toBe(0);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.getByRole('button', { name: 'Regional <img> · My playlist', exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').inputValue()).toBe(
      'http://guide.invalid/feed.xml',
    );
    expect(await page.getByLabel('Allow HTTP for this guide source').isChecked()).toBe(false);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isVisible()).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});
it('late canceled guide discovery cannot prefill or publish and manual guide input remains available', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => {
      Reflect.set(window, 'blockDiscovery', true);
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Late',
            location: 'https://guide.invalid/feed',
            playlistNames: ['Playlist'],
            allowHttp: false,
            requiresHttpPermission: false,
          },
        ],
        outcomes: [],
      });
    });
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).click();
    await page.evaluate(() => Reflect.get(window, 'resolveDiscovery')());
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Find program guides', exact: true }).isDisabled(),
      )
      .toBe(false);
    expect(await page.getByRole('button', { name: 'Late · Playlist' }).count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    await page.getByText('Add guide link or file', { exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});
it('partial timeline keeps Find available and reports exact linked channel count', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const original = host.channels()[0];
      host.channels = () => [original, { ...original, id: 'unmapped', name: 'Other channel' }];
      host.buildForChannels = async () => ({
        connected: 1,
        unmatched: 1,
        checked: 1,
        failed: 0,
        skipped: 0,
      });
      Reflect.get(window, 'guide').open();
    });
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(2);
    expect(
      await page
        .getByText(
          '1 of 2 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    expect(await find.isVisible()).toBe(true);
    await find.click();
    await expect.poll(() => find.isDisabled()).toBe(false);
    expect(await find.isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const originalMappings = host.mappings;
      host.mappings = async () => {
        const mappings = await originalMappings();
        return [...mappings, { ...mappings[0], appChannelId: 'unmapped' }];
      };
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect.poll(() => find.isVisible()).toBe(true);
    expect(
      await page
        .getByText(
          '2 of 2 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
  } finally {
    await dispose(page);
  }
});
it('held normal Find presents real phase and settled feed progress without acquiring or tuning elsewhere', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      host.buildForChannels = () =>
        new Promise((resolve) => Reflect.set(window, 'finishBuild', resolve));
      Reflect.get(window, 'guide').open();
    });
    await page.locator('.gx-timeline-row').first().waitFor();
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    // An explicit retry remains available even when every channel has a mapping.
    await find.click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 1,
        unmatched: 0,
        checked: 1,
        failed: 1,
        skipped: 0,
        total: 4,
        attempted: 2,
        phase: 'fetching',
      }),
    );
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toContain('Fetching schedules · 2 of 4 feeds settled');
    expect(await update.textContent()).toContain('1 could not be checked');
    expect(await find.isDisabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 1, unmatched: 0, checked: 3, failed: 1, skipped: 0 }),
    );
    await expect.poll(() => find.isDisabled()).toBe(false);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 1, unmatched: 0, checked: 3, failed: 1, skipped: 0 }),
    );
    await dispose(page);
  }
});
it('canceled Find retains the actual join and never leaves stale pending progress after settlement', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.get(window, 'host').buildForChannels = (signal: AbortSignal) =>
        new Promise((resolve) => {
          Reflect.set(window, 'buildSignal', signal);
          Reflect.set(window, 'finishBuild', resolve);
        });
      Reflect.get(window, 'guide').open();
    });
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    await find.click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 0,
        unmatched: 1,
        checked: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        attempted: 0,
        phase: 'capturing',
      }),
    );
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toBe('Preparing guide check');
    await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'buildSignal').aborted)).toBe(true);
    expect(await find.isDisabled()).toBe(true);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 1, unmatched: 0, checked: 1, failed: 0, skipped: 0 }),
    );
    await expect.poll(() => find.isDisabled()).toBe(false);
    expect(await update.isVisible()).toBe(false);
    expect(await page.getByRole('alert').textContent()).toContain('Operation canceled');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 0, unmatched: 1, checked: 0, failed: 0, skipped: 0 }),
    );
    await dispose(page);
  }
});
it('partial Find failure remains visible after mapping reload and later catalog refresh', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.get(window, 'host').buildForChannels = async () => {
        Reflect.set(window, 'mode', 'normal');
        return {
          connected: 1,
          unmatched: 0,
          checked: 1,
          failed: 2,
          skipped: 1,
          discoveryFailed: 3,
        };
      };
      Reflect.get(window, 'guide').open();
    });
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.locator('.gx-timeline-cell').first().waitFor();
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toContain('2 could not be checked');
    expect(await update.textContent()).toContain('1 skipped');
    expect(await update.textContent()).toContain('3 playlists could not be checked');
    await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged(true));
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').sources))
      .toBeGreaterThan(1);
    expect(await update.isVisible()).toBe(true);
    expect(await update.textContent()).toContain('2 could not be checked');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});
it('six linked channels with no schedule keep manual Find reachable without claiming usable schedules', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const original = host.channels()[0];
      host.channels = () =>
        Array.from({ length: 6 }, (_, i) => ({ ...original, id: 'channel' + i }));
      host.mappings = async () =>
        host.channels().map((channel: { id: string }) => ({
          catalogSourceId: 'catalog',
          appChannelId: channel.id,
          guideSourceId: 'guide',
          xmltvChannelId: 'wfld',
        }));
      host.coverage = async () => null;
      host.query = async () => ({
        programs: [],
        nextCursor: null,
        sourceRevision: 1,
        databaseRevision: 1,
      });
      Reflect.get(window, 'guide').open();
    });
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(6);
    expect(
      await page
        .getByText(
          '6 of 6 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.locator('.gx-timeline-cell').count()).toBe(0);
    expect(await page.locator('.gx-timeline-row').first().textContent()).toContain(
      'No listings for this time',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});
it('normal Guide forwards complete listed membership, keeps Find reachable and reports listings instead of linked counts', async () => {
  const page = await fixture(false, true, true);
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').dispose();
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'listedRequests', []);
      Reflect.set(window, 'listedEmpty', false);
      host.listedChannels = async (start: number, end: number, signal: AbortSignal) => {
        Reflect.get(window, 'listedRequests').push([start, end]);
        Reflect.set(window, 'listedSignal', signal);
        if (Reflect.get(window, 'listedRequests').length === 1)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          channels: Reflect.get(window, 'listedEmpty')
            ? []
            : [
                {
                  catalogSourceId: 'catalog',
                  appChannelId: 'fox',
                  guideSourceId: 'guide',
                  xmltvChannelId: 'wfld',
                  sourceRevision: 1,
                },
              ],
        };
      };
      host.presentation = 'page';
      Reflect.set(
        window,
        'guide',
        Reflect.get(window, 'GuideUI').mountGuide(document.getElementById('guide'), host),
      );
      Reflect.get(window, 'guide').open();
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'listedRequests').length))
      .toBe(1);
    const guideStatus = page.locator('.guide-feedback > p').first();
    expect(await guideStatus.textContent()).toBe('Checking saved listings…');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseListed')());
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await guideStatus.textContent()).toBe('1 channel with listings');
    expect(await guideStatus.getAttribute('title')).toContain('selected time');
    expect(await guideStatus.textContent()).not.toContain('linked');
    await page.evaluate(() => {
      Reflect.set(window, 'listedEmpty', true);
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'listedRequests').length))
      .toBe(2);
    await expect.poll(() => guideStatus.textContent()).toBe('0 channels with listings');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'No saved listings for this time. Find program guides or choose another time.',
    );
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});
it('1920 TV at 960 CSS pixels keeps held progress and retained failure readable outside navigation clipping', async () => {
  const page = await fixture(false, true, true);
  try {
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
          ].map((name) => readStylesheet(`src/ui/${name}.css`)),
        )
      ).join('\n'),
    });
    await page.addScriptTag({
      type: 'module',
      content: `
      await window.guide.dispose();
      const app=document.getElementById('guide');app.id='app';app.dataset.deviceKind='tv';
      GuideUI.createShell(app);
      app.dataset.guidePanel='open';app.dataset.compactView='watch';
      document.getElementById('primary-view-host').hidden=false;
      host.presentation='page';
      const saved=Array.from({length:30},(_,i)=>({id:'channel'+i,sourceId:'catalog',name:'Channel '+i}));
      host.channels=()=>saved;host.selectedChannel=()=>saved[0];
      host.mappings=async()=>saved.slice(0,6).map(c=>({...mapping,appChannelId:c.id}));
      host.query=async()=>({programs:[],nextCursor:null,sourceRevision:1,databaseRevision:1});
      host.buildForChannels=()=>new Promise(resolve=>window.finishBuild=resolve);
      window.guide=GuideUI.mountGuide(document.getElementById('primary-view-host'),host);
      await window.guide.open();
    `,
    });
    await page.locator('.gx-timeline-row').nth(7).waitFor();
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 6,
        unmatched: 24,
        checked: 1,
        failed: 2,
        skipped: 1,
        total: 12,
        attempted: 4,
        phase: 'fetching',
      }),
    );
    const readable = () =>
      page.evaluate(() => {
        const feedback = document.querySelector<HTMLElement>('.guide-feedback')!;
        const toolbar = document.querySelector<HTMLElement>('.gx-timeline-toolbar')!;
        const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
        const f = feedback.getBoundingClientRect(),
          t = toolbar.getBoundingClientRect(),
          v = viewport.getBoundingClientRect();
        const update = feedback.querySelector('[aria-label="Guide update"]')!;
        const range = document.createRange();
        range.selectNodeContents(update);
        return {
          local: !toolbar.contains(feedback),
          readable: [...range.getClientRects()].every(
            (r) =>
              r.top >= f.top &&
              r.bottom <= f.bottom + 1 &&
              r.left >= f.left &&
              r.right <= f.right + 1,
          ),
          belowNavigation: f.top >= t.bottom,
          aboveRows: f.bottom <= v.top,
          rowsUsable: v.height >= 180,
          overflow: document.documentElement.scrollWidth > innerWidth,
          scale: devicePixelRatio,
        };
      });
    expect(await readable()).toEqual({
      local: true,
      readable: true,
      belowNavigation: true,
      aboveRows: true,
      rowsUsable: true,
      overflow: false,
      scale: 2,
    });
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 6, unmatched: 24, checked: 9, failed: 2, skipped: 1 }),
    );
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Find program guides', exact: true }).isDisabled(),
      )
      .toBe(false);
    expect(await page.getByRole('status', { name: 'Guide update' }).textContent()).toContain(
      '2 could not be checked',
    );
    expect(await readable()).toEqual({
      local: true,
      readable: true,
      belowNavigation: true,
      aboveRows: true,
      rowsUsable: true,
      overflow: false,
      scale: 2,
    });
    const text = await page.getByRole('status', { name: 'Guide update' }).textContent();
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').setForeground(false);
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 0,
        unmatched: 30,
        checked: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        attempted: 0,
        phase: 'capturing',
      });
    });
    expect(await page.getByRole('status', { name: 'Guide update' }).textContent()).toBe(text);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 6, unmatched: 24, checked: 9, failed: 2, skipped: 1 }),
    );
    await dispose(page);
  }
});
it('empty normal timeline Find connects schedules without opening technical source setup', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'buildCalls', 0);
      Reflect.set(window, 'manualPreviewCalls', 0);
      const host = Reflect.get(window, 'host');
      host.preview = async () => {
        Reflect.set(window, 'manualPreviewCalls', Reflect.get(window, 'manualPreviewCalls') + 1);
        throw new Error('Manual preview must not be entered from normal Find.');
      };
      host.buildForChannels = (_signal: AbortSignal) => {
        Reflect.set(window, 'buildCalls', Reflect.get(window, 'buildCalls') + 1);
        return new Promise((resolve) => {
          Reflect.set(window, 'finishBuild', () => {
            Reflect.set(window, 'mode', 'normal');
            resolve({ connected: 1, unmatched: 0, checked: 1, failed: 0, skipped: 0 });
          });
        });
      };
      Reflect.get(window, 'guide').open();
    });
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-note')?.textContent === 'Guide not linked',
    );
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'buildCalls') === 1);
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'finishBuild')());
    await page.waitForFunction(() => document.querySelectorAll('.gx-timeline-cell').length > 0);
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'buildCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'manualPreviewCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
  } finally {
    await dispose(page);
  }
});
for (const unmapped of [false, true]) {
  for (const activation of ['click', 'Enter']) {
    it(`timeline channel ${activation} starts the exact saved stream and closes Guide, mapped=${!unmapped}`, async () => {
      const page = await fixture(false, true);
      try {
        await page.evaluate((missing) => {
          if (missing) Reflect.set(window, 'mode', 'unmapped');
          Reflect.get(window, 'guide').open();
        }, unmapped);
        const row = page.locator('.gx-timeline-channel').filter({ hasText: 'FOX Chicago' });
        await row.waitFor();
        if (unmapped) expect(await page.locator('.gx-timeline-cell').count()).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        if (activation === 'Enter') {
          await row.focus();
          await page.keyboard.press('Enter');
        } else await row.click();
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
        await page.close();
      }
    });
  }
}
it('failed channel-row Watch stays open and a stale removed row cannot start a stream', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').watch = async () => {
        throw new Error('private-sentinel');
      };
      Reflect.get(window, 'guide').open();
    });
    const row = page.locator('.gx-timeline-channel').first();
    await row.waitFor();
    await row.click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Guide action failed');
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await page.getByRole('alert').textContent()).not.toContain('private-sentinel');
    await page.evaluate(() => {
      Reflect.get(window, 'host').channels = () => [];
    });
    await row.click();
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await page.close();
  }
});
