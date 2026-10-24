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
 * Timeline guide in a real browser: empty rows, Settings navigation and
 * native grouped inventory.
 */
import { expect, it } from 'vitest';
import { type TimelineChannel } from '../../src/ui/guide/guide-timeline-model';
import {
  useTimelineBrowser,
  emptyFixture,
  remoteBundle,
  browser,
  fullCss,
  archiveBundle,
  fixture,
} from './timeline-browser.fixture';

useTimelineBrowser();

it('empty Guide rows stay quiet and D-pad stays on the intended channel', async () => {
  const page = await emptyFixture(true);
  try {
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
    expect(await page.locator('button.gx-timeline-note').count()).toBe(0);
    const first = page.locator('.gx-timeline-channel').first();
    await page.locator('.gx-timeline-viewport').focus();
    await page.keyboard.press('ArrowDown');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowDown');
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.querySelector('.media-result-title')?.textContent ??
          document.activeElement?.textContent,
      ),
    ).toBe('Channel 1');
    await page.keyboard.press('ArrowLeft');
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.querySelector('.media-result-title')?.textContent ??
          document.activeElement?.textContent,
      ),
    ).toBe('Channel 1');
    await page.keyboard.press('ArrowUp');
    expect(await first.evaluate((n) => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('Settings header routes select the visible section before lower destructive or export actions', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog{width:600px}button{min-height:44px}#settings-section{width:100%}.dialog-head{text-align:right}[data-settings-panel] button{display:block;margin:16px}</style><button id="opener">Settings</button><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources"><button id="import">Import</button><button id="export" style="margin-left:480px">Export</button></section><section data-settings-panel="other" hidden><button id="remove">Remove</button></section></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => {
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLButtonElement>('#opener')!.focus();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    await page.locator('[data-close]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('import');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('[data-close]').evaluate((n) => n === document.activeElement)).toBe(
      true,
    );
  } finally {
    await page.close();
  }
});
it('first arrow from BODY in an open primary Guide enters its channel instead of hidden Live', async () => {
  const page = await emptyFixture(true);
  try {
    await page.addStyleTag({ content: fullCss });
    await page.evaluate(() => {
      const root = document.querySelector('#app')!;
      const dialog = document.createElement('dialog');
      dialog.className = 'guide-dialog';
      dialog.dataset.primaryPage = 'guide';
      root.before(dialog);
      dialog.append(root);
      dialog.show();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() =>
      Reflect.get(window, 'Remote').installRemoteNavigation({
        initialFocus: () => document.querySelector('#irrelevant-live'),
      }),
    );
    await page.keyboard.press('ArrowDown');
    expect(
      await page
        .locator('.gx-timeline-channel')
        .first()
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it.each(['live', 'genxtra'])(
  'TV Search Up reaches the %s header without activating same-row actions',
  async (library) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>button,input{position:absolute}#live-tv-button{left:16px;top:12px;width:120px;height:44px}#genxtra-button{left:150px;top:12px;width:120px;height:44px}#search-programs{left:16px;top:93px;width:34px;height:34px}#search{left:60px;top:93px;width:300px;height:48px}</style><main id="app" data-device-kind="tv"><nav class="top-actions"><button id="live-tv-button" aria-pressed="${library === 'live'}">Live TV</button><button id="genxtra-button" aria-pressed="${library === 'genxtra'}">GenXtra</button></nav><button id="search-programs">Find online</button><input id="search" type="search" aria-label="Search"></main>`,
      );
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => {
        Reflect.set(window, 'activations', 0);
        document.addEventListener('click', () =>
          Reflect.set(window, 'activations', Reflect.get(window, 'activations') + 1),
        );
        const remote = Reflect.get(window, 'Remote'),
          mode = remote.createRemoteEditMode();
        remote.installRemoteNavigation({ editMode: mode });
        const search = document.getElementById('search')!;
        mode.navigate(search);
        search.focus();
      });
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        library === 'live' ? 'live-tv-button' : 'genxtra-button',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'activations'))).toBe(0);
    } finally {
      await page.close();
    }
  },
);
it('Settings scrolling panel and fixed footer have stable vertical boundaries and remembered return', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog[open]{position:fixed;top:20px;left:20px;width:600px;height:320px;margin:0;display:grid;grid-template-rows:44px 44px minmax(0,1fr) 44px}button{min-height:44px}.dialog-head{text-align:right}[data-settings-panel]{overflow:auto;min-height:0}[data-settings-panel] button{display:block;width:220px;margin:12px}.settings-footer{display:flex;justify-content:flex-end;gap:16px}</style><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources">${['Import', 'Refresh', 'Restore', 'Country', 'Region', 'Save region', 'Voice'].map((name, i) => `<button id="section-${i}">${name}</button>`).join('')}</section><footer class="settings-footer"><button id="about-button">About</button><button id="exit-button">Exit</button></footer></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => {
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    await page.locator('#settings-section').focus();
    for (let index = 0; index < 7; index++) {
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`section-${index}`);
    }
    expect(
      await page.locator('[data-settings-panel]').evaluate((n) => n.scrollTop),
    ).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('exit-button');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('section-6');
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => document.getElementById('section-6')!.setAttribute('disabled', ''));
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('section-5');
    for (let index = 4; index >= 0; index--) {
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`section-${index}`);
    }
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-section');
  } finally {
    await page.close();
  }
});
it('real closed GenXtra management yields Down to Settings footer and returns without activating hidden Clear', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>dialog[open]{position:fixed;top:20px;left:20px;width:600px;height:320px;margin:0;display:grid;grid-template-rows:44px 44px minmax(0,1fr) 44px}button,summary{min-height:34px}.dialog-head{text-align:right}[data-settings-panel]{overflow:auto;min-height:0}#panel-padding{height:400px}.settings-footer{display:flex;justify-content:flex-end;gap:16px}</style><input id="fixture-search" hidden><div id="archive-host" hidden></div><dialog id="settings-dialog"><div class="dialog-head"><button data-close="settings-dialog">Close</button></div><button id="settings-section" aria-expanded="false">Your sources</button><section data-settings-panel="sources"><button id="source-first">Import</button><div id="panel-padding"></div></section><footer class="settings-footer"><button id="about-button">About</button><button id="exit-button">Exit</button></footer></dialog>`,
    );
    await page.addScriptTag({ content: remoteBundle + '\n' + archiveBundle });
    await page.evaluate(async () => {
      Reflect.set(window, 'removeCalls', 0);
      const ui = Reflect.get(window, 'ArchiveFixture').mountArchiveSearch(
        document.getElementById('archive-host'),
        {
          input: document.getElementById('fixture-search'),
          readyScope: () => 'controlled',
          managementContainer: document.querySelector('[data-settings-panel]'),
          catalog: {
            query: async () => ({
              schemaVersion: 1,
              revision: '1',
              offset: 0,
              totalCount: 0,
              items: [],
              more: false,
            }),
            files: async () => {
              throw Error('unexpected files');
            },
          },
          onSelect: async () => {
            throw Error('unexpected playback');
          },
          onRemove: async () => {
            Reflect.set(window, 'removeCalls', Reflect.get(window, 'removeCalls') + 1);
            throw Error('unexpected removal');
          },
        },
      );
      Reflect.set(window, 'archiveManagementOwner', ui);
      await ui.resume('');
      Reflect.get(window, 'Remote').installRemoteNavigation();
      document.querySelector<HTMLDialogElement>('dialog')!.showModal();
    });
    const summary = page.locator('.gx-archive-management > summary');
    await summary.focus();
    expect(
      await page.locator('.gx-archive-management').evaluate((n) => n.hasAttribute('open')),
    ).toBe(false);
    expect(await page.locator('.gx-archive-management button').count()).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('about-button');
    await page.keyboard.press('ArrowUp');
    expect(await summary.evaluate((n) => n === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'removeCalls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'archiveManagementOwner')?.dispose());
    await page.close();
  }
});
it('native grouped inventory retains News and Sports aliases while showing one representative and keeping navigation scoped', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const all = Reflect.get(window, 'channels');
      all[20].category = 'General';
      all[21].category = 'Sports';
      Reflect.set(window, 'channels', all.slice(20, 22));
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        Reflect.set(
          window,
          'groupedMembershipCalls',
          Reflect.get(window, 'groupedMembershipCalls') + 1,
        );
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '11',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
              filterMask: 6,
            },
          ],
        };
      };
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['Channel 20']);
    for (const category of ['Sports', 'News']) {
      await page.getByRole('button', { name: category, exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20']);
    }
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('native grouped inventory reacquires after favorite facts change on unchanged mapping identities', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'channels', Reflect.get(window, 'channels').slice(20, 22));
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        Reflect.set(
          window,
          'groupedMembershipCalls',
          Reflect.get(window, 'groupedMembershipCalls') + 1,
        );
        const saved = Reflect.get(window, 'channels');
        const split = saved[1].favorite === true;
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: split ? '12' : '11',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: (split ? saved : [saved[0]]).map((c: TimelineChannel) => ({
            catalogSourceId: c.sourceId,
            appChannelId: c.id,
            guideSourceId: c.guideSourceId,
            xmltvChannelId: c.xmltvChannelId,
            sourceRevision: 1,
            filterMask: c.favorite ? 1 : 0,
          })),
        };
      };
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['Channel 20']);
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
          ...c,
          favorite: c.id === 'c21',
        })),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(2);
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['Channel 21']);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('declared native grouped inventory refuses missing or unknown filter bits without publishing rows', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').listedChannels = async () => ({
        catalogRevision: '1',
        databaseRevision: 1,
        viewRevision: '11',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
        channels: [
          {
            catalogSourceId: 's',
            appChannelId: 'c20',
            guideSourceId: 'g',
            xmltvChannelId: 'x20',
            sourceRevision: 1,
            filterMask: 8,
          },
        ],
      });
    });
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'Guide could not refresh. Choose Now to retry.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('held native grouped favorite snapshot refuses old host preferences then retries after the host commit', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels')
          .slice(20, 21)
          .map((c: TimelineChannel) => ({ ...c, favorite: false })),
      );
      Reflect.set(window, 'groupedMembershipCalls', 0);
      Reflect.get(window, 'host').listedChannels = async () => {
        const call = Reflect.get(window, 'groupedMembershipCalls') + 1;
        Reflect.set(window, 'groupedMembershipCalls', call);
        if (call === 1)
          await new Promise<void>((resolve) =>
            Reflect.set(window, 'finishGroupedMembership', resolve),
          );
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '12',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
              filterMask: 1,
            },
          ],
        };
      };
      Reflect.set(window, 'groupedPending', Reflect.get(window, 'owner').setForeground(true));
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls')))
      .toBe(1);
    await page.evaluate(async () => {
      Reflect.get(window, 'finishGroupedMembership')();
      await Reflect.get(window, 'groupedPending');
    });
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'Guide could not refresh. Choose Now to retry.',
    );
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({ ...c, favorite: true })),
      );
      await Reflect.get(window, 'owner').refresh();
    });
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['Channel 20']);
    expect(await page.evaluate(() => Reflect.get(window, 'groupedMembershipCalls'))).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
