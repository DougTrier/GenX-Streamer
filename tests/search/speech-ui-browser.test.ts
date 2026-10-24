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

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
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
      lib: { entry: 'src/ui/speech-search.ts', formats: ['iife'], name: 'SpeechUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing speech bundle');
  const chunk = result.output.find((value) => value.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing speech chunk');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<input id="search" value="typed" maxlength="256"><div id="voice"></div>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({
    content: `
 window.calls={start:0,cancel:0,end:0,dispose:0,input:0,enter:0};window.notices=[];window.mode='local';window.capBlocked=false;window.instant=1000;
 const input=document.getElementById('search');input.addEventListener('input',()=>calls.input++);input.addEventListener('keydown',event=>{if(event.key==='Enter')calls.enter++});
 const recognizer={capability:async()=>{if(window.capBlocked)await new Promise(resolve=>window.resolveCap=resolve);return {available:mode!=='unsupported',mode:mode==='cloud'?'cloud':'on-device',languages:[]}},
 recognize:async options=>{calls.start++;window.options=options;return await new Promise(resolve=>window.finishResult=resolve)},
    finish:async()=>{calls.end++},cancel:async()=>{calls.cancel++;if(window.refuseCancel)throw new Error('unconfirmed')},dispose:async()=>{calls.dispose++}};
 window.component=SpeechUI.mountSpeechSearch(document.getElementById('voice'),input,{recognizer,notice:value=>notices.push(value),cloudConsent:()=>window.persistConsent===true,saveCloudConsent:async(accepted,signal)=>{window.consentSaves=(window.consentSaves||0)+1;if(window.saveConsentBlocked)await new Promise(resolve=>window.finishConsentSave=resolve);if(window.saveConsentFails)throw new Error('storage');window.persistConsent=accepted;},language:()=> 'en-US',now:()=>instant,timer:{set:callback=>{window.expire=callback;return 1},clear:()=>{}}});
 window.final=text=>window.finishResult({status:'final',transcript:text});
 `,
  });
  return page;
}
async function begin(page: Page) {
  await page.getByRole('button', { name: 'Voice search', exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { calls: { start: number } }).calls.start === 1,
  );
}
async function run(page: Page, code: string) {
  await page.evaluate((value) => {
    (0, eval)(value);
  }, code);
}
it('retarget joins recognition and cancellation, serializes moves and fences obsolete words', async () => {
  const page = await fixture();
  try {
    await run(
      page,
      `document.body.insertAdjacentHTML('beforeend','<input id="next"><div id="slot"></div><input id="last"><div id="last-slot"></div>');
       window.originalButton=document.querySelector('#voice button');
       window.cancelGate=new Promise(resolve=>window.releaseCancel=resolve);
       recognizer.cancel=async()=>{calls.cancel++;await cancelGate};
       window.finalEvents=0;document.addEventListener('speech-search-final',event=>{finalEvents++;window.finalTarget=event.target.id;window.finalHasPayload='detail' in event});`,
    );
    await begin(page);
    await run(
      page,
      `window.moved=false;window.moveWork=component.retarget(document.querySelector('#slot'),document.querySelector('#next'));
       window.lastWork=component.retarget(document.querySelector('#last-slot'),document.querySelector('#last')).then(()=>window.moved=true);`,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'options').signal.aborted)).toBe(true);
    expect(await page.locator('#voice button').count()).toBe(1);
    expect(await page.locator('#last-slot button').count()).toBe(0);
    await run(page, "final('obsolete');");
    expect(await page.evaluate(() => Reflect.get(window, 'moved'))).toBe(false);
    await run(page, 'releaseCancel()');
    await page.evaluate(() => Reflect.get(window, 'lastWork'));
    expect(await page.locator('#search').inputValue()).toBe('typed');
    expect(await page.locator('#next').inputValue()).toBe('');
    expect(await page.evaluate(() => Reflect.get(window, 'finalEvents'))).toBe(0);
    expect(
      await page.evaluate(
        () => document.querySelector('#last-slot button') === Reflect.get(window, 'originalButton'),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').start === 2);
    await page.locator('#search').fill('old target typing');
    expect(await page.evaluate(() => Reflect.get(window, 'options').signal.aborted)).toBe(false);
    await run(page, "final('Chicago Bears')");
    await expect.poll(() => page.locator('#last').inputValue()).toBe('Chicago Bears');
    expect(
      await page.evaluate(() => ({
        count: Reflect.get(window, 'finalEvents'),
        target: Reflect.get(window, 'finalTarget'),
        payload: Reflect.get(window, 'finalHasPayload'),
      })),
    ).toEqual({ count: 1, target: 'last', payload: false });
    expect(await page.evaluate(() => Reflect.get(window, 'calls').enter)).toBe(0);
  } finally {
    await run(page, "window.releaseCancel?.();window.finishResult?.({status:'canceled'})");
    await page.evaluate(() => Reflect.get(window, 'component').dispose());
    await page.close();
  }
});

it('failed cancellation retains the old target and successful retry releases that same owner', async () => {
  const page = await fixture();
  try {
    await run(
      page,
      `document.body.insertAdjacentHTML('beforeend','<input id="next"><div id="slot"></div>');window.refuseCancel=true;`,
    );
    await begin(page);
    await run(
      page,
      `window.moveFailed=false;window.moveWork=component.retarget(document.querySelector('#slot'),document.querySelector('#next')).catch(()=>window.moveFailed=true);`,
    );
    await run(page, "final('late')");
    await page.evaluate(() => Reflect.get(window, 'moveWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'moveFailed'))).toBe(true);
    expect(await page.locator('#voice button').count()).toBe(1);
    expect(await page.locator('#slot button').count()).toBe(0);
    expect(await page.locator('#search').inputValue()).toBe('typed');
    await run(page, 'window.refuseCancel=false');
    await page.evaluate(() =>
      Reflect.get(window, 'component').retarget(
        document.querySelector('#slot'),
        document.querySelector('#next'),
      ),
    );
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').start === 2);
    await page.locator('#next').fill('new typed');
    expect(await page.evaluate(() => Reflect.get(window, 'options').signal.aborted)).toBe(true);
    await run(page, "final('obsolete retry')");
    await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
    expect(await page.locator('#next').inputValue()).toBe('new typed');
  } finally {
    await run(page, "window.refuseCancel=false;window.finishResult?.({status:'canceled'})");
    await page.evaluate(() => Reflect.get(window, 'component').dispose());
    await page.close();
  }
});

it('dispose joins queued retargets without moving or admitting another capture', async () => {
  const page = await fixture();
  try {
    await run(
      page,
      `document.body.insertAdjacentHTML('beforeend','<input id="next"><div id="slot"></div>');window.capBlocked=true;`,
    );
    await page.getByRole('button').click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'resolveCap') === 'function');
    await run(
      page,
      `window.moveFailed=false;window.moveWork=component.retarget(document.querySelector('#slot'),document.querySelector('#next')).catch(()=>window.moveFailed=true);
       window.disposedDone=false;window.disposeWork=component.dispose().then(()=>window.disposedDone=true);`,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(false);
    await run(page, 'resolveCap()');
    await page.evaluate(() => Reflect.get(window, 'disposeWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'moveFailed'))).toBe(true);
    expect(await page.locator('button').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toMatchObject({
      start: 0,
      dispose: 1,
    });
    await page.evaluate(() => Reflect.get(window, 'component').dispose());
    expect(await page.evaluate(() => Reflect.get(window, 'calls').dispose)).toBe(1);
  } finally {
    await run(page, 'window.resolveCap?.()');
    await page.evaluate(() => Reflect.get(window, 'component').dispose());
    await page.close();
  }
});
it('persisted device consent skips the popup while microphone permission remains provider-owned', async () => {
  const page = await fixture();
  try {
    await run(page, "window.mode='cloud';window.persistConsent=true");
    await begin(page);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'options').allowCloud)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'consentSaves') ?? 0)).toBe(0);
    await run(page, "final('FOX')");
    await expect.poll(() => page.locator('#search').inputValue()).toBe('FOX');
  } finally {
    await run(page, 'window.component.dispose()');
    await page.close();
  }
});
it('save refusal prevents recording and permits a deliberate retry after a confirmed save', async () => {
  const page = await fixture();
  try {
    await run(page, "window.mode='cloud';window.saveConsentFails=true");
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    await page.getByRole('button', { name: 'Use speech service', exact: true }).click();
    await page.waitForFunction(() =>
      Reflect.get(window, 'notices').some((value: string) =>
        value.includes('consent could not be saved'),
      ),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
    await run(page, 'window.saveConsentFails=false');
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    await page.getByRole('button', { name: 'Use speech service', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').start === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'persistConsent'))).toBe(true);
    await run(page, "final('FOX')");
  } finally {
    await run(page, 'window.component.dispose()');
    await page.close();
  }
});
it('revocation fences pending acceptance/save and cannot restart a late capture', async () => {
  const page = await fixture();
  try {
    await run(page, "window.mode='cloud';window.saveConsentBlocked=true");
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    await page.getByRole('button', { name: 'Use speech service', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'consentSaves') === 1);
    await run(
      page,
      'window.revoked=false;window.revokeWork=window.component.revokeConsent().then(()=>window.revoked=true)',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'revoked'))).toBe(false);
    await run(page, 'window.finishConsentSave()');
    await page.evaluate(() => Reflect.get(window, 'revokeWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    expect(await page.getByRole('dialog', { name: 'Use TV speech service' }).isVisible()).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    await run(page, 'window.component.dispose()');
    await page.close();
  }
});
it('revoking an accepted active capture joins it, discards late words and requires consent again', async () => {
  const page = await fixture();
  try {
    await run(page, "window.mode='cloud';window.persistConsent=true");
    await begin(page);
    await run(
      page,
      'window.persistConsent=false;window.revokeDone=false;window.revokeWork=window.component.revokeConsent().then(()=>window.revokeDone=true)',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'options').signal.aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'revokeDone'))).toBe(false);
    await run(page, "final('Late private words')");
    await page.evaluate(() => Reflect.get(window, 'revokeWork'));
    expect(await page.locator('#search').inputValue()).toBe('typed');
    await page.getByRole('button', { name: 'Voice search', exact: true }).click();
    expect(await page.getByRole('dialog', { name: 'Use TV speech service' }).isVisible()).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'component').dispose());
    await page.close();
  }
});
describe('one-shot voice input in Chromium with injected provider', () => {
  it('has no startup capture; final text uses editable input only and focuses it', async () => {
    const page = await fixture();
    try {
      expect(
        await page.evaluate(() => (window as unknown as { calls: { start: number } }).calls.start),
      ).toBe(0);
      await begin(page);
      await run(page, "final('Chicago Bears')");
      await expect.poll(() => page.locator('#search').inputValue()).toBe('Chicago Bears');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { input: number; enter: number } }).calls,
        ),
      ).toMatchObject({ input: 1, enter: 0 });
      await page.locator('#search').fill('Chicago Bears tomorrow');
      expect(await page.locator('#search').inputValue()).toContain('tomorrow');
    } finally {
      await page.close();
    }
  });
  it.each(['unsupported'])('keeps typed fallback for %s without capture', async (mode) => {
    const page = await fixture();
    try {
      await run(page, `window.mode='${mode}'`);
      await page.getByRole('button').click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { notices: string[] }).notices.length),
        )
        .toBe(1);
      expect(
        await page.evaluate(() => (window as unknown as { calls: { start: number } }).calls.start),
      ).toBe(0);
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('cloud service waits for deliberate consent without a capture deadline; Cancel never starts permission or speech', async () => {
    const page = await fixture();
    try {
      await run(page, "window.mode='cloud'");
      await page.getByRole('button', { name: 'Voice search', exact: true }).click();
      await page.getByRole('dialog', { name: 'Use TV speech service' }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
      expect(await page.evaluate(() => typeof Reflect.get(window, 'expire'))).toBe('undefined');
      await run(page, 'window.instant=90000');
      expect(await page.getByRole('dialog').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('accepted cloud consent starts a fresh15s attempt, final text remains editable and consent is saved on this device', async () => {
    const page = await fixture();
    try {
      await run(page, "window.mode='cloud'");
      await page.getByRole('button', { name: 'Voice search', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await run(page, 'window.instant=90000');
      await page.getByRole('button', { name: 'Use speech service', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(1);
      expect(
        await page.evaluate(() => ({
          allowCloud: Reflect.get(window, 'options').allowCloud,
          deadlineMs: Reflect.get(window, 'options').deadlineMs,
        })),
      ).toEqual({ allowCloud: true, deadlineMs: 105000 });
      await run(page, "final('Bears tomorrow')");
      await expect.poll(() => page.locator('#search').inputValue()).toBe('Bears tomorrow');
      await page.getByRole('button', { name: 'Voice search', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(2);
      expect(await page.getByRole('dialog').count()).toBe(0);
      await run(page, "final('Fox')");
    } finally {
      await page.close();
    }
  });
  it.each(['typed', 'pagehide', 'dispose'])(
    'pending consent is owned and cannot revive after %s',
    async (action) => {
      const page = await fixture();
      try {
        await run(page, "window.mode='cloud'");
        await page.getByRole('button', { name: 'Voice search', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await run(page, "window.lateConsent=document.querySelector('dialog button')");
        if (action === 'typed')
          await run(
            page,
            "document.querySelector('#search').value='new typed';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))",
          );
        else if (action === 'pagehide')
          await run(page, "window.dispatchEvent(new Event('pagehide'))");
        else
          await page.evaluate(async () => {
            await Reflect.get(window, 'component').dispose();
          });
        await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
        await run(page, 'lateConsent.click()');
        expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
  it('late capabilities after cloud acceptance cannot start a disposed owner', async () => {
    const page = await fixture();
    try {
      await run(page, "window.mode='cloud'");
      await page.getByRole('button', { name: 'Voice search', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await run(page, 'window.capBlocked=true');
      await page.getByRole('button', { name: 'Use speech service', exact: true }).click();
      await page.waitForFunction(() => typeof Reflect.get(window, 'resolveCap') === 'function');
      await run(
        page,
        'window.disposedDone=false;component.dispose().then(()=>window.disposedDone=true)',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(false);
      await run(page, 'resolveCap()');
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'disposedDone'))).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').start)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('second click ends once; repeated clicks cannot start another owner', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await page.getByRole('button', { name: 'Stop voice input' }).click();
      await run(
        page,
        "document.querySelector('button').click();document.querySelector('button').click()",
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { end: number; start: number } }).calls,
        ),
      ).toMatchObject({ end: 1, start: 1 });
      await run(page, "final('Fox')");
      await expect.poll(() => page.locator('#search').inputValue()).toBe('Fox');
    } finally {
      await page.close();
    }
  });
  it('background and late transcript cannot replace typed input', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(
        page,
        "Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));final('late private text')",
      );
      await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('typing supersedes voice and late final is discarded', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await page.locator('#search').fill('new typed search');
      await run(page, "final('obsolete')");
      await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
      expect(await page.locator('#search').inputValue()).toBe('new typed search');
    } finally {
      await page.close();
    }
  });
  it('absolute deadline cancels and waits provider settlement', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(page, 'window.instant=16000;window.expire()');
      expect(await page.getByRole('button').getAttribute('data-state')).not.toBe('idle');
      await run(page, "final('too late')");
      await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
      expect(await page.locator('#search').inputValue()).toBe('typed');
      expect(
        await page.evaluate(() => (window as unknown as { notices: string[] }).notices.join(' ')),
      ).toContain('timed out');
    } finally {
      await page.close();
    }
  });
  it('disposal waits pending capability and does not start after a late capability reply', async () => {
    const page = await fixture();
    try {
      await run(page, 'window.capBlocked=true');
      await page.getByRole('button').click();
      await run(
        page,
        'window.cleaned=false;window.component.dispose().then(()=>window.cleaned=true)',
      );
      expect(await page.evaluate(() => (window as unknown as { cleaned: boolean }).cleaned)).toBe(
        false,
      );
      await run(page, 'window.resolveCap()');
      await expect.poll(() => page.locator('button').count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { start: number; dispose: number } }).calls,
        ),
      ).toMatchObject({ start: 0, dispose: 1 });
    } finally {
      await page.close();
    }
  });
  it('refuses overlong transcript instead of truncating it', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(page, "final('x'.repeat(257))");
      await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('dispose cannot complete while a capture final callback is still pending', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(
        page,
        'window.cleaned=false;window.component.dispose().then(()=>window.cleaned=true)',
      );
      expect(await page.evaluate(() => (window as unknown as { cleaned: boolean }).cleaned)).toBe(
        false,
      );
      expect(await page.locator('button').count()).toBe(1);
      await run(
        page,
        'window.duplicatePending=false;window.component.dispose().then(()=>window.duplicatePending=true)',
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { duplicatePending: boolean }).duplicatePending,
        ),
      ).toBe(false);
      await run(page, "final('obsolete')");
      await expect.poll(() => page.locator('button').count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { cleaned: boolean; duplicatePending: boolean }).cleaned,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => (window as unknown as { duplicatePending: boolean }).duplicatePending,
        ),
      ).toBe(true);
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('late final after absolute deadline is rejected even before the timer callback executes', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(page, "window.instant=16001;final('late')");
      await expect.poll(() => page.getByRole('button').getAttribute('data-state')).toBe('idle');
      expect(await page.locator('#search').inputValue()).toBe('typed');
    } finally {
      await page.close();
    }
  });
  it('unconfirmed cancellation prevents another capture and disposal reports failure', async () => {
    const page = await fixture();
    try {
      await begin(page);
      await run(
        page,
        "window.refuseCancel=true;window.dispatchEvent(new Event('pagehide'));final('late')",
      );
      await expect.poll(() => page.getByRole('button').isDisabled()).toBe(true);
      expect(await page.locator('#search').inputValue()).toBe('typed');
      await run(
        page,
        'window.disposeFailed=false;window.component.dispose().catch(()=>window.disposeFailed=true)',
      );
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { disposeFailed: boolean }).disposeFailed),
        )
        .toBe(true);
      expect(await page.locator('button').count()).toBe(1);
      await run(
        page,
        'window.refuseCancel=false;window.disposeRetried=false;window.component.dispose().then(()=>window.disposeRetried=true)',
      );
      await page.waitForFunction(
        () => (window as unknown as { disposeRetried: boolean }).disposeRetried,
      );
      expect(await page.locator('button').count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { start: number; dispose: number } }).calls,
        ),
      ).toMatchObject({ start: 1, dispose: 1 });
    } finally {
      await page.close();
    }
  });
});
