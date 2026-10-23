import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, type Page } from '@playwright/test';
import { expect, it } from 'vitest';

const browserOptions = {
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const fixture = `
window.calls=[];window.loads=[];window.destroyed=0;
window.Hls=class {static isSupported(){return true} static Events={ERROR:'error'};on(){}loadSource(path){window.loads.push(path)}attachMedia(){}destroy(){window.destroyed++}stopLoad(){}startLoad(){}};
HTMLMediaElement.prototype.canPlayType=function(){return ''};
HTMLMediaElement.prototype.play=async function(){};
HTMLMediaElement.prototype.pause=function(){};HTMLMediaElement.prototype.load=function(){};
window.fetch=(path,options)=>new Promise(resolve=>window.calls.push({path,signal:options.signal,body:options.body,resolve}));
window.reply=(index,value)=>window.calls[index].resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}));
window.hide=()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))};
window.show=()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))};
`;
async function setup(page: Page, mocked = true) {
  const html = await readFile('src-tauri/src/lan/viewer.html', 'utf8');
  await page.setContent(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''));
  if (mocked) await page.addScriptTag({ content: fixture });
  await page.addScriptTag({ content: await readFile('src-tauri/src/lan/viewer.js', 'utf8') });
}
async function reply(page: Page, index: number, value: unknown) {
  await page.evaluate(
    ({ index, value }) =>
      (window as unknown as { reply(index: number, value: unknown): void }).reply(index, value),
    { index, value },
  );
}
async function calls(page: Page, count: number) {
  await page.waitForFunction(
    (count) => (window as unknown as { calls: unknown[] }).calls.length === count,
    count,
  );
}
async function pair(page: Page) {
  await page.locator('#secret').fill('fixture-invite');
  await page.locator('#pair').dispatchEvent('submit');
}
async function withPage(action: (page: Page) => Promise<void>) {
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await setup(page);
    await action(page);
  } finally {
    await browser.close();
  }
}

it('a viewer can wait without publication, choose Watch, then follow the first published channel', async () => {
  await withPage(async (page) => {
    await page.clock.install();
    await pair(page);
    await reply(page, 0, { role: 'viewer' });
    await calls(page, 2);
    await reply(page, 1, { revision: null, mediaPath: null });
    await page.clock.runFor(1);
    expect(await page.locator('#view').isVisible()).toBe(true);
    expect(await page.locator('#pair').isVisible()).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([]);
    await page.locator('#watch').click();
    await calls(page, 3);
    await reply(page, 2, { revision: null, mediaPath: null });
    await page.clock.runFor(1);
    expect(await page.locator('#view').isVisible()).toBe(true);
    await page.clock.runFor(2000);
    await calls(page, 4);
    await reply(page, 3, { revision: 1, mediaPath: '/media/1/first' });
    await page.getByText('Following the host channel.', { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([
      '/media/1/first',
    ]);
  });
});

it('a controller can search and request a channel before any publication with revision zero', async () => {
  await withPage(async (page) => {
    await page.clock.install();
    await pair(page);
    await reply(page, 0, { role: 'controller' });
    await calls(page, 2);
    await reply(page, 1, [
      { id: 'a', name: 'News' },
      { id: 'b', name: 'Sports' },
    ]);
    await calls(page, 3);
    await reply(page, 2, { revision: null, mediaPath: null });
    await page.clock.runFor(1);
    expect(await page.locator('#control').isVisible()).toBe(true);
    await page.locator('#search').fill('Sports');
    expect(await page.locator('#channel option').count()).toBe(1);
    await page.locator('#channel').selectOption('b');
    await page.locator('#control').dispatchEvent('submit');
    await calls(page, 4);
    expect(
      await page.evaluate(() =>
        JSON.parse((window as unknown as { calls: { body: string }[] }).calls[3].body),
      ),
    ).toMatchObject({ action: 'select', channelId: 'b', revision: 0, sequence: 1 });
    await reply(page, 3, { applied: true });
    await page.getByText('The host confirmed your request.', { exact: true }).waitFor();
  });
});

it.each([
  { label: 'null response', state: null },
  { label: 'array response', state: [] },
  { label: 'missing fields', state: {} },
  {
    label: 'null revision with a media path',
    state: { revision: null, mediaPath: '/media/1/first' },
  },
  { label: 'different path revision', state: { revision: 2, mediaPath: '/media/1/first' } },
  { label: 'noncanonical path revision', state: { revision: 2, mediaPath: '/media/02/first' } },
  { label: 'unsafe numeric revision', state: { revision: 9007199254740992, mediaPath: null } },
  { label: 'zero publication revision', state: { revision: 0, mediaPath: null } },
])('rejects unsupported native state: $label without loading media', async ({ state }) => {
  await withPage(async (page) => {
    await pair(page);
    await reply(page, 0, { role: 'viewer' });
    await calls(page, 2);
    await reply(page, 1, state);
    await page
      .getByText('The host returned an unsupported channel state.', { exact: true })
      .waitFor();
    expect(await page.locator('#pair').isVisible()).toBe(true);
    expect(await page.locator('#view').isVisible()).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([]);
  });
});

it('late pairing after pagehide cannot restore a disposed viewer or launch polling', async () => {
  await withPage(async (page) => {
    await pair(page);
    await calls(page, 1);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(
      await page.evaluate(
        () => (window as unknown as { calls: { signal: AbortSignal }[] }).calls[0].signal.aborted,
      ),
    ).toBe(true);
    await reply(page, 0, { role: 'viewer' });
    await page.evaluate(() => Promise.resolve());
    expect(await page.locator('#pair').isVisible()).toBe(true);
    expect(await page.locator('#view').isVisible()).toBe(false);
    await page.locator('#watch').dispatchEvent('click');
    await calls(page, 1);
  });
});

it('controller channels are owned: background and superseded pairing reject late channels', async () => {
  await withPage(async (page) => {
    await pair(page);
    await reply(page, 0, { role: 'controller' });
    await calls(page, 2);
    expect(
      await page.evaluate(() => (window as unknown as { calls: { path: string }[] }).calls[1].path),
    ).toBe('/channels');
    await page.evaluate(() => (window as unknown as { hide(): void }).hide());
    expect(
      await page.evaluate(
        () => (window as unknown as { calls: { signal: AbortSignal }[] }).calls[1].signal.aborted,
      ),
    ).toBe(true);
    await page.evaluate(() => (window as unknown as { show(): void }).show());
    await pair(page);
    await calls(page, 3);
    await reply(page, 2, { role: 'viewer' });
    await calls(page, 4);
    await reply(page, 3, { revision: 1, mediaPath: '/media/1/new' });
    await reply(page, 1, [{ id: 'old', name: '<b>Old controller</b>' }]);
    await page.getByText('Connected. Press Watch to follow the host.', { exact: true }).waitFor();
    expect(await page.locator('#control').isVisible()).toBe(false);
    expect(await page.locator('#view').isVisible()).toBe(true);
    expect(await page.locator('#channel option').count()).toBe(0);
  });
});

it('late state after pagehide cannot load media; pairing alone never starts playback', async () => {
  await withPage(async (page) => {
    await pair(page);
    await reply(page, 0, { role: 'viewer' });
    await calls(page, 2);
    await reply(page, 1, { revision: 1, mediaPath: '/media/1/first' });
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([]);
    await page.locator('#watch').click();
    await calls(page, 3);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await reply(page, 2, { revision: 2, mediaPath: '/media/2/late' });
    await page.evaluate(() => Promise.resolve());
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([]);
    expect(await page.locator('#video').getAttribute('src')).toBe(null);
  });
});

it('hide destroys current media; foreground requires explicit Watch and accepts a fresh revision', async () => {
  await withPage(async (page) => {
    await pair(page);
    await reply(page, 0, { role: 'viewer' });
    await calls(page, 2);
    await reply(page, 1, { revision: 1, mediaPath: '/media/1/first' });
    await page.locator('#watch').click();
    await calls(page, 3);
    await reply(page, 2, { revision: 1, mediaPath: '/media/1/first' });
    await page.getByText('Following the host channel.', { exact: true }).waitFor();
    await page.evaluate(() => (window as unknown as { hide(): void }).hide());
    expect(await page.evaluate(() => (window as unknown as { destroyed: number }).destroyed)).toBe(
      1,
    );
    await page.evaluate(() => (window as unknown as { show(): void }).show());
    await calls(page, 4);
    await reply(page, 3, { revision: 2, mediaPath: '/media/2/second' });
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([
      '/media/1/first',
    ]);
    await page.locator('#watch').click();
    await calls(page, 5);
    await reply(page, 4, { revision: 2, mediaPath: '/media/2/second' });
    await page.getByText('Following the host channel.', { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual([
      '/media/1/first',
      '/media/2/second',
    ]);
  });
});

it('late control acknowledgement cannot overwrite a newer pairing or restart polling', async () => {
  await withPage(async (page) => {
    await pair(page);
    await reply(page, 0, { role: 'controller' });
    await calls(page, 2);
    await reply(page, 1, [{ id: 'a', name: 'A' }]);
    await calls(page, 3);
    await reply(page, 2, { revision: 1, mediaPath: null });
    await page.locator('[data-action="pause"]').click();
    await calls(page, 4);
    await page.evaluate(() => (window as unknown as { hide(): void }).hide());
    await page.evaluate(() => (window as unknown as { show(): void }).show());
    await calls(page, 5);
    await reply(page, 4, { revision: 1, mediaPath: null });
    await reply(page, 3, { applied: true });
    await page.getByText('Controller connected.', { exact: true }).waitFor();
    await calls(page, 5);
  });
});

it('actual HTTP controller-channel fetch aborts at its ten-second deadline', async () => {
  let channelRequests = 0;
  let channelClosed = false;
  const server = createServer((request, response) => {
    if (request.url === '/pair') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ role: 'controller' }));
    } else if (request.url === '/channels') {
      channelRequests++;
      response.setHeader('Content-Type', 'application/json');
      response.write('['); // Hold the actual body read until the owned deadline aborts it.
      response.on('close', () => {
        channelClosed = true;
      });
    } else {
      response.end('<!doctype html><title>Fixture</title>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await setup(page, false);
    await page.clock.install();
    await pair(page);
    await page.waitForFunction(
      () => document.getElementById('secret')?.getAttribute('id') === 'secret',
    );
    for (let count = 0; count < 100 && channelRequests === 0; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channelRequests).toBe(1);
    await page.clock.runFor(10001);
    await page.getByText('The host did not respond in time. Try again.', { exact: true }).waitFor();
    expect(await page.locator('#pair button').isEnabled()).toBe(true);
    for (let count = 0; count < 100 && !channelClosed; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channelClosed).toBe(true);
    expect(await page.locator('#control').isVisible()).toBe(false);
    await page.clock.runFor(2000);
    expect(channelRequests).toBe(1);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
