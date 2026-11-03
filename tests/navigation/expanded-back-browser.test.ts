// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

let browser: Browser, bundle: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'expanded-back-owner',
        resolveId: (id) => (id.endsWith('virtual:expanded-back') ? '\0expanded-back' : undefined),
        load: (id) =>
          id === '\0expanded-back'
            ? `export {createShell} from ${JSON.stringify(resolve('src/ui/shell/shell.ts'))}; export {createForegroundController} from ${JSON.stringify(resolve('src/application/shell/foreground-controller.ts'))}; export {installFullscreenPresentation} from ${JSON.stringify(resolve('src/ui/player/fullscreen-presentation.ts'))};`
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:expanded-back', formats: ['iife'], name: 'ExpandedBack' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing expanded Back bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing expanded Back entry');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent('<main id="app"></main>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const api = Reflect.get(window, 'ExpandedBack'),
      app = document.getElementById('app')!;
    api.createShell(app);
    app.dataset.playerIdle = 'false';
    app.classList.add('expanded');
    const state = { primaryPage: 'watch' };
    const calls = {
      expandedChanges: [] as boolean[],
      fullscreenChanges: 0,
      vod: 0,
      archive: 0,
      paid: 0,
      replay: 0,
      stop: 0,
      notices: [] as string[],
    };
    const flags = { edit: false, replay: false, paid: false, vod: false };
    Reflect.set(window, 'backCalls', calls);
    Reflect.set(window, 'backFlags', flags);
    Reflect.set(window, 'backPage', state);
    Reflect.set(document.querySelector('.workspace')!, 'requestFullscreen', async () => {
      calls.fullscreenChanges++;
    });
    const presentation = api.installFullscreenPresentation(app);
    const owner = api.createForegroundController({
      element: (id: string) => document.getElementById(id),
      setExpanded: (next: boolean) => {
        calls.expandedChanges.push(next);
        app.classList.toggle('expanded', next);
      },
      fullscreenPresentation: presentation,
      updatePreviewControl() {},
      notice: (message: string) => calls.notices.push(message),
      remoteEditMode: { exit: () => flags.edit },
      primaryHost: document.getElementById('primary-view-host'),
      pageState: state,
      paidGuide: {
        get open() {
          return flags.paid;
        },
        closeDetails: () => false,
      },
      switchPrimaryPage: async (next: string) => {
        calls.paid++;
        state.primaryPage = next;
        flags.paid = false;
      },
      playerView: {
        liveReplay: {
          back: () => {
            if (!flags.replay) return false;
            calls.replay++;
            flags.replay = false;
            return true;
          },
        },
      },
      libraries: {
        vodBack: () => {
          calls.vod++;
          return flags.vod;
        },
      },
      archiveSearch: {
        dismissFilters: () => {
          calls.archive++;
          return false;
        },
        dismissEpisodes: () => false,
      },
      player: {
        stop: () => {
          calls.stop++;
        },
      },
      nativeViewingForeground: true,
      applicationClosing: false,
    });
    Reflect.set(window, 'backOwner', owner);
    Reflect.set(window, 'backPresentation', presentation);
  });
  return page;
}
async function close(page: Page) {
  await page.evaluate(() => Reflect.get(window, 'backPresentation')?.dispose());
  await page.context().close();
}
async function snapshot(page: Page) {
  return page.evaluate(() => ({
    expanded: document.getElementById('app')!.classList.contains('expanded'),
    fullscreen: Reflect.get(window, 'backOwner').fullscreenOwner.active,
    ...Reflect.get(window, 'backCalls'),
  }));
}

it('native Back collapses expanded live Watch without stepping libraries or stopping playback', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.dispatchEvent(new Event('native-back-requested', { cancelable: true })),
    );
    const result = await snapshot(page);
    expect(result.expanded).toBe(false);
    expect(result.expandedChanges).toEqual([false]);
    expect(result.vod).toBe(0);
    expect(result.archive).toBe(0);
    expect(result.stop).toBe(0);
    expect(result.notices).toEqual([]);
  } finally {
    await close(page);
  }
});

it('expanded VOD leaves acknowledged fullscreen first, then collapses, then unwinds the VOD rail', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      document.getElementById('app')!.dataset.vod = 'open';
      Reflect.get(window, 'backFlags').vod = true;
      await Reflect.get(window, 'backOwner').fullscreenOwner.set(true);
      await Reflect.get(window, 'backOwner').handleBack();
    });
    expect(await snapshot(page)).toMatchObject({
      fullscreen: false,
      expanded: true,
      vod: 0,
      stop: 0,
    });
    await page.evaluate(() => Reflect.get(window, 'backOwner').handleBack());
    expect(await snapshot(page)).toMatchObject({
      fullscreen: false,
      expanded: false,
      vod: 0,
      stop: 0,
    });
    await page.evaluate(() => Reflect.get(window, 'backOwner').handleBack());
    expect(await snapshot(page)).toMatchObject({ expanded: false, vod: 1, stop: 0 });
  } finally {
    await close(page);
  }
});

it('Escape collapses expanded live Watch but respects prevented keys and editable fields', async () => {
  const page = await mount();
  try {
    const blocked = await page.evaluate(() => {
      const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      key.preventDefault();
      document.dispatchEvent(key);
      return document.getElementById('app')!.classList.contains('expanded');
    });
    expect(blocked).toBe(true);
    await page.locator('#search').focus();
    await page.keyboard.press('Escape');
    expect((await snapshot(page)).expanded).toBe(true);
    await page.evaluate(() => {
      document.getElementById('app')!.dataset.vod = 'open';
    });
    await page.keyboard.press('Escape');
    expect(await snapshot(page)).toMatchObject({ expanded: true, vod: 0 });
    await page.evaluate(() => {
      delete document.getElementById('app')!.dataset.vod;
    });
    await page.locator('#expand-button').focus();
    await page.keyboard.press('Escape');
    expect(await snapshot(page)).toMatchObject({ expanded: false, vod: 0, stop: 0 });
  } finally {
    await close(page);
  }
});

it('modal cancel, menu, replay and Paid Guide keep their Back ownership before expanded Watch', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      const modal = document.createElement('dialog');
      modal.id = 'owned-modal';
      document.body.append(modal);
      modal.showModal();
      modal.addEventListener('cancel', (event) => event.preventDefault());
      await Reflect.get(window, 'backOwner').handleBack();
    });
    expect(
      await page.locator('#owned-modal').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(true);
    expect((await snapshot(page)).expanded).toBe(true);
    await page.evaluate(async () => {
      (document.getElementById('owned-modal') as HTMLDialogElement).close();
      const menu = document.createElement('div');
      menu.dataset.videoQualityOpen = 'true';
      document.body.append(menu);
      menu.addEventListener('video-quality-close', () => menu.remove());
      await Reflect.get(window, 'backOwner').handleBack();
    });
    expect(await page.locator('[data-video-quality-open]').count()).toBe(0);
    expect((await snapshot(page)).expanded).toBe(true);
    await page.evaluate(async () => {
      Reflect.get(window, 'backFlags').replay = true;
      await Reflect.get(window, 'backOwner').handleBack();
      Reflect.get(window, 'backFlags').paid = true;
      Reflect.get(window, 'backPage').primaryPage = 'guide';
      await Reflect.get(window, 'backOwner').handleBack();
    });
    expect(await snapshot(page)).toMatchObject({
      expanded: true,
      replay: 1,
      paid: 1,
      vod: 0,
      stop: 0,
    });
  } finally {
    await close(page);
  }
});

it('Escape closes a primary Guide page before the retained expanded Watch presentation', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'backPage').primaryPage = 'guide';
      const dialog = document.createElement('dialog');
      dialog.id = 'primary-guide';
      dialog.dataset.primaryPage = 'guide';
      const close = document.createElement('button');
      close.textContent = 'Close Guide';
      dialog.append(close);
      document.getElementById('primary-view-host')!.append(dialog);
      dialog.addEventListener('close', () => {
        Reflect.get(window, 'backPage').primaryPage = 'watch';
      });
      dialog.show();
      close.focus();
    });
    await page.keyboard.press('Escape');
    expect(
      await page.locator('#primary-guide').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(false);
    expect(await snapshot(page)).toMatchObject({ expanded: true, vod: 0, stop: 0 });
  } finally {
    await close(page);
  }
});
