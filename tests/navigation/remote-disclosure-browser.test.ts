import { expect, it } from 'vitest';
import { build } from 'vite';
import { chromium } from '@playwright/test';

it('never restores remote focus inside closed details, but permits the summary and opened controls', async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/remote-navigation.ts', formats: ['iife'], name: 'RemoteUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing navigation bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing navigation entry');
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>button,summary{display:block;min-height:44px;width:200px}</style>
      <button id="start">Start</button><details id="advanced"><summary id="summary">Advanced</summary>
      <button id="run">Run action</button><details><summary id="nested">Nested</summary></details>
      </details>`);
    await page.addScriptTag({ content: chunk.code });
    const inspect = () =>
      page.evaluate(() => {
        const restore = Reflect.get(window, 'RemoteUI').restoreRemoteFocus;
        const run = document.getElementById('run');
        const summary = document.getElementById('summary');
        const nested = document.getElementById('nested');
        return {
          closedRestored: restore(run, summary),
          closedTarget: document.activeElement?.id,
          nestedRestored: restore(nested, summary),
          nestedTarget: document.activeElement?.id,
        };
      });
    expect(await inspect()).toEqual({
      closedRestored: true,
      closedTarget: 'summary',
      nestedRestored: true,
      nestedTarget: 'summary',
    });
    await page.keyboard.press('Enter');
    expect(
      await page.locator('#advanced').evaluate((node) => (node as HTMLDetailsElement).open),
    ).toBe(true);
    expect(
      await page.evaluate(() => {
        const restored = Reflect.get(window, 'RemoteUI').restoreRemoteFocus(
          document.getElementById('run'),
        );
        return { restored, target: document.activeElement?.id };
      }),
    ).toEqual({ restored: true, target: 'run' });
    await page.locator('#advanced').evaluate((node) => ((node as HTMLDetailsElement).open = false));
    await page.evaluate(() => {
      Reflect.set(
        window,
        'disposeRemote',
        Reflect.get(window, 'RemoteUI').installRemoteNavigation(),
      );
      document.getElementById('start')?.focus();
    });
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('summary');
    await page.evaluate(() => Reflect.get(window, 'disposeRemote')());
  } finally {
    await browser.close();
  }
}, 15000);
