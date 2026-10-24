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
import { chromium, type Browser } from '@playwright/test';
import { createDiagnostics } from '../../src/diagnostics/native';
import {
  describeDiagnosticEvent,
  validateDiagnosticInput,
  validateDiagnosticPage,
} from '../../src/diagnostics/events';
import { readStylesheet } from '../support/stylesheet';
const event = {
  id: '1',
  timestampMs: 1000,
  operation: 'scan' as const,
  level: 'info' as const,
  code: 'scan-started' as const,
  checked: 0,
  total: 100000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it('strictly refuses raw messages, provider addresses, wrong pairings and unsafe counts', () => {
  for (const bad of [
    { ...event, message: 'https://secret.invalid' },
    { ...event, code: '<script>' },
    { ...event, operation: 'storage' },
    { ...event, checked: 100001 },
    { ...event, total: NaN },
  ])
    expect(() => validateDiagnosticPage({ schemaVersion: 1, events: [bad] })).toThrow();
  expect(() =>
    validateDiagnosticInput({ operation: 'application', code: 'scan-started', level: 'info' }),
  ).toThrow();
  expect(describeDiagnosticEvent(event)).toContain('100000 total');
});
it('bounds history and validates decimal monotonic IDs while allowing clock rollback', () => {
  expect(() =>
    validateDiagnosticPage({ schemaVersion: 1, events: Array.from({ length: 301 }, () => event) }),
  ).toThrow();
  expect(() => validateDiagnosticPage({ schemaVersion: 1, events: [event, event] })).toThrow();
  expect(() =>
    validateDiagnosticPage({
      schemaVersion: 1,
      events: [{ ...event, id: '18446744073709551616' }],
    }),
  ).toThrow();
  expect(
    validateDiagnosticPage({
      schemaVersion: 1,
      events: [event, { ...event, id: '2', timestampMs: 0 }],
    }).events,
  ).toHaveLength(2);
});
it('matches native scan-only counts, total relationships and safe ID bound', () => {
  for (const bad of [
    { ...event, total: 1, checked: 2 },
    { ...event, total: 1, published: 2 },
    { ...event, operation: 'playback', code: 'playback-failed' },
    { ...event, id: '9007199254740992' },
  ])
    expect(() => validateDiagnosticPage({ schemaVersion: 1, events: [bad] })).toThrow();
  expect(describeDiagnosticEvent({ ...event, published: 1 })).toContain('1 saved responses');
});
it('limits queued actual writes to 32 and dispose joins their real settlement', async () => {
  const held = deferred<unknown>();
  let calls = 0;
  const owner = createDiagnostics({
    invoke: async () => {
      calls++;
      return calls === 1 ? held.promise : { ...event, id: String(calls) };
    },
  });
  const { id: _id, timestampMs: _time, ...input } = event;
  const writes = Array.from({ length: 33 }, () => owner.emit(input));
  expect(await writes[32]).toBe(false);
  let closed = false;
  const close = owner.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(calls).toBe(1);
  held.resolve(event);
  await close;
  expect((await Promise.all(writes)).filter(Boolean)).toHaveLength(32);
  expect(calls).toBe(32);
  expect(await owner.emit(input)).toBe(false);
});
it('rejecting settled logging work cannot poison Exit and emitted malformed receipts fail safely', async () => {
  const owner = createDiagnostics({
    invoke: async () => {
      throw new Error('https://credentials.invalid');
    },
  });
  expect(await owner.emit({ operation: 'scan', level: 'error', code: 'scan-failed' })).toBe(false);
  await expect(owner.dispose()).resolves.toBeUndefined();
  const wrong = createDiagnostics({ invoke: async () => ({ ...event, code: 'scan-failed' }) });
  expect(await wrong.emit({ operation: 'scan', level: 'info', code: 'scan-started' })).toBe(false);
});
it('abort fences publication but never abandons an already dispatched native read', async () => {
  const held = deferred<unknown>(),
    signal = new AbortController();
  const owner = createDiagnostics({ invoke: () => held.promise });
  const read = owner.read(signal.signal);
  const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  signal.abort();
  let closed = false;
  const close = owner.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  held.resolve({ schemaVersion: 1, events: [event] });
  await rejected;
  await close;
});
it('validates read and clear envelopes without exposing provider errors', async () => {
  const owner = createDiagnostics({
    invoke: async (command) =>
      command === 'read_diagnostic_events'
        ? { schemaVersion: 1, events: [event], url: 'secret' }
        : { cleared: true, data: 'secret' },
  });
  await expect(owner.read(new AbortController().signal)).rejects.toThrow('Event history');
  await expect(owner.clear(new AbortController().signal)).rejects.toThrow('Event history');
});
it('already dispatched Clear stays owned until its actual receipt even after cancellation', async () => {
  const held = deferred<unknown>(),
    controller = new AbortController();
  const owner = createDiagnostics({ invoke: () => held.promise });
  const clearing = owner.clear(controller.signal);
  const refused = expect(clearing).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  controller.abort();
  let disposed = false;
  const closing = owner.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  held.resolve({ cleared: true });
  await refused;
  await closing;
  expect(disposed).toBe(true);
});
let browser: Browser, bundle: string, navBundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'src/ui/settings/event-history.ts', formats: ['iife'], name: 'HistoryUI' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing bundle');
  bundle = chunk.code;
  const nav = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'src/ui/shell/remote-navigation.ts', formats: ['iife'], name: 'NavUI' },
    },
  });
  const navOutput = Array.isArray(nav) ? nav[0] : nav;
  if (!navOutput || !('output' in navOutput)) throw new Error('Missing navigation bundle');
  const navChunk = navOutput.output.find((item) => item.type === 'chunk');
  if (!navChunk || navChunk.type !== 'chunk') throw new Error('Missing navigation bundle');
  navBundle = navChunk.code;
  css = await readStylesheet('src/ui/event-history.css');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(held = false, width = 960, height = 540, many = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="opener">History</button><main></main>',
    }),
  );
  await page.goto('http://localhost/history');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: navBundle });
  await page.evaluate(
    ({ event, held, many }) => {
      Reflect.set(window, 'removeNav', Reflect.get(window, 'NavUI').installRemoteNavigation());
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      Reflect.set(window, 'release', release);
      Reflect.set(window, 'clears', 0);
      Reflect.set(
        window,
        'owner',
        Reflect.get(window, 'HistoryUI').mountEventHistory(document.querySelector('main'), {
          read: async () => {
            if (held) await pending;
            return {
              schemaVersion: 1,
              events: many
                ? Array.from({ length: 60 }, (_, i) => ({
                    ...event,
                    id: String(i + 1),
                    timestampMs: 1000 + i,
                  }))
                : [event],
            };
          },
          clear: async () => {
            Reflect.set(window, 'clears', 1);
            throw new Error('https://private.invalid');
          },
          formatTime: (at: number) => new Date(at).toLocaleString(),
        }),
      );
      document.querySelector<HTMLElement>('#opener')!.focus();
      Reflect.get(window, 'owner').open();
    },
    { event, held, many },
  );
  return page;
}
it('renders bounded chronological safe descriptions and actionable clear failure', async () => {
  const page = await fixture();
  try {
    await expect.poll(() => page.locator('li').count()).toBe(1);
    expect(await page.locator('time').getAttribute('datetime')).toBe('1970-01-01T00:00:01.000Z');
    expect(await page.locator('.gx-event-code').textContent()).toBe('scan-started');
    await page.getByRole('button', { name: 'Clear history' }).click();
    await expect.poll(() => page.getByRole('status').textContent()).toContain('Retry Clear');
    expect(await page.locator('body').textContent()).not.toContain('private.invalid');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('dialog').isVisible()).toBe(false);
    expect(await page.locator('#opener').evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
  } finally {
    await page.close();
  }
});
it('Close and dispose share real pending read ownership without late rendering', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'settled', false);
      Reflect.set(
        window,
        'closing',
        Reflect.get(window, 'owner')
          .close()
          .then(() => Reflect.set(window, 'settled', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'settled'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await page.evaluate(() => Reflect.get(window, 'closing'));
    expect(await page.locator('li').count()).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    expect(await page.locator('dialog').count()).toBe(0);
  } finally {
    await page.close();
  }
});
it('44px history controls fit narrow enlarged text without polling', async () => {
  const page = await fixture(false, 320, 640);
  try {
    await expect.poll(() => page.locator('li').count()).toBe(1);
    await page.addStyleTag({ content: 'html{font-size:32px}' });
    for (const button of await page.locator('dialog button').all()) {
      const rect = await button.boundingBox();
      expect(rect!.width).toBeGreaterThanOrEqual(44);
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(
        rect!.x >= 0 &&
          rect!.y >= 0 &&
          rect!.x + rect!.width <= 320 &&
          rect!.y + rect!.height <= 640,
      ).toBe(true);
    }
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
  } finally {
    await page.close();
  }
});
it('D-pad enters history, scrolls twenty rows and returns to the toolbar at the top', async () => {
  const page = await fixture(false, 960, 540, true);
  try {
    await expect.poll(() => page.locator('li').count()).toBe(60);
    await page.keyboard.press('ArrowDown');
    const list = page.getByRole('list', { name: 'Recent events' });
    expect(await list.evaluate((node) => node === document.activeElement)).toBe(true);
    const height = await page
      .locator('li')
      .first()
      .evaluate((node) => node.getBoundingClientRect().height);
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(height * 20 - 1);
    expect(await list.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press('End');
    expect(
      await list.evaluate((node) =>
        Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop),
      ),
    ).toBeLessThanOrEqual(1);
    const end = await list.evaluate((node) => node.scrollTop);
    const pageHeight = await list.evaluate((node) => node.clientHeight);
    await page.keyboard.press('PageUp');
    expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(end - pageHeight, 0);
    await page.keyboard.press('PageDown');
    expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(end, 0);
    await page.keyboard.press('Home');
    expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
    await page.keyboard.press('ArrowUp');
    expect(
      await page
        .locator('dialog header button')
        .evaluateAll((nodes) => nodes.includes(document.activeElement as HTMLButtonElement)),
    ).toBe(true);
    await page.getByRole('button', { name: 'Close history' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('dialog').isVisible()).toBe(false);
    expect(await page.locator('#opener').evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    await page.evaluate(() => Reflect.get(window, 'removeNav')());
  } finally {
    await page.close();
  }
});
