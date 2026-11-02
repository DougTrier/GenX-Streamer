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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';
let browser: Browser, code: string, styles: string, searchStyles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'remote-region-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:regions')) return '\0regions';
        },
        load(id) {
          if (id === '\0regions')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell/shell.ts'))}; export {installRemoteNavigation,createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/shell/remote-navigation.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:regions', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  styles = (
    await Promise.all(
      ['style', 'management', 'guide', 'responsive', 'modal-viewport', 'fullscreen'].map((name) =>
        readStylesheet(`src/ui/${name}.css`),
      ),
    )
  ).join('\n');
  searchStyles = styles + '\n' + (await readStylesheet('src/ui/tv-density.css'));
  for (const font of [
    'yellowtail/Yellowtail-Regular.ttf',
    'roboto-condensed/RobotoCondensed-Variable.ttf',
  ])
    searchStyles = searchStyles.replaceAll(
      `../../assets/fonts/${font}`,
      `data:font/ttf;base64,${(await readFile(`assets/fonts/${font}`)).toString('base64')}`,
    );
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(television = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: code });
  await page.evaluate((tv) => {
    const api = Reflect.get(window, 'Fixture');
    const app = document.getElementById('app')!;
    api.createShell(app);
    app.dataset.deviceKind = tv ? 'tv' : 'desktop';
    document.getElementById('channel-rows')!.innerHTML =
      '<button class="channel" data-channel="first">First</button><button class="channel" data-channel="second">Second</button>';
    document.getElementById('list-empty')!.hidden = true;
    Reflect.set(
      window,
      'removeNav',
      api.installRemoteNavigation({ editMode: api.createRemoteEditMode() }),
    );
  }, television);
  return page;
}
it.each([
  { name: 'TV', width: 960, height: 540, kind: 'tv' },
  { name: 'Thor', width: 854, height: 432, kind: 'personal' },
])(
  '$name search actions share the field centre and retain owned vertical and horizontal routes',
  async ({ width, height, kind }) => {
    const page = await fixture();
    try {
      await page.setViewportSize({ width, height });
      await page.addStyleTag({ content: searchStyles });
      await page.evaluate((deviceKind) => {
        const api = Reflect.get(window, 'Fixture');
        document.getElementById('app')!.dataset.deviceKind = deviceKind;
        document.getElementById('app')!.style.setProperty('--sidebar', '390px');
        document.getElementById('clear-search')!.hidden = false;
        (document.getElementById('search') as HTMLInputElement).value = 'A';
        const microphone = document.createElement('button');
        microphone.id = 'search-centre-speech';
        microphone.className = 'speech-search-button';
        microphone.setAttribute('aria-label', 'Speak search');
        document.getElementById('speech-control')!.append(microphone);
        Reflect.get(window, 'removeNav')();
        const mode = api.createRemoteEditMode();
        Reflect.set(window, 'searchMode', mode);
        Reflect.set(window, 'removeNav', api.installRemoteNavigation({ editMode: mode }));
        Reflect.set(window, 'searchActionCount', 0);
        document.querySelector('.search-controls')!.addEventListener('click', () => {
          Reflect.set(window, 'searchActionCount', Reflect.get(window, 'searchActionCount') + 1);
        });
      }, kind);
      await page.evaluate(() => document.fonts.ready);
      const controls = ['search-programs', 'search', 'clear-search', 'search-centre-speech'];
      const geometry = await page.evaluate((ids) => {
        const field = document.getElementById('search')!.getBoundingClientRect();
        return ids.map((id) => {
          const node = document.getElementById(id)!;
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            id,
            centreOffset: box.y + box.height / 2 - (field.y + field.height / 2),
            inside: box.y >= field.y && box.bottom <= field.bottom,
            hit: hit === node || node.contains(hit),
          };
        });
      }, controls);
      expect(geometry.every((control) => Math.abs(control.centreOffset) < 0.6)).toBe(true);
      expect(geometry.every((control) => control.inside && control.hit)).toBe(true);
      await page.evaluate(() => {
        const field = document.getElementById('search')!;
        Reflect.get(window, 'searchMode').navigate(field);
        field.focus();
      });
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.top-actions'))).toBe(
        true,
      );
      await page.evaluate(() => {
        const field = document.getElementById('search')!;
        Reflect.get(window, 'searchMode').navigate(field);
        field.focus();
      });
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.browse-options'))).toBe(
        true,
      );
      await page.evaluate(() => {
        const field = document.getElementById('search')!;
        Reflect.get(window, 'searchMode').navigate(field);
        field.focus();
      });
      await page.keyboard.press('ArrowLeft');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('search-programs');
      for (const id of controls.slice(1)) {
        await page.keyboard.press('ArrowRight');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
      }
      for (const id of controls.slice(0, -1).reverse()) {
        await page.keyboard.press('ArrowLeft');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
      }
      expect(await page.evaluate(() => Reflect.get(window, 'searchActionCount'))).toBe(0);
      expect(await page.locator('#search').inputValue()).toBe('A');
    } finally {
      await page.close();
    }
  },
);
it('TV search, header and dock have predictable per-key region routes without activation', async () => {
  const page = await fixture();
  try {
    await page.locator('[data-channel="second"]').focus();
    await page.keyboard.press('ArrowRight');
    expect(
      await page.locator('#mute-button').evaluate((node) => node === document.activeElement),
    ).toBe(true);
    // Up from the dock reaches the library tabs (the Guide is in the channel row now).
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await page.locator('#mute-button').focus();
    await page.keyboard.press('ArrowLeft');
    expect(
      await page
        .locator('[data-channel="second"]')
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.locator('#live-tv-button').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#search').evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('guide-button');
    expect(
      await page.locator('#import-dialog').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(false);
    expect(await page.locator('#mute-button').getAttribute('aria-pressed')).toBe('false');
  } finally {
    await page.close();
  }
});
it('NV04: rows the channel list keeps rendered outside its visible part never win a move', async () => {
  const page = await fixture();
  try {
    const order = await page.evaluate(() => {
      // As on the Streamer: virtualized rows are positioned above the list's
      // visible top, behind the categories, and clipped by the list.
      const list = document.getElementById('channel-list')!;
      list.style.overflow = 'auto';
      const rows = document.getElementById('channel-rows')!;
      rows.style.position = 'relative';
      const filters = [...document.querySelectorAll<HTMLElement>('.filters button')].filter(
        (button) => button.getClientRects().length,
      );
      const first = filters[0]!.getBoundingClientRect();
      const listTop = list.getBoundingClientRect().top;
      const hidden = document.createElement('button');
      hidden.className = 'channel';
      hidden.dataset.channel = 'clipped';
      hidden.textContent = 'Clipped row';
      hidden.style.cssText = `position:absolute;left:0;width:240px;height:${first.height}px;top:${first.top - listTop}px`;
      rows.prepend(hidden);
      return filters.map((button) => button.textContent?.trim());
    });
    expect(order.length).toBeGreaterThan(1);
    await page.locator('.filters button').first().focus();
    for (const name of order.slice(1)) {
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(name);
    }
  } finally {
    await page.close();
  }
});
it('TV: Up from the one channel row (categories folded) reaches the search field', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      // As category-menu.ts folds them: the category buttons become a hidden list.
      document.querySelector<HTMLElement>('.filters')!.hidden = true;
    });
    await page.locator('.sidehead .row-filter').first().focus();
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
  } finally {
    await page.close();
  }
});
it('a text field reached by another handler on an arrow arrives in navigation mode (keyboard waits for OK)', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      // As the guide's toolbar does: its own handler moves focus on Left/Right.
      const bar = document.createElement('div');
      bar.innerHTML = '<button id="bar-now">Now</button><input id="bar-search" type="search">';
      document.body.append(bar);
      const now = document.getElementById('bar-now')!;
      now.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft') return;
        event.preventDefault();
        event.stopPropagation();
        document.getElementById('bar-search')!.focus();
      });
    });
    await page.locator('#bar-now').focus();
    await page.keyboard.press('ArrowLeft');
    const field = page.locator('#bar-search');
    await expect.poll(() => field.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await field.getAttribute('readonly')).toBe('');
    expect(await field.getAttribute('inputmode')).toBe('none');
    // A later focus that no arrow caused (a click, speech, a test's typing) stays editable.
    await page.locator('#bar-now').focus();
    await page.locator('#bar-search').focus();
    expect(await field.getAttribute('readonly')).toBeNull();
  } finally {
    await page.close();
  }
});
it('NV07: with a website open, Up from the player controls reaches the page area, not the header', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      // Local's page area over the picture, as local-streams.ts adds it.
      const into = document.createElement('button');
      into.type = 'button';
      into.className = 'local-stage-enter';
      into.setAttribute('aria-label', 'Use the station page');
      into.style.cssText = 'position:absolute;inset:0;opacity:0';
      document.getElementById('screen')!.append(into);
    });
    await page.locator('#mute-button').focus();
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('local-stage-enter');
    // With no page open the area is hidden and Up keeps its header route.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.local-stage-enter')!.hidden = true;
    });
    await page.locator('#mute-button').focus();
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
  } finally {
    await page.close();
  }
});
it('the channel row is Favs | Loc & Sort | Guide, and the remote reaches it from both sides', async () => {
  const page = await fixture();
  try {
    expect(await page.locator('.top-actions #guide-button').count()).toBe(0);
    expect(
      await page
        .locator('.sidehead')
        .evaluate((row) =>
          [...row.querySelectorAll<HTMLElement>('button, summary')].map((node) =>
            node.textContent?.trim(),
          ),
        ),
    ).toEqual(['Favs', 'Loc & Sort', 'Guide']);
    // Short labels on screen, the full names for screen readers and tests.
    await expect
      .poll(() => page.getByRole('button', { name: 'Favorites', exact: true }).count())
      .toBe(1);
    expect(await page.locator('.sidehead summary').getAttribute('aria-label')).toBe(
      'Location and sort',
    );
    const inRow = () => page.evaluate(() => !!document.activeElement?.closest('.sidehead'));
    await page.locator('.filters button[data-filter="sports"]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await inRow()).toBe(true);
    await page.locator('#guide-button').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('channel');
    await page.keyboard.press('ArrowUp');
    expect(await inRow()).toBe(true);
  } finally {
    await page.close();
  }
});
it('TV search Down visits category filters and Up returns, while active text editing owns arrows', async () => {
  const page = await fixture();
  try {
    // The production location action sits below the filters. Align this real
    // button with the wide search field: geometric scoring must not skip a row.
    await page.evaluate(() => {
      const search = document.getElementById('search')!.getBoundingClientRect();
      const filters = document.querySelector('.filters')!.getBoundingClientRect();
      const location = document.createElement('button');
      location.id = 'location-route-fixture';
      location.textContent = 'Location and sort';
      location.style.cssText = `position:fixed;left:${search.left + search.width / 2 - 60}px;top:${filters.bottom + 4}px;width:120px;height:44px`;
      document.getElementById('geography-controls')!.append(location);
      const microphone = document.createElement('button');
      microphone.id = 'voice-route-fixture';
      microphone.className = 'speech-search-button';
      microphone.setAttribute('aria-label', 'Voice search');
      microphone.textContent = 'Mic';
      document.getElementById('speech-control')!.append(microphone);
    });
    await page.locator('#live-tv-button').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.filters'))).toBe(true);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.filter)).toBe(
      'all',
    );
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    for (const selector of ['#search-programs', '#voice-route-fixture']) {
      await page.locator(selector).focus();
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.filters'))).toBe(true);
    }
    await page.locator('.filters button[data-filter="all"]').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.filter)).toBe(
      'movies',
    );
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.filter)).toBe(
      'movies',
    );
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.filters'))).toBe(true);
    expect(
      await page.locator('.browse-options .filters button[aria-pressed="true"]').textContent(),
    ).toContain('All');
  } finally {
    await page.close();
  }
});
it('desktop separator stays reachable and TV fullscreen does not route to hidden header', async () => {
  const page = await fixture(false);
  try {
    await page.locator('#mute-button').focus();
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('divider');
    await page.evaluate(() => {
      const app = document.getElementById('app')!;
      app.dataset.deviceKind = 'tv';
      app.classList.add('viewing-fullscreen');
    });
    await page.locator('#mute-button').focus();
    await page.keyboard.press('ArrowUp');
    expect(
      await page.locator('#guide-button').evaluate((node) => node === document.activeElement),
    ).toBe(false);
  } finally {
    await page.close();
  }
});
it('nested modal return does not overwrite original parent opener', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const opener = document.getElementById('settings-button')!;
      const parent = document.createElement('dialog'),
        child = document.createElement('dialog');
      parent.id = 'parent';
      parent.innerHTML = '<button id="child-opener">Child</button>';
      child.id = 'child';
      child.innerHTML = '<input id="child-field">';
      document.body.append(parent, child);
      opener.focus();
      parent.showModal();
      document.getElementById('child-opener')!.focus();
      child.showModal();
      document.getElementById('child-field')!.focus();
      child.close();
      document.getElementById('child-opener')!.focus();
      parent.close();
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.waitForFunction(() => document.activeElement?.id === 'settings-button');
    expect(
      await page.locator('#settings-button').evaluate((node) => node === document.activeElement),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

async function nativeEditingFixture(): Promise<Page> {
  const page = await fixture();
  await page.addStyleTag({ content: searchStyles });
  await page.evaluate(() => {
    const api = Reflect.get(window, 'Fixture');
    Reflect.get(window, 'removeNav')();
    const mode = api.createRemoteEditMode();
    Reflect.set(window, 'nativeEditMode', mode);
    Reflect.set(window, 'removeNav', api.installRemoteNavigation({ editMode: mode }));
    (document.getElementById('search') as HTMLInputElement).value = 'QA';
    document.getElementById('clear-search')!.hidden = false;
  });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#live-tv-button').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
  return page;
}
async function nativeIme(page: Page, visible: boolean, sequence: number, extra = {}) {
  await page.evaluate(
    ({ visible, sequence, extra }) => {
      const detail = {
        schemaVersion: 1,
        visible,
        bottomPx: visible ? 200 : 0,
        overlapPx: visible ? 200 : 0,
        webViewHeightPx: 540,
        sequence,
        ...extra,
      };
      Reflect.set(window, '__genxImeInsets', detail);
      window.dispatchEvent(new CustomEvent('native-ime-insets', { detail }));
    },
    { visible, sequence, extra },
  );
}
it.each([
  ['ArrowUp', '.top-actions'],
  ['ArrowDown', '.browse-options'],
  ['ArrowLeft', '#search-programs'],
  ['ArrowRight', '#clear-search'],
])(
  'after Android consumes keyboard Back, the first %s returns the exact editor to navigation',
  async (key, region) => {
    const page = await nativeEditingFixture();
    try {
      await nativeIme(page, true, 1);
      await nativeIme(page, false, 2);
      // Hiding the IME alone never moves focus or pre-consumes an application Back.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
      expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
      await page.keyboard.press(key);
      expect(
        await page.evaluate((selector) => !!document.activeElement?.closest(selector), region),
      ).toBe(true);
      expect(await page.locator('#search').inputValue()).toBe('QA');
    } finally {
      await page.close();
    }
  },
);
it('a visible native keyboard retains native caret arrows, and hidden-only/stale/malformed measurements do not finish editing', async () => {
  const page = await nativeEditingFixture();
  try {
    await nativeIme(page, false, 1);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await nativeIme(page, true, 3);
    await page
      .locator('#search')
      .evaluate((field) => (field as HTMLInputElement).setSelectionRange(2, 2));
    await page.keyboard.press('ArrowLeft');
    expect(
      await page.locator('#search').evaluate((field) => (field as HTMLInputElement).selectionStart),
    ).toBe(1);
    await nativeIme(page, false, 2);
    await nativeIme(page, false, 4, { overlapPx: 9999 });
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
    await nativeIme(page, false, 4);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
  } finally {
    await page.close();
  }
});
it('repeated hidden notifications preserve dismissal, while a newer visible notification cancels it', async () => {
  const page = await nativeEditingFixture();
  try {
    await nativeIme(page, true, 1);
    await nativeIme(page, false, 2);
    await nativeIme(page, false, 3);
    await nativeIme(page, true, 4);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await nativeIme(page, false, 5);
    await nativeIme(page, false, 6);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
  } finally {
    await page.close();
  }
});
it.each([false, true])(
  'a reopened edit session on the same field is not retired by its older IME owner (hidden first: %s)',
  async (hiddenFirst) => {
    const page = await nativeEditingFixture();
    try {
      await nativeIme(page, true, 1);
      if (hiddenFirst) await nativeIme(page, false, 2);
      await page.evaluate(() => {
        const mode = Reflect.get(window, 'nativeEditMode');
        mode.exit();
        mode.begin(document.getElementById('search'));
      });
      if (!hiddenFirst) await nativeIme(page, false, 2);
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
      expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
      // A fresh keyboard lifetime for this new session can still finish normally.
      await nativeIme(page, true, 3);
      await nativeIme(page, false, 4);
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
    } finally {
      await page.close();
    }
  },
);
it('another editor and a pointer-origin field cannot inherit a remote IME dismissal', async () => {
  const page = await nativeEditingFixture();
  try {
    await nativeIme(page, true, 1);
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'ime-other';
      document.querySelector('.browser')!.prepend(field);
      const mode = Reflect.get(window, 'nativeEditMode');
      mode.navigate(field);
      field.focus();
      mode.begin(field);
    });
    await nativeIme(page, false, 2);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('ime-other');
    await page.locator('#search').click();
    await nativeIme(page, true, 3);
    await nativeIme(page, false, 4);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
  } finally {
    await page.close();
  }
});
it('a separately delivered Back keeps its edit-layer ownership and disposal clears the pending handoff', async () => {
  const page = await nativeEditingFixture();
  try {
    await nativeIme(page, true, 1);
    await nativeIme(page, false, 2);
    expect(await page.evaluate(() => Reflect.get(window, 'nativeEditMode').exit())).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('live-tv-button');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await nativeIme(page, true, 3);
    await nativeIme(page, false, 4);
    await page.evaluate(() => {
      Reflect.get(window, 'removeNav')();
      const field = document.getElementById('search')!;
      const mode = Reflect.get(window, 'nativeEditMode');
      mode.navigate(field);
      field.focus();
      mode.begin(field);
    });
    await nativeIme(page, false, 5);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    expect(await page.locator('#search').getAttribute('readonly')).toBeNull();
  } finally {
    await page.close();
  }
});
