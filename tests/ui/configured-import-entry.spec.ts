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

// Real Import shell/CSS/owner with deferred read-only capability. No native/scan/decoder claim.
async function mount(page: Page) {
  await page.route('**/configured-import-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>',
    }),
  );
  await page.goto('/configured-import-fixture');
  await page.evaluate(async () => {
    for (const sheet of ['style', 'management', 'responsive', 'modal-viewport', 'tv-density']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/src/ui/${sheet}.css`;
      document.head.append(link);
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = reject;
      });
    }
    const shellPath = '/src/ui/shell/shell.ts',
      ownerPath = '/src/ui/scan/import-entry.ts';
    const { createShell } = await import(shellPath);
    const { installConfiguredImportEntry } = await import(ownerPath);
    createShell(document.querySelector('#app')!);
    document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
    for (const node of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
      node.addEventListener('click', () =>
        document.querySelector<HTMLDialogElement>(`#${node.dataset.close}`)!.close(),
      );
    let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
    const capability = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const state = {
      generation: 0,
      allowed: true,
      configured: true,
      throws: false,
      calls: 0,
      starts: 0,
      startThrows: false,
      failures: [] as string[],
      owned: 0,
    };
    const jobs = new Set<Promise<void>>();
    const owner = installConfiguredImportEntry({
      root: document,
      allowed: () => state.allowed,
      foreground: () => state.generation,
      configured: () => {
        if (state.throws) throw new Error('invalid source scope');
        return state.configured;
      },
      capability: () => {
        state.calls++;
        return capability;
      },
      own: (work: Promise<void>) => {
        state.owned++;
        jobs.add(work);
        void work.then(
          () => jobs.delete(work),
          () => jobs.delete(work),
        );
        return work;
      },
      run: (work: Promise<void>) => {
        void work.catch((error: unknown) =>
          state.failures.push(error instanceof Error ? error.message : 'unknown'),
        );
      },
      refreshFiles: () => {},
      start: () => {
        if (state.startThrows) throw new Error('controlled synchronous scan refusal');
        state.starts++;
      },
    });
    const navigationPath = '/src/ui/shell/remote-navigation.ts';
    const { installRemoteNavigation, createRemoteEditMode } = await import(navigationPath);
    const removeNavigation = installRemoteNavigation({ editMode: createRemoteEditMode() });
    Reflect.set(window, 'importFixture', { state, owner, jobs, resolve, reject, removeNavigation });
    document.querySelector<HTMLDialogElement>('#settings-dialog')!.showModal();
  });
}
const state = (page: Page) =>
  page.evaluate(() => ({
    ...Reflect.get(window, 'importFixture').state,
    jobs: Reflect.get(window, 'importFixture').jobs.size,
  }));
const release = (page: Page, supported = true) =>
  page.evaluate((value) => Reflect.get(window, 'importFixture').resolve(value), supported);
async function closeImport(page: Page) {
  await page.evaluate(() => {
    Reflect.set(
      window,
      'importClosed',
      new Promise<void>((resolve) => {
        document
          .querySelector('#import-dialog')!
          .addEventListener('close', () => resolve(), { once: true });
      }),
    );
  });
  await page.locator('[data-close="import-dialog"]').click();
  await page.evaluate(() => Reflect.get(window, 'importClosed'));
}
async function open(page: Page) {
  await page.locator('#import-button').click();
  await expect(page.locator('#import-dialog')).toBeVisible();
}

test('manual Import opens immediately; a single retained capability only exposes the explicit configured action', async ({
  page,
}) => {
  await mount(page);
  await open(page);
  await expect(page.locator('#automatic-scan-button')).toBeHidden();
  await expect(page.locator('#playlist-url')).toBeVisible();
  await expect.poll(async () => (await state(page)).jobs).toBe(1);
  await page.locator('#import-button').evaluate((node: HTMLButtonElement) => node.click());
  expect(await state(page)).toMatchObject({ calls: 1, owned: 1, starts: 0 });
  await release(page);
  await expect(page.locator('#automatic-scan-button')).toHaveText('Scan configured sources');
  await expect(page.locator('#automatic-scan-button')).toBeVisible();
  expect((await state(page)).starts).toBe(0);
  await page.locator('#automatic-scan-button').click();
  expect((await state(page)).starts).toBe(1);
  await expect(page.locator('#import-dialog')).toBeHidden();
});

test('typing or focusing the manual URL during a held capability never collapses, retargets or inserts an action above it', async ({
  page,
}) => {
  await mount(page);
  await open(page);
  await page.locator('#playlist-url').fill('https://manual.fixture.invalid/source.m3u');
  await release(page);
  await expect.poll(async () => (await state(page)).jobs).toBe(0);
  await expect(page.locator('#playlist-url')).toHaveValue(
    'https://manual.fixture.invalid/source.m3u',
  );
  await expect(page.locator('#playlist-url')).toBeFocused();
  await expect(page.locator('#custom-source-options')).toHaveAttribute('open', '');
  await expect(page.locator('#automatic-scan-button')).toBeHidden();
  expect((await state(page)).starts).toBe(0);
});

for (const reason of ['unsupported', 'failure', 'empty', 'invalid'] as const) {
  test(`capability/source ${reason} retains usable manual controls without scan admission`, async ({
    page,
  }) => {
    await mount(page);
    await open(page);
    await page.evaluate((mode) => {
      const f = Reflect.get(window, 'importFixture');
      if (mode === 'empty') f.state.configured = false;
      if (mode === 'invalid') f.state.throws = true;
      if (mode === 'failure') f.reject(new Error('private adapter detail'));
      else f.resolve(mode !== 'unsupported');
    }, reason);
    await expect.poll(async () => (await state(page)).jobs).toBe(0);
    await expect(page.locator('#automatic-scan-button')).toBeHidden();
    await page.locator('#playlist-url').fill('https://manual.fixture.invalid/retained.m3u');
    await expect(page.locator('#load-button')).toBeEnabled();
    await expect(page.locator('#playlist-file')).toBeVisible();
    expect((await state(page)).starts).toBe(0);
    await expect(page.locator('#import-dialog')).not.toContainText('private adapter detail');
  });
}

for (const reason of [
  'close',
  'cancel',
  'background-cycle',
  'document-cycle',
  'admission',
  'dispose',
] as const) {
  test(`held result after ${reason} cannot revive or authorize the prior intent`, async ({
    page,
  }) => {
    await mount(page);
    await open(page);
    await page.evaluate((mode) => {
      const f = Reflect.get(window, 'importFixture');
      const dialog = document.querySelector<HTMLDialogElement>('#import-dialog')!;
      if (mode === 'close') dialog.close();
      if (mode === 'cancel') dialog.dispatchEvent(new Event('cancel'));
      if (mode === 'background-cycle') {
        window.dispatchEvent(new Event('native-app-background'));
        f.state.generation++; // Main's validated foreground owner, now foreground again.
      }
      if (mode === 'document-cycle') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      }
      if (mode === 'admission') f.state.allowed = false;
      if (mode === 'dispose') Reflect.set(window, 'disposedImport', f.owner.dispose());
    }, reason);
    expect((await state(page)).jobs).toBe(1); // Close/dispose cannot pretend the held read has joined.
    await release(page);
    await expect.poll(async () => (await state(page)).jobs).toBe(0);
    await expect(page.locator('#automatic-scan-button')).toBeHidden();
    await page
      .locator('#automatic-scan-button')
      .evaluate((node: HTMLButtonElement) => node.click());
    expect((await state(page)).starts).toBe(0);
    if (reason === 'close') await expect(page.locator('#import-dialog')).toBeHidden();
    if (reason === 'dispose') await page.evaluate(() => Reflect.get(window, 'disposedImport'));
  });
}

test('fresh explicit close/reopen owns the still-held read once; foreground generation mismatch refuses even after guard clears', async ({
  page,
}) => {
  await mount(page);
  await open(page);
  await closeImport(page);
  await expect(page.locator('#import-dialog')).toBeHidden();
  await page.evaluate(() =>
    document.querySelector<HTMLDialogElement>('#settings-dialog')!.showModal(),
  );
  await open(page);
  expect(await state(page)).toMatchObject({ calls: 1, owned: 1 });
  await page.evaluate(() => {
    Reflect.get(window, 'importFixture').state.generation++;
  });
  await release(page);
  await expect.poll(async () => (await state(page)).jobs).toBe(0);
  await expect(page.locator('#automatic-scan-button')).toBeHidden();
});

for (const viewport of [
  { width: 960, height: 540 },
  { width: 320, height: 640 },
]) {
  test(`expanded Import remains scrollable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mount(page);
    await open(page);
    await release(page);
    await expect(page.locator('#automatic-scan-button')).toBeVisible();
    await page.locator('#import-dialog').evaluate((root) => {
      const sizes = [root, ...root.querySelectorAll<HTMLElement>('*')].map((node) => ({
        node,
        size: parseFloat(getComputedStyle(node).fontSize),
      }));
      for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
    });
    // The actual shell moves a fixed close header outside the existing .dialog-body scrollport.
    for (const selector of ['#playlist-url', '#allow-http', '#load-button', '#playlist-file']) {
      await page.locator(selector).focus();
      const visible = await page.locator(selector).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const port = node.closest('.dialog-body')!.getBoundingClientRect();
        return (
          rect.top >= port.top - 1 &&
          rect.bottom <= port.bottom + 1 &&
          rect.left >= port.left - 1 &&
          rect.right <= port.right + 1
        );
      });
      expect(visible).toBe(true);
    }
    await expect(page.locator('[data-close="import-dialog"]')).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    await page.locator('[data-close="import-dialog"]').click();
    await expect(page.locator('#import-dialog')).toBeHidden();
  });
}

test('TV directional navigation reaches the expanded manual form through the contained scrollport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page);
  await open(page);
  await release(page);
  await expect(page.locator('#automatic-scan-button')).toBeVisible();
  await expect(page.locator('[data-close="import-dialog"]')).toBeFocused();
  const visited = new Set<string>();
  for (let press = 0; press < 20; press++) {
    await page.keyboard.press('ArrowDown');
    const current = await page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      const rect = node.getBoundingClientRect();
      const port = node.closest('.dialog-body')?.getBoundingClientRect();
      return {
        id: node.id,
        visible: port ? rect.top >= port.top - 1 && rect.bottom <= port.bottom + 1 : true,
      };
    });
    expect(current.visible).toBe(true);
    visited.add(current.id);
    if (current.id === 'playlist-file') break;
  }
  for (const id of [
    'automatic-scan-button',
    'playlist-url',
    'allow-http',
    'load-button',
    'playlist-file',
  ])
    expect([...visited], `Directional route did not reach ${id}`).toContain(id);
  expect((await state(page)).starts).toBe(0);
});

test('a new explicit reopen may adopt the one still-pending read, while the closed intent stays revoked', async ({
  page,
}) => {
  await mount(page);
  await open(page);
  await page.locator('#playlist-url').fill('https://old-manual.fixture.invalid/old.m3u');
  await closeImport(page);
  await expect(page.locator('#import-dialog')).toBeHidden();
  await page.evaluate(() =>
    document.querySelector<HTMLDialogElement>('#settings-dialog')!.showModal(),
  );
  await open(page);
  await release(page);
  await expect(page.locator('#automatic-scan-button')).toBeVisible();
  expect(await state(page)).toMatchObject({ calls: 1, owned: 1, starts: 0 });
  await page.locator('#automatic-scan-button').click();
  expect((await state(page)).starts).toBe(1);
});

for (const reason of ['admission', 'sources', 'foreground'] as const) {
  test(`configured action rechecks ${reason} immediately before explicit scan admission`, async ({
    page,
  }) => {
    await mount(page);
    await open(page);
    await release(page);
    await expect(page.locator('#automatic-scan-button')).toBeVisible();
    await page.evaluate((mode) => {
      const state = Reflect.get(window, 'importFixture').state;
      if (mode === 'admission') state.allowed = false;
      if (mode === 'sources') state.configured = false;
      if (mode === 'foreground') state.generation++;
    }, reason);
    await page.locator('#automatic-scan-button').click();
    expect((await state(page)).starts).toBe(0);
    await expect(page.locator('#automatic-scan-button')).toBeHidden();
  });
}

test('synchronous SourceScan admission refusal is retained and observed by the normal run boundary', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mount(page);
  await open(page);
  await release(page);
  await expect(page.locator('#automatic-scan-button')).toBeVisible();
  await page.evaluate(() => {
    Reflect.get(window, 'importFixture').state.startThrows = true;
  });
  await page.locator('#automatic-scan-button').click();
  await expect
    .poll(async () => (await state(page)).failures)
    .toEqual(['controlled synchronous scan refusal']);
  await expect.poll(async () => (await state(page)).jobs).toBe(0);
  expect((await state(page)).starts).toBe(0);
  expect(errors).toEqual([]);
});

test('queued explicit action is revoked before execution and disposal joins its retained admission work', async ({
  page,
}) => {
  await mount(page);
  await open(page);
  await release(page);
  await expect(page.locator('#automatic-scan-button')).toBeVisible();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'importFixture');
    document.querySelector<HTMLButtonElement>('#automatic-scan-button')!.click();
    f.state.allowed = false;
    Reflect.set(window, 'disposedImport', f.owner.dispose());
  });
  await page.evaluate(() => Reflect.get(window, 'disposedImport'));
  expect(await state(page)).toMatchObject({ starts: 0, jobs: 0 });
});
