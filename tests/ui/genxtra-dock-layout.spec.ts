import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, television: boolean): Promise<void> {
  await page.route('**/vod-dock-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/style.css"><link rel="stylesheet" href="/src/ui/management.css"><link rel="stylesheet" href="/src/ui/guide.css"><link rel="stylesheet" href="/src/ui/responsive.css"><link rel="stylesheet" href="/src/ui/fullscreen.css"><link rel="stylesheet" href="/src/ui/video-quality.css"><link rel="stylesheet" href="/src/ui/genxtra.css"><link rel="stylesheet" href="/src/ui/media-results.css"></head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/vod-dock-fixture');
  await page.evaluate(async (television) => {
    const shellPath = '/src/ui/shell.ts',
      dockPath = '/src/ui/vod-dock.ts',
      viewportPath = '/src/ui/viewport.ts',
      stopPath = '/src/ui/vod-stop.ts';
    const { createShell } = await import(shellPath);
    const { installVODDock } = await import(dockPath);
    const { installViewport } = await import(viewportPath);
    const { mountVODStop } = await import(stopPath);
    const app = document.querySelector<HTMLElement>('#app')!;
    createShell(app);
    app.dataset.deviceKind = television ? 'tv' : 'handheld';
    app.dataset.compactView = 'watch';
    app.dataset.contentLibrary = 'genxtra';
    app.style.setProperty('--sidebar', '360px');
    installViewport(app);
    document.querySelector<HTMLElement>('#player-overlay')!.hidden = true;
    document.querySelector<HTMLElement>('#watch-title')!.textContent = 'Night of the Living Dead';
    document.querySelector<HTMLElement>('#playback-status')!.textContent = 'Playing';
    document.querySelector<HTMLElement>('#vod-transport')!.hidden = false;
    document.querySelector<HTMLElement>('#vod-position')!.textContent = '10080:00';
    for (const id of ['pause-button', 'vod-rewind', 'vod-forward'])
      document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = false;
    const quality = document.createElement('button');
    quality.className = 'video-quality-button';
    quality.type = 'button';
    quality.textContent = 'Auto ▴';
    quality.disabled = true;
    quality.setAttribute('aria-label', 'Video quality');
    document.querySelector('#video-quality')!.append(quality);
    const audio = document.createElement('button');
    audio.className = 'video-quality-button';
    audio.type = 'button';
    audio.textContent = 'Audio · English ▴';
    audio.setAttribute('aria-label', 'Audio track');
    document.querySelector('#audio-tracks')!.append(audio);
    Reflect.set(window, 'fixtureForeground', true);
    const dock = installVODDock(app, () => Reflect.get(window, 'fixtureForeground') === true);
    Reflect.set(window, 'fixtureVODDock', dock);
    dock.render(true);
    const stopState = { calls: 0, errors: 0, active: true, disposed: false };
    const stop = mountVODStop(document.querySelector<HTMLButtonElement>('#vod-stop')!, {
      stop: async () => {
        stopState.calls++;
        await new Promise<void>((resolve, reject) => {
          Reflect.set(window, 'finishStop', resolve);
          Reflect.set(window, 'failStop', () => reject(new Error('controlled stop failure')));
        });
        stopState.active = false;
      },
      changed: () => {
        stop.render(true, stopState.active);
        if (!stopState.active && Reflect.get(window, 'fixtureStopHidesDock')) {
          document.querySelector<HTMLElement>('.watch-card')!.hidden = true;
          document.querySelector<HTMLElement>('#archive-details')!.hidden = false;
        }
      },
      run: (work: Promise<void>) => {
        void work.catch(() => {
          stopState.errors++;
        });
      },
      focusFallback: () => document.querySelector<HTMLButtonElement>('#mute-button')!.focus(),
      canRestoreFocus: () => Reflect.get(window, 'fixtureForeground') === true,
    });
    stop.render(true, true);
    Reflect.set(window, 'fixtureStop', stop);
    Reflect.set(window, 'fixtureStopState', stopState);
  }, television);
}

test('GenXtra Stop joins one actual request, retains search and leaves navigation usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  await page.locator('#search').fill('Disney');
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(page.locator('#mute-button')).toBeFocused();
  await stop.dispatchEvent('click');
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').calls)).toBe(1);
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(stop).toHaveAttribute('aria-busy', 'false');
  await expect(stop).toBeDisabled();
  await expect(page.locator('#search')).toHaveValue('Disney');
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').errors)).toBe(0);
});

async function stopChangesLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, 'fixtureStopHidesDock', true);
    const selected = document.createElement('article');
    selected.className = 'gx-archive-result-row';
    selected.innerHTML =
      '<button id="selected-stop-title" class="gx-archive-title-button" data-archive-ref="selected-title-ref" aria-current="true">Selected title</button><div class="gx-archive-inline-videos"><button id="selected-stop-file" class="gx-archive-file-button">Play selected file</button></div>';
    document.querySelector('.browser')!.append(selected);
    document.querySelector('#archive-details')!.textContent = 'Selected title details';
  });
}

async function publishStopIdle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const details = document.querySelector<HTMLElement>('#archive-details')!;
    details.hidden = false;
    details.dataset.playbackActive = 'false';
  });
}

test('Stop repairs CSS-hidden dock focus while real cleanup is still pending', async ({ page }) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await expect(page.locator('#mute-button')).toBeFocused();
  await publishStopIdle(page);
  await expect(page.locator('.watch-card')).toBeHidden();
  await expect(page.locator('#vod-stop')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#selected-stop-file')).toBeFocused();
  await page.locator('#search').focus();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#vod-stop')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#search')).toBeFocused();
});

test('pending Stop respects a pointer action on blank space before its dock disappears', async ({
  page,
}) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    (document.activeElement as HTMLElement).blur();
  });
  await publishStopIdle(page);
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#vod-stop')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
  await expect(page.locator('#selected-stop-title')).not.toBeFocused();
});

test('pending Stop cannot hand focus to a different selected title identity', async ({ page }) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await page.locator('#selected-stop-title').evaluate((node: HTMLElement) => {
    node.dataset.archiveRef = 'other-title-ref';
  });
  await publishStopIdle(page);
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#vod-stop')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
  await expect(page.locator('#selected-stop-title')).not.toBeFocused();
});

test('disposing pending Stop cancels a queued handoff and joins its actual owner', async ({
  page,
}) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await page.evaluate(() => {
    const details = document.querySelector<HTMLElement>('#archive-details')!;
    details.hidden = false;
    details.dataset.playbackActive = 'false';
    (document.activeElement as HTMLElement).blur();
    Reflect.set(window, 'pendingStopDisposal', Reflect.get(window, 'fixtureStop').dispose());
  });
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
  await page.evaluate(async () => {
    Reflect.get(window, 'finishStop')();
    await Reflect.get(window, 'pendingStopDisposal');
  });
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
});

for (const boundary of ['background', 'inert', 'modal'] as const)
  test(`pending Stop CSS handoff respects ${boundary}`, async ({ page }) => {
    await mount(page, true);
    await stopChangesLayout(page);
    await page.locator('#vod-stop').click();
    await page.evaluate((boundary) => {
      if (boundary === 'background') Reflect.set(window, 'fixtureForeground', false);
      if (boundary === 'inert') document.querySelector<HTMLElement>('.workspace')!.inert = true;
      if (boundary === 'modal') {
        const dialog = document.createElement('dialog');
        dialog.innerHTML = '<button id="pending-stop-modal">Modal choice</button>';
        document.body.append(dialog);
        dialog.showModal();
      }
    }, boundary);
    await publishStopIdle(page);
    await expect(page.locator('.watch-card')).toBeHidden();
    await expect(page.locator('#vod-stop')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#selected-stop-file')).not.toBeFocused();
    if (boundary === 'modal') await expect(page.locator('#pending-stop-modal')).toBeFocused();
    await page.evaluate(() => Reflect.get(window, 'finishStop')());
  });

test('Stop keeps its focus handoff when final selected-title layout hides the dock', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#search').fill('Great Train Robbery');
  await page.locator('#vod-stop').click();
  await expect(page.locator('#mute-button')).toBeFocused();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('.watch-card')).toBeHidden();
  await expect(page.locator('#selected-stop-file')).toBeFocused();
  await expect(page.locator('#search')).toHaveValue('Great Train Robbery');
});

test('Stop reveals an offscreen selected file only within its result list', async ({ page }) => {
  await mount(page, true);
  await stopChangesLayout(page);
  const before = await page.evaluate(() => {
    const list = document.createElement('section');
    list.className = 'gx-archive-results';
    list.id = 'stop-scroll-owner';
    list.style.cssText =
      'position:fixed;top:180px;left:20px;width:300px;height:120px;overflow:auto;display:block';
    const spacer = document.createElement('div');
    spacer.style.height = '1200px';
    list.append(
      spacer,
      document.querySelector('#selected-stop-title')!.closest('.gx-archive-result-row')!,
    );
    document.querySelector('.browser')!.append(list);
    const positions = () => [
      document.scrollingElement!.scrollTop,
      document.querySelector('.workspace')!.scrollTop,
      document.querySelector('.browser')!.scrollTop,
      document.querySelector('.topbar')!.getBoundingClientRect().top,
    ];
    Reflect.set(window, 'stopOuterPositions', positions);
    return positions();
  });
  expect((await page.locator('#selected-stop-file').boundingBox())!.y).toBeGreaterThan(1000);
  await page.locator('#vod-stop').click();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#selected-stop-file')).toBeFocused();
  const after = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#stop-scroll-owner')!,
      box = document.querySelector('#selected-stop-file')!.getBoundingClientRect(),
      viewport = list.getBoundingClientRect();
    return {
      scroll: list.scrollTop,
      top: box.top,
      bottom: box.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      outer: Reflect.get(window, 'stopOuterPositions')(),
    };
  });
  expect(after.scroll).toBeGreaterThan(0);
  expect(after.top).toBeGreaterThanOrEqual(after.viewportTop);
  expect(after.bottom).toBeLessThanOrEqual(after.viewportBottom);
  expect(after.outer).toEqual(before);
});

test('Stop falls back to the selected title when its episode controls are unavailable', async ({
  page,
}) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#selected-stop-file').evaluate((node: HTMLButtonElement) => {
    node.disabled = true;
  });
  await page.locator('#vod-stop').click();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#selected-stop-title')).toBeFocused();
});

test('Stop preserves later search focus when the dock disappears', async ({ page }) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await page.locator('#search').focus();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('#search')).toBeFocused();
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
});

test('Stop does not own another dock control selected while its request is pending', async ({
  page,
}) => {
  await mount(page, true);
  await stopChangesLayout(page);
  await page.locator('#vod-stop').click();
  await page.locator('#pause-button').focus();
  await page.evaluate(() => Reflect.get(window, 'finishStop')());
  await expect(page.locator('.watch-card')).toBeHidden();
  await expect(page.locator('#selected-stop-file')).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

for (const boundary of ['background', 'inert', 'modal'] as const)
  test(`Stop does not restore its hidden dock handoff across ${boundary}`, async ({ page }) => {
    await mount(page, true);
    await stopChangesLayout(page);
    await page.locator('#vod-stop').click();
    await expect(page.locator('#mute-button')).toBeFocused();
    await page.evaluate((boundary) => {
      if (boundary === 'background') Reflect.set(window, 'fixtureForeground', false);
      if (boundary === 'inert') document.querySelector<HTMLElement>('.workspace')!.inert = true;
      if (boundary === 'modal') {
        const dialog = document.createElement('dialog');
        dialog.innerHTML = '<button id="later-stop-modal">Later modal</button>';
        document.body.append(dialog);
        dialog.showModal();
      }
      Reflect.get(window, 'finishStop')();
    }, boundary);
    await expect(page.locator('.watch-card')).toBeHidden();
    await expect(page.locator('#selected-stop-file')).not.toBeFocused();
    await expect(page.locator('#selected-stop-title')).not.toBeFocused();
    if (boundary === 'modal') await expect(page.locator('#later-stop-modal')).toBeFocused();
  });

test('failed GenXtra Stop remains retryable and disposal joins the pending retry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await page.evaluate(() => Reflect.get(window, 'failStop')());
  await expect(stop).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').errors)).toBe(1);
  await stop.click();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'fixtureStopState');
    Reflect.set(
      window,
      'stopDisposal',
      Reflect.get(window, 'fixtureStop')
        .dispose()
        .then(() => {
          state.disposed = true;
        }),
    );
  });
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').disposed)).toBe(false);
  await page.evaluate(async () => {
    Reflect.get(window, 'finishStop')();
    await Reflect.get(window, 'stopDisposal');
  });
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').calls)).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').disposed)).toBe(true);
  await stop.dispatchEvent('click');
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').calls)).toBe(2);
});

test('Stop is hidden for Live TV and cannot admit an archive request there', async ({ page }) => {
  await mount(page, false);
  await page.evaluate(() => Reflect.get(window, 'fixtureStop').render(false, true));
  await expect(page.locator('#vod-stop')).toBeHidden();
  await page.locator('#vod-stop').dispatchEvent('click');
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureStopState').calls)).toBe(0);
});
test('Stop does not move focus into the dock after native background or inert ownership', async ({
  page,
}) => {
  await mount(page, true);
  for (const inert of [false, true]) {
    await page.evaluate(() => {
      Reflect.set(window, 'fixtureForeground', true);
      Reflect.get(window, 'fixtureStop').render(true, true);
    });
    await page.locator('#vod-stop').focus();
    await page.evaluate((inert) => {
      if (inert) document.querySelector<HTMLElement>('.workspace')!.inert = true;
      else Reflect.set(window, 'fixtureForeground', false);
      Reflect.get(window, 'fixtureStop').render(true, false);
    }, inert);
    await expect(page.locator('#mute-button')).not.toBeFocused();
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.workspace')!.inert = false;
    });
  }
});

async function bounds(page: Page): Promise<{ errors: string[]; rows: number }> {
  return page.locator('.dock').evaluate((dock) => {
    const errors: string[] = [],
      tops = new Set<number>();
    const owner = dock.getBoundingClientRect();
    if (dock.scrollWidth > dock.clientWidth + 1) errors.push('horizontal dock overflow');
    const visible = (e: HTMLElement) =>
      e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const controls = [...dock.querySelectorAll<HTMLElement>('button,output')].filter(visible);
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      const label = control.id || control.getAttribute('aria-label') || 'control';
      if (control instanceof HTMLButtonElement) tops.add(Math.round(box.top));
      if (
        box.left < owner.left - 1 ||
        box.right > owner.right + 1 ||
        box.top < owner.top - 1 ||
        box.bottom > owner.bottom + 1
      )
        errors.push(`outside dock: ${label}`);
      if (
        box.left < -1 ||
        box.right > innerWidth + 1 ||
        box.top < -1 ||
        box.bottom > innerHeight + 1
      )
        errors.push(`outside viewport: ${label}`);
      if (control instanceof HTMLButtonElement) {
        if (box.width < 43 || box.height < 43) errors.push(`small target: ${label}`);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!control.contains(hit)) errors.push(`covered: ${label}`);
      }
      const range = document.createRange();
      range.selectNodeContents(control);
      for (const text of range.getClientRects())
        if (
          text.left < box.left - 1 ||
          text.right > box.right + 1 ||
          text.top < box.top - 1 ||
          text.bottom > box.bottom + 1
        )
          errors.push(`clipped text: ${label}`);
      if (
        (control.id === 'vod-rewind' || control.id === 'vod-forward') &&
        range.getClientRects().length !== 1
      )
        errors.push(`seek label wraps: ${label}`);
    }
    for (let a = 0; a < controls.length; a++)
      for (let b = a + 1; b < controls.length; b++) {
        const x = controls[a]!.getBoundingClientRect(),
          y = controls[b]!.getBoundingClientRect();
        if (
          Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 &&
          Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1
        )
          errors.push(`overlap: ${controls[a]!.id}/${controls[b]!.id}`);
      }
    return { errors, rows: tops.size };
  });
}

test('GenXtra keeps result count and Filters in one toolbar without a second Search action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  await page.evaluate(async () => {
    const archivePath = '/src/ui/archive-search.ts';
    const { mountArchiveSearch } = await import(archivePath);
    const container = document.querySelector<HTMLElement>('#genxtra-library')!;
    container.hidden = false;
    const titles = Array.from({ length: 10 }, (_, index) => ({
      titleRef: (index + 1).toString(16).padStart(64, '0'),
      title: `Original show ${index + 1}`,
      kind: 'tv',
      releaseYear: 1972,
      curated: false,
      titleProvenance: 'provider-item',
      fileCount: 1,
      durationSeconds: 120,
      rights: null,
      rank: index + 1,
      quality: 'metadata-h264',
      observedMs: 1,
      favorite: false,
    }));
    const ui = mountArchiveSearch(container, {
      input: document.querySelector<HTMLInputElement>('#search')!,
      readyScope: () => 'fixture-root',
      catalog: {
        query: async () => ({
          schemaVersion: 1,
          revision: '1',
          totalCount: 10,
          offset: 0,
          items: titles,
          more: false,
        }),
        files: async () => {
          throw new Error('File lookup is outside this layout fixture.');
        },
      },
      onSelect: async () => {},
    });
    Reflect.set(window, 'fixtureArchiveUI', ui);
    await ui.resume('Original');
  });
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(10);
  await expect(page.locator('.gx-archive-result-summary')).toBeVisible();
  await expect(page.locator('.gx-archive-result-summary')).toHaveText(
    'Results for “Original” · 10 saved',
  );
  await expect(page.locator('.gx-archive-find-more')).toHaveCount(0);
  const observed = await page.locator('.gx-archive-search').evaluate((root) => {
    const tools = root.querySelector('.gx-archive-tools')!.getBoundingClientRect();
    const source = root.querySelector('.gx-archive-result-summary')!.getBoundingClientRect();
    const filters = root.querySelector('.gx-archive-filter-toggle')!.getBoundingClientRect();
    const list = root.querySelector('.gx-archive-results')!.getBoundingClientRect();
    const first = root.querySelector('.gx-archive-title-button')!.getBoundingClientRect();
    return { tools, source, filters, list, first };
  });
  expect(observed.tools.height).toBeLessThanOrEqual(45);
  expect(observed.source.right).toBeLessThanOrEqual(observed.filters.left);
  expect(observed.filters.height).toBeGreaterThanOrEqual(44);
  expect(observed.list.height).toBeGreaterThanOrEqual(120);
  expect(observed.first.top).toBeGreaterThanOrEqual(observed.list.top);
  await page.locator('.gx-archive-filter-toggle').focus();
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  await page.evaluate(async () => {
    await Reflect.get(window, 'fixtureArchiveUI').dispose();
  });
  await expect(page.locator('.gx-archive-search')).toHaveCount(0);
});

test('TV search input and two compact selectors have separate unclipped rows', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#genxtra-browse-filters')!.hidden = false;
    document.querySelector<HTMLInputElement>('#search')!.value = "Gilligan's Island";
    document.querySelector<HTMLElement>('#clear-search')!.hidden = false;
  });
  await page.locator('#search').focus();
  const observed = await page.evaluate(() => {
    const row = document.querySelector('.search-controls')!.getBoundingClientRect();
    const input = document.querySelector('#search')!.getBoundingClientRect();
    const filters = document.querySelector('#genxtra-browse-filters')!.getBoundingClientRect();
    const buttons = [
      ...document.querySelectorAll<HTMLElement>('#genxtra-browse-filters select'),
    ].map((button) => {
      const box = button.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    });
    return { row, input, filters, buttons };
  });
  expect(observed.input.bottom).toBeLessThanOrEqual(observed.row.bottom + 1);
  expect(observed.filters.top - observed.row.bottom).toBeGreaterThanOrEqual(8);
  for (const button of observed.buttons) {
    expect(button.top).toBeGreaterThanOrEqual(observed.filters.top);
    expect(button.bottom).toBeLessThanOrEqual(observed.filters.bottom);
    expect(button.height).toBe(40);
  }
  await page.locator('#genxtra-browse-filters select').first().focus();
  await expect(page.locator('#genxtra-browse-filters select').first()).toBeFocused();
  // The GenXtra accent is its neon badge (no grey button frame), and it is static.
  const accent = await page.locator('#genxtra-button').evaluate((button) => {
    const style = getComputedStyle(button);
    const badge = getComputedStyle(button.querySelector('.genxtra-badge')!);
    return {
      border: style.borderTopColor,
      badge: badge.filter,
      animation: style.animationName,
    };
  });
  expect(accent.border).not.toBe('rgb(51, 71, 102)');
  expect(accent.badge).not.toBe('none');
  expect(accent.animation).toBe('none');
});

for (const size of [
  { width: 960, height: 540, tv: true },
  { width: 320, height: 640, tv: false },
  { width: 412, height: 915, tv: false },
  { width: 640, height: 360, tv: false },
  { width: 854, height: 432, tv: false },
]) {
  test(`VOD seek/control bounds ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await mount(page, size.tv);
    await expect(page.locator('.channel-actions')).toBeHidden();
    await expect(page.locator('#video-quality')).toBeHidden();
    await expect(page.locator('#captions-button')).toBeHidden();
    let result = await bounds(page);
    expect(result.errors).toEqual([]);
    if (size.tv) expect(result.rows).toBe(1);
    // Delayed actual capability publication must reveal its existing control.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = false;
      document.querySelector<HTMLButtonElement>('#video-quality button')!.disabled = false;
      document.querySelector<HTMLElement>('#audio-tracks')!.hidden = false;
    });
    await expect(page.locator('#captions-button')).toBeVisible();
    await expect(page.locator('#video-quality')).toBeVisible();
    await expect(page.locator('#audio-tracks')).toBeVisible();
    result = await bounds(page);
    expect(result.errors).toEqual([]);
    if (size.tv) expect(result.rows).toBe(1);
    if (size.width === 854 && !size.tv) {
      expect(result.rows).toBe(2);
      await page.screenshot({
        path: 'artifacts/handheld-layout/2026-10-14/dock-854x432-after-fix.png',
      });
    }
  });
}

for (const size of [
  { width: 854, height: 432 },
  { width: 320, height: 640 },
  { width: 640, height: 360 },
]) {
  test(`Handheld search and GenXtra filters remain separate ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await mount(page, false);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#app')!.dataset.compactView = 'channels';
      document.querySelector<HTMLElement>('#genxtra-browse-filters')!.hidden = false;
      document.querySelector<HTMLInputElement>('#search')!.value = 'Fixture programme search';
      document.querySelector<HTMLElement>('#clear-search')!.hidden = false;
    });
    await page.locator('#search').focus();
    const result = await page.evaluate(() => {
      const input = document.querySelector('#search')!.getBoundingClientRect();
      const filters = document.querySelector('#genxtra-browse-filters')!.getBoundingClientRect();
      const buttons = [
        ...document.querySelectorAll<HTMLElement>('#genxtra-browse-filters select'),
      ].map((node) => {
        const box = node.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      });
      const neon = getComputedStyle(document.querySelector('#genxtra-button')!);
      const badge = getComputedStyle(document.querySelector('#genxtra-button .genxtra-badge')!);
      return {
        input,
        filters,
        buttons,
        neon: { badge: badge.filter, animation: neon.animationName },
        scroll: document.documentElement.scrollHeight > innerHeight + 1,
      };
    });
    expect(result.input.bottom + 8).toBeLessThanOrEqual(result.filters.top + 1);
    for (const control of result.buttons) {
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(size.width);
      expect(control.bottom).toBeLessThanOrEqual(size.height);
    }
    expect(result.neon.badge).not.toBe('none');
    expect(result.neon.animation).toBe('none');
    expect(result.scroll).toBe(false);
  });
}

test('VOD capability loss restores reachable focus, fullscreen hides dock, Live controls return, disposal releases observer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = false;
  });
  await page.locator('#captions-button').focus();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = true;
  });
  await expect(page.locator('#captions-button')).toBeHidden();
  await expect(page.locator('#pause-button')).toBeFocused();
  await page.evaluate(() => {
    document.querySelector('#app')!.classList.add('viewing-fullscreen', 'fullscreen-dock-hidden');
  });
  await expect(page.locator('.dock')).toBeHidden();
  await page.evaluate(() => {
    document.querySelector('#app')!.classList.remove('fullscreen-dock-hidden');
  });
  await expect(page.locator('.dock')).toBeVisible();
  expect((await bounds(page)).errors).toEqual([]);
  await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('#app')!;
    app.classList.remove('viewing-fullscreen', 'fullscreen-dock-hidden');
    (Reflect.get(window, 'fixtureVODDock') as { render(v: boolean): void }).render(false);
    document.querySelector<HTMLElement>('#vod-transport')!.hidden = true;
  });
  await expect(page.locator('.channel-actions')).toBeVisible();
  await expect(page.locator('#captions-button')).toBeVisible();
  await expect(page.locator('#video-quality')).toBeVisible();
  await page.evaluate(() => {
    (Reflect.get(window, 'fixtureVODDock') as { dispose(): void }).dispose();
  });
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#captions-button')!.hidden = true;
    document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = false;
  });
  await expect(page.locator('#app')).not.toHaveAttribute('data-play-mode');
  // An undisconnected observer would unhide this during its queued refresh.
  await expect(page.locator('#captions-button')).toBeHidden();
});

test('native background and inert ownership do not restore viewing focus', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await mount(page, true);
  for (const inert of [false, true]) {
    await page.evaluate(() => {
      Reflect.set(window, 'fixtureForeground', true);
      document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = false;
    });
    await page.locator('#captions-button').focus();
    await page.evaluate((inert) => {
      if (inert) document.querySelector<HTMLElement>('.workspace')!.inert = true;
      else Reflect.set(window, 'fixtureForeground', false);
      document.querySelector<HTMLButtonElement>('#captions-button')!.disabled = true;
    }, inert);
    await expect(page.locator('#captions-button')).toBeHidden();
    await expect(page.locator('#pause-button')).not.toBeFocused();
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.workspace')!.inert = false;
    });
  }
});
