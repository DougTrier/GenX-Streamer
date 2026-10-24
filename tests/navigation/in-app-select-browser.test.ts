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
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';

import { readStylesheet } from '../support/stylesheet';
let browser: Browser, bundle: string, styles: string, fullStyles: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/shell/in-app-select.ts', formats: ['iife'], name: 'Choices' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing entry');
  bundle = chunk.code;
  styles = await readStylesheet('src/ui/in-app-select.css');
  fullStyles = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(width = 640, height = 360): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<style>body{margin:8px;background:#10151d;color:white;font:16px sans-serif}button,input{box-sizing:border-box;background:#171e28;color:white;border:1px solid #8addf0;padding:8px}dialog{background:#10151d;color:white;width:90%;height:85%;box-sizing:border-box}label{display:block}</style><main id="root"><dialog id="dialog"><label>Source<select id="source" aria-label="Guide source"><option value="a">Alpha</option><optgroup label="Region"><option value="b">Beta</option><option value="disabled" disabled>Disabled</option></optgroup></select></label><select id="multi" multiple><option>Leave native</option></select></dialog></main>`,
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    (document.getElementById('dialog') as HTMLDialogElement).showModal();
    Reflect.set(window, 'changes', 0);
    document
      .getElementById('source')!
      .addEventListener('change', () =>
        Reflect.set(window, 'changes', Reflect.get(window, 'changes') + 1),
      );
    Reflect.set(
      window,
      'installed',
      Reflect.get(window, 'Choices').installInAppSelects(document.getElementById('root')),
    );
  });
  return page;
}
it('keeps exact values/change semantics, disabled groups and first Back without commit', async () => {
  const page = await fixture();
  try {
    expect(await page.locator('.in-app-select').count()).toBe(1);
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    await browserExpect(
      page.getByRole('option', { name: 'Region \u00b7 Disabled' }),
    ).toBeDisabled();
    await page.getByRole('option', { name: 'Region \u00b7 Beta' }).click();
    expect(await page.locator('#source').inputValue()).toBe('b');
    expect(await page.evaluate(() => Reflect.get(window, 'changes'))).toBe(1);
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    expect(
      await page.evaluate(() => {
        const event = new CustomEvent('native-back-requested', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    expect(await page.locator('.in-app-select-menu').count()).toBe(0);
    expect(await page.locator('#source').inputValue()).toBe('b');
    expect(await page.locator('#dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      true,
    );
    await page.keyboard.down('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'changes'))).toBe(1);
  } finally {
    await page.close();
  }
});
it('refreshes programmatic values and mutated options while removed owners never revive', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const s = document.getElementById('source') as HTMLSelectElement;
      s.value = 'b';
      Reflect.get(window, 'installed').refresh();
    });
    expect(
      await page.getByRole('button', { name: 'Guide source', exact: true }).textContent(),
    ).toBe('Beta');
    await page.evaluate(() => {
      const s = document.getElementById('source') as HTMLSelectElement;
      s.options[1]!.textContent = 'Changed';
    });
    await browserExpect(page.getByRole('button', { name: 'Guide source', exact: true })).toHaveText(
      'Changed',
    );
    await page.evaluate(() => {
      (document.getElementById('source') as HTMLSelectElement).disabled = true;
    });
    await browserExpect(
      page.getByRole('button', { name: 'Guide source', exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => {
      document.getElementById('source')!.remove();
    });
    await browserExpect(page.locator('.in-app-select')).toHaveCount(0);
    await page.evaluate(() => Reflect.get(window, 'installed').dispose());
    expect(
      await page
        .locator('#multi')
        .evaluate((node) => node.classList.contains('in-app-select-native')),
    ).toBe(false);
  } finally {
    await page.close();
  }
});
it('pages all 2,001 exact choices with no hidden truncation and searchable final value', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const s = document.getElementById('source') as HTMLSelectElement;
      s.replaceChildren(
        ...Array.from({ length: 2001 }, (_, i) => new Option('Channel ' + i, 'id-' + i)),
      );
    });
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    expect(await page.locator('.in-app-select-menu').getByRole('option').count()).toBe(50);
    await browserExpect(page.getByRole('status')).toHaveText('1\u201350 of 2001');
    await page.getByRole('button', { name: 'Next choices' }).click();
    await browserExpect(page.getByRole('status')).toHaveText('51\u2013100 of 2001');
    await page.getByRole('searchbox').fill('Channel 2000');
    expect(await page.locator('.in-app-select-menu').getByRole('option').count()).toBe(1);
    await page.getByRole('option', { name: 'Channel 2000' }).click();
    expect(await page.locator('#source').inputValue()).toBe('id-2000');
  } finally {
    await page.close();
  }
});
it('first dialog cancel closes only choices; background closes and disposal restores the real source', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'outerCancels', 0);
      document
        .getElementById('dialog')!
        .addEventListener('cancel', () =>
          Reflect.set(window, 'outerCancels', Reflect.get(window, 'outerCancels') + 1),
        );
    });
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    await page.evaluate(() =>
      document.getElementById('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(await page.locator('.in-app-select-menu').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'outerCancels'))).toBe(0);
    expect(await page.locator('#source').inputValue()).toBe('a');
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
    expect(await page.locator('.in-app-select-menu').count()).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'installed').dispose());
    await page.evaluate(() =>
      document.getElementById('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'outerCancels'))).toBe(1);
  } finally {
    await page.close();
  }
});
it('honors hidden state and disabled optgroups when the same owner is refreshed', async () => {
  const page = await fixture();
  try {
    await page.evaluate(
      () => ((document.querySelector('optgroup') as HTMLOptGroupElement).disabled = true),
    );
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    await browserExpect(page.getByRole('option', { name: 'Region \u00b7 Beta' })).toBeDisabled();
    await page.evaluate(
      () => ((document.getElementById('source') as HTMLSelectElement).hidden = true),
    );
    await browserExpect(page.locator('.in-app-select-menu')).toHaveCount(0);
    await browserExpect(
      page.getByRole('button', { name: 'Guide source', exact: true }),
    ).not.toBeVisible();
    await page.evaluate(
      () => ((document.getElementById('source') as HTMLSelectElement).hidden = false),
    );
    await browserExpect(
      page.getByRole('button', { name: 'Guide source', exact: true }),
    ).toBeVisible();
  } finally {
    await page.close();
  }
});
for (const size of [
  { width: 320, height: 640 },
  { width: 640, height: 360 },
])
  it(`fits dialog portal at 200% text ${size.width}x${size.height} and drains on resize/dispose`, async () => {
    const page = await fixture(size.width, size.height);
    try {
      await page.evaluate(() => {
        document.body.style.fontSize = '32px';
        (document.getElementById('source') as HTMLSelectElement).replaceChildren(
          ...Array.from({ length: 250 }, (_, i) => new Option('Country ' + i, 'country-' + i)),
        );
      });
      await page.getByRole('button', { name: 'Guide source', exact: true }).click();
      expect(
        await page.locator('.in-app-select-menu').evaluate((node) => {
          const r = node.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        }),
      ).toBe(true);
      for (const name of ['Close choices', 'Next choices', 'Previous choices']) {
        const control = page.getByRole('button', { name, exact: true });
        expect(
          await control.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= 44 &&
              node.scrollHeight <= node.clientHeight + 1 &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
      }
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      expect(await page.locator('.in-app-select-menu').count()).toBe(0);
      await page.getByRole('button', { name: 'Guide source', exact: true }).click();
      await page.evaluate(() => {
        Reflect.get(window, 'installed').dispose();
        Reflect.get(window, 'installed').dispose();
      });
      expect(await page.locator('.in-app-select,.in-app-select-menu').count()).toBe(0);
      expect(
        await page
          .locator('#source')
          .evaluate((node) => node.classList.contains('in-app-select-native')),
      ).toBe(false);
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      expect(await page.locator('.in-app-select-menu').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

for (const size of [
  { width: 960, height: 540, font: 16 },
  { width: 640, height: 360, font: 32 },
  { width: 320, height: 640, font: 32 },
])
  it(`all seven small choices are fully reachable with full app styles ${size.width}x${size.height}`, async () => {
    const page = await browser.newPage({ viewport: size });
    try {
      await page.setContent(
        `<main id="root"><dialog id="settings-dialog"><div class="dialog-head"><h2>Settings</h2><button aria-label="Close settings">Close</button></div><div class="dialog-body"><h3>Your sources</h3><label>Automatic updates<select id="cadence" aria-label="Automatic updates"><option value="off">Off</option><option value="hourly">Hourly</option><option value="every6hours">4 times daily</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="every2weeks">Every 2 weeks</option><option value="monthly">Monthly</option></select></label><p>Checks while the app is open.</p></div></dialog></main>`,
      );
      await page.addStyleTag({ content: fullStyles });
      await page.addStyleTag({
        content: `body{font-size:${size.font}px}button,input,select{font-size:inherit}`,
      });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        (document.querySelector('#settings-dialog') as HTMLDialogElement).showModal();
        Reflect.set(
          window,
          'installed',
          Reflect.get(window, 'Choices').installInAppSelects(document.querySelector('#root')),
        );
      });
      const trigger = page.getByRole('button', { name: 'Automatic updates', exact: true });
      if (size.width === 960)
        await trigger.evaluate((node) => {
          const label = node.closest('label')!;
          label.style.marginTop = `${252 - node.getBoundingClientRect().top}px`;
        });
      await trigger.click();
      await browserExpect(page.getByRole('option')).toHaveCount(7);
      await browserExpect(page.getByRole('searchbox')).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: 'Next choices' })).not.toBeVisible();
      const checkFocused = async (index: number) => {
        const option = page.locator(`[data-option-index="${index}"]`);
        await browserExpect(option).toBeFocused();
        expect(
          await option.evaluate((node) => {
            const r = node.getBoundingClientRect(),
              list = node.parentElement!.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= Math.max(0, list.top) &&
              r.bottom <= Math.min(innerHeight, list.bottom) + 0.5 &&
              node.scrollHeight <= node.clientHeight + 1 &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
      };
      for (let i = 0; i < 7; i++) {
        if (i) await page.keyboard.press('ArrowDown');
        await checkFocused(i);
      }
      for (let i = 5; i >= 0; i--) {
        await page.keyboard.press('ArrowUp');
        await checkFocused(i);
      }
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('native-back-requested', { cancelable: true })),
      );
      await browserExpect(trigger).toBeFocused();
      expect(await page.locator('#cadence').inputValue()).toBe('off');
      await trigger.press('Enter');
      await page.keyboard.press('End');
      await checkFocused(6);
      await page.keyboard.press('Enter');
      expect(await page.locator('#cadence').inputValue()).toBe('monthly');
      await page.evaluate(() => Reflect.get(window, 'installed').dispose());
      await browserExpect(page.locator('.in-app-select-menu')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

it('keeps search and all 250 country choices paged when a filter leaves only seven results', async () => {
  const page = await fixture(960, 540);
  try {
    await page.evaluate(() => {
      (document.querySelector('#source') as HTMLSelectElement).replaceChildren(
        ...Array.from(
          { length: 250 },
          (_, i) => new Option(i < 7 ? 'Match ' + i : 'Country ' + i, String(i)),
        ),
      );
    });
    await page.getByRole('button', { name: 'Guide source', exact: true }).click();
    await browserExpect(page.locator('.in-app-select-menu').getByRole('option')).toHaveCount(50);
    await page.getByRole('button', { name: 'Next choices' }).click();
    await browserExpect(page.getByRole('status')).toHaveText('51\u2013100 of 250');
    await page.getByRole('searchbox').fill('Match');
    await browserExpect(page.locator('.in-app-select-menu').getByRole('option')).toHaveCount(7);
    await browserExpect(page.getByRole('searchbox')).toBeVisible();
    await browserExpect(page.getByRole('status')).toHaveText('1\u20137 of 7');
    await page.getByRole('option', { name: 'Match 6', exact: true }).click();
    expect(await page.locator('#source').inputValue()).toBe('6');
  } finally {
    await page.close();
  }
});

it('disabling every small choice returns focus to the live trigger and Back closes without changing value', async () => {
  const page = await fixture();
  try {
    const trigger = page.getByRole('button', { name: 'Guide source', exact: true });
    await trigger.click();
    await page.evaluate(() => {
      for (const option of (document.querySelector('#source') as HTMLSelectElement).options)
        option.disabled = true;
    });
    await browserExpect(trigger).toBeFocused();
    await browserExpect(page.getByRole('searchbox')).not.toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('native-back-requested', { cancelable: true })),
    );
    await browserExpect(page.locator('.in-app-select-menu')).toHaveCount(0);
    expect(await page.locator('#source').inputValue()).toBe('a');
    expect(await page.evaluate(() => Reflect.get(window, 'changes'))).toBe(0);
  } finally {
    await page.close();
  }
});

for (const label of ['Country', 'Region country']) {
  it(`shows all 250 ${label} choices in one scrollable list and traps every boundary arrow until Back`, async () => {
    const page = await fixture(960, 540);
    try {
      await page.evaluate((name) => {
        const select = document.getElementById('source') as HTMLSelectElement;
        select.setAttribute('aria-label', name);
        select.replaceChildren(
          ...Array.from(
            { length: 250 },
            (_, index) => new Option('Country ' + index, 'code-' + index),
          ),
        );
        Reflect.get(window, 'installed').refresh();
      }, label);
      await page.getByRole('button', { name: label, exact: true }).click();
      await browserExpect(page.locator('.in-app-select-menu').getByRole('option')).toHaveCount(250);
      await browserExpect(page.getByRole('searchbox')).not.toBeVisible();
      await browserExpect(page.getByRole('button', { name: 'Next choices' })).not.toBeVisible();
      await page.keyboard.press('Home');
      for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowRight']) {
        await page.keyboard.press(key);
        await browserExpect(
          page.getByRole('option', { name: 'Country 0', exact: true }),
        ).toBeFocused();
      }
      await page.keyboard.press('End');
      const last = page.getByRole('option', { name: 'Country 249', exact: true });
      for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowRight']) {
        await page.keyboard.press(key);
        await browserExpect(last).toBeFocused();
      }
      expect(
        await last.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.height >= 44 &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        }),
      ).toBe(true);
      expect(await page.locator('#source').inputValue()).toBe('code-0');
      await page.keyboard.press('Escape');
      await browserExpect(page.locator('.in-app-select-menu')).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: label, exact: true })).toBeFocused();
      expect(await page.locator('#source').inputValue()).toBe('code-0');
    } finally {
      await page.close();
    }
  });
}
