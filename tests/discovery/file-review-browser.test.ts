import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/source-scan.ts', formats: ['iife'], name: 'ScanUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(page: Page, mode = 'normal', count = 2) {
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main id="mount"></main>' }),
  );
  await page.goto('http://localhost/file-review-fixture');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ mode, count }) => {
      const scope = window as unknown as {
        ScanUI: typeof import('../../src/ui/source-scan');
        owner: ReturnType<typeof import('../../src/ui/source-scan').mountSourceScan>;
        pending: Promise<void>;
        released: boolean;
        release(): void;
        revision: string;
        counters: {
          reads: number;
          network: number;
          commits: number;
          aborted: boolean;
          settled: boolean;
        };
        selection: unknown;
      };
      scope.revision = '0';
      scope.counters = { reads: 0, network: 0, commits: 0, aborted: false, settled: false };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      scope.release = release;
      const source = {
        id: 'file-source',
        name: 'fixture.m3u',
        location: 'fixture.m3u',
        kind: 'file' as const,
        allowHttp: true,
      };
      scope.owner = scope.ScanUI.mountSourceScan(document.querySelector('#mount')!, {
        capture: (definitions) => ({ revision: scope.revision, sources: definitions! }),
        revision: () => scope.revision,
        collect: async () => {
          scope.counters.network++;
          throw new Error('Unexpected collect');
        },
        probe: async () => {
          scope.counters.network++;
          throw new Error('Unexpected probe');
        },
        guides: async () => {
          scope.counters.network++;
          return [];
        },
        readFileSnapshot: async (file, captured, signal) => {
          scope.counters.reads++;
          signal.addEventListener(
            'abort',
            () => {
              scope.counters.aborted = true;
            },
            { once: true },
          );
          // A File read cannot be canceled: retain its actual settlement on cancellation.
          if (mode === 'held') await held;
          await file.text();
          signal.throwIfAborted();
          return {
            channels: Array.from({ length: count }, (_, index) => ({
              sourceId: captured.id,
              providerId: String(index),
              name: `Channel ${index}`,
              category: 'Fixture',
              urls: [`https://media.invalid/${index}`],
            })),
            warnings: [],
          };
        },
        commit: async (selection) => {
          scope.counters.commits++;
          scope.selection = structuredClone(selection);
          scope.revision = '1';
          return { committed: true, revision: '1' };
        },
      });
      const file = new File(['#EXTM3U'], 'fixture.m3u');
      if (mode === 'oversized')
        Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 + 1 });
      scope.pending = scope.owner.reviewFile(source, file).then(() => {
        scope.counters.settled = true;
      });
    },
    { mode, count },
  );
}

it('reviews every local candidate without network or publication, then Save stages exact source identity', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page);
    const review = page.getByRole('dialog', { name: 'Review source scan' });
    await expect
      .poll(() => review.getByRole('status').textContent())
      .toContain('2 channels ready for review');
    expect(await review.locator('li label').allTextContents()).toEqual([
      'Channel 0 · Fixture · fixture.m3u · Not checked',
      'Channel 1 · Fixture · fixture.m3u · Not checked',
    ]);
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ reads: 1, network: 0, commits: 0 });
    expect(await review.locator('img').count()).toBe(0);
    await review.getByRole('button', { name: 'Save selected channels', exact: true }).click();
    await expect
      .poll(() => review.getByRole('status').textContent())
      .toBe('Selected channels saved.');
    expect(
      await page.evaluate(() => (window as unknown as { selection: unknown }).selection),
    ).toMatchObject({
      sessionRevision: '0',
      sources: [
        {
          sourceId: 'file-source',
          candidates: [
            { sourceId: 'file-source', providerId: '0' },
            { sourceId: 'file-source', providerId: '1' },
          ],
        },
      ],
    });
  } finally {
    await page.close();
  }
});

it('Cancel joins a held file read and cannot admit late review or Save', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, 'held');
    await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ aborted: true, settled: false, commits: 0 });
    await page.evaluate(() => (window as unknown as { release(): void }).release());
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('File review canceled');
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Save selected channels', exact: true }).isVisible(),
      )
      .toBe(false);
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ settled: true, network: 0, commits: 0 });
  } finally {
    await page.close();
  }
});

it.each(['suspend', 'dispose'] as const)(
  '%s retains the actual deferred read until settlement',
  async (operation) => {
    const page = await browser.newPage();
    try {
      await fixture(page, 'held');
      await page.evaluate((operation) => {
        const scope = window as unknown as {
          owner: ReturnType<typeof import('../../src/ui/source-scan').mountSourceScan>;
          cleanupSettled: boolean;
          cleanup: Promise<void>;
        };
        scope.cleanupSettled = false;
        scope.cleanup = scope.owner[operation]().then(() => {
          scope.cleanupSettled = true;
        });
      }, operation);
      expect(
        await page.evaluate(
          () => (window as unknown as { cleanupSettled: boolean }).cleanupSettled,
        ),
      ).toBe(false);
      await page.evaluate(() => (window as unknown as { release(): void }).release());
      await page.evaluate(() => (window as unknown as { cleanup: Promise<void> }).cleanup);
      expect(
        await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
      ).toMatchObject({ aborted: true, settled: true, commits: 0, network: 0 });
    } finally {
      await page.close();
    }
  },
);

it('catalog changes during reading reject review instead of capturing a later revision', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, 'held');
    await page.evaluate(() => {
      const scope = window as unknown as { revision: string; release(): void };
      scope.revision = 'changed';
      scope.release();
    });
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('Saved channels changed');
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ commits: 0, network: 0 });
  } finally {
    await page.close();
  }
});

it('Save rejects a completed file review after an unrelated catalog change', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page);
    await page.evaluate(() => (window as unknown as { pending: Promise<void> }).pending);
    await page.evaluate(() => {
      (window as unknown as { revision: string }).revision = 'changed';
    });
    await page.getByRole('button', { name: 'Save selected channels', exact: true }).click();
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('Selection was not saved');
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ commits: 0, network: 0 });
  } finally {
    await page.close();
  }
});

it('oversized files refuse reading and oversized parsed catalogs refuse publication without truncating', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, 'oversized');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('20 MiB');
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ reads: 0, commits: 0 });
    await page.evaluate(() =>
      (
        window as unknown as {
          owner: ReturnType<typeof import('../../src/ui/source-scan').mountSourceScan>;
        }
      ).owner.dispose(),
    );
    await fixture(page, 'normal', 100001);
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('100,000');
    expect(
      await page.evaluate(() => (window as unknown as { counters: unknown }).counters),
    ).toMatchObject({ commits: 0, network: 0 });
  } finally {
    await page.close();
  }
});

it('large valid file review retains all candidates while rendering only one bounded page', async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, 'normal', 1001);
    await expect
      .poll(() => page.getByRole('status').textContent())
      .toContain('1001 channels ready for review');
    expect(await page.locator('li label').count()).toBe(50);
    await page.getByRole('button', { name: 'Next results', exact: true }).click();
    expect(await page.locator('li label').first().textContent()).toContain('Channel 50');
  } finally {
    await page.close();
  }
});
