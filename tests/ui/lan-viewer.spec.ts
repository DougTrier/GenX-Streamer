import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

type FixtureWindow = Window & {
  calls: { body: string; signal: AbortSignal }[];
  loads: string[];
  destroyed: number;
  reply: (index: number, value: unknown) => void;
  finishPlay: () => void;
  hide: () => void;
  show: () => void;
};

async function setup(page: Page, { mse = true, native = true, pending = false } = {}) {
  const html = await readFile('src-tauri/src/lan/viewer.html', 'utf8');
  await page.setContent(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''));
  await page.clock.install();
  await page.addScriptTag({
    content: `
    window.calls=[];window.loads=[];window.destroyed=0;
    window.Hls=${mse ? "class {static isSupported(){return true} static Events={ERROR:'error'};on(){}loadSource(path){window.loads.push(path)}attachMedia(){}destroy(){window.destroyed++}startLoad(){}}" : 'undefined'};
    HTMLMediaElement.prototype.canPlayType=function(){return ${native ? "'probably'" : "''"}};
    HTMLMediaElement.prototype.play=function(){return ${pending ? 'new Promise(resolve=>window.finishPlay=resolve)' : 'Promise.resolve()'}};
    HTMLMediaElement.prototype.pause=function(){};HTMLMediaElement.prototype.load=function(){};
    window.fetch=(path,options)=>new Promise(resolve=>window.calls.push({path,body:options.body,signal:options.signal,resolve}));
    window.reply=(index,value)=>window.calls[index].resolve(new Response(JSON.stringify(value)));
    window.hide=()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))};
    window.show=()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))};
  `,
  });
  await page.addScriptTag({ content: await readFile('src-tauri/src/lan/viewer.js', 'utf8') });
}
async function reply(page: Page, index: number, value: unknown) {
  await page.evaluate(
    ({ index, value }) => (window as unknown as FixtureWindow).reply(index, value),
    { index, value },
  );
}
async function calls(page: Page, count: number) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).calls.length))
    .toBe(count);
}
async function watching(page: Page) {
  await page.locator('#secret').fill('owned-fixture');
  await page.locator('#pair').dispatchEvent('submit');
  await reply(page, 0, { role: 'viewer' });
  await calls(page, 2);
  await reply(page, 1, { revision: null, mediaPath: null });
  await page.locator('#watch').click();
  await calls(page, 3);
  await reply(page, 2, { revision: 1, mediaPath: '/media/1/owned' });
}

test('both native HLS and MSE support select the owned bundled HLS engine', async ({ page }) => {
  await setup(page);
  await watching(page);
  await expect(page.locator('#status')).toHaveText('Following the host channel.');
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).loads)).toEqual([
    '/media/1/owned',
  ]);
  expect(await page.locator('#video').getAttribute('src')).toBeNull();
});

test('missing bundled HLS uses native support and gives actionable failure if neither exists', async ({
  page,
}) => {
  await setup(page, { mse: false });
  await watching(page);
  await expect(page.locator('#video')).toHaveAttribute('src', '/media/1/owned');
  await page.reload();
  await setup(page, { mse: false, native: false });
  await watching(page);
  await expect(page.locator('#status')).toHaveText(
    'This browser cannot play this stream. Use a supported browser.',
  );
  expect(await page.locator('#video').getAttribute('src')).toBeNull();
});

test('pending play does not block heartbeats; hidden cancellation prevents late success or automatic resume', async ({
  page,
}) => {
  await setup(page, { pending: true });
  await watching(page);
  await page.clock.runFor(2000);
  await calls(page, 4);
  expect(
    await page.evaluate(() => JSON.parse((window as unknown as FixtureWindow).calls[3].body)),
  ).toEqual({ paused: false });
  await reply(page, 3, { revision: 1, mediaPath: '/media/1/owned' });
  await page.evaluate(() => (window as unknown as FixtureWindow).hide());
  await page.evaluate(() => (window as unknown as FixtureWindow).finishPlay());
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).destroyed)).toBe(1);
  await page.evaluate(() => (window as unknown as FixtureWindow).show());
  await calls(page, 5);
  expect(
    await page.evaluate(() => JSON.parse((window as unknown as FixtureWindow).calls[4].body)),
  ).toEqual({ paused: true });
  await reply(page, 4, { revision: 1, mediaPath: '/media/1/owned' });
  await expect(page.locator('#status')).toHaveText('Press Watch to resume following the host.');
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).loads)).toEqual([
    '/media/1/owned',
  ]);
});

test('pagehide cancels pending startup and no late play result can update a disposed viewer', async ({
  page,
}) => {
  await setup(page, { pending: true });
  await watching(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const message = await page.locator('#status').textContent();
  await page.evaluate(() => (window as unknown as FixtureWindow).finishPlay());
  await page.clock.runFor(12000);
  expect(await page.locator('#status').textContent()).toBe(message);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).calls.length)).toBe(3);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).destroyed)).toBe(1);
});

test('pending startup times out independently while heartbeats renew and requires explicit Watch', async ({
  page,
}) => {
  await setup(page, { pending: true });
  await watching(page);
  for (let index = 3; index < 7; index++) {
    await page.clock.runFor(2000);
    await calls(page, index + 1);
    await reply(page, index, { revision: 1, mediaPath: '/media/1/owned' });
  }
  await page.clock.runFor(2000);
  await expect(page.locator('#status')).toHaveText(
    'Playback did not begin in time. Press Watch to try again.',
  );
  await calls(page, 8);
  await reply(page, 7, { revision: 1, mediaPath: null });
  await page.clock.runFor(2000);
  await calls(page, 9);
  expect(
    await page.evaluate(() => JSON.parse((window as unknown as FixtureWindow).calls[8].body)),
  ).toEqual({ paused: true });
  await page.evaluate(() => (window as unknown as FixtureWindow).finishPlay());
  await expect(page.locator('#status')).toHaveText(
    'Playback did not begin in time. Press Watch to try again.',
  );
});

test('viewer pause disposes pending media and later play settlement cannot resume its heartbeat', async ({
  page,
}) => {
  await setup(page, { pending: true });
  await watching(page);
  await page.evaluate(() => {
    const video = document.getElementById('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    video.dispatchEvent(new Event('pause'));
    (window as unknown as FixtureWindow).finishPlay();
  });
  await page.clock.runFor(2000);
  await calls(page, 4);
  expect(
    await page.evaluate(() => JSON.parse((window as unknown as FixtureWindow).calls[3].body)),
  ).toEqual({ paused: true });
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).destroyed)).toBe(1);
  expect(await page.locator('#video').getAttribute('src')).toBeNull();
  expect(await page.locator('#status').textContent()).not.toBe('Following the host channel.');
});
