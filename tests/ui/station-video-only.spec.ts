import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * The station-page scripts GenX runs for Full screen (src-tauri/page-scripts),
 * against fixture pages shaped like real station players. Browser layout only;
 * the native page view and real sites are checked on devices.
 */
const showVideo = readFileSync('src-tauri/page-scripts/show-video.js', 'utf8');
const showPage = readFileSync('src-tauri/page-scripts/show-page.js', 'utf8');

async function fixture(page: Page, body: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.route('**/station-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0;padding-top:60px"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#22f;z-index:23">Station</header>${body}<p style="height:2000px">Article</p></body></html>`,
    }),
  );
  await page.goto('/station-fixture');
}
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  });

test('a player frame keeps its shape on an ultrawide screen (whole picture, centred)', async ({
  page,
}) => {
  // 32:9, like a 49" ultrawide; the player frame is 16:9.
  await fixture(
    page,
    '<div style="translate:0px"><iframe allowfullscreen id="player" style="width:640px;height:360px;border:0" srcdoc="<body style=margin:0><div style=width:100%;padding-top:56.25%;background:red></div></body>"></iframe></div>',
    1600,
    450,
  );
  expect(await page.evaluate(showVideo)).toBe('iframe');
  expect(await box(page, '#player')).toEqual([400, 0, 800, 450]);
  await expect(page.locator('#genx-backdrop')).toHaveCount(1);
  expect(await page.evaluate(showPage)).toBe('page');
  expect(await box(page, '#player')).toEqual([0, 60, 640, 360]);
  await expect(page.locator('#genx-backdrop')).toHaveCount(0);
});

test('a plain video fills a 16:9 screen, even inside a translated wrapper', async ({ page }) => {
  await fixture(
    page,
    '<div style="translate:0px;position:relative;z-index:1"><video id="clip" width="465" height="262" style="background:#000"></video></div>',
    960,
    540,
  );
  expect(await page.evaluate(showVideo)).toBe('video');
  expect(await box(page, '#clip')).toEqual([0, 0, 960, 540]);
  // Above the site's own fixed header.
  expect(await page.evaluate(() => document.elementFromPoint(480, 20)?.id)).toBe('clip');
  expect(await page.evaluate(showPage)).toBe('page');
  expect(await box(page, '#clip')).toEqual([0, 60, 465, 262]);
});

test('a player frame still fills a 16:9 TV screen', async ({ page }) => {
  await fixture(
    page,
    '<iframe allowfullscreen id="player" style="width:565px;height:318px;border:0" srcdoc="<body style=margin:0></body>"></iframe>',
    960,
    540,
  );
  expect(await page.evaluate(showVideo)).toBe('iframe');
  const [left, top, width, height] = await box(page, '#player');
  // 565x318 is 16:9 to the pixel; the box may differ by one pixel from rounding.
  expect(Math.abs(left)).toBeLessThanOrEqual(1);
  expect(top).toBe(0);
  expect(width).toBeGreaterThanOrEqual(958);
  expect(height).toBe(540);
});

test('the video being watched wins over a bigger one elsewhere on the page', async ({ page }) => {
  await fixture(
    page,
    '<video id="big" width="640" height="360"></video><video id="small" width="320" height="180"></video>',
    960,
    540,
  );
  // Fixture: the small video is the one playing.
  await page.evaluate(() => {
    const small = document.getElementById('small')!;
    Object.defineProperty(small, 'paused', { get: () => false });
    Object.defineProperty(small, 'readyState', { get: () => 4 });
  });
  expect(await page.evaluate(showVideo)).toBe('video');
  expect(await box(page, '#small')).toEqual([0, 0, 960, 540]);
  expect(await box(page, '#big')).toEqual([0, 60, 640, 360]);
});

test('a frame that reports its video started wins over a bigger frame', async ({ page }) => {
  const agent = readFileSync('src-tauri/page-scripts/frame-agent.js', 'utf8').replaceAll(
    '__GENX_TOKEN__',
    'fixture-token',
  );
  await fixture(
    page,
    '<iframe allowfullscreen id="big" style="width:640px;height:360px;border:0" srcdoc="<body></body>"></iframe><iframe allowfullscreen id="small" style="width:320px;height:180px;border:0" srcdoc="<body><video></video></body>"></iframe>',
    960,
    540,
  );
  // The helper runs in every frame, as GenX installs it.
  for (const frame of page.frames()) await frame.evaluate(agent);
  const inner = await (await page.$('#small'))!.contentFrame();
  if (!inner) throw new Error('fixture frame missing');
  await inner.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
  await expect
    .poll(() =>
      page.locator('#small').evaluate((e) => (e as HTMLElement).dataset.genxPlaying ?? ''),
    )
    .not.toBe('');
  expect(await page.evaluate(showVideo)).toBe('iframe');
  const [, top, , height] = await box(page, '#small');
  expect([top, height]).toEqual([0, 540]);
});

test('with no player, Full screen keeps the page: a schedule box is never blown up', async ({
  page,
}) => {
  // Like WTVP's home page: a large "What's On Now" frame and no video.
  await fixture(
    page,
    '<iframe id="schedule" style="width:640px;height:400px;border:0" srcdoc="<body>What is on now</body>"></iframe>',
    960,
    540,
  );
  expect(await page.evaluate(showVideo)).toBe('none');
  expect(await box(page, '#schedule')).toEqual([0, 60, 640, 400]);
  await expect(page.locator('#genx-backdrop')).toHaveCount(0);
});

test('a frame from a video host is a player even without the full-screen attribute', async ({
  page,
}) => {
  await page.route('**/player.vimeo.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<body style=margin:0></body>' }),
  );
  await fixture(
    page,
    '<iframe id="clip" style="width:640px;height:360px;border:0" src="https://player.vimeo.com/video/1"></iframe>',
    960,
    540,
  );
  expect(await page.evaluate(showVideo)).toBe('iframe');
  expect(await box(page, '#clip')).toEqual([0, 0, 960, 540]);
});
