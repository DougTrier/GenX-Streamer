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
 * What the GenXtra banner browser tests share: the built component, the
 * browser and the mount helper. Each genxtra-banner*-browser.test.ts file calls
 * useGenxtraBannerBrowser() once.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll } from 'vitest';
import { build } from 'vite';
import { readStylesheet } from '../support/stylesheet';
import { readFile } from 'node:fs/promises';

export let browser: Browser, bundle: string, css: string;

export async function mount(
  width: number,
  height: number,
  tv = false,
  withFiles = false,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  // A controlled loopback document preserves real secure-context APIs used by
  // the audio attachment owner; no network listener or crypto replacement.
  await page.route('http://localhost/controlled-layout', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto('http://localhost/controlled-layout');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ narrow, tv, withFiles }) => {
      const module = Reflect.get(window, 'GenxtraLayout');
      const app = document.getElementById('app')!;
      Reflect.get(window, 'GenxtraShell').createShell(app);
      app.dataset.deviceKind = tv ? 'tv' : narrow ? 'handheld' : 'desktop';
      app.dataset.contentLibrary = 'genxtra';
      app.classList.toggle('compact-content', narrow);
      app.dataset.compactView = 'channels';
      if (tv) {
        document.getElementById('cast-button')!.hidden = true;
        // The real TV capability disables casting before the viewing shell is shown.
        document.documentElement.style.setProperty('--sidebar', '360px');
      }
      for (const id of ['genxtra-browse-filters', 'genxtra-library'])
        document.getElementById(id)!.hidden = false;
      const yearStatus = document.getElementById('genxtra-filter-status')!;
      yearStatus.hidden = false;
      yearStatus.textContent = 'All years · Original release metadata';
      const input = document.getElementById('search') as HTMLInputElement;
      input.value = 'Controlled layout';
      const speech = Reflect.get(window, 'GenxtraSpeech').mountSpeechSearch(
        document.getElementById('speech-control'),
        input,
        {
          recognizer: {
            capability: async () => {
              throw Error('Unexpected voice activation');
            },
            recognize: async () => {
              throw Error('Unexpected recognition');
            },
            cancel: async () => {},
            dispose: async () => {},
          },
          notice: () => {},
        },
      );
      Reflect.set(window, 'layoutSpeech', speech);
      document.getElementById('clear-search')!.hidden = false;
      const titleRef = 'a'.repeat(64);
      const title = {
        titleRef,
        title: 'Controlled layout fixture',
        kind: 'tv',
        contentType: 'tv',
        contentTypeProvenance: 'provider-item',
        releaseYear: 1972,
        curated: true,
        titleProvenance: 'provider-item',
        fileCount: withFiles ? 2 : 1,
        durationSeconds: 120,
        rights: null,
        rank: 1,
        quality: 'metadata-h264',
        observedMs: 1,
        favorite: false,
      };
      // Decode actual JPEG bytes with the same 180x135 natural dimensions as the
      // packaged failure. This is controlled display data, never production content.
      const canvas = document.createElement('canvas');
      canvas.width = 180;
      canvas.height = 135;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#369';
      context.fillRect(0, 0, 180, 135);
      context.fillStyle = '#fc3';
      context.fillRect(0, 0, 20, 20);
      context.fillRect(160, 115, 20, 20);
      const dataUrl = canvas.toDataURL('image/jpeg');
      Reflect.set(window, 'selections', []);
      const activity = { queries: 0, discoveries: 0, language: 'english-first' };
      Reflect.set(window, 'layoutActivity', activity);
      const ui = module.mountArchiveSearch(document.getElementById('genxtra-library'), {
        input,
        detailsContainer: document.getElementById('archive-details'),
        readyScope: () => 'controlled-layout',
        playbackActive: () => Reflect.get(window, 'fixturePlaying') === true,
        onTitleSelected: () => {
          app.dataset.compactView = 'watch';
        },
        onSelect: async () => Reflect.get(window, 'selections').push('unexpected-play'),
        onFavorite: async () => {
          throw Error('Unexpected fixture favorite activation');
        },
        artwork: async (request: { titleRef: string }) => ({
          schemaVersion: 1,
          titleRef: request.titleRef,
          revision: '1',
          artworkRef: 'c'.repeat(64),
          mimeType: 'image/jpeg',
          width: 180,
          height: 135,
          byteLength: atob(dataUrl.split(',')[1]).length,
          dataUrl,
        }),
        catalog: {
          query: async (request: { languageMode: string }) => {
            activity.queries++;
            activity.language = request.languageMode;
            const items = Array.from({ length: tv ? 12 : 1 }, (_, i) => ({
              ...title,
              titleRef: (i + 1).toString(16).padStart(64, '0'),
              title: `Controlled layout fixture ${i + 1}`,
            }));
            // Preserve the original first title authority used by the JPEG fixture.
            items[0]!.titleRef = titleRef;
            return {
              schemaVersion: 1,
              revision: '1',
              totalCount: items.length,
              offset: 0,
              items,
              more: false,
            };
          },
          files: async () => ({
            schemaVersion: 1,
            revision: '1',
            titleRef,
            totalCount: withFiles ? 2 : 0,
            offset: 0,
            files: withFiles
              ? [0, 1].map((index) => ({
                  fileRef: (index ? 'd' : 'b').repeat(64),
                  title: `Controlled episode ${index + 1}`,
                  fileName: `controlled-${index + 1}.mp4`,
                  itemId: 'controlled-layout',
                  format: 'h.264',
                  durationSeconds: 120,
                  sizeBytes: '1024',
                  availability: 'unverified',
                  observedMs: 1,
                }))
              : [],
            more: false,
          }),
        },
        discover: async () => {
          activity.discoveries++;
          return { revision: '1', outcome: 'partial' };
        },
      });
      Reflect.set(window, 'archiveLayout', ui);
      await ui.resume(input.value);
      if (tv)
        Reflect.set(
          window,
          'layoutSelects',
          Reflect.get(window, 'GenxtraSelects').installInAppSelects(document.body),
        );
      await document.fonts.ready;
    },
    { narrow: width < 650, tv, withFiles },
  );
  return page;
}

/** The hooks every test file of this suite needs; call once at the top of the file. */
export function useGenxtraBannerBrowser(): void {
  beforeAll(async () => {
    bundle = '';
    for (const [file, name] of [
      ['shell', 'GenxtraShell'],
      ['archive-search', 'GenxtraLayout'],
      ['in-app-select', 'GenxtraSelects'],
      ['selected-guide', 'GenxtraGuide'],
      ['speech-search', 'GenxtraSpeech'],
      ['channel-browser', 'LiveRows'],
      ['fullscreen-presentation', 'LayoutFullscreen'],
      ['vod-dock', 'LayoutVODDock'],
      ['video-quality', 'LayoutQuality'],
      ['../../tests/catalog/fixtures/tv-dock-audio', 'LayoutAudio'],
    ]) {
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          lib: { entry: `src/ui/${file}.ts`, name, formats: ['iife'] },
        },
      });
      const output = Array.isArray(result) ? result[0] : result;
      if (!output || !('output' in output)) throw new Error('Missing GenXtra fixture bundle');
      const chunk = output.output.find((entry) => entry.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('Missing GenXtra fixture code');
      bundle += `${chunk.code}\n`;
    }
    // Include the real global cascade, not only the component stylesheet. In particular,
    // responsive.css supplies the generic filter pseudo icon that caused the regression.
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
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
}
