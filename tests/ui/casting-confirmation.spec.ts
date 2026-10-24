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

import { expect, test, type Page } from '@playwright/test';

test('TV capability blocks opening and synthetic discovery/probe/start actions', async ({
  page,
}) => {
  await mount(page);
  // Opening the dialog searches for TVs once by itself.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'castFixture').discoveries))
    .toBe(1);
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'castFixture');
    (document.getElementById('cast-dialog') as HTMLDialogElement).close();
    fixture.available = false;
    document.getElementById('cast-button')!.click();
    document.getElementById('cast-discover')!.click();
    document
      .getElementById('cast-known-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.getElementById('cast-confirm')!.click();
  });
  await expect(page.locator('#cast-dialog')).not.toBeVisible();
  expect(
    await page.evaluate(() => {
      const fixture = Reflect.get(window, 'castFixture');
      return {
        probes: fixture.probes,
        discoveries: fixture.discoveries,
        starts: fixture.starts.length,
      };
    }),
  ).toEqual({ probes: 0, discoveries: 1, starts: 0 });
});

async function mount(page: Page, unverified = false) {
  await page.route('**/casting-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"><link rel="stylesheet" href="/src/ui/guide.css"><link rel="stylesheet" href="/src/ui/responsive.css"></head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/casting-fixture');
  await page.evaluate(async (unknown) => {
    const shellPath = '/src/ui/shell.ts';
    const castingPath = '/src/ui/casting.ts';
    const receiverPath = '/src/casting/confirmed-receiver.ts';
    const { createShell } = (await import(shellPath)) as typeof import('../../src/ui/shell');
    const { installCasting } = (await import(castingPath)) as typeof import('../../src/ui/casting');
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
    const devices: Device[] = [
      {
        id: 'receiver-a',
        name: 'Room TV',
        protocol: 'chromecast',
        ...(!unknown ? { protocolReceiverId: 'protocol-a', model: 'Fixture A' } : {}),
      },
      {
        id: 'receiver-b',
        name: 'Room TV',
        protocol: 'chromecast',
        protocolReceiverId: 'protocol-b',
        model: 'Fixture B',
      },
    ];
    const fixture = {
      starts: [] as Array<{ deviceId: string; handle: string; channel: Selection }>,
      validations: 0,
      holdAt: 0,
      pending: null as (() => void) | null,
      network: {
        generation: 1,
        scopeId: 'fixture-network',
        observation: 'interfaces-and-routes' as const,
      },
      channel: {
        id: 'channel-a',
        name: 'Channel A',
        url: 'https://fixture.invalid/a',
      } as Selection | null,
      probes: 0,
      available: true,
      discoveries: 0,
      stopCalls: 0,
      stopRefused: false,
      engineDisposeCalls: 0,
      holdDispose: false,
      resolveDispose: null as (() => void) | null,
      dispose: (() => Promise.resolve()) as () => Promise<void>,
    };
    const receivers = createConfirmedReceiver({
      readNetworkScope: async () => ({ ...fixture.network }),
      validateReceiver: async (device, network, acknowledge) => {
        fixture.validations++;
        if (fixture.holdAt === fixture.validations)
          await new Promise<void>((resolve) => {
            fixture.pending = resolve;
          });
        return {
          device,
          network,
          issuedHandle: device.protocolReceiverId || acknowledge ? 'issued-fixture-handle' : null,
          identityRecheck: device.protocolReceiverId ? 'matched' : 'unavailable',
          cryptographicallyAttested: false,
        };
      },
    });
    fixture.dispose = installCasting(
      () => fixture.channel,
      () => false,
      {
        available: () => fixture.available,
        receivers,
        warnings: async () => [],
        probe: async () => {
          fixture.probes++;
          return devices[0];
        },
        createAdapter: (authorize) => ({
          discover: async () => {
            fixture.discoveries++;
            return devices;
          },
          create: (device, sessionId, emit) => ({
            async start(channel, signal) {
              const handle = await authorize(device, signal);
              signal.throwIfAborted();
              fixture.starts.push({ deviceId: device.id, handle, channel: { ...channel } });
              emit({
                sessionId,
                selectionId: channel.id,
                state: 'playing',
                remoteSessionId: 'fixture-media',
              });
            },
            stop: async () => {
              fixture.stopCalls++;
              return { confirmed: !fixture.stopRefused };
            },
            dispose: async () => {
              fixture.engineDisposeCalls++;
              if (fixture.holdDispose)
                await new Promise<void>((resolve) => {
                  fixture.resolveDispose = resolve;
                });
            },
          }),
        }),
      },
    );
    Reflect.set(window, 'castFixture', fixture);
  }, unverified);
  await page.locator('#cast-button').click();
}

/** Opening lists the TVs by itself; choose the first one. */
async function selectFirst(page: Page) {
  await expect(page.locator('#cast-devices button')).toHaveCount(2);
  await page.locator('#cast-devices button').first().click();
}

async function starts(page: Page) {
  return page.evaluate(() => Reflect.get(window, 'castFixture').starts);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => Reflect.get(window, 'castFixture')?.dispose());
});

test('Cast, choose the TV, it plays: a verified TV needs no second step', async ({ page }) => {
  await mount(page);
  await selectFirst(page);
  await expect(page.locator('#cast-status')).toContainText('playing');
  await expect(page.locator('#cast-confirmation')).toBeHidden();
  await expect(page.locator('#cast-relay-http')).toHaveCount(0);
  expect(await starts(page)).toEqual([
    {
      deviceId: 'receiver-a',
      handle: 'issued-fixture-handle',
      channel: { id: 'channel-a', name: 'Channel A', url: 'https://fixture.invalid/a' },
    },
  ]);
});

test('identity unavailable requires deliberate uncertainty acknowledgment', async ({ page }) => {
  await mount(page, true);
  await selectFirst(page);
  await expect(page.locator('#cast-confirmation')).toBeVisible();
  await expect(page.locator('#cast-unverified')).toBeVisible();
  await expect(page.locator('#cast-confirm')).toBeDisabled();
  expect(await starts(page)).toEqual([]);
  await page.locator('#cast-unverified').check();
  await page.locator('#cast-confirm').click();
  await expect(page.locator('#cast-status')).toContainText('playing');
  expect(await starts(page)).toHaveLength(1);
});

test('connection method exposes one path and known-address probe does not cast', async ({
  page,
}) => {
  await mount(page);
  await page.locator('#cast-method').selectOption('venue');
  await expect(page.locator('#cast-venue-instructions')).toBeVisible();
  await expect(page.locator('#cast-discover')).toBeHidden();
  await expect(page.locator('#cast-known-form')).toBeHidden();
  await page.locator('#cast-method').selectOption('known');
  await expect(page.locator('#cast-venue-instructions')).toBeHidden();
  await expect(page.locator('#cast-known-form')).toBeVisible();
  await page.locator('#cast-known-address').fill('192.0.2.1');
  await page.locator('#cast-known-check').click();
  await expect(page.locator('#cast-devices button')).toHaveCount(1);
  expect(await starts(page)).toEqual([]);
  await expect(page.locator('#cast-confirmation')).toBeHidden();
});

for (const action of ['close', 'cancel'] as const) {
  test(`${action} during receiver inspection suppresses the late confirmation`, async ({
    page,
  }) => {
    await mount(page);
    await page.evaluate(() => {
      Reflect.get(window, 'castFixture').holdAt = 1;
    });
    await page.locator('#cast-discover').click();
    await page.locator('#cast-devices button').first().click();
    await expect
      .poll(() => page.evaluate(() => !!Reflect.get(window, 'castFixture').pending))
      .toBe(true);
    if (action === 'close') await page.getByRole('button', { name: 'Close casting' }).click();
    else await page.keyboard.press('Escape');
    await expect(page.locator('#cast-dialog')).not.toBeVisible();
    await page.evaluate(() => Reflect.get(window, 'castFixture').pending());
    await page.locator('#cast-button').click();
    await expect(page.locator('#cast-confirmation')).toBeHidden();
    expect(await starts(page)).toEqual([]);
  });
}

test('closing during final authorization prevents late media dispatch', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'castFixture').holdAt = 3;
  });
  await selectFirst(page);
  await expect
    .poll(() => page.evaluate(() => !!Reflect.get(window, 'castFixture').pending))
    .toBe(true);
  await page.getByRole('button', { name: 'Close casting' }).click();
  await page.evaluate(() => Reflect.get(window, 'castFixture').pending());
  await page.locator('#cast-button').click();
  await expect(page.locator('#cast-confirmation')).toBeHidden();
  expect(await starts(page)).toEqual([]);
});

test('choosing the TV captures its channel while a delayed check completes', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'castFixture').holdAt = 2;
  });
  await selectFirst(page);
  await expect
    .poll(() => page.evaluate(() => !!Reflect.get(window, 'castFixture').pending))
    .toBe(true);
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'castFixture');
    fixture.channel = { id: 'channel-b', name: 'Channel B', url: 'https://fixture.invalid/b' };
    fixture.pending();
  });
  await expect(page.locator('#cast-status')).toContainText('playing');
  expect((await starts(page))[0].channel.id).toBe('channel-a');
});

test('a network change while starting refuses and asks to choose the TV again', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'castFixture').holdAt = 2;
  });
  await selectFirst(page);
  await expect
    .poll(() => page.evaluate(() => !!Reflect.get(window, 'castFixture').pending))
    .toBe(true);
  await page.evaluate(() => {
    const fixture = Reflect.get(window, 'castFixture');
    fixture.network.generation = 2;
    fixture.pending();
  });
  await expect(page.locator('#cast-status')).toContainText('could not start');
  expect(await starts(page)).toEqual([]);
});

for (const size of [
  { width: 320, height: 640 },
  { width: 640, height: 360 },
]) {
  test(`unverified receiver confirmation ${size.width}x${size.height} 200% text retains reachable actions`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await mount(page, true);
    await selectFirst(page);
    await page.locator('#cast-dialog').evaluate((dialog) => {
      const snapshot = [dialog, ...dialog.querySelectorAll<HTMLElement>('*')].map((element) => ({
        element: element as HTMLElement,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
      }));
      for (const { element, font } of snapshot) element.style.fontSize = `${font * 2}px`;
    });
    const dialog = page.locator('#cast-dialog');
    const close = page.getByRole('button', { name: 'Close casting' });
    await expect(close).toBeVisible();
    const header = await close.boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(0);
    expect(header!.y + header!.height).toBeLessThanOrEqual(size.height);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    const outsideScroll = await dialog.evaluate(
      (element) =>
        element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1,
    );
    expect(outsideScroll).toBe(false);
    await page.locator('#cast-unverified').check();
    const confirm = page.locator('#cast-confirm');
    await confirm.scrollIntoViewIfNeeded();
    const clipped = await confirm.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const button = element.getBoundingClientRect();
      return (
        text.left < button.left - 1 ||
        text.right > button.right + 1 ||
        text.top < button.top - 1 ||
        text.bottom > button.bottom + 1
      );
    });
    expect(clipped).toBe(false);
    await confirm.click();
    await expect.poll(async () => (await starts(page)).length).toBe(1);
    await close.click();
    await expect(dialog).not.toBeVisible();
  });
}

test('close cleanup awaits remote ownership and retries refusal without admitting new UI work', async ({
  page,
}) => {
  await mount(page);
  await selectFirst(page);
  await expect.poll(async () => (await starts(page)).length).toBe(1);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'castFixture');
    f.stopRefused = true;
    f.failed = false;
    f.dispose().catch(() => {
      f.failed = true;
    });
  });
  await page.waitForFunction(() => Reflect.get(window, 'castFixture').failed);
  expect(await page.locator('#cast-method').count()).toBe(0);
  await page.locator('#cast-discover').click();
  expect(await starts(page)).toHaveLength(1);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'castFixture');
    f.stopRefused = false;
    f.holdDispose = true;
    f.finished = false;
    const work = f.dispose();
    f.samePromise = work === f.dispose();
    void work.then(() => {
      f.finished = true;
    });
  });
  await page.waitForFunction(
    () => typeof Reflect.get(window, 'castFixture').resolveDispose === 'function',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'castFixture').finished)).toBe(false);
  expect(await page.evaluate(() => Reflect.get(window, 'castFixture').samePromise)).toBe(true);
  await page.evaluate(() => Reflect.get(window, 'castFixture').resolveDispose());
  await page.waitForFunction(() => Reflect.get(window, 'castFixture').finished);
  expect(await page.evaluate(() => Reflect.get(window, 'castFixture').engineDisposeCalls)).toBe(1);
  expect(await starts(page)).toHaveLength(1);
});
