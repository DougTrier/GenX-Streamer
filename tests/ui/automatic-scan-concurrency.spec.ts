import { configureControlledDiscoveryProviders } from './helpers/source-scan';
import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { expect, test, type Page } from '@playwright/test';
import { canonicalRecords } from './helpers/source-scan';

const provider = 'https://iptv-org.github.io/iptv/index.m3u';
const freeTv = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const names = Array.from({ length: 40 }, (_, index) => `Parallel ${index}`);
const playlist =
  '#EXTM3U\n' +
  names
    .map(
      (name, index) =>
        `#EXTINF:-1 group-title="Fixture",${name}\nhttps://parallel-${index}.fixture.invalid/feed\n`,
    )
    .join('');

async function setup(page: Page) {
  await installOnlineDirectoryFixture(page, [provider, freeTv]);
  await page.route('https://iptv-org.github.io/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(provider, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: playlist }),
  );
  await page.route(freeTv, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '#EXTM3U\n' }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0,
    active = 0,
    peak = 0,
    canceled = false;
  const settlements: Promise<void>[] = [];
  await page.route(/^https:\/\/parallel-\d+\.fixture\.invalid\/feed$/, async (route) => {
    entered++;
    active++;
    peak = Math.max(peak, active);
    let settle!: () => void;
    settlements.push(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    try {
      await held;
      await route
        .fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: media })
        .catch((error) => {
          if (!canceled && !route.request().failure()) throw error;
        });
    } finally {
      active--;
      settle();
    }
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await configureControlledDiscoveryProviders(page);
  return {
    entered: () => entered,
    active: () => active,
    peak: () => peak,
    cancel: () => {
      canceled = true;
    },
    release,
    join: async () => {
      await Promise.all(settlements);
    },
  };
}
async function start(page: Page) {
  await expect(page.locator('#search')).toHaveValue('');
  if (!(await page.locator('#search-programs').isVisible()))
    await page.locator('#compact-view').selectOption('channels');
  await page.locator('#search-programs').focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('#inline-source-scan');
  await expect(panel).toBeVisible();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  return panel;
}

test('zero-input automatic Scan owns sixteen distinct-origin checks and saves all forty across reload', async ({
  page,
}) => {
  const checks = await setup(page);
  try {
    const baseline = await canonicalRecords(page);
    const dialog = await start(page);
    await expect.poll(checks.entered).toBe(16);
    expect(checks.active()).toBe(16);
    expect(checks.peak()).toBe(16);
    expect(await canonicalRecords(page)).toEqual(baseline);
    await expect(dialog.getByRole('button', { name: 'Save selected channels' })).not.toBeVisible();
    checks.release();
    await expect(dialog.getByRole('status')).toHaveText('40 channels saved.');
    await checks.join();
    expect(checks.entered()).toBe(40);
    expect(checks.active()).toBe(0);
    expect(checks.peak()).toBe(16);
    const saved = await canonicalRecords(page);
    expect(
      JSON.parse(String(saved[0]))
        .channels.map((channel: { name: string }) => channel.name)
        .sort(),
    ).toEqual([...names].sort());
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#channel-count')).toHaveText('40 channels');
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    expect(await canonicalRecords(page)).toEqual(saved);
    expect(checks.entered()).toBe(40);
    await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  } finally {
    checks.cancel();
    checks.release();
    await checks.join();
  }
});

test('Cancel sixteen held automatic checks joins the batch with no late publication or next candidates', async ({
  page,
}) => {
  const checks = await setup(page);
  try {
    const baseline = await canonicalRecords(page);
    const dialog = await start(page);
    await expect.poll(checks.entered).toBe(16);
    expect(checks.active()).toBe(16);
    checks.cancel();
    await page.locator('#inline-scan-stop').click();
    checks.release();
    await checks.join();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    await expect(dialog.getByRole('alert')).toContainText('retained');
    expect(checks.entered()).toBe(16);
    expect(checks.active()).toBe(0);
    expect(checks.peak()).toBe(16);
    expect(await canonicalRecords(page)).toEqual(baseline);
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    expect(await canonicalRecords(page)).toEqual(baseline);
    expect(checks.entered()).toBe(16);
  } finally {
    checks.cancel();
    checks.release();
    await checks.join();
  }
});
