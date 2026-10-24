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
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import ts from 'typescript';
import { readStylesheet } from '../support/stylesheet';

let browser: Browser, bundle: string, css: string;
let nativeBackScript: string, mainBackListener: string;
const evidence = 'artifacts/archive-footer/2026-10-16';
const phase = process.env.GENX_FOOTER_PHASE ?? 'current';
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid footer fixture phase');
beforeAll(async () => {
  const [main, foreground, android] = await Promise.all([
    readFile('src/main.ts', 'utf8'),
    readFile('src/application/foreground-controller.ts', 'utf8'),
    readFile('src-tauri/gen/android/app/src/main/java/com/tmg/tv/ViewingPlugin.kt', 'utf8'),
  ]);
  // The Back listener is registered while main.ts loads (when it creates the
  // foreground controller), before initialize() and before any GenXtra
  // control can mount.
  const listenerStart = foreground.indexOf("window.addEventListener('native-back-requested'");
  const listenerEnd = foreground.indexOf('async function handleBack()', listenerStart);
  const created = main.indexOf('createForegroundController(app)');
  if (
    listenerStart < 0 ||
    listenerEnd < listenerStart ||
    created < 0 ||
    created > main.indexOf('void initialize()') ||
    main.includes('mountArchiveSearch(')
  )
    throw new Error('Production Archive/Back listener registration order changed');
  mainBackListener = ts.transpileModule(foreground.slice(listenerStart, listenerEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  nativeBackScript =
    android.match(
      /webView\.evaluateJavascript\("([^"\r\n]*native-back-requested[^"\r\n]*)", null\)/,
    )?.[1] ?? '';
  if (!nativeBackScript) throw new Error('Production Android Back payload missing');
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'tests/catalog/fixtures/archive-footer.ts', name: 'Footer', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing footer fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing footer fixture code');
  bundle = chunk.code;
  css = (
    await Promise.all(
      [
        'archive-search',
        'style',
        'fullscreen',
        'video-quality',
        'guide',
        'responsive',
        'in-app-select',
        'genxtra',
        'media-results',
        'tv-density',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  ).join('\n');
  for (const font of [
    'yellowtail/Yellowtail-Regular.ttf',
    'roboto-condensed/RobotoCondensed-Variable.ttf',
  ]) {
    const bytes = await readFile(`assets/fonts/${font}`);
    css = css.replace(
      `../../assets/fonts/${font}`,
      `data:font/ttf;base64,${bytes.toString('base64')}`,
    );
  }
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function mount(width = 960, height = 540): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const calls: unknown[] = [];
    Reflect.set(window, 'backCalls', calls);
    Reflect.set(window, 'isTauri', () => true);
    Reflect.set(window, 'invoke', async (command: unknown, args: unknown) => {
      calls.push({ command, args });
    });
    Reflect.set(window, 'env', {
      notice: (message: unknown) => {
        calls.push({ notice: message });
      },
    });
    Reflect.set(window, 'handleBack', async () => {
      calls.push('unexpected-main-navigation');
    });
  });
  // Deliberately register real main before the component, covering late-mounted controls.
  await page.addScriptTag({ content: mainBackListener });
  await page.evaluate(async () => {
    const F = Reflect.get(window, 'Footer'),
      app = document.getElementById('app')!;
    const backReceipts: Array<{ requestId: unknown; consumed: boolean }> = [];
    window.addEventListener('native-back-requested', (event) => {
      backReceipts.push({
        requestId: (event as CustomEvent<{ requestId: unknown }>).detail?.requestId,
        consumed: event.defaultPrevented,
      });
    });
    F.createShell(app);
    app.dataset.deviceKind = 'tv';
    app.dataset.contentLibrary = 'genxtra';
    document.documentElement.style.setProperty('--sidebar', '360px');
    document.getElementById('cast-button')!.hidden = true;
    for (const id of ['genxtra-browse-filters', 'genxtra-library'])
      document.getElementById(id)!.hidden = false;
    const input = document.getElementById('search') as HTMLInputElement;
    input.placeholder = 'Search shows and movies';
    let snapshot = {
      revision: '1',
      entries: [],
      activeFileRef: null,
      progress: null,
      state: 'idle',
      message: null,
      cleanupPending: false,
    };
    const listeners = new Set<() => void>();
    let rejectDownload = false;
    const downloads = {
      get snapshot() {
        return snapshot;
      },
      subscribe(fn: () => void) {
        listeners.add(fn);
        fn();
        return () => listeners.delete(fn);
      },
      cancel: async () => {},
      download: async () => {
        if (rejectDownload) throw new Error('Controlled pre-admission failure');
      },
      remove: async () => {},
    };
    const titles = Array.from({ length: 50 }, (_, i) => ({
      favorite: false,
      titleRef: (i + 1).toString(16).padStart(64, '0'),
      title: `Readable title ${i + 1}`,
      kind: 'tv',
      contentType: 'tv',
      contentTypeProvenance: 'provider-item',
      releaseYear: 2020,
      curated: false,
      titleProvenance: 'provider-item',
      fileCount: 34,
      durationSeconds: 100,
      rights: null,
      rank: i + 1,
      quality: 'metadata-h264',
      observedMs: 1,
    }));
    const pendingItems = [
      {
        titleRef: 'a'.repeat(64),
        itemId: 'pending',
        title: 'Explore another series',
        kind: 'tv',
        originalYear: null,
        nextOffset: 0,
        providerFileCount: 10,
        availableFileCount: 1,
        complete: false,
        capacityReached: false,
      },
    ];
    let selected = 0,
      loaded = 0;
    const ui = F.mountArchiveSearch(document.getElementById('genxtra-library'), {
      input,
      readyScope: () => 'root',
      detailsContainer: document.getElementById('archive-details'),
      downloads,
      onPlaySaved: async () => {
        selected++;
      },
      onSelect: async () => {
        selected++;
      },
      onFavorite: async () => {
        throw new Error('Unexpected favorite edit');
      },
      catalog: {
        query: async () => ({
          schemaVersion: 1,
          revision: '1',
          offset: 0,
          totalCount: 227,
          items: titles,
          more: true,
        }),
        files: async () => ({
          schemaVersion: 1,
          revision: '1',
          titleRef: titles[0].titleRef,
          offset: 0,
          totalCount: 2,
          more: false,
          files: [0, 1].map((i) => ({
            fileRef: (500 + i).toString(16).padStart(64, '0'),
            title: `Episode ${i + 1}`,
            fileName: `episode${i + 1}.mp4`,
            itemId: 'fixture',
            format: 'h.264',
            durationSeconds: 100,
            sizeBytes: '1024',
            availability: 'unverified',
            observedMs: 1,
          })),
        }),
      },
      pendingFiles: async () => ({
        schemaVersion: 1,
        revision: '1',
        offset: 0,
        totalCount: 9,
        items: pendingItems,
        more: false,
      }),
      loadFiles: async () => {
        loaded++;
        throw new Error('Controlled exploration failure');
      },
    });
    await ui.resume();
    const remote = F.installRemoteNavigation();
    Reflect.set(window, 'footerFixture', {
      ui,
      remote,
      selected: () => selected,
      rejectDownload: () => {
        rejectDownload = true;
      },
      loaded: () => loaded,
      backReceipts,
      emit(patch: unknown) {
        snapshot = { ...snapshot, ...(patch as object) };
        for (const listener of listeners) listener();
      },
    });
  });
  return page;
}
for (const [width, height] of [
  [960, 540],
  [1280, 800],
])
  it(`keeps a compact truthful footer and readable title viewport at ${width}x${height}`, async () => {
    const page = await mount(width, height);
    try {
      const geometry = await page.evaluate(() => {
        const list = document.querySelector('.gx-archive-results')!.getBoundingClientRect();
        const band = document.querySelector('.gx-archive-footer-band')?.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.gx-archive-title-button')].map((n) =>
          n.getBoundingClientRect(),
        );
        return {
          listHeight: list.height,
          bandHeight: band?.height ?? null,
          visibleTitles: rows.filter((r) => r.top >= list.top && r.bottom <= list.bottom).length,
          overflow: document.documentElement.scrollHeight > innerHeight,
          footerText: document.querySelector('.gx-archive-result-footer')!.textContent,
        };
      });
      await writeFile(
        `${evidence}/${phase}-${width}-geometry.json`,
        JSON.stringify(geometry, null, 2),
      );
      await page.screenshot({ path: `${evidence}/${phase}-${width}.png` });
      expect(geometry.listHeight).toBeGreaterThanOrEqual(width === 960 ? 240 : 400);
      expect(geometry.bandHeight).not.toBeNull();
      expect(geometry.bandHeight!).toBeLessThanOrEqual(44);
      expect(geometry.visibleTitles).toBeGreaterThanOrEqual(width === 960 ? 4 : 7);
      expect(geometry.overflow).toBe(false);
      expect(geometry.footerText).toBe('50 of 227 loaded');
      await browserExpect(page.locator('.gx-archive-downloads')).toBeHidden();
    } finally {
      await page.close();
    }
  });
it('opens exploration without shrinking the list and Back restores the exact opener', async () => {
  const page = await mount();
  try {
    const summary = page.locator('.gx-archive-pending-summary');
    const listHeight = await page.locator('.gx-archive-results').evaluate((n) => n.clientHeight);
    const origin = page.locator('.gx-archive-title-button').nth(2);
    await origin.focus();
    await summary.focus();
    await page.keyboard.press('ArrowUp');
    await browserExpect(origin).toBeFocused();
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await browserExpect(
      page.getByRole('button', { name: 'Find episodes', exact: true }),
    ).toBeFocused();
    expect(await page.locator('.gx-archive-results').evaluate((n) => n.clientHeight)).toBe(
      listHeight,
    );
    await page.keyboard.press('ArrowUp');
    await browserExpect(summary).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await browserExpect(origin).toBeFocused();
    await browserExpect(page.locator('.gx-archive-pending')).not.toHaveAttribute('open', '');
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await browserExpect(summary).toBeFocused();
    await browserExpect(page.locator('.gx-archive-pending')).not.toHaveAttribute('open', '');
    await page.keyboard.press('Enter');
    expect(
      await summary.evaluate(
        (node) =>
          !node.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'BrowserBack',
              bubbles: true,
              cancelable: true,
            }),
          ),
      ),
    ).toBe(true);
    await browserExpect(summary).toBeFocused();
    await browserExpect(page.locator('.gx-archive-pending')).not.toHaveAttribute('open', '');
    expect(await page.evaluate(() => Reflect.get(window, 'footerFixture').loaded())).toBe(0);
    await page.locator('.gx-archive-title-button').first().click();
    const play = page.locator('.gx-archive-file-button'),
      caret = page.locator('.gx-archive-file-details>summary');
    await play.first().focus();
    await page.keyboard.press('ArrowRight');
    await browserExpect(caret.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(caret.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await browserExpect(play.nth(1)).toBeFocused();
  } finally {
    await page.close();
  }
});
it('keeps saved downloads reachable without shrinking results and returns owned focus after removal', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      Reflect.get(window, 'footerFixture').emit({
        entries: [
          {
            downloadRef: 'c'.repeat(64),
            fileRef: 'b'.repeat(64),
            titleRef: 'a'.repeat(64),
            title: 'Saved series',
            fileTitle: 'Saved episode',
            fileName: 'episode.mp4',
            sizeBytes: '1024',
            completedMs: 1,
            integrity: 'sha1-verified',
            available: true,
          },
        ],
      }),
    );
    const summary = page.getByText('Saved · 1', { exact: true });
    const height = await page.locator('.gx-archive-results').evaluate((n) => n.clientHeight);
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    const play = page.getByRole('button', { name: 'Play saved', exact: true });
    await browserExpect(play).toBeFocused();
    expect(await page.locator('.gx-archive-results').evaluate((n) => n.clientHeight)).toBe(height);
    expect(await page.evaluate(() => Reflect.get(window, 'footerFixture').selected())).toBe(0);
    await page.keyboard.press('Escape');
    await browserExpect(summary).toBeFocused();
    await page.evaluate(() => Reflect.get(window, 'footerFixture').emit({ entries: [] }));
    await browserExpect(page.locator('.gx-archive-downloads')).toBeHidden();
    await browserExpect(page.locator('.gx-archive-title-button').first()).toBeFocused();
    await page.locator('#search').focus();
    await page.evaluate(() => Reflect.get(window, 'footerFixture').emit({ entries: [] }));
    await browserExpect(page.locator('#search')).toBeFocused();
  } finally {
    await page.close();
  }
});
it('keeps unloaded, failed and active download states visible while hiding only proven idle-empty', async () => {
  const page = await mount();
  try {
    const downloads = page.locator('.gx-archive-downloads');
    await browserExpect(downloads).toBeHidden();
    await page.evaluate(() =>
      Reflect.get(window, 'footerFixture').emit({ revision: null, state: 'reading' }),
    );
    await browserExpect(downloads).toBeVisible();
    await browserExpect(downloads).toContainText('Loading saved videos');
    await page.evaluate(() =>
      Reflect.get(window, 'footerFixture').emit({
        revision: '1',
        state: 'failed',
        message: 'Downloads are unavailable.',
      }),
    );
    await browserExpect(downloads).toContainText('Downloads are unavailable.');
    await page.evaluate(() =>
      Reflect.get(window, 'footerFixture').emit({
        state: 'downloading',
        message: null,
        activeFileRef: 'b'.repeat(64),
      }),
    );
    await browserExpect(
      page.getByRole('button', { name: 'Cancel download', exact: true }),
    ).toBeVisible();
    await browserExpect(downloads).toContainText('Downloading');
    await page.evaluate(() =>
      Reflect.get(window, 'footerFixture').emit({ state: 'idle', activeFileRef: null }),
    );
    await browserExpect(downloads).toBeHidden();
  } finally {
    await page.close();
  }
});
it('reveals pre-admission download failures from a previously hidden idle-empty footer', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => Reflect.get(window, 'footerFixture').rejectDownload());
    await page.locator('.gx-archive-title-button').first().click();
    await page.locator('.gx-archive-file-details > summary').first().click();
    await page
      .locator('.gx-archive-file-details')
      .first()
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    await browserExpect(page.locator('.gx-archive-downloads')).toBeVisible();
    await browserExpect(page.locator('.gx-archive-download-progress')).toBeVisible();
    await browserExpect(page.locator('.gx-archive-download-progress')).not.toHaveText('');
  } finally {
    await page.close();
  }
});
it('consumes native Back before main navigation, preserves episodes and removes its listener on disposal', async () => {
  const page = await mount();
  try {
    const title = page.locator('.gx-archive-title-button').first();
    await title.click();
    const before = await page.locator('.gx-archive-results').innerHTML();
    const summary = page.locator('.gx-archive-pending-summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await browserExpect(
      page.getByRole('button', { name: 'Find episodes', exact: true }),
    ).toBeFocused();
    await page.addScriptTag({ content: nativeBackScript.replace('$id', 'back-1') });
    await browserExpect(summary).toBeFocused();
    await browserExpect(page.locator('.gx-archive-pending')).not.toHaveAttribute('open', '');
    expect(await page.locator('.gx-archive-results').innerHTML()).toBe(before);
    expect(await page.evaluate(() => Reflect.get(window, 'footerFixture').backReceipts)).toEqual([
      { requestId: 'back-1', consumed: true },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'backCalls'))).toEqual([
      { command: 'acknowledge_back', args: { requestId: 'back-1' } },
    ]);
    const disposed = await page.evaluate(async () => {
      const disclosure = document.querySelector<HTMLDetailsElement>('.gx-archive-pending')!;
      const originalRemove = window.removeEventListener.bind(window);
      let removed = 0;
      window.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) => {
        if (type === 'native-back-requested' && options === true) removed++;
        originalRemove(type, listener, options);
      };
      await Reflect.get(window, 'footerFixture').ui.dispose();
      window.removeEventListener = originalRemove;
      disclosure.open = true;
      const consumed = !document.dispatchEvent(
        new CustomEvent('native-back-requested', {
          detail: { requestId: 'back-2' },
          cancelable: true,
          bubbles: true,
        }),
      );
      return {
        removed,
        consumed,
        detachedOpen: disclosure.open,
        receipts: Reflect.get(window, 'footerFixture').backReceipts,
      };
    });
    expect(disposed).toEqual({
      removed: 1,
      consumed: false,
      detachedOpen: true,
      receipts: [
        { requestId: 'back-1', consumed: true },
        { requestId: 'back-2', consumed: false },
      ],
    });
  } finally {
    await page.close();
  }
});
