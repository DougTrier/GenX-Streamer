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
 * Guide screen in a real browser: Map guide, normal timeline, program
 * search and discovery.
 */
import { expect, it } from 'vitest';
import { useGuideUiBrowser, fixture, dispose, open } from './guide-ui-browser.fixture';

useGuideUiBrowser();

it('opens contextual Map guide without advanced setup and saves only after explicit confirmation', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.getByRole('heading', { name: 'Map guide for FOX Chicago' }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').mapping.length)).toBe(0);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').mapping.length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    expect(await page.locator('.guide-mapping-panel').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
it('normal timeline keeps discovery simple and joins its work when closed', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'missing'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-note')?.textContent === 'Guide not linked',
    );
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    const queries = await page.evaluate(() => Reflect.get(window, 'calls').queries.length);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(queries);
  } finally {
    await dispose(page);
  }
});
it('normal timeline preserves program search and Back returns from details before closing', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => document.querySelectorAll('.gx-timeline-cell').length > 0);
    await page.locator('.gx-timeline-cell').first().click();
    if (await page.getByRole('button', { name: 'Chicago Bears', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Chicago Bears', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gx-timeline-details strong'));
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('dialog').isVisible()).toBe(true);
    expect(await page.locator('.gx-timeline-details').isVisible()).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    await open(page, 'Chicago Bears');
    expect(await page.locator('.gx-timeline').isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: /Chicago Bears/ }).count()).toBeGreaterThan(0);
  } finally {
    await dispose(page);
  }
});
it('program search preserves provider categories through the native page conversion', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const originalQuery = host.query;
      host.query = async (...args: unknown[]) => {
        const response = await originalQuery(...args);
        return {
          ...response,
          programs: response.programs.slice(0, 1).map((program: Record<string, unknown>) => ({
            ...program,
            title: 'Silent film',
            description: null,
            categories: [{ text: 'Drama', language: 'en' }],
          })),
        };
      };
    });
    await open(page, 'Drama');
    expect(await page.getByRole('button', { name: /Silent film/ }).count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});
it('normal empty Guide offers actual discovery without technical controls or automatic remote work', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'missing'));
    await open(page);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.getByLabel('Mapping guide source').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    expect(
      await page.getByRole('option', { name: 'Program guide setup', exact: true }).isVisible(),
    ).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'discoveryCalls') === 1);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Go back to Guide', exact: true }).isVisible(),
    ).toBe(true);
    await page.getByRole('button', { name: 'Go back to Guide', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Guide view', exact: true }).isVisible()).toBe(
      true,
    );
  } finally {
    await dispose(page);
  }
});
it('normal Find obtains exact-match listings through one automatic callback without technical steps', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'buildCalls', 0);
      Reflect.get(window, 'host').buildForChannels = async () => {
        Reflect.set(window, 'buildCalls', Reflect.get(window, 'buildCalls') + 1);
        return { connected: 2, unmatched: 1, checked: 1, failed: 0, skipped: 0 };
      };
    });
    await open(page);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'buildCalls') === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
  } finally {
    await dispose(page);
  }
});
it('post-Scan automatic build stays in the existing operation owner and disposal joins its real settlement', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').buildForChannels = (signal: AbortSignal) =>
        new Promise((resolve) => {
          Reflect.set(window, 'buildSignal', signal);
          Reflect.set(window, 'finishBuild', () =>
            resolve({ connected: 0, unmatched: 1, checked: 1, failed: 0, skipped: 1 }),
          );
        });
      Reflect.set(window, 'buildWork', Reflect.get(window, 'guide').buildForChannels());
    });
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
    await page.evaluate(() => {
      Reflect.set(window, 'disposedBuild', false);
      Reflect.set(
        window,
        'disposeWork',
        Reflect.get(window, 'guide')
          .dispose()
          .then(() => Reflect.set(window, 'disposedBuild', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'buildSignal').aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'disposedBuild'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'finishBuild')());
    await page.evaluate(() => Reflect.get(window, 'disposeWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'disposedBuild'))).toBe(true);
  } finally {
    await dispose(page);
  }
});
it('normal discovered guide requires deliberate selection and reviewed Save, while Settings Advanced retains editing', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Regional schedule',
            limitations:
              'Regional channel identifiers need review; exact sports coverage is unconfirmed.',
            location: 'https://fixture.invalid/guide',
            playlistNames: ['My channels'],
            allowHttp: false,
            requiresHttpPermission: false,
          },
        ],
        outcomes: [],
      });
    });
    await open(page);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Regional channel identifiers need review'),
    );
    await page
      .getByRole('button', { name: 'Regional schedule \u00b7 My channels', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>('[aria-label="Save reviewed schedule"]')
          ?.disabled && document.body.textContent?.includes('guide channels'),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits.length)).toBe(0);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').commits.length === 1);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page
      .locator('.guide-manual-source')
      .evaluate((node) => ((node as HTMLDetailsElement).open = true));
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Go back to Guide', exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
