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

// Owner requests, October 24, 2026: several TVs at once, each its own channel;
// watching something else here meanwhile; cast channels pinned above the
// channel list with their TVs' names; and TVs that end the cast on their side.
// The adapter is a controlled engine in the page, not a TV.
import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.route('**/casting-multi-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"><link rel="stylesheet" href="/src/ui/responsive.css"><link rel="stylesheet" href="/src/ui/dialog-polish.css"></head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/casting-multi-fixture');
  await page.evaluate(async () => {
    const shellPath = '/src/ui/shell/shell.ts';
    const castingPath = '/src/ui/player/casting.ts';
    const pinsPath = '/src/ui/channels/cast-pins.ts';
    const receiverPath = '/src/casting/confirmed-receiver.ts';
    const { createShell } = (await import(shellPath)) as typeof import('../../src/ui/shell/shell');
    const { installCasting } = (await import(
      castingPath
    )) as typeof import('../../src/ui/player/casting');
    const { mountCastPins } = (await import(
      pinsPath
    )) as typeof import('../../src/ui/channels/cast-pins');
    const { createConfirmedReceiver } = (await import(
      receiverPath
    )) as typeof import('../../src/casting/confirmed-receiver');
    createShell(document.getElementById('app')!);
    document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((button) => {
      button.addEventListener('click', () => {
        (document.getElementById(button.dataset.close!) as HTMLDialogElement).close();
      });
    });
    type Device = import('../../src/casting/receiver-confirmation').ReceiverDetails;
    type Selection = import('../../src/playback/controller').ChannelSelection;
    type Event = import('../../src/casting/controller').CastEvent;
    const tv = (id: string, name: string): Device => ({
      id: `roster-${id}`,
      name,
      protocol: 'chromecast',
      protocolReceiverId: `identity-${id}`,
      model: 'Google TV',
    });
    const fixture = {
      devices: [tv('living', 'Living room'), tv('bedroom', 'Bedroom'), tv('kitchen', 'Kitchen')],
      channel: {
        id: 'news',
        name: 'News',
        url: 'https://fixture.invalid/news',
      } as Selection | null,
      available: true,
      starts: [] as Array<{ tv: string; channel: string }>,
      stops: [] as string[],
      watched: [] as string[],
      /** The latest session on each TV, to play the TV's side of the cast. */
      sessions: {} as Record<
        string,
        { sessionId: string; channel: string; emit: (e: Event) => void }
      >,
      dispose: (() => Promise.resolve()) as () => Promise<void>,
      tvEnds(name: string, reason: 'receiver' | 'unreachable') {
        const owned = fixture.sessions[name]!;
        owned.emit({
          sessionId: owned.sessionId,
          selectionId: owned.channel,
          state: 'ended',
          reason,
        });
      },
    };
    const receivers = createConfirmedReceiver({
      readNetworkScope: async () => ({
        generation: 1,
        scopeId: 'fixture-network',
        observation: 'interfaces-and-routes',
      }),
      validateReceiver: async (device, network) => ({
        device,
        network,
        issuedHandle: `handle-${device.id}`,
        identityRecheck: 'matched',
        cryptographicallyAttested: false,
      }),
    });
    const pins = mountCastPins(document.getElementById('channel-list')!, (selection) =>
      fixture.watched.push(selection.id),
    );
    const removeCasting = installCasting(
      () => fixture.channel,
      () => false,
      {
        available: () => fixture.available,
        receivers,
        warnings: async () => [],
        castsChanged: (casts) => pins.update(casts),
        createAdapter: (authorize) => ({
          discover: async () => fixture.devices.map((device) => ({ ...device })),
          create: (device, sessionId, emit) => ({
            async start(channel, signal) {
              await authorize(device, signal);
              signal.throwIfAborted();
              fixture.starts.push({ tv: device.name, channel: channel.id });
              fixture.sessions[device.name] = { sessionId, channel: channel.id, emit };
              emit({
                sessionId,
                selectionId: channel.id,
                state: 'playing',
                remoteSessionId: 'media',
              });
            },
            stop: async () => {
              fixture.stops.push(device.name);
              return { confirmed: true };
            },
            dispose: async () => undefined,
          }),
        }),
      },
    );
    fixture.dispose = async () => {
      pins.dispose();
      await removeCasting();
    };
    Reflect.set(window, 'castFixture', fixture);
  });
  await page.locator('#cast-button').click();
  await expect(page.locator('#cast-devices .cast-device')).toHaveCount(3);
}

const row = (page: Page, name: string) =>
  page.locator('#cast-devices .cast-device-row').filter({ hasText: name });
const fixture = <T>(page: Page, read: (f: Record<string, unknown>) => T) =>
  page.evaluate(read, undefined as never);
async function cast(page: Page, tv: string, channel: { id: string; name: string }) {
  await page.evaluate((selected) => {
    Reflect.get(window, 'castFixture').channel = {
      ...selected,
      url: `https://fixture.invalid/${selected.id}`,
    };
  }, channel);
  await row(page, tv).locator('.cast-device').click();
  await expect(row(page, tv).locator('.cast-device-channel')).toHaveText(` · ${channel.name}`);
}
const starts = (page: Page) =>
  page.evaluate(
    () => Reflect.get(window, 'castFixture').starts as Array<{ tv: string; channel: string }>,
  );
const stops = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'castFixture').stops as string[]);
const pinTexts = (page: Page) =>
  page
    .locator('#cast-pins .cast-pin')
    .evaluateAll((pins) =>
      pins.map((pin) => [
        pin.querySelector('.cast-pin-tv')!.textContent,
        pin.querySelector('.cast-pin-name')!.textContent,
      ]),
    );

test.afterEach(async ({ page }) => {
  await page.evaluate(() => Reflect.get(window, 'castFixture')?.dispose());
});

test('several TVs at once, each its own channel, and Stop on one leaves the others', async ({
  page,
}) => {
  await mount(page);
  await cast(page, 'Living room', { id: 'news', name: 'News' });
  await cast(page, 'Bedroom', { id: 'sports', name: 'Sports' });
  expect(await starts(page)).toEqual([
    { tv: 'Living room', channel: 'news' },
    { tv: 'Bedroom', channel: 'sports' },
  ]);
  expect(await stops(page)).toEqual([]);
  for (const [tv, channel] of [
    ['Living room', ' · News'],
    ['Bedroom', ' · Sports'],
  ]) {
    await expect(row(page, tv).locator('.cast-device')).toHaveAttribute('aria-current', 'true');
    await expect(row(page, tv).locator('.cast-device-badge')).toHaveText('Casting');
    await expect(row(page, tv).locator('.cast-device-channel')).toHaveText(channel);
    await expect(row(page, tv).locator('.cast-device-stop')).toBeVisible();
  }
  await expect(row(page, 'Kitchen').locator('.cast-device')).toHaveAttribute(
    'aria-current',
    'false',
  );
  await expect(row(page, 'Kitchen').locator('.cast-device-stop')).toBeHidden();
  await expect(page.locator('#cast-status')).toContainText('Casting to 2 TVs');
  // Choosing a TV that is casting replaces only that TV's cast.
  await cast(page, 'Living room', { id: 'movies', name: 'Movies' });
  expect(await stops(page)).toEqual(['Living room']);
  await expect(row(page, 'Bedroom').locator('.cast-device-channel')).toHaveText(' · Sports');
  await row(page, 'Bedroom').getByRole('button', { name: 'Stop casting to Bedroom' }).click();
  await expect(row(page, 'Bedroom').locator('.cast-device-stop')).toBeHidden();
  await expect(row(page, 'Living room').locator('.cast-device-channel')).toHaveText(' · Movies');
  expect(await stops(page)).toEqual(['Living room', 'Bedroom']);
  await expect(page.locator('#cast-status')).toHaveText('Casting to Living room: Movies.');
  // The panel's Stop casting stops every TV.
  await cast(page, 'Kitchen', { id: 'news', name: 'News' });
  await page.locator('#cast-stop').click();
  await expect(page.locator('#cast-devices [aria-current="true"]')).toHaveCount(0);
  expect((await stops(page)).slice(2).sort()).toEqual(['Kitchen', 'Living room']);
  await expect(page.locator('#cast-stop')).toBeDisabled();
});

test('watching something else here never changes what the TVs play', async ({ page }) => {
  await mount(page);
  await cast(page, 'Living room', { id: 'news', name: 'News' });
  // The viewer changes channel here, then watches Paid TV (not castable).
  await page.evaluate(() => {
    const f = Reflect.get(window, 'castFixture');
    f.channel = { id: 'cartoons', name: 'Cartoons', url: 'https://fixture.invalid/cartoons' };
  });
  await page.getByRole('button', { name: 'Close casting' }).click();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'castFixture');
    f.channel = null;
    f.available = false;
  });
  expect(await stops(page)).toEqual([]);
  // Cast still opens, to show and stop the TVs; the TV keeps its channel.
  await page.locator('#cast-button').click();
  await expect(page.locator('#cast-dialog')).toBeVisible();
  const active = page.locator('#cast-active .cast-device-row');
  await expect(active).toHaveCount(1);
  await expect(active.locator('.cast-device')).toContainText('Living room');
  await expect(active.locator('.cast-device-channel')).toHaveText(' · News');
  await active.getByRole('button', { name: 'Stop casting to Living room' }).click();
  await expect(active).toHaveCount(0);
  expect(await stops(page)).toEqual(['Living room']);
});

test('cast channels are pinned above the channel list with their TVs, and unpinned when done', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('#cast-pins')).toBeHidden();
  await cast(page, 'Living room', { id: 'news', name: 'News' });
  await cast(page, 'Bedroom', { id: 'sports', name: 'Sports' });
  await cast(page, 'Kitchen', { id: 'news', name: 'News' });
  await expect(page.locator('#cast-pins')).toBeVisible();
  expect(await pinTexts(page)).toEqual([
    ['On Living room, Kitchen', 'News'],
    ['On Bedroom', 'Sports'],
  ]);
  // The strip sits right above the list, so it tops every view of it:
  // all channels, search results, categories, favorites and Paid TV.
  expect(
    await page.evaluate(() => document.getElementById('cast-pins')!.nextElementSibling?.id),
  ).toBe('channel-list');
  await page.getByRole('button', { name: 'Close casting' }).click();
  // The bare fixture page lays the footer over the list; a dispatched click reaches the pin.
  await page.getByRole('button', { name: 'Sports, casting on Bedroom' }).dispatchEvent('click');
  expect(await fixture(page, () => Reflect.get(window, 'castFixture').watched)).toEqual(['sports']);
  await page.locator('#cast-button').click();
  await row(page, 'Bedroom').getByRole('button', { name: 'Stop casting to Bedroom' }).click();
  await expect.poll(() => pinTexts(page)).toEqual([['On Living room, Kitchen', 'News']]);
  await row(page, 'Kitchen').getByRole('button', { name: 'Stop casting to Kitchen' }).click();
  await expect.poll(() => pinTexts(page)).toEqual([['On Living room', 'News']]);
  await page.locator('#cast-stop').click();
  await expect(page.locator('#cast-pins')).toBeHidden();
});

for (const [reason, message] of [
  ['receiver', 'Bedroom stopped casting.'],
  ['unreachable', 'Bedroom stopped answering, so its cast ended.'],
] as const) {
  test(`a TV that ends the cast on its side (${reason}) is released, unpinned and castable again`, async ({
    page,
  }) => {
    await mount(page);
    await cast(page, 'Living room', { id: 'news', name: 'News' });
    await cast(page, 'Bedroom', { id: 'sports', name: 'Sports' });
    // Back or Home on the Bedroom TV, or the TV turned off or gone.
    await page.evaluate((why) => Reflect.get(window, 'castFixture').tvEnds('Bedroom', why), reason);
    await expect(row(page, 'Bedroom').locator('.cast-device')).toHaveAttribute(
      'aria-current',
      'false',
    );
    await expect(row(page, 'Bedroom').locator('.cast-device-stop')).toBeHidden();
    await expect(page.locator('#cast-status')).toHaveText(message);
    await expect.poll(() => pinTexts(page)).toEqual([['On Living room', 'News']]);
    // GenX asked the TV to let go of its session; the other TV plays on.
    expect(await stops(page)).toEqual(['Bedroom']);
    await expect(row(page, 'Living room').locator('.cast-device-channel')).toHaveText(' · News');
    // A late status from the ended session changes nothing.
    await page.evaluate(() => {
      const owned = Reflect.get(window, 'castFixture').sessions['Bedroom'];
      owned.emit({
        sessionId: owned.sessionId,
        selectionId: owned.channel,
        state: 'playing',
        remoteSessionId: 'late',
      });
    });
    await expect(row(page, 'Bedroom').locator('.cast-device')).toHaveAttribute(
      'aria-current',
      'false',
    );
    // One tap casts to it again.
    await cast(page, 'Bedroom', { id: 'movies', name: 'Movies' });
    await expect
      .poll(() => pinTexts(page))
      .toEqual([
        ['On Living room', 'News'],
        ['On Bedroom', 'Movies'],
      ]);
  });
}
