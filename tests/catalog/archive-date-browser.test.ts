import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'tests/catalog/fixtures/archive-date.ts', name: 'Dates', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing date fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing date fixture code');
  bundle = chunk.code;
  css = await readFile('src/ui/archive-search.css', 'utf8');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

for (const width of [960, 1280])
  it.each([false, true])(
    `IA assessment=%s at ${width}px preserves compact cards, explicit Play and source-year facts`,
    async (assessed) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent('<div id="app"></div>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(async (assessed) => {
          const D = Reflect.get(window, 'Dates');
          D.createShell(document.getElementById('app'));
          document.getElementById('app')!.dataset.contentLibrary = 'genxtra';
          const titleRef = 'a'.repeat(64);
          const title = D.validateArchiveTitle({
            favorite: false,
            titleRef,
            title: 'The Six Million Dollar Man',
            kind: 'tv',
            releaseYear: 2020,
            curated: false,
            titleProvenance: 'provider-item',
            fileCount: 1,
            durationSeconds: 100,
            rights: null,
            rank: 1,
            quality: 'metadata-h264',
            observedMs: 1,
            ...(assessed
              ? {
                  dateAssessment: {
                    version: 1,
                    providerListedYear: 2020,
                    originalReleaseYear: null,
                    status: 'unverified-item-date',
                    provenance: 'legacy-item-year',
                    field: 'unknown',
                  },
                }
              : {}),
          });
          let selected = 0;
          const input = document.getElementById('search') as HTMLInputElement;
          const ui = D.mountArchiveSearch(document.getElementById('genxtra-library'), {
            input,
            readyScope: () => 'root',
            onSelect: async () => {
              selected++;
            },
            catalog: {
              query: async () => ({
                schemaVersion: 1,
                revision: '1',
                offset: 0,
                totalCount: 1,
                items: [title],
                more: false,
              }),
              files: async () => ({
                schemaVersion: 1,
                revision: '1',
                titleRef,
                offset: 0,
                totalCount: 1,
                more: false,
                files: [
                  {
                    fileRef: 'b'.repeat(64),
                    title: 'Moon and Desert',
                    fileName: 'episode.mp4',
                    itemId: 'test-item',
                    format: 'h.264',
                    durationSeconds: 100,
                    sizeBytes: '1024',
                    availability: 'unverified',
                    observedMs: 1,
                  },
                ],
              }),
            },
          });
          document.getElementById('genxtra-library')!.hidden = false;
          await ui.resume();
          Reflect.set(window, 'datesFixture', { ui, selected: () => selected });
        }, assessed);
        await browserExpect(page.locator('.gx-archive-result-subtitle')).toHaveText(
          'Video · 1 video',
        );
        expect(await page.locator('#genxtra-filter-status').textContent()).toContain(
          'Source-listed years',
        );
        expect(await page.locator('#genxtra-decade-select').getAttribute('aria-label')).toBe(
          'GenXtra source-listed decade',
        );
        await page.locator('.gx-archive-title-button').click();
        await browserExpect(page.locator('.gx-archive-file-row')).toHaveCount(1);
        await browserExpect(page.locator('.gx-archive-metadata')).toContainText('Source year 2020');
        await page.getByText('More info', { exact: true }).click();
        await browserExpect(page.locator('.gx-archive-title-info')).toContainText(
          'Original release year: Unknown',
        );
        await browserExpect(page.locator('.gx-archive-title-info')).toContainText(
          'Source-listed year: 2020',
        );
        await browserExpect(page.locator('.gx-archive-title-info')).toContainText(
          'Source metadata; exact date field not retained',
        );
        await page.locator('.gx-archive-file-details > summary').click();
        await browserExpect(page.locator('.gx-archive-file-facts')).toContainText(
          'Unverified item date',
        );
        await browserExpect(page.locator('.gx-archive-file-facts')).toContainText(
          'Source-listed year',
        );
        await browserExpect(page.locator('.gx-archive-file-facts')).toContainText('2020');
        expect(await page.evaluate(() => Reflect.get(window, 'datesFixture').selected())).toBe(0);
        await page.getByRole('button', { name: 'Play Moon and Desert', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'datesFixture').selected())).toBe(1);
        await page.evaluate(() => Reflect.get(window, 'datesFixture').ui.dispose());
      } finally {
        await page.close();
      }
    },
  );
