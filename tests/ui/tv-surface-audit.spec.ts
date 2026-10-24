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

/** Actual UI/CSS with controlled capability metadata. No decoder/native/network claims. */
async function mount(page: Page): Promise<void> {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.route('**/tv-surface-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/tv-surface-fixture');
  await page.evaluate(async () => {
    for (const sheet of [
      'style',
      'management',
      'guide',
      'responsive',
      'in-app-select',
      'modal-viewport',
      'genxtra',
      'media-results',
      'fullscreen',
      'video-quality',
      'tv-density',
    ]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/src/ui/${sheet}.css`;
      document.head.append(link);
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(sheet));
      });
    }
    const shellPath = '/src/ui/shell/shell.ts',
      viewportPath = '/src/ui/shell/viewport.ts';
    const { createShell } = await import(shellPath);
    const { installViewport } = await import(viewportPath);
    const app = document.querySelector<HTMLElement>('#app')!;
    createShell(app);
    app.dataset.deviceKind = 'tv';
    app.dataset.compactView = 'watch';
    app.dataset.contentLibrary = 'live';
    app.style.setProperty('--sidebar', '360px');
    Reflect.set(window, 'auditViewport', installViewport(app));
    document.querySelector<HTMLElement>('#player-overlay')!.hidden = true;
    document.querySelector<HTMLElement>('#playback-status')!.textContent = 'Playing';
    for (const id of ['pause-button', 'captions-button', 'favorite-button', 'remove-channel'])
      document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = false;
    await document.fonts.ready;
  });
}

async function geometry(page: Page, selector: string) {
  return page.locator(selector).evaluate((owner) => {
    const box = owner.getBoundingClientRect();
    const visible = [...owner.querySelectorAll<HTMLElement>('button,input,select,summary')].filter(
      (node) =>
        !node.closest('[hidden],[inert]') &&
        node.getClientRects().length &&
        getComputedStyle(node).visibility !== 'hidden',
    );
    return {
      width: box.width,
      height: box.height,
      x: box.x,
      y: box.y,
      overflowX: owner.scrollWidth > owner.clientWidth + 1,
      controls: visible.map((node) => {
        const r = node.getBoundingClientRect();
        return {
          label: node.getAttribute('aria-label') || node.textContent,
          width: r.width,
          height: r.height,
          x: r.x,
          y: r.y,
        };
      }),
    };
  });
}

async function focusedVisible(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      const r = node.getBoundingClientRect(),
        hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return (
        r.x >= -1 &&
        r.y >= -1 &&
        r.right <= innerWidth + 1 &&
        r.bottom <= innerHeight + 1 &&
        node.contains(hit)
      );
    }),
  ).toBe(true);
}

async function focusedMenuVisible(page: Page): Promise<void> {
  await focusedVisible(page);
  expect(
    await page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      const menu = node.closest('.video-quality-menu')!;
      const box = node.getBoundingClientRect(),
        owner = menu.getBoundingClientRect(),
        style = getComputedStyle(node);
      const ring = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      return (
        box.top - ring >= owner.top &&
        box.bottom + ring <= owner.bottom &&
        box.left - ring >= owner.left &&
        box.right + ring <= owner.right
      );
    }),
  ).toBe(true);
}

test('quality and bounded provider audio menus remain inside the TV viewport and scroll all options', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    const qualityPath = '/src/ui/player/video-quality.ts',
      audioPath = '/src/ui/player/audio-tracks.ts',
      tracksPath = '/src/platform/browser-audio-tracks.ts',
      ownersPath = '/src/playback/resource-owners.ts';
    const { installVideoQuality } = await import(qualityPath),
      { installAudioTracks } = await import(audioPath);
    const { createBrowserAudioTracks } = await import(tracksPath),
      { createResourceOwners } = await import(ownersPath);
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const tracks = Object.assign(new EventTarget(), { length: 32 });
    for (let i = 0; i < 32; i++)
      Reflect.set(tracks, i, {
        enabled: i === 0,
        label: i === 0 ? '長'.repeat(80) : 'A'.repeat(256),
        language: i === 0 ? 'en' : 'English '.repeat(32),
        description: 'Provider supplied description '.repeat(8).slice(0, 256),
      });
    Object.defineProperty(video, 'audioTracks', { value: tracks, configurable: true });
    const owner = createBrowserAudioTracks(video, {
      current: () => true,
      canSelect: () => true,
      emit: () => {},
      owners: createResourceOwners(),
    });
    owner.activate();
    owner.attachNative();
    Reflect.set(window, 'auditAudioOwner', owner);
    Reflect.set(
      window,
      'auditAudioDispose',
      installAudioTracks(video, document.querySelector('#audio-tracks')!),
    );
    Reflect.set(
      window,
      'auditQualityDispose',
      installVideoQuality(video, document.querySelector('#video-quality')!, {
        read: () => ({
          auto: true,
          currentLevel: 0,
          availableLevels: Array.from({ length: 20 }, (_, index) => ({
            index,
            height: 2160 + index,
            bitrate: 99999999999,
          })),
          levelsTruncated: false,
        }),
        set: () => true,
      }),
    );
  });
  await page.getByRole('button', { name: 'Video quality', exact: true }).click();
  const quality = page.getByRole('menu', { name: 'Available video quality' });
  await expect(quality).toBeVisible();
  await page.keyboard.press('End');
  await focusedMenuVisible(page);
  const qualityGeometry = await geometry(page, '[aria-label="Available video quality"]');
  expect(qualityGeometry.overflowX).toBe(false);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Audio track', exact: true }).click();
  const audio = page.getByRole('menu', { name: 'Available audio tracks' });
  await expect(audio).toBeVisible();
  await page.keyboard.press('End');
  const audioGeometry = await geometry(page, '[aria-label="Available audio tracks"]');
  await info.attach('menus-geometry', {
    body: JSON.stringify({ qualityGeometry, audioGeometry }),
    contentType: 'application/json',
  });
  await info.attach('audio-menu', { body: await page.screenshot(), contentType: 'image/png' });
  await focusedMenuVisible(page);
  expect(audioGeometry.overflowX).toBe(false);
  expect(audioGeometry.controls.every((control) => control.height <= 100)).toBe(true);
  expect(
    await audio
      .locator('button')
      .last()
      .evaluate((node) => ({ text: node.textContent, title: (node as HTMLElement).title })),
  ).toMatchObject({ text: expect.any(String), title: expect.any(String) });
  expect(
    await audio
      .locator('button')
      .last()
      .evaluate((node) => node.textContent === (node as HTMLElement).title),
  ).toBe(true);
  await page.keyboard.press('ArrowUp');
  await focusedMenuVisible(page);
  await page.keyboard.press('ArrowDown');
  await focusedMenuVisible(page);
  await page.keyboard.press('Escape');
});

test('fullscreen live dock retains visible nonoverlapping controls with audio and quality available', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    for (const [id, label] of [
      ['video-quality', 'Quality · 2160p ▴'],
      ['audio-tracks', 'Audio · English ▴'],
    ]) {
      const button = document.createElement('button');
      button.className = 'video-quality-button';
      button.textContent = label;
      const container = document.querySelector<HTMLElement>(`#${id}`)!;
      container.hidden = false;
      container.append(button);
    }
    const path = '/src/ui/player/fullscreen-presentation.ts';
    const { installFullscreenPresentation } = await import(path);
    const presentation = installFullscreenPresentation(document.querySelector('#app')!);
    presentation.set(true);
    Reflect.set(window, 'auditFullscreen', presentation);
  });
  const dock = await geometry(page, '.dock');
  await info.attach('fullscreen-geometry', {
    body: JSON.stringify(dock),
    contentType: 'application/json',
  });
  await info.attach('fullscreen-dock', { body: await page.screenshot(), contentType: 'image/png' });
  expect(dock.overflowX).toBe(false);
  for (const control of dock.controls) {
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(961);
    expect(control.y + control.height).toBeLessThanOrEqual(541);
    expect(control.height).toBeGreaterThanOrEqual(32);
  }
  for (let i = 0; i < dock.controls.length; i++)
    for (const b of dock.controls.slice(i + 1)) {
      const a = dock.controls[i]!;
      expect(
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1,
      ).toBe(false);
    }
});

test('paused inline scan retains readable actions and channel browsing space', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    // The real panel: Finish scan, Rescan and Close for a paused scan.
    const panelPath = '/src/ui/scan/inline-scan-panel.ts';
    const { mountInlineScanPanel } = await import(panelPath);
    mountInlineScanPanel(document, () => false).render({
      schemaVersion: 1,
      generation: 1,
      phase: 'paused',
      busy: false,
      pendingPublications: 0,
      total: 18091,
      checked: 1250,
      responded: 1200,
      published: 1200,
      lastFailure: 'other',
      canContinue: true,
      query: '',
      presentation: 'inline',
      status: 'Scan paused · 1,250 checked · 1,200 saved',
      error:
        'Saving could not finish. Finish scan to retry the remaining channels, or rescan to start a new scan.',
      scopeRefusal: null,
    });
  });
  await expect(page.locator('#inline-source-scan button:visible')).toHaveText([
    'Finish scan',
    'Rescan',
    'Close',
  ]);
  const scan = await geometry(page, '#inline-source-scan');
  const list = await page.locator('#channel-list').boundingBox();
  await info.attach('inline-scan-geometry', {
    body: JSON.stringify({ scan, list }),
    contentType: 'application/json',
  });
  await info.attach('inline-scan', { body: await page.screenshot(), contentType: 'image/png' });
  expect(scan.overflowX).toBe(false);
  expect(list!.height).toBeGreaterThan(100);
  for (const button of await page.locator('#inline-source-scan button:visible').all()) {
    await button.focus();
    await focusedVisible(page);
  }
});

test('resume choice wraps a maximum supplied title and keeps all actions reachable', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    const path = '/src/ui/genxtra/archive-resume.ts';
    const { chooseArchiveResume } = await import(path);
    const controller = new AbortController();
    Reflect.set(window, 'auditResumeController', controller);
    void chooseArchiveResume('A'.repeat(1024), 86400000, controller.signal);
  });
  const dialog = page.getByRole('dialog', { name: 'Resume this video' });
  await expect(dialog).toBeVisible();
  const metrics = await geometry(page, '.archive-resume-dialog');
  expect(metrics.overflowX).toBe(false);
  for (const button of await dialog.locator('button').all()) {
    await button.focus();
    await focusedVisible(page);
  }
  await info.attach('resume-geometry', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });
  await info.attach('resume', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('account long-name removal and sign-in form fit the actual Sources panel without horizontal clipping', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    const navPath = '/src/ui/settings/settings-navigation.ts',
      accountsPath = '/src/ui/accounts/accounts.ts';
    const { mountSettingsNavigation } = await import(navPath),
      { mountAccountManagement } = await import(accountsPath);
    const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    Reflect.set(window, 'auditSettingsDispose', mountSettingsNavigation(dialog));
    const container = document.createElement('div');
    document.querySelector('[data-settings-panel="sources"]')!.append(container);
    const metadata = {
      schemaVersion: 1,
      id: 'a'.repeat(32),
      name: 'A'.repeat(160),
      kind: 'xtream',
      serverOrigin: 'https://provider.example',
      allowHttp: false,
      revision: '1',
      requiresSignIn: false,
    };
    Reflect.set(
      window,
      'auditAccounts',
      mountAccountManagement(container, {
        vault: {
          list: async () => [metadata],
          save: async () => {
            throw new Error('No saving in visual audit');
          },
          remove: async () => {
            throw new Error('No removing in visual audit');
          },
        },
        refresh: async () => {},
        browse: async () => {},
      }),
    );
    dialog.showModal();
  });
  const accounts = page.getByRole('region', { name: 'Your IPTV accounts' });
  await expect(accounts.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await accounts.getByRole('button', { name: 'Remove', exact: true }).click();
  await focusedVisible(page);
  const removal = await geometry(page, '[data-settings-panel="sources"]');
  await info.attach('account-removal', { body: await page.screenshot(), contentType: 'image/png' });
  await accounts.getByRole('button', { name: 'Keep account', exact: true }).click();
  await accounts.getByRole('button', { name: 'Add account', exact: true }).click();
  for (const input of await accounts.locator('form input:visible').all()) {
    await input.focus();
    await focusedVisible(page);
  }
  await accounts.getByRole('button', { name: 'Save sign-in', exact: true }).focus();
  await focusedVisible(page);
  const form = await geometry(page, '[data-settings-panel="sources"]');
  await info.attach('account-geometry', {
    body: JSON.stringify({ removal, form }),
    contentType: 'application/json',
  });
  await info.attach('account-form', { body: await page.screenshot(), contentType: 'image/png' });
  expect(removal.overflowX).toBe(false);
  expect(form.overflowX).toBe(false);
});

test('inline video removal confirmation stays in the list and keeps focus without deleting or playing', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    const path = '/src/ui/genxtra/archive-search.ts';
    const { mountArchiveSearch } = await import(path);
    const app = document.querySelector<HTMLElement>('#app')!;
    app.dataset.contentLibrary = 'genxtra';
    document.querySelector<HTMLElement>('.browse-options')!.hidden = true;
    document.querySelector<HTMLElement>('#channel-list')!.hidden = true;
    document.querySelector<HTMLElement>('#genxtra-browse-filters')!.hidden = false;
    const library = document.querySelector<HTMLElement>('#genxtra-library')!;
    library.hidden = false;
    const counts = { removed: 0, played: 0 };
    Reflect.set(window, 'auditRemovalCounts', counts);
    const title = {
      titleRef: 'a'.repeat(64),
      title: 'Saved collection',
      kind: 'tv',
      releaseYear: 1972,
      curated: true,
      titleProvenance: 'provider-item',
      fileCount: 1,
      durationSeconds: 120,
      rights: null,
      rank: 1,
      quality: 'metadata-h264',
      observedMs: 1,
      favorite: false,
    };
    const file = {
      fileRef: 'b'.repeat(64),
      title: 'Long supplied video title '.repeat(8).trim(),
      fileName: 'Long_supplied_filename_'.repeat(8) + '.mp4',
      itemId: 'fixture',
      format: 'h.264',
      durationSeconds: 120,
      sizeBytes: '1024',
      availability: 'unverified',
      observedMs: 1,
    };
    const ui = mountArchiveSearch(library, {
      input: document.querySelector('#search')!,
      detailsContainer: document.querySelector('#archive-details')!,
      readyScope: () => 'audit-root',
      catalog: {
        query: async () => ({
          schemaVersion: 1,
          revision: '1',
          totalCount: 1,
          offset: 0,
          items: [title],
          more: false,
        }),
        files: async () => ({
          schemaVersion: 1,
          revision: '1',
          titleRef: title.titleRef,
          totalCount: 1,
          offset: 0,
          files: [file],
          more: false,
        }),
      },
      onSelect: async () => {
        counts.played++;
      },
      onRemove: async () => {
        counts.removed++;
        throw new Error('No removal allowed in geometry audit');
      },
    });
    Reflect.set(window, 'auditArchiveUI', ui);
    await ui.resume('Saved');
  });
  await page.locator('.gx-archive-title-button').click();
  const inline = page.locator('.gx-archive-inline-videos:not([hidden])');
  await inline.locator('.gx-archive-file-details > summary').click();
  await inline.getByRole('button', { name: 'Remove from GenXtra', exact: true }).click();
  await expect(inline.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
  await focusedVisible(page);
  const metrics = await geometry(page, '.gx-archive-results');
  await info.attach('video-removal-geometry', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });
  await info.attach('video-removal', { body: await page.screenshot(), contentType: 'image/png' });
  expect(metrics.overflowX).toBe(false);
  await page.keyboard.press('ArrowDown');
  await expect(inline.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  await focusedVisible(page);
  await page.keyboard.press('Enter');
  await expect(inline.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await expect(inline.locator('.gx-archive-file-details > summary')).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'auditRemovalCounts'))).toEqual({
    removed: 0,
    played: 0,
  });
});

test('Back collapse fully reveals the selected title and its focus outline after scrolling through episodes', async ({
  page,
}, info) => {
  await mount(page);
  await page.evaluate(async () => {
    const path = '/src/ui/genxtra/archive-search.ts';
    const { mountArchiveSearch } = await import(path);
    document.querySelector<HTMLElement>('#app')!.dataset.contentLibrary = 'genxtra';
    document.querySelector<HTMLElement>('.browse-options')!.hidden = true;
    document.querySelector<HTMLElement>('#channel-list')!.hidden = true;
    document.querySelector<HTMLElement>('#genxtra-browse-filters')!.hidden = false;
    const library = document.querySelector<HTMLElement>('#genxtra-library')!;
    library.hidden = false;
    const titles = Array.from({ length: 20 }, (_, index) => ({
      titleRef: (index + 1).toString(16).padStart(64, '0'),
      title: `Saved collection ${index + 1}`,
      kind: 'tv',
      releaseYear: 1972,
      curated: true,
      titleProvenance: 'provider-item',
      fileCount: 8,
      durationSeconds: 120,
      rights: null,
      rank: index + 1,
      quality: 'metadata-h264',
      observedMs: 1,
      favorite: false,
    }));
    const files = Array.from({ length: 8 }, (_, index) => ({
      fileRef: (index + 100).toString(16).padStart(64, '0'),
      title: `Supplied video ${index + 1}`,
      fileName: `supplied-video-${index + 1}.mp4`,
      itemId: 'fixture',
      format: 'h.264',
      durationSeconds: 120,
      sizeBytes: '1024',
      availability: 'unverified',
      observedMs: 1,
    }));
    const counts = { played: 0, queries: 0, fileReads: 0 };
    Reflect.set(window, 'auditCollapseCounts', counts);
    const ui = mountArchiveSearch(library, {
      input: document.querySelector('#search')!,
      detailsContainer: document.querySelector('#archive-details')!,
      readyScope: () => 'audit-root',
      catalog: {
        query: async () => {
          counts.queries++;
          return {
            schemaVersion: 1,
            revision: '1',
            totalCount: titles.length,
            offset: 0,
            items: titles,
            more: false,
          };
        },
        files: async (request: { titleRef: string }) => {
          counts.fileReads++;
          return {
            schemaVersion: 1,
            revision: '1',
            titleRef: request.titleRef,
            totalCount: files.length,
            offset: 0,
            files,
            more: false,
          };
        },
      },
      onSelect: async () => {
        counts.played++;
      },
    });
    Reflect.set(window, 'auditCollapseUI', ui);
    await ui.resume('Saved');
  });
  const title = page.locator('.gx-archive-title-button').nth(4);
  expect(
    await page.locator('#search-programs').evaluate((button) => ({
      overflowX: button.scrollWidth > button.clientWidth + 1,
      overflowY: button.scrollHeight > button.clientHeight + 1,
    })),
  ).toEqual({ overflowX: false, overflowY: false });
  await title.click();
  await expect(
    page.getByRole('button', { name: 'Play Supplied video 1', exact: true }),
  ).toBeFocused();
  const actions = await page
    .locator('.gx-archive-file-row')
    .first()
    .evaluate((row) => {
      const play = row.querySelector('button')!.getBoundingClientRect(),
        more = row.querySelector('summary')!.getBoundingClientRect();
      return {
        playRight: play.right,
        moreLeft: more.left,
        playWidth: play.width,
        moreWidth: more.width,
        playHeight: play.height,
        moreHeight: more.height,
      };
    });
  await info.attach('inline-action-geometry', {
    body: JSON.stringify(actions),
    contentType: 'application/json',
  });
  expect(actions.moreLeft - actions.playRight).toBeGreaterThanOrEqual(6);
  expect(actions.playHeight).toBeGreaterThanOrEqual(32);
  expect(actions.moreHeight).toBeGreaterThanOrEqual(32);
  for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.gx-archive-file-details > summary').last()).toBeFocused();
  expect(
    await title.evaluate(
      (node) =>
        node.getBoundingClientRect().bottom <
        node.closest('.gx-archive-results')!.getBoundingClientRect().top,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, 'auditCollapseUI').dismissEpisodes())).toBe(
    true,
  );
  await expect(title).toBeFocused();
  const visibility = await title.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      clip = node.closest('.gx-archive-results')!.getBoundingClientRect(),
      style = getComputedStyle(node);
    const ring = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    return {
      top: box.top,
      bottom: box.bottom,
      clipTop: clip.top,
      clipBottom: clip.bottom,
      ring,
      visible: box.top - ring >= clip.top && box.bottom + ring <= clip.bottom,
    };
  });
  await info.attach('collapse-restored-title', {
    body: JSON.stringify(visibility),
    contentType: 'application/json',
  });
  await info.attach('collapse-restored-title', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(visibility.visible).toBe(true);
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(20);
  expect(await page.evaluate(() => Reflect.get(window, 'auditCollapseCounts'))).toEqual({
    played: 0,
    queries: 1,
    fileReads: 1,
  });
});

test('switching the account type keeps what was typed, and a playlist save sends only the link', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const accountsPath = '/src/ui/accounts/accounts.ts';
    const { mountAccountManagement } = await import(accountsPath);
    const container = document.createElement('div');
    document.querySelector('#settings-dialog')!.append(container);
    const saved: unknown[] = [];
    Reflect.set(window, 'auditSaved', saved);
    mountAccountManagement(container, {
      vault: {
        list: async () => [],
        save: async (request: unknown) => {
          saved.push(structuredClone(request));
          throw new Error('Fixture vault does not store');
        },
        remove: async () => {
          throw new Error('No removing in this test');
        },
      },
    });
    document.querySelector<HTMLDialogElement>('#settings-dialog')!.showModal();
  });
  const accounts = page.getByRole('region', { name: 'Your IPTV accounts' });
  await accounts.getByRole('button', { name: 'Add account', exact: true }).click();
  // Test-only values, typed the slow way like a remote.
  const link =
    'http://provider.test:8080/get.php?username=fixture&password=fixture-pass&type=m3u_plus&output=ts';
  await accounts.getByLabel('Account name').fill('Fixture provider');
  await accounts.getByLabel('Server address').pressSequentially(link);
  await expect(accounts.getByText('This looks like a playlist link.')).toBeVisible();
  await accounts.getByLabel('Account type').selectOption('playlist');
  await expect(accounts.getByLabel('Private playlist URL')).toHaveValue(link);
  await expect(accounts.getByLabel('Account name')).toHaveValue('Fixture provider');
  await expect(accounts.getByText('This looks like a playlist link.')).toBeHidden();
  // Back and forth again: nothing is lost.
  await accounts.getByLabel('Account type').selectOption('xtream');
  await accounts.getByLabel('Account type').selectOption('playlist');
  await expect(accounts.getByLabel('Private playlist URL')).toHaveValue(link);
  await accounts.getByLabel('This provider only works over HTTP', { exact: false }).check();
  await accounts.getByRole('button', { name: 'Save sign-in', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, 'auditSaved') as unknown[]).length))
    .toBe(1);
  const request = (await page.evaluate(
    () => (Reflect.get(window, 'auditSaved') as unknown[])[0],
  )) as Record<string, unknown>;
  expect(request).toMatchObject({ kind: 'playlist', playlistUrl: link });
  expect(request).not.toHaveProperty('username');
  expect(request).not.toHaveProperty('password');
  // Closing the form still clears everything typed.
  await accounts.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(accounts.getByLabel('Server address')).toHaveValue('');
});

test('a channel import keeps running after Settings closes and reports when done', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const accountsPath = '/src/ui/accounts/accounts.ts';
    const { mountAccountManagement } = await import(accountsPath);
    const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    const container = document.createElement('div');
    dialog.append(container);
    const state = { aborted: false, notices: [] as string[], finish: () => {} };
    Reflect.set(window, 'importState', state);
    mountAccountManagement(container, {
      vault: {
        list: async () => [
          {
            schemaVersion: 1,
            id: 'a'.repeat(32),
            name: 'Fixture provider',
            kind: 'playlist',
            serverOrigin: 'http://provider.test:8080',
            allowHttp: true,
            revision: '1',
            requiresSignIn: false,
          },
        ],
        save: async () => {
          throw new Error('unused');
        },
        remove: async () => {
          throw new Error('unused');
        },
      },
      refresh: (_account: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            state.aborted = true;
          });
          state.finish = resolve;
        }),
      notice: (message: string) => state.notices.push(message),
    });
    dialog.showModal();
  });
  const accounts = page.getByRole('region', { name: 'Your IPTV accounts' });
  await accounts.getByRole('button', { name: 'Refresh channels', exact: true }).click();
  await expect(accounts.getByText('You can close Settings; the import continues.')).toBeVisible();
  await page.evaluate(() => document.querySelector<HTMLDialogElement>('#settings-dialog')!.close());
  await page.evaluate(() => (Reflect.get(window, 'importState') as { finish(): void }).finish());
  await expect
    .poll(() =>
      page.evaluate(() => (Reflect.get(window, 'importState') as { notices: string[] }).notices),
    )
    .toEqual(['Fixture provider: channels imported.']);
  expect(
    await page.evaluate(() => (Reflect.get(window, 'importState') as { aborted: boolean }).aborted),
  ).toBe(false);
});

test('Paid TV second row keeps every label inside its button, with VOD explained by a tooltip', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const vodPath = '/src/ui/accounts/account-vod.ts';
    const { mountAccountVod } = await import(vodPath);
    const row = document.querySelector<HTMLElement>('.sidehead')!;
    const vod = mountAccountVod(
      { play: async () => undefined, run: () => undefined },
      {
        row,
        list: document.querySelector<HTMLElement>('#channel-list')!,
        stage: document.querySelector<HTMLElement>('#screen')!,
      },
      { list: async () => ({ categories: [], items: [], skipped: 0 }), episodes: async () => [] },
    );
    vod.present({ id: 'a'.repeat(32), revision: '1' });
    document.querySelector('#channel-count')!.textContent = '19,688 channels';
  });
  const button = page.locator('#vod-button');
  await expect(button).toHaveText('VOD');
  await expect(button).toHaveAttribute('title', 'Video On Demand');
  await expect(button).toHaveAccessibleName('Video On Demand');
  for (const width of [960, 1280, 1920]) {
    await page.setViewportSize({ width, height: Math.round((width * 9) / 16) });
    const overflow = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.sidehead')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('.sidehead button, .sidehead summary')]
        .filter((node) => node.getClientRects().length)
        .flatMap((node) => {
          const box = node.getBoundingClientRect();
          return node.scrollWidth > node.clientWidth + 1 ||
            box.left < row.left - 1 ||
            box.right > row.right + 1
            ? [`${node.textContent} ${node.scrollWidth}>${node.clientWidth}`]
            : [];
        });
    });
    expect(overflow, `width ${width}`).toEqual([]);
  }
});
