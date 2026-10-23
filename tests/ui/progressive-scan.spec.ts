import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { configureControlledDiscoveryProviders } from './helpers/source-scan';
import { openPlaylistImport } from './helpers/source-scan';
import { expect, test, type Page } from '@playwright/test';
import { canonicalRecords } from './helpers/source-scan';

const providers = [
  'https://iptv-org.github.io/iptv/index.m3u',
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
];
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
async function fixture(page: Page) {
  const sourceRequests: string[] = [],
    requests = new Map<number, number>();
  const releases: (() => void)[] = [],
    settlements: Promise<void>[] = [];
  let hold = true;
  const playlist =
    '#EXTM3U\n' +
    Array.from(
      { length: 48 },
      (_, index) =>
        `#EXTINF:-1 group-title="Fixture",Ready ${String(index).padStart(2, '0')}\nhttps://progress${index}.fixture.invalid/feed\n`,
    ).join('');
  await page.route('https://iptv-org.github.io/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  for (const [index, url] of providers.entries())
    await page.route(url, (route) => {
      sourceRequests.push(url);
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: index === 0 ? playlist : '#EXTM3U\n',
      });
    });
  await page.route(/^https:\/\/progress\d+\.fixture\.invalid\/feed$/, async (route) => {
    const index = Number(new URL(route.request().url()).hostname.match(/progress(\d+)/)![1]);
    requests.set(index, (requests.get(index) ?? 0) + 1);
    if (hold && index >= 16) {
      let finish!: () => void;
      settlements.push(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        await route
          .fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: media })
          .catch(() => undefined);
      } finally {
        finish();
      }
    } else
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: media,
      });
  });
  await page.route(/https:\/\/progress\d+\.fixture\.invalid\/segment.ts$/, (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await installOnlineDirectoryFixture(page, providers);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await configureControlledDiscoveryProviders(page);
  return {
    sourceRequests,
    requests,
    async release() {
      hold = false;
      releases.splice(0).forEach((resolve) => resolve());
      await Promise.all(settlements);
    },
  };
}
async function scan(page: Page) {
  if (!(await page.locator('#search-programs').isVisible()))
    await page.locator('#compact-view').selectOption('channels');
  await page.locator('#search-programs').click();
  const panel = page.locator('#inline-source-scan');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  return panel;
}

async function holdCheckpointAdmission(page: Page) {
  await page.evaluate(() => {
    const reads = new WeakSet<IDBTransaction>();
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (key === 'scanCheckpoint') reads.add(this.transaction);
      return get.call(this, key);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Reflect.set(window, 'entryRead', { held: false, release: () => {} });
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback) {
        complete.set!.call(this, function (this: IDBTransaction, event: Event) {
          const state = Reflect.get(window, 'entryRead');
          if (reads.has(this) && !state.held) {
            state.held = true;
            state.release = () => callback.call(this, event);
          } else callback.call(this, event);
        });
      },
    });
  });
}

test('inline checkpoint admission cannot open a dialog or steal the current search focus', async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await holdCheckpointAdmission(page);
    await page.locator('#search-programs').click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'entryRead').held)).toBe(true);
    await expect(page.locator('#search-programs')).toBeDisabled();
    await page.locator('#search').focus();
    await page.evaluate(() => Reflect.get(window, 'entryRead').release());
    await expect(page.locator('#inline-source-scan')).toBeVisible();
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    const stopping = page.locator('#inline-scan-stop').click();
    await state.release();
    await stopping;
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
  } finally {
    await page.evaluate(() => Reflect.get(window, 'entryRead').release());
    await state.release();
  }
});
for (const kind of ['file', 'url'] as const) {
  test(`Settings custom ${kind} acquisition stays reviewed and unpublished until Save`, async ({
    page,
  }) => {
    await fixture(page);
    const body = '#EXTM3U\n#EXTINF:-1,Captured custom\nhttps://fixture.invalid/captured\n';
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('https://custom.fixture.invalid/index.m3u', async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'text/plain', body });
    });
    await page.route('https://fixture.invalid/captured', (route) =>
      route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: media }),
    );
    try {
      await openPlaylistImport(page);
      if (kind === 'file') {
        await page.evaluate(() => {
          const original = File.prototype.text;
          File.prototype.text = function () {
            const read = original.bind(this);
            return new Promise<string>((resolve) =>
              Reflect.set(window, 'releaseFileReview', async () => resolve(await read())),
            );
          };
        });
        await page.locator('#playlist-file').setInputFiles({
          name: 'captured.m3u',
          mimeType: 'text/plain',
          buffer: Buffer.from(body),
        });
      } else {
        await page.locator('#playlist-url').fill('https://custom.fixture.invalid/index.m3u');
        await page.locator('#load-button').click();
      }
      const review = page.getByRole('dialog', { name: 'Review source scan' });
      await expect(review).toBeVisible();
      expect(await savedCount(page)).toBe(0);
      if (kind === 'file') await page.evaluate(() => Reflect.get(window, 'releaseFileReview')());
      else release();
      await expect(review.getByText(/Captured custom/)).toBeVisible();
      expect(await savedCount(page)).toBe(0);
    } finally {
      release();
      if (kind === 'file') await page.evaluate(() => Reflect.get(window, 'releaseFileReview')?.());
    }
  });
}
test('Settings custom URL typing remains independent of online checkpoint admission', async ({
  page,
}) => {
  await fixture(page);
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill('https://custom.fixture.invalid/typed');
  await expect(page.locator('#playlist-url')).toBeFocused();
  await expect(page.locator('#playlist-url')).toHaveValue('https://custom.fixture.invalid/typed');
  await expect(page.locator('#automatic-scan-button')).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  expect(await savedCount(page)).toBe(0);
});

test('online search reenters the same scan while durable save confirmation is pending', async ({
  page,
}) => {
  // Delay the paired catalog/checkpoint publication ACK, not the new initial
  // checkpoint-only ACK that must finish before any response probe is admitted.
  await page.addInitScript(() => {
    const transactions = new WeakMap<
      IDBTransaction,
      { catalog: boolean; checkpoint: boolean; channels: number }
    >();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === 'catalog' || key === 'scanCheckpoint') {
        const records = transactions.get(this.transaction) ?? {
          catalog: false,
          checkpoint: false,
          channels: 0,
        };
        if (key === 'catalog') {
          records.catalog = true;
          records.channels = JSON.parse(value).channels.length;
        } else records.checkpoint = true;
        transactions.set(this.transaction, records);
      }
      return put.call(this, value, key);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    const state = { held: false, initialCompletions: 0, publicationChannels: 0, release: () => {} };
    Object.assign(window, { scanSaveConfirmation: state });
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback) {
        complete.set!.call(this, function (this: IDBTransaction, event: Event) {
          const records = transactions.get(this);
          if (records?.checkpoint && !records.catalog) state.initialCompletions++;
          if (!state.held && records?.catalog && records.checkpoint) {
            state.held = true;
            state.publicationChannels = records.channels;
            state.release = () => callback.call(this, event);
          } else callback.call(this, event);
        });
      },
    });
  });
  const state = await fixture(page);
  try {
    const dialog = await scan(page);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'scanSaveConfirmation').held), {
        timeout: 8000,
      })
      .toBe(true);
    expect(
      await page.evaluate(() => Reflect.get(window, 'scanSaveConfirmation').initialCompletions),
    ).toBe(1);
    expect(
      await page.evaluate(() => Reflect.get(window, 'scanSaveConfirmation').publicationChannels),
    ).toBe(16);
    await expect(page.locator('#playlist-file')).toBeDisabled();
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#search-programs')).toBeEnabled();
    await page.locator('#search-programs').click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    expect(state.sourceRequests).toEqual(providers);
    expect(await savedCount(page)).toBe(16);
    await page.evaluate(() => Reflect.get(window, 'scanSaveConfirmation').release());
    await expect.poll(() => state.requests.size).toBe(32);
    await page.locator('#inline-scan-stop').click();
    await state.release();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    expect(await savedCount(page)).toBe(16);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scanSaveConfirmation').release());
    await state.release();
  }
});
async function savedCount(page: Page) {
  const pair = await canonicalRecords(page);
  return pair[0] ? (JSON.parse(String(pair[0])) as { channels: unknown[] }).channels.length : 0;
}

test('a durable first batch is usable while checks continue, and same-page browsing retains the same scan owner', async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    const dialog = await scan(page);
    // A partial batch is deliberately coalesced for5s, then prepared and durably committed.
    await expect.poll(() => savedCount(page), { timeout: 8000 }).toBe(16);
    await expect.poll(() => state.requests.size).toBe(32);
    await expect(dialog.getByRole('status')).toContainText('checked');
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#channel-count')).toHaveText('16 channels');
    const channel = page
      .locator('.channel')
      .filter({ has: page.locator('strong', { hasText: /^Ready 00$/ }) });
    await channel.click();
    await expect(page.locator('#watch-title')).toHaveText('Ready 00');
    await scan(page);
    expect(state.sourceRequests).toEqual(providers);
    for (let index = 1; index < 16; index++) expect(state.requests.get(index)).toBe(1);
    expect(await savedCount(page)).toBe(16);
    await page.locator('#inline-scan-stop').click();
    await state.release();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    expect(await savedCount(page)).toBe(16);
  } finally {
    await state.release();
  }
});

test('Stop and cold restart offer Continue Scan, then explicit Rescan preserves unique channels', async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    const dialog = await scan(page);
    // A partial batch is deliberately coalesced for5s, then prepared and durably committed.
    await expect.poll(() => savedCount(page), { timeout: 8000 }).toBe(16);
    await expect.poll(() => state.requests.size).toBe(32);
    await page.locator('#inline-scan-stop').click();
    await state.release();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    expect(await savedCount(page)).toBe(16);
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const requestsBeforeEntry = state.requests.size;
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    expect(state.requests.size).toBe(requestsBeforeEntry);
    expect(state.sourceRequests).toEqual(providers);
    await scan(page);
    await expect(dialog.getByRole('status')).toHaveText('48 channels saved.');
    expect(state.sourceRequests).toEqual(providers);
    for (let index = 0; index < 48; index++)
      expect(state.requests.get(index)).toBe(index >= 16 && index < 32 ? 2 : 1);
    expect(await savedCount(page)).toBe(48);
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#inline-scan-rescan')).toBeVisible();
    await page.locator('#inline-scan-rescan').click();
    await expect.poll(() => state.sourceRequests.length).toBe(4);
    await expect(dialog.getByRole('status')).toHaveText('48 channels saved.');
    for (let index = 0; index < 48; index++)
      expect(state.requests.get(index)).toBe(index >= 16 && index < 32 ? 3 : 2);
    expect(await savedCount(page)).toBe(48);
    const canonical = await canonicalRecords(page);
    const saved = JSON.parse(canonical[0] as string);
    expect(new Set(saved.channels.map((channel: { id: string }) => channel.id)).size).toBe(48);
  } finally {
    await state.release();
  }
});
