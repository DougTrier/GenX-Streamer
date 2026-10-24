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

import { beforeAll, afterAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from '@playwright/test';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/remote-navigation.ts', formats: ['iife'], name: 'RemoteUI' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
it('remote OK selects HTTP and a source once per press without submitting the form', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<dialog><form><label>HTTP<input id="http" type="checkbox"></label><label>Source one<input id="one" type="radio" name="source"></label><label>Source two<input id="two" type="radio" name="source"></label><button id="submit">Scan</button></form></dialog>',
    );
    await page.addStyleTag({ content: 'label { display:block; margin:12px 0; }' });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({
      content: `window.changes=0;window.submits=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submits++});document.querySelector('dialog').showModal();document.querySelector('#http').addEventListener('change',()=>window.changes++);window.dispose=RemoteUI.installRemoteNavigation({editMode:RemoteUI.createRemoteEditMode()});`,
    });
    await expect
      .poll(() => page.locator('#http').evaluate((el) => el === document.activeElement))
      .toBe(true);
    await page.keyboard.down('Enter');
    expect(await page.locator('#http').isChecked()).toBe(true);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'changes'))).toBe(1);
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => page.locator('#one').evaluate((el) => el === document.activeElement))
      .toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.locator('#one').isChecked()).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('#two').isChecked()).toBe(true);
    expect(await page.locator('#one').isChecked()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'submits'))).toBe(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'submits'))).toBe(1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'dispose')?.());
    await page.close();
  }
});
it('OK cannot activate a background checkbox outside the current modal', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<input id="outside" type="checkbox"><dialog><button>Close</button></dialog>',
    );
    await page.addStyleTag({ content: 'label { display:block; margin:12px 0; }' });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({
      content: `document.querySelector('#outside').focus();document.querySelector('dialog').show();window.dispose=RemoteUI.installRemoteNavigation();`,
    });
    await page.keyboard.press('Enter');
    expect(await page.locator('#outside').isChecked()).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'dispose')?.());
    await page.close();
  }
});

it('DPAD protects text before focus, OK restores editing and Back returns to navigation', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button id="start">Start</button><input id="text" inputmode="url"><button id="next">Next</button>',
    );
    await page.addStyleTag({
      content: 'body {display:flex;gap:20px} input,button {width:120px;height:44px}',
    });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({
      content: `window.mode=RemoteUI.createRemoteEditMode();window.dispose=RemoteUI.installRemoteNavigation({editMode:window.mode});window.focusEntries=[];document.querySelector('#text').addEventListener('focus',e=>{window.focusEntries.push(e.target.readOnly);window.arrival={readonly:e.target.readOnly,inputmode:e.target.getAttribute('inputmode')};});document.querySelector('#start').focus();`,
    });
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => Reflect.get(window, 'arrival'))).toEqual({
      readonly: true,
      inputmode: 'none',
    });
    await page.evaluate(() =>
      Reflect.get(window, 'mode').navigate(document.querySelector('#text')),
    );
    await page.keyboard.press('Enter');
    expect(await page.locator('#text').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#text').getAttribute('inputmode')).toBe('url');
    expect(await page.evaluate(() => Reflect.get(window, 'focusEntries'))).toEqual([true, false]);
    await page.keyboard.type('https');
    expect(await page.locator('#text').inputValue()).toContain('https');
    await page.keyboard.press('Escape');
    expect(await page.locator('#text').getAttribute('readonly')).toBe('');
    expect(await page.locator('#text').getAttribute('inputmode')).toBe('none');
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('#next').evaluate((e) => e === document.activeElement)).toBe(true);
    expect(await page.locator('#text').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#text').getAttribute('inputmode')).toBe('url');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'dispose')?.());
    await page.close();
  }
});
it('pointer, Tab, external focus and disposal restore exact attributes without granting readonly editing', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button id="start">Start</button><input id="text"><input id="locked" readonly="readonly" inputmode="numeric"><textarea id="multi" inputmode="text"></textarea><select id="choice"><option>One</option><option>Two</option></select>',
    );
    await page.addStyleTag({
      content:
        'body {display:flex;gap:12px} input,button,textarea,select {width:100px;height:44px}',
    });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({
      content: `window.mode=RemoteUI.createRemoteEditMode();window.dispose=RemoteUI.installRemoteNavigation({editMode:window.mode});document.querySelector('#start').focus();`,
    });
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('#text').getAttribute('inputmode')).toBe('none');
    await page.locator('#text').click();
    expect(await page.locator('#text').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#text').getAttribute('inputmode')).toBeNull();
    await page.evaluate(() =>
      Reflect.get(window, 'mode').navigate(document.querySelector('#text')),
    );
    await page.keyboard.press('Tab');
    expect(await page.locator('#text').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#text').getAttribute('inputmode')).toBeNull();
    await page.evaluate(() => {
      const mode = Reflect.get(window, 'mode');
      mode.navigate(document.querySelector('#locked'));
      mode.begin(document.querySelector('#locked'));
    });
    expect(await page.locator('#locked').getAttribute('readonly')).toBe('readonly');
    expect(await page.locator('#locked').getAttribute('inputmode')).toBe('numeric');
    await page.evaluate(() => {
      const mode = Reflect.get(window, 'mode');
      const field = document.querySelector<HTMLTextAreaElement>('#multi');
      if (!field) throw new Error('Missing textarea');
      mode.navigate(field);
      field.focus();
      mode.begin(field);
    });
    await page.keyboard.type('line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    expect(await page.locator('#multi').inputValue()).toBe('line\ntwo');
    await page.evaluate(() => {
      const mode = Reflect.get(window, 'mode');
      const choice = document.querySelector<HTMLSelectElement>('#choice');
      if (!choice) throw new Error('Missing select');
      mode.navigate(choice);
      choice.focus();
    });
    expect(await page.locator('#choice').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#choice').getAttribute('inputmode')).toBeNull();
    await page.evaluate(() => {
      const mode = Reflect.get(window, 'mode');
      const field = document.querySelector<HTMLInputElement>('#text');
      if (!field) throw new Error('Missing input');
      mode.navigate(field);
      field.focus();
      document.querySelector<HTMLButtonElement>('#start')?.focus();
    });
    expect(await page.locator('#text').getAttribute('readonly')).toBeNull();
    expect(await page.locator('#text').getAttribute('inputmode')).toBeNull();
    await page.evaluate(() => {
      Reflect.get(window, 'mode').navigate(document.querySelector('#locked'));
      Reflect.get(window, 'dispose')();
    });
    expect(await page.locator('#locked').getAttribute('readonly')).toBe('readonly');
    expect(await page.locator('#locked').getAttribute('inputmode')).toBe('numeric');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'dispose')?.());
    await page.close();
  }
});
