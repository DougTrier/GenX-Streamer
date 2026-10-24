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

import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import { test, expect, type Page, type Locator } from '@playwright/test';

const sizes = [
  { width: 320, height: 640 },
  { width: 640, height: 360 },
  { width: 960, height: 540 },
];
const playlist =
  '#EXTM3U\n' +
  Array.from(
    { length: 55 },
    (_, index) =>
      `#EXTINF:-1 tvg-id="c${index}" tvg-country="US" tvg-region="NORAM" tvg-state="US-IL" group-title="News",Chicago regional news and community television ${index}\nhttps://fixture.invalid/channel-${index}\n`,
  ).join('');
type Screen =
  | 'channels'
  | 'watch'
  | 'location'
  | 'import'
  | 'cast-known'
  | 'settings-sources'
  | 'settings-preferences'
  | 'settings-data'
  | 'settings-migration'
  | 'settings-discovery'
  | 'sharing-setup'
  | 'sharing-connected'
  | 'scan'
  | 'website'
  | 'guide-programs'
  | 'guide-detail'
  | 'guide-sources'
  | 'guide-mapping';
const screens: Screen[] = [
  'channels',
  'watch',
  'location',
  'import',
  'cast-known',
  'settings-sources',
  'settings-preferences',
  'settings-data',
  'settings-migration',
  'settings-discovery',
  'sharing-setup',
  'sharing-connected',
  'scan',
  'website',
  'guide-programs',
  'guide-detail',
  'guide-sources',
  'guide-mapping',
];
async function populate(page: Page, sourceFixture: boolean): Promise<void> {
  await page.route('https://fixture.invalid/**', (route) =>
    route.request().url().endsWith('/source')
      ? route.fulfill({ contentType: 'text/plain', body: playlist })
      : route.abort(),
  );
  // Application layouts use the same fresh bundle as native packaging; isolated
  // component fixtures below still use the source server for their module imports.
  await page.goto(sourceFixture ? '/' : 'http://127.0.0.1:1420/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'Regional news and community channels.data',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('55 channels');
  // Avoid measuring the short-lived import notification as persistent layout overlap.
  await expect(page.locator('#notice')).not.toBeVisible({ timeout: 10000 });
}
async function guideFixture(page: Page, screen: Screen): Promise<Locator> {
  // Real UI/styles with injected deterministic guide records, not native SQL/device proof.
  await page.evaluate(async () => {
    const path = '/src/ui/guide/guide.ts';
    const { mountGuide } = await import(path);
    const container = document.createElement('section');
    document.body.append(container);
    const now = 1700000000000;
    const channel = {
      id: 'c0',
      sourceId: 'source',
      name: 'Chicago regional news and community television',
    };
    const source = {
      id: 'guide',
      name: 'Regional television programme schedules',
      location: 'https://fixture.invalid/guide',
      kind: 'url',
      allowHttp: false,
      revision: 1,
      updatedMs: now,
    };
    const mapping = {
      catalogSourceId: 'source',
      appChannelId: 'c0',
      guideSourceId: 'guide',
      xmltvChannelId: 'regional',
    };
    const programs = Array.from({ length: 50 }, (_, ordinal) => ({
      ...mapping,
      title: 'Chicago Bears community preview and regional highlights ' + ordinal,
      description: 'Detailed scheduled programme description. '.repeat(8),
      startMs: now + 1000 + ordinal * 60000,
      stopMs: now + 61000 + ordinal * 60000,
      ordinal,
    }));
    const ui = mountGuide(container, {
      selectedChannel: () => channel,
      channels: () => [channel],
      now: () => now,
      formatTime: (ms: number) => new Date(ms).toISOString(),
      sources: async () => [source],
      mappings: async () => [mapping],
      query: async () => ({ programs, nextCursor: null, sourceRevision: 1, databaseRevision: 1 }),
      coverage: async () => ({
        publishedRevision: 1,
        updatedMs: now,
        startMs: now,
        endMs: now + 3000000,
      }),
      guideChannels: async () => ({
        channels: [{ id: 'regional', names: ['Chicago regional television guide'] }],
        nextCursor: null,
        sourceRevision: 1,
      }),
      preview: async () => {
        throw new Error('No fixture publication');
      },
      commitPreview: async () => {
        throw new Error('No fixture publication');
      },
      discardPreview: async () => {},
      removeSource: async () => {},
      setMapping: async () => {},
      watch: async () => {
        throw new Error('No fixture tuning');
      },
    });
    Reflect.set(window, 'layoutGuide', ui);
    ui.open();
  });
  const dialog = page.getByRole('dialog', { name: 'Program guide' });
  await expect(dialog.getByLabel('Guide programs')).toContainText('Chicago Bears');
  if (screen === 'guide-sources' || screen === 'guide-mapping') {
    await page.evaluate(() => {
      const guide = Reflect.get(window, 'layoutGuide') as { openAdvanced(): void };
      guide.openAdvanced();
    });
    await dialog.getByRole('button', { name: 'Guide view', exact: true }).click();
    await dialog
      .getByRole('option', {
        name: screen === 'guide-sources' ? 'Program guide setup' : 'Channel mapping',
        exact: true,
      })
      .click();
    if (screen === 'guide-sources')
      await dialog.getByText('Add guide link or file', { exact: true }).click();
  }
  if (screen === 'guide-detail')
    await dialog.getByLabel('Guide programs').getByRole('button').first().click();
  return dialog;
}
async function sharingFixture(page: Page, connected: boolean): Promise<Locator> {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sharing');
  // Injected owned sharing service proves form layout only; no listener, TLS or phone is started.
  await page.evaluate(async () => {
    const path = '/src/sharing/settings.ts';
    const { mountSharingSettings } = await import(path);
    const container = document.getElementById('sharing-settings')!;
    container.replaceChildren();
    const host = {
      snapshot: () => ({
        generation: 1,
        muted: false,
        volume: 1,
        playback: { state: 'idle', selection: null, error: null },
      }),
      subscribe: () => () => {},
      channels: () => [{ id: 'c0', name: 'Chicago regional news and community television' }],
      apply: async () => ({ generation: 1 }),
    };
    const api = {
      start: async () => ({
        address: 'https://fixture.invalid',
        pairingSecret: 'fixture-invitation',
      }),
      stop: async () => {},
      selectionChanged: async () => {},
      publish: async () => ({ revision: 1, mediaId: 'fixture-media' }),
      invite: async () => 'fixture-invitation',
      viewers: async () => [],
      revoke: async () => {},
      nextCommand: async () => null,
      active: async () => true,
      allows: async () => true,
      acknowledge: async () => true,
    };
    Reflect.set(window, 'layoutSharing', mountSharingSettings(container, host, { api }));
  });
  const dialog = page.locator('#settings-dialog');
  if (connected) {
    await dialog.getByLabel('Private interface IPv4 address').fill('127.0.0.1');
    await dialog.getByLabel('Port', { exact: true }).fill('9443');
    await dialog.getByLabel('Trusted certificate file').fill('C:\\fixture.pem');
    await dialog.getByLabel('Certificate private key file').fill('C:\\fixture-key.pem');
    await dialog.getByRole('button', { name: 'Start sharing', exact: true }).click();
    await expect(dialog).toContainText('Sharing is on');
  }
  return dialog;
}
async function openScreen(page: Page, screen: Screen): Promise<Locator> {
  if (screen.startsWith('guide-')) return guideFixture(page, screen);
  if (screen.startsWith('sharing-')) return sharingFixture(page, screen === 'sharing-connected');
  if (screen.startsWith('settings-')) {
    await page.locator('#settings-button').click();
    await chooseSettingsSection(page, screen.slice(9));
    if (screen === 'settings-migration')
      await page.getByText('Import from the previous app', { exact: true }).click();
    return page.locator('#settings-dialog');
  }
  if (screen === 'cast-known') {
    await page.locator('#cast-button').click();
    await page.getByLabel('Connection method').selectOption('known');
    return page.locator('#cast-dialog');
  }
  if (screen === 'import') {
    await openPlaylistImport(page);
    return page.locator('#import-dialog');
  }
  if (screen === 'location') {
    if (await page.getByLabel('Viewing panel').isVisible())
      await page.getByLabel('Viewing panel').selectOption('channels');
    await page.getByRole('button', { name: 'Location and sort', exact: true }).click();
    return page.getByRole('dialog', { name: 'Location and sort' });
  }
  if (screen === 'scan') {
    await page.route('https://fixture.invalid/channel-*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
      }),
    );
    await openPlaylistImport(page);
    await page.locator('#playlist-url').fill('https://fixture.invalid/source');
    await page.locator('#load-button').click();
    const dialog = page.getByRole('dialog', { name: 'Review source scan' });
    // All 55 sequential response checks finish before the review rows are published.
    await expect(dialog.getByLabel('Candidate channels').locator('li')).toHaveCount(50, {
      timeout: 30000,
    });
    await expect(dialog.getByRole('button', { name: 'Run action', exact: true })).not.toBeVisible();
    return dialog;
  }
  if (screen === 'website') {
    await page.route('**/layout-website', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: Array.from(
          { length: 55 },
          (_, i) =>
            `<a href="https://fixture.invalid/source-${i}">Regional provider playlist reference ${i}</a>`,
        ).join(''),
      }),
    );
    await page.evaluate(async () => {
      const inputPath = '/src/discovery/page-input.ts';
      const uiPath = '/src/ui/scan/website-discovery.ts';
      const { createPageInput } = await import(inputPath);
      const { mountWebsiteDiscovery } = await import(uiPath);
      const input = createPageInput();
      const container = document.createElement('section');
      document.body.append(container);
      const mounted = mountWebsiteDiscovery(container, {
        inspect: (url: string, allowHttp: boolean, signal: AbortSignal) =>
          input.inspect(url, allowHttp, signal),
        reviewSource: () => {},
      });
      Reflect.set(window, 'layoutWebsite', { input, mounted });
      mounted.open();
    });
    const dialog = page.getByRole('dialog', { name: 'Find sources on a website' });
    await dialog
      .getByLabel('Website URL', { exact: true })
      .fill('http://127.0.0.1:1420/layout-website');
    await dialog.getByRole('checkbox', { name: /Allow unencrypted HTTP/ }).check();
    await dialog.getByRole('button', { name: 'Scan website', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('55 possible sources found');
    return dialog;
  }
  if (await page.getByLabel('Viewing panel').isVisible())
    await page.getByLabel('Viewing panel').selectOption(screen === 'watch' ? 'watch' : 'channels');
  return page.locator('#app');
}
for (const size of sizes)
  for (const screen of screens) {
    const textFactor = size.width === 960 ? 1 : 2;
    test(`${screen} ${size.width}x${size.height} populated ${textFactor * 100}% text`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(size);
      await populate(
        page,
        screen.startsWith('guide-') || screen.startsWith('sharing-') || screen === 'website',
      );
      if (size.width === 960)
        await page.locator('#app').evaluate((root) => {
          (root as HTMLElement).dataset.deviceKind = 'tv';
        });
      const scope = await openScreen(page, screen);
      // Snapshot computed sizes before assigning any: no compounded inheritance or CSS zoom.
      await scope.evaluate((root, textFactor) => {
        const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')].filter(
          (node): node is HTMLElement => node instanceof HTMLElement,
        );
        const sizes = nodes.map((node) => ({
          node,
          size: parseFloat(getComputedStyle(node).fontSize),
        }));
        const persistentRows = document.createElement('style');
        persistentRows.textContent = ['.channel-copy strong', '.channel-copy small']
          .map((selector) => {
            const sample = sizes.find(({ node }) => node.matches(selector));
            return sample ? `${selector}{font-size:${sample.size * textFactor}px !important}` : '';
          })
          .join('\n');
        document.head.append(persistentRows);
        for (const { node, size } of sizes) node.style.fontSize = `${size * textFactor}px`;
      }, textFactor);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (
        ['channels', 'watch'].includes(screen) &&
        (await page.getByLabel('Viewing panel').isVisible())
      )
        await page
          .getByLabel('Viewing panel')
          .selectOption(screen === 'watch' ? 'watch' : 'channels');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const findings = await scope.evaluate((root) => {
        const errors: string[] = [];
        const channelList = root.querySelector<HTMLElement>('.channel-list');
        if (channelList?.getClientRects().length && channelList.clientHeight < 40)
          errors.push('channel list has insufficient visible space');
        const rect = root.getBoundingClientRect();
        const label = (node: Element) =>
          node.id ||
          node.getAttribute('aria-label') ||
          node.textContent?.trim().slice(0, 80) ||
          node.tagName;
        if (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1
        )
          errors.push(
            `surface outside viewport: ${JSON.stringify({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })}`,
          );
        if (
          document.documentElement.scrollHeight > innerHeight + 1 ||
          document.documentElement.scrollWidth > innerWidth + 1
        )
          errors.push('outer page scroll');
        if (
          root instanceof HTMLDialogElement &&
          (root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1)
        )
          errors.push('outer dialog scroll; expected inner panel only');
        for (const control of root.querySelectorAll<HTMLElement>('button,input,select,summary')) {
          if (!control.getClientRects().length || control.closest('dialog:not([open])')) continue;
          // Closed details may retain descendant layout boxes in Chromium. Only their
          // direct summary is actionable; do not mistake hidden Advanced controls for
          // fixed navigation. Open disclosures retain every clipping/hit-test check.
          let hiddenDisclosure = false;
          for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
              const summary = ancestor.querySelector(':scope > summary');
              if (!summary?.contains(control)) hiddenDisclosure = true;
            }
            if (ancestor === root) break;
          }
          if (hiddenDisclosure) continue;
          const box = control.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          if (box.left < rect.left - 1 || box.right > rect.right + 1)
            errors.push(`horizontal control clipping: ${label(control)}`);
          if (
            root.id === 'app' &&
            control instanceof HTMLButtonElement &&
            !control.closest('.channel-list')
          ) {
            if (box.top < -1 || box.bottom > innerHeight + 1)
              errors.push(`main action outside viewport: ${label(control)}`);
            const x = Math.min(innerWidth - 1, Math.max(0, (box.left + box.right) / 2)),
              y = Math.min(innerHeight - 1, Math.max(0, (box.top + box.bottom) / 2));
            if (!control.contains(document.elementFromPoint(x, y)))
              errors.push(`main action covered: ${label(control)}`);
          }
          if (control instanceof HTMLButtonElement) {
            if (
              control.scrollWidth > control.clientWidth + 1 ||
              control.scrollHeight > control.clientHeight + 1
            )
              errors.push(`button content clipped: ${label(control)}`);
            const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (!node.textContent?.trim()) continue;
              const parent = node.parentElement;
              if (
                !parent ||
                !parent.getClientRects().length ||
                getComputedStyle(parent).visibility === 'hidden'
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const style = getComputedStyle(parent);
              const intentionalChannelEllipsis =
                control.classList.contains('channel') &&
                parent.closest('.channel-copy') &&
                style.textOverflow === 'ellipsis' &&
                style.overflowX === 'hidden' &&
                style.whiteSpace === 'nowrap' &&
                control.textContent?.includes(node.textContent!);
              for (const textBox of range.getClientRects())
                if (
                  (!intentionalChannelEllipsis &&
                    (textBox.left < box.left - 1 || textBox.right > box.right + 1)) ||
                  textBox.top < box.top - 1 ||
                  textBox.bottom > box.bottom + 1
                ) {
                  errors.push(`button text cropped: ${label(control)}`);
                  break;
                }
              const copy = control.querySelector<HTMLElement>('.channel-copy');
              if (copy) {
                const copyBox = copy.getBoundingClientRect();
                if (copyBox.top < box.top - 1 || copyBox.bottom > box.bottom + 1)
                  errors.push(`channel copy vertically clipped: ${label(control)}`);
              }
            }
          }
          if (
            control instanceof HTMLButtonElement &&
            /^(Close|Done|Back|More programs|First programs|Save selected|Run action)/.test(
              control.getAttribute('aria-label') || control.textContent?.trim() || '',
            )
          ) {
            if (box.top < -1 || box.bottom > innerHeight + 1)
              errors.push(`fixed/navigation action unreachable: ${label(control)}`);
            const x = Math.min(innerWidth - 1, Math.max(0, (box.left + box.right) / 2)),
              y = Math.min(innerHeight - 1, Math.max(0, (box.top + box.bottom) / 2));
            if (!control.contains(document.elementFromPoint(x, y)))
              errors.push(`fixed/navigation action covered: ${label(control)}`);
          }
        }
        return [...new Set(errors)];
      });
      await testInfo.attach('layout-findings', {
        body: JSON.stringify(
          {
            screen,
            viewport: size,
            textFactor,
            fixtureSeed: '55-channel-50-program-55-reference-v1',
            browser: page.context().browser()?.version(),
            findings,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      expect(
        findings,
        `${screen} ${size.width}x${size.height} at ${textFactor * 100}% text`,
      ).toEqual([]);
    });
  }
