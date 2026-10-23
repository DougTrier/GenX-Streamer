import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { validateSeriesIdentity } from '../../src/platform/series-identity';

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/archive-series-suggestions.ts', formats: ['iife'], name: 'SeriesUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing UI bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing UI entry');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
const identity = {
  shows: [
    { name: 'The Andy Griffith Show', premieredYear: 1960, endedYear: 1968, network: 'CBS' },
    { name: '<img src=x onerror=alert(1)>', premieredYear: 1971 },
  ],
  person: { name: 'Don Knotts', shows: [{ name: "Three's Company", premieredYear: 1977 }] },
  attribution: 'Show information from TVmaze (CC BY-SA 4.0)',
};
interface SeriesView {
  element: HTMLElement;
  show(query: string): Promise<void>;
  clear(): void;
}
interface SeriesWindow {
  view: SeriesView;
  chosen: string[];
}
type MountSeries = (
  doc: Document,
  options: {
    lookup(query: string, signal: AbortSignal): Promise<unknown>;
    choose(title: string): void;
  },
) => SeriesView;
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate((reply) => {
    const w = window as unknown as Record<string, unknown>;
    w.chosen = [];
    w.lookups = [];
    const view = (w.SeriesUI as { mountSeriesSuggestions: MountSeries }).mountSeriesSuggestions(
      document,
      {
        lookup: (query: string, signal: AbortSignal) => {
          (w.lookups as string[]).push(query);
          if (query === 'fail') return Promise.reject(new Error('offline'));
          if (query === 'slow')
            return new Promise((resolve) =>
              setTimeout(() => resolve(signal.aborted ? null : reply), 200),
            );
          return Promise.resolve(reply);
        },
        choose: (title: string) => (w.chosen as string[]).push(title),
      },
    );
    document.getElementById('root')!.append(view.element);
    w.view = view;
  }, identity);
  return page;
}
describe('GenXtra show suggestions', () => {
  it('renders person and title chips as text, omits the current query and runs a chosen title', async () => {
    const page = await fixture();
    await page.evaluate(() =>
      (window as unknown as SeriesWindow).view.show('the andy griffith show'),
    );
    const chips = await page.locator('.gx-archive-series-chip').allTextContents();
    expect(chips).toEqual(["Three's Company (1977)", '<img src=x onerror=alert(1)> (1971)']);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.locator('.gx-archive-series-attribution').textContent()).toContain('TVmaze');
    await page.getByRole('button', { name: "Three's Company (1977)" }).click();
    expect(await page.evaluate(() => (window as unknown as SeriesWindow).chosen)).toEqual([
      "Three's Company",
    ]);
    expect(await page.locator('.gx-archive-series').isHidden()).toBe(true);
    await page.close();
  });
  it('hides on failure and drops a stale slower lookup', async () => {
    const page = await fixture();
    await page.evaluate(() => (window as unknown as SeriesWindow).view.show('fail'));
    expect(await page.locator('.gx-archive-series').isHidden()).toBe(true);
    await page.evaluate(() => {
      const view = (window as unknown as SeriesWindow).view;
      void view.show('slow');
      view.clear();
    });
    await page.waitForTimeout(300);
    expect(await page.locator('.gx-archive-series-chip').count()).toBe(0);
    await page.close();
  });
});
describe('series identity reply validation', () => {
  it('admits display fields only and refuses unexpected or oversized replies', () => {
    expect(validateSeriesIdentity(identity).person?.shows).toHaveLength(1);
    for (const bad of [
      { ...identity, attribution: 'other' },
      { ...identity, shows: Array(6).fill(identity.shows[0]) },
      { ...identity, shows: [{ ...identity.shows[0], url: 'https://x' }] },
      { ...identity, shows: [{ name: 'Bad\nName' }] },
      { ...identity, shows: [{ name: 'A', premieredYear: 1800 }] },
      { ...identity, person: { name: 'P', shows: Array(13).fill({ name: 'A' }) } },
    ])
      expect(() => validateSeriesIdentity(bad)).toThrow();
  });
});
