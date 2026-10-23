import { beforeAll, afterAll, it, expect } from 'vitest';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: {
        entry: 'tests/catalog/fixtures/archive-downloads.ts',
        name: 'Downloads',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw Error('Missing fixture bundle');
  const chunk = output.output.find((e) => e.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw Error('Missing fixture chunk');
  bundle = chunk.code;
  css = (
    await Promise.all(
      ['style', 'archive-search', 'responsive', 'media-results', 'tv-density'].map((n) =>
        readFile(`src/ui/${n}.css`, 'utf8'),
      ),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

it.each(['loc', 'nasa'] as const)(
  'public %s files retain originals, source facts and safe rights without fake Play or Download',
  async (provider) => {
    const page = await mount(960, true);
    try {
      await page.evaluate(async (provider) => {
        await Reflect.get(window, 'fixture').dispose();
        document.getElementById('app')!.innerHTML =
          '<input id="public-search" value="train"><div id="public-library"></div>';
        const titleRef = 'c'.repeat(64),
          title = {
            favorite: false,
            titleRef,
            title: 'The great train robbery',
            kind: 'movie',
            releaseYear: provider === 'nasa' ? null : 1903,
            curated: false,
            titleProvenance: 'provider-item',
            fileCount: 2,
            durationSeconds: null,
            rights: 'Attribution <img src=x onerror=alert(1)>',
            rank: 0,
            quality: 'metadata-listed',
            observedMs: 1,
            providerId: provider,
            sourceUrl:
              provider === 'nasa'
                ? 'https://images-assets.nasa.gov/video/00694220/collection.json'
                : 'https://www.loc.gov/item/00694220/',
          };
        const facts = {
          providerId: provider,
          sourceUrl: title.sourceUrl,
          mimeType: 'video/mp4',
          videoCodec: null,
          audioCodec: null,
          width: null,
          height: null,
          representationRole: 'derivative',
          contentRole: null,
          rights: title.rights,
          licenseUrl: null,
          attribution: provider === 'nasa' ? 'NASA' : 'Library of Congress',
          ...(provider === 'nasa'
            ? {
                dateClaims: {
                  schemaVersion: 1,
                  providerCreated: {
                    field: 'date_created',
                    value: '2021-01-30T00:00:00Z',
                    provenance: 'provider-search-record',
                  },
                },
              }
            : {}),
          downloadAllowed: true,
          accessRestricted: false,
          playbackCandidate: true,
          downloadSupported: false,
          unsupportedReason: null,
        };
        const files = [
          {
            fileRef: 'a'.repeat(64),
            title: 'Streaming copy',
            fileName: 'stream.mp4',
            itemId: '00694220',
            format: 'video/mp4',
            durationSeconds: null,
            sizeBytes: null,
            availability: 'unverified',
            observedMs: 1,
            providerFacts: facts,
          },
          {
            fileRef: 'b'.repeat(64),
            title: 'Disc original',
            fileName: 'original.iso',
            itemId: '00694220',
            format: 'ISO',
            durationSeconds: null,
            sizeBytes: null,
            availability: 'unverified',
            observedMs: 1,
            providerFacts: {
              ...facts,
              mimeType: null,
              representationRole: 'original',
              playbackCandidate: false,
              unsupportedReason: 'This disc image cannot be played by this app.',
            },
          },
        ];
        let selected = 0;
        const ui = Reflect.get(window, 'Downloads').mountArchiveSearch(
          document.getElementById('public-library'),
          {
            input: document.getElementById('public-search'),
            readyScope: () => 'root',
            onSelect: async () => {
              selected++;
            },
            catalog: {
              query: async () => ({
                schemaVersion: 1,
                revision: '8',
                offset: 0,
                totalCount: 1,
                items: [title],
                more: false,
              }),
              files: async () => ({
                schemaVersion: 1,
                revision: '8',
                titleRef,
                offset: 0,
                totalCount: 2,
                files,
                more: false,
              }),
            },
          },
        );
        await ui.resume();
        Reflect.set(window, 'publicView', { ui, selected: () => selected });
      }, provider);
      await page.locator('.gx-archive-title-button').click();
      await browserExpect(page.locator('.gx-archive-file-row')).toHaveCount(2);
      await browserExpect(
        page
          .locator('.gx-archive-file-row')
          .nth(1)
          .getByRole('button', { name: 'Play Disc original', exact: true }),
      ).toBeDisabled();
      await page.locator('.gx-archive-file-details>summary').nth(1).click();
      const facts = page
        .locator('.gx-archive-file-details')
        .nth(1)
        .locator('.gx-archive-file-facts');
      await browserExpect(facts).toContainText('This disc image cannot be played by this app.');
      await browserExpect(facts).toContainText('Not listed');
      await browserExpect(facts).toContainText(
        provider === 'nasa' ? 'NASA' : 'Library of Congress',
      );
      if (provider === 'nasa') {
        await browserExpect(facts).toContainText('Original release yearUnknown');
        await browserExpect(facts).toContainText('NASA provider-created date2021-01-30T00:00:00Z');
        await browserExpect(facts).toContainText('NASA search record · date_created');
        await browserExpect(page.locator('.gx-archive-result-subtitle')).not.toContainText('2021');
      }
      await browserExpect(
        page.locator('#public-library').getByRole('button', { name: 'Download', exact: true }),
      ).toHaveCount(0);
      expect(await page.locator('#public-library img[src="x"]').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'publicView').selected())).toBe(0);
      await page
        .locator('.gx-archive-file-row')
        .first()
        .getByRole('button', { name: 'Play Streaming copy', exact: true })
        .click();
      expect(await page.evaluate(() => Reflect.get(window, 'publicView').selected())).toBe(1);
      expect(await page.locator('#public-search').inputValue()).toBe('train');
    } finally {
      await page.evaluate(() => Reflect.get(window, 'publicView')?.ui.dispose());
      await page.close();
    }
  },
);
async function mount(width: number, tv: boolean, saved = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 540 } });
  await page.setContent(
    `<div id="app" data-device-kind="${tv ? 'tv' : 'handheld'}" style="display:block;height:100vh;padding:10px"><section class="gx-archive-search"><details id="file" open><summary>Chosen video details</summary></details></section></div>`,
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async (saved) => {
    const D = Reflect.get(window, 'Downloads'),
      entry = {
        downloadRef: 'a'.repeat(64),
        fileRef: 'b'.repeat(64),
        titleRef: 'c'.repeat(64),
        title: 'Controlled title',
        fileTitle: 'Controlled episode',
        fileName: 'episode.mp4',
        sizeBytes: '100',
        completedMs: 1000,
        integrity: 'sha1-verified',
        available: true,
      };
    let complete!: (v: unknown) => void, report!: (v: unknown) => void;
    const selected: string[] = [],
      removed: string[] = [];
    let starts = 0,
      stop = 0;
    const owner = D.createArchiveDownloads({
      readyScope: () => 'root',
      native: {
        list: async () => ({
          schemaVersion: 1,
          revision: saved ? '1' : '0',
          entries: saved ? [entry] : [],
        }),
        status: async () => null,
        start: async (_f: string, _r: string, _s: AbortSignal, p: (v: unknown) => void) => {
          starts++;
          report = p;
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
        remove: async (ref: string, revision: string) => {
          removed.push(ref);
          return {
            schemaVersion: 1,
            committed: true,
            revision: String(Number(revision) + 1),
            changed: true,
            downloadRef: ref,
            cleanupPending: false,
          };
        },
        stop: async () => {
          stop++;
        },
      },
    });
    await owner.refresh();
    const view = D.mountArchiveDownloads(document.querySelector('.gx-archive-search'), {
      downloads: owner,
      play: async (e: { downloadRef: string }) => {
        selected.push(e.downloadRef);
      },
    });
    document.getElementById('file')!.append(view.fileControls(entry.fileRef, '7'));
    Reflect.set(window, 'fixture', {
      owner,
      view,
      selected,
      removed,
      starts: () => starts,
      stop: () => stop,
      report: (phase: string) =>
        report({
          schemaVersion: 1,
          requestId: 'test',
          fileRef: entry.fileRef,
          jobId: 'd'.repeat(64),
          phase,
          receivedBytes: '100',
          totalBytes: '100',
        }),
      finish: () =>
        complete({ schemaVersion: 1, committed: true, revision: '1', changed: true, entry }),
      dispose: async () => {
        await view.dispose();
        await owner.dispose();
      },
    });
  }, saved);
  return page;
}
it('real file controls keep Saving until receipt, retain one download while browsing, and require explicit Play saved', async () => {
  const page = await mount(854, false);
  try {
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Cancel download', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => Reflect.get(window, 'fixture').report('saving'));
    await browserExpect(page.locator('.gx-archive-download-progress')).toHaveText(
      'Saving download…',
    );
    await browserExpect(
      page.getByRole('button', { name: 'Play saved', exact: true }),
    ).not.toBeVisible();
    await page.locator('#file>summary').click();
    await page.evaluate(() => Reflect.get(window, 'fixture').finish());
    await browserExpect(page.locator('.gx-archive-download-progress')).toHaveText(
      'Saved on this device.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').selected)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').starts())).toBe(1);
    await page.locator('.gx-archive-downloads>details>summary').click();
    await page
      .locator('.gx-archive-saved-row')
      .getByRole('button', { name: 'Play saved', exact: true })
      .click();
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').selected)).toEqual([
      'a'.repeat(64),
    ]);
    await page
      .locator('.gx-archive-saved-row')
      .getByRole('button', { name: 'Remove download', exact: true })
      .click();
    await browserExpect(page.locator('.gx-archive-saved-row')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').removed)).toEqual([
      'a'.repeat(64),
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'fixture').dispose());
    await page.close();
  }
});
for (const [width, tv] of [
  [320, false],
  [854, false],
  [960, true],
] as const)
  it(`saved metadata/actions remain readable and bounded at ${width} TV=${tv}`, async () => {
    const page = await mount(width, tv, true);
    try {
      await page.locator('.gx-archive-downloads>details>summary').click();
      for (const button of await page.locator('.gx-archive-downloads button:visible').all()) {
        const b = await button.boundingBox();
        expect(b).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(0);
        expect(b!.x + b!.width).toBeLessThanOrEqual(width);
        expect(b!.height).toBeGreaterThanOrEqual(tv ? 34 : 44);
      }
      await page.locator('#file').getByRole('button', { name: 'Play saved', exact: true }).focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').selected)).toEqual([
        'a'.repeat(64),
      ]);
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').starts())).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'fixture').dispose());
      await page.close();
    }
  });

it('actual Archive file disclosure binds Download while browsing stays independent and never auto-plays', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(1500);
  try {
    await page.setContent(
      '<div id="app" data-content-library="genxtra" data-device-kind="tv" style="display:block;height:100vh"><input id="search"><div id="library" style="height:480px"></div></div>',
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(async () => {
      const D = Reflect.get(window, 'Downloads'),
        ref = 'c'.repeat(64),
        file = 'b'.repeat(64);
      let complete!: (v: unknown) => void,
        started = 0,
        played = 0;
      const entry = {
        downloadRef: 'a'.repeat(64),
        fileRef: file,
        titleRef: ref,
        title: 'Controlled title',
        fileTitle: 'Episode one',
        fileName: 'episode.mp4',
        sizeBytes: '100',
        completedMs: 1,
        integrity: 'size-verified',
        available: true,
      };
      const owner = D.createArchiveDownloads({
        readyScope: () => 'root',
        native: {
          list: async () => ({ schemaVersion: 1, revision: '0', entries: [] }),
          status: async () => null,
          remove: async () => {
            throw Error('Unexpected removal');
          },
          stop: async () => {},
          start: async () => {
            started++;
            return new Promise((resolve) => {
              complete = resolve;
            });
          },
        },
      });
      await owner.refresh();
      const title = {
        titleRef: ref,
        title: 'Controlled title',
        kind: 'tv',
        releaseYear: 1972,
        curated: true,
        titleProvenance: 'provider-item',
        fileCount: 1,
        durationSeconds: 100,
        rights: null,
        rank: 1,
        quality: 'metadata-h264',
        observedMs: 1,
        favorite: false,
      };
      const ui = D.mountArchiveSearch(document.getElementById('library'), {
        input: document.getElementById('search'),
        readyScope: () => 'root',
        downloads: owner,
        onPlaySaved: async () => {
          played++;
        },
        onSelect: async () => {
          played++;
        },
        catalog: {
          query: async () => ({
            schemaVersion: 1,
            revision: '7',
            offset: 0,
            totalCount: 1,
            items: [title],
            more: false,
          }),
          files: async () => ({
            schemaVersion: 1,
            revision: '7',
            titleRef: ref,
            offset: 0,
            totalCount: 1,
            files: [
              {
                fileRef: file,
                title: 'Episode one',
                fileName: 'episode.mp4',
                itemId: 'controlled',
                format: 'h.264',
                durationSeconds: 100,
                sizeBytes: '100',
                availability: 'unverified',
                observedMs: 1,
              },
            ],
          }),
        },
      });
      await ui.resume();
      Reflect.set(window, 'integrated', {
        ui,
        owner,
        started: () => started,
        played: () => played,
        finish: () =>
          complete({ schemaVersion: 1, committed: true, revision: '1', changed: true, entry }),
      });
    });
    await page.locator('.gx-archive-title-button').click();
    await page.locator('.gx-archive-file-details>summary').click();
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'integrated').started())).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'integrated').ui.query('another browse query'));
    await page.evaluate(() => Reflect.get(window, 'integrated').finish());
    await browserExpect(page.locator('.gx-archive-download-progress')).toHaveText(
      'Saved on this device.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'integrated').played())).toBe(0);
    await page.locator('.gx-archive-downloads>details>summary').click();
    await page
      .locator('.gx-archive-saved-row')
      .getByRole('button', { name: 'Play saved', exact: true })
      .click();
    expect(await page.evaluate(() => Reflect.get(window, 'integrated').played())).toBe(1);
  } finally {
    await page.evaluate(async () => {
      const f = Reflect.get(window, 'integrated');
      if (f) {
        await f.ui.dispose();
        await f.owner.dispose();
      }
    });
    await page.close();
  }
});

it('saved initializer cancellation and disposal join the raw failure; tab preservation does not abort it', async () => {
  const page = await mount(854, false, true);
  try {
    await page.evaluate(async () => {
      const original = Reflect.get(window, 'fixture');
      await original.view.dispose();
      let reject!: (error: unknown) => void;
      const work = new Promise<void>((_r, no) => {
        reject = no;
      });
      let signal: AbortSignal | null = null;
      const view = Reflect.get(window, 'Downloads').mountArchiveDownloads(
        document.querySelector('.gx-archive-search'),
        {
          downloads: original.owner,
          play: async (_entry: unknown, _rev: string, owned: AbortSignal) => {
            signal = owned;
            await work;
          },
        },
      );
      Reflect.set(window, 'heldView', {
        view,
        started: () => signal !== null,
        aborted: () => signal?.aborted,
        reject: () => reject(new Error('Controlled native cleanup failure')),
        dispose: async () => {
          try {
            await view.dispose();
            return 'resolved';
          } catch {
            return 'rejected';
          }
        },
      });
    });
    await page.locator('.gx-archive-downloads>details>summary').click();
    await page
      .locator('.gx-archive-saved-row')
      .getByRole('button', { name: 'Play saved', exact: true })
      .click();
    await browserExpect
      .poll(() => page.evaluate(() => Reflect.get(window, 'heldView').started()))
      .toBe(true);
    await page.evaluate(() => Reflect.get(window, 'heldView').view.suspend(true));
    expect(await page.evaluate(() => Reflect.get(window, 'heldView').aborted())).toBe(false);
    await page.evaluate(() =>
      Reflect.set(window, 'disposeObserved', Reflect.get(window, 'heldView').dispose()),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'heldView').aborted())).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'heldView').reject());
    expect(await page.evaluate(() => Reflect.get(window, 'disposeObserved'))).toBe('rejected');
    // Exact task is settled now; disposal retries have no abandoned initializer.
    await page.evaluate(() => Reflect.get(window, 'heldView').view.dispose());
  } finally {
    await page.evaluate(() => Reflect.get(window, 'fixture').dispose());
    await page.close();
  }
});

it('cold retained tombstone exposes Retry removal and no Play, then joins exact stop before native retry', async () => {
  const page = await mount(854, false, true);
  try {
    await page.evaluate(async () => {
      const old = Reflect.get(window, 'fixture');
      await old.dispose();
      const D = Reflect.get(window, 'Downloads'),
        events: string[] = [],
        entry = {
          downloadRef: 'a'.repeat(64),
          fileRef: 'b'.repeat(64),
          titleRef: 'c'.repeat(64),
          title: 'Controlled title',
          fileTitle: 'Controlled episode',
          fileName: 'episode.mp4',
          sizeBytes: '100',
          completedMs: 1000,
          integrity: 'sha1-verified',
          available: false,
          cleanupPending: true,
        };
      const owner = D.createArchiveDownloads({
        readyScope: () => 'root',
        beforeRemove: async (ref: string) => {
          events.push(`stop-${ref}`);
        },
        native: {
          list: async () => ({ schemaVersion: 1, revision: '2', entries: [entry] }),
          start: async () => {
            throw Error('No acquisition allowed');
          },
          status: async () => null,
          stop: async () => {},
          remove: async (ref: string, rev: string) => {
            events.push(`remove-${ref}-${rev}`);
            return {
              schemaVersion: 1,
              committed: true,
              revision: rev,
              changed: false,
              downloadRef: ref,
              cleanupPending: false,
            };
          },
        },
      });
      await owner.resume();
      const view = D.mountArchiveDownloads(document.querySelector('.gx-archive-search'), {
        downloads: owner,
        play: async () => {
          throw Error('Tombstone cannot play');
        },
      });
      document.getElementById('file')!.append(view.fileControls(entry.fileRef, '7'));
      Reflect.set(window, 'coldCleanup', {
        events,
        dispose: async () => {
          await view.dispose();
          await owner.dispose();
        },
      });
    });
    await page.locator('.gx-archive-downloads>details>summary').click();
    await browserExpect(page.locator('.gx-archive-saved-row')).toContainText(
      'Removal cleanup pending',
    );
    await browserExpect(
      page
        .locator('.gx-archive-saved-row')
        .getByRole('button', { name: 'Play saved', exact: true }),
    ).toBeHidden();
    const retry = page
      .locator('.gx-archive-saved-row')
      .getByRole('button', { name: 'Retry removal', exact: true });
    await browserExpect(retry).toBeEnabled();
    await retry.click();
    await browserExpect(page.locator('.gx-archive-saved-row')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'coldCleanup').events)).toEqual([
      `stop-${'a'.repeat(64)}`,
      `remove-${'a'.repeat(64)}-2`,
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'coldCleanup')?.dispose());
    await page.close();
  }
});
