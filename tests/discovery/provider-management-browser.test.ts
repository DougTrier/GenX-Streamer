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

import { afterAll, beforeAll, it } from 'vitest';
import { build } from 'vite';
import { chromium, expect, type Browser } from '@playwright/test';
let browser: Browser;
let code: string;
beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'src/ui/provider-management.ts', name: 'Providers', formats: ['iife'] },
    },
  });
  const result = Array.isArray(built) ? built[0] : built;
  if (!('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
  code = chunk.code;
  browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture() {
  const page = await browser.newPage();
  await page.setContent('<div id="host"></div>');
  await page.addScriptTag({ content: code });
  await page.addScriptTag({
    content: `
    window.registry={schemaVersion:1,reviewedChannelProviders:[{id:'a',name:'<unsafe>',location:'https://a.example/list',provenance:'https://a.example/'},{id:'b',name:'Second',location:'https://b.example/list',provenance:'https://b.example/'}],reviewedGuideProviders:[{id:'a',name:'Guide',location:'https://guide.example/xml',provenance:'https://guide.example/',limitations:'Coverage unknown'}]};
    window.savedChannels=['untouched'];window.calls=[];window.mode='success';
    window.ui=Providers.mountProviderManagement(document.getElementById('host'),{read:()=>window.registry,remove:async(kind,id,signal)=>{window.calls.push([kind,id]);window.signal=signal;if(window.mode==='held')await new Promise(resolve=>window.release=resolve);if(window.mode==='failure')throw new Error('secret URL payload');if(signal.aborted)return false;const key=kind==='channel'?'reviewedChannelProviders':'reviewedGuideProviders';window.registry[key]=window.registry[key].filter(item=>item.id!==id);return true;}});
  `,
  });
  return page;
}
it('removes each exact provider kind, keeps saved channels and explicit empty configuration', async () => {
  const page = await fixture();
  try {
    expect(await page.locator('unsafe').count()).toBe(0);
    await page
      .getByRole('button', { name: 'Remove channel provider <unsafe>', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Remove channel provider <unsafe>', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Remove guide provider Guide', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Remove channel provider Second', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Channel providers', exact: true })).toContainText(
      'No discovery providers configured.',
    );
    await page.getByRole('button', { name: 'Remove guide provider Guide', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Provider removed.');
    expect(
      await page.evaluate(() => ({
        calls: Reflect.get(window, 'calls'),
        saved: Reflect.get(window, 'savedChannels'),
        registry: Reflect.get(window, 'registry'),
      })),
    ).toMatchObject({
      calls: [
        ['channel', 'a'],
        ['channel', 'b'],
        ['guide', 'a'],
      ],
      saved: ['untouched'],
      registry: { reviewedChannelProviders: [], reviewedGuideProviders: [] },
    });
    await page.evaluate(() => Reflect.get(window, 'ui').update());
    expect(await page.getByRole('button').count()).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'ui').dispose());
    await page.close();
  }
});
it('waits for durable confirmation, handles failure without removing or exposing raw errors', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'held'));
    const remove = page.getByRole('button', {
      name: 'Remove channel provider Second',
      exact: true,
    });
    const box = await remove.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await remove.click();
    await expect(remove).toBeDisabled();
    expect(
      await page.evaluate(() => Reflect.get(window, 'registry').reviewedChannelProviders.length),
    ).toBe(2);
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'failure');
      Reflect.get(window, 'release')();
    });
    await expect(page.getByRole('status')).toHaveText('Provider could not be removed. Try again.');
    await expect(remove).toBeEnabled();
    expect(await page.locator('body').innerText()).not.toContain('secret URL payload');
    await page.evaluate(() => Reflect.set(window, 'mode', 'success'));
    await remove.click();
    await expect(remove).toHaveCount(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'ui').dispose());
    await page.close();
  }
});
it('dispose aborts and joins a noncooperative admitted save without late UI or second admission', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'held'));
    await page.getByRole('button', { name: 'Remove channel provider Second', exact: true }).click();
    await page.evaluate(() => {
      window.setTimeout(() => {}, 0);
      Reflect.set(window, 'done', false);
      void Reflect.get(window, 'ui')
        .dispose()
        .then(() => Reflect.set(window, 'done', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'signal').aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'done'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').length)).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await expect(page.locator('#host')).toBeEmpty();
    expect(await page.evaluate(() => Reflect.get(window, 'done'))).toBe(true);
    expect(
      await page.evaluate(() => Reflect.get(window, 'registry').reviewedChannelProviders.length),
    ).toBe(2);
  } finally {
    await page.close();
  }
});
