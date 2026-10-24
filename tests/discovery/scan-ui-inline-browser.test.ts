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

/**
 * Scan screen in a real browser: inline automatic scans, the initial durable
 * collection and Stop.
 */
import { expect, it } from 'vitest';
import { useScanUiBrowser, fixture, installMutationSeam } from './scan-ui-browser.fixture';

useScanUiBrowser();

for (const suspendFirst of [false, true])
  it(`dispose joins active probes ${suspendFirst ? 'and pending suspension' : 'directly'} while retaining the last paired checkpoint`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'candidateCount', 20);
        Reflect.set(window, 'parallelOrigins', true);
        Reflect.set(window, 'probeMode', 'batch');
        Reflect.set(window, 'commitAdvances', true);
        Reflect.get(window, 'scan').startAutomatic();
      });
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'probes').length === 20 &&
          Reflect.get(window, 'persisted')?.publishedKeys.length === 16,
        undefined,
        { timeout: 6000 },
      );
      const saved = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
      await page.evaluate(async (withSuspension) => {
        const checkpoint = Reflect.get(window, 'scanHost').checkpoint;
        Reflect.set(window, 'forbiddenCheckpointCalls', 0);
        checkpoint.prepare = checkpoint.save = async () => {
          Reflect.set(
            window,
            'forbiddenCheckpointCalls',
            Reflect.get(window, 'forbiddenCheckpointCalls') + 1,
          );
          throw new Error('application-closing');
        };
        const scan = Reflect.get(window, 'scan');
        const suspension = withSuspension ? scan.suspend() : Promise.resolve();
        await Promise.all([suspension, scan.dispose()]);
      }, suspendFirst);
      expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(4);
      expect(await page.evaluate(() => Reflect.get(window, 'forbiddenCheckpointCalls'))).toBe(0);
      expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(
        saved,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
      expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
it('automatic review admits another origin while sixteen earlier same-origin candidates wait and Stop joins both', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 17);
      Reflect.set(window, 'fairOrigins', true);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 2);
    const before = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes'),
      closed: Reflect.get(window, 'closedProbes'),
      commits: Reflect.get(window, 'commits'),
    }));
    expect(before.probes[0]).toMatch(/:0$/);
    expect(before.probes[1]).toMatch(/:16$/);
    expect(before.closed).toBe(0);
    expect(before.commits).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel operation' }).click();
    await page.getByText('Review retained.', { exact: true }).waitFor();
    const after = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes'),
      closed: Reflect.get(window, 'closedProbes'),
      commits: Reflect.get(window, 'commits'),
    }));
    expect(after.probes).toEqual(before.probes);
    expect(after.closed).toBe(2);
    expect(after.commits).toHaveLength(0);
  } finally {
    await page.close();
  }
});
it('automatic publications share one immutable review without changing captured membership', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      const host = Reflect.get(window, 'scanHost');
      const prepare = host.checkpoint.prepare;
      const captures: unknown[] = [];
      Reflect.set(window, 'captureChecks', captures);
      let previous: unknown;
      host.checkpoint.prepare = (
        snapshot: {
          review: { candidates: { channel: { urls: string[] } }[] };
          observations: unknown[];
        },
        signal: AbortSignal,
      ) => {
        const channel = snapshot.review.candidates[0].channel;
        const before = channel.urls[0];
        const mutated = Reflect.set(channel.urls, '0', 'https://foreign.invalid/');
        captures.push({
          frozen: Object.isFrozen(snapshot.review) && Object.isFrozen(channel.urls),
          mutated,
          unchanged: channel.urls[0] === before,
          sameReview: previous === undefined || previous === snapshot.review,
          observations: snapshot.observations.length,
        });
        previous = snapshot.review;
        return prepare(snapshot, signal);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('130 channels saved.', { exact: true }).waitFor();
    const captures = await page.evaluate(() => Reflect.get(window, 'captureChecks'));
    expect(captures.length).toBeGreaterThanOrEqual(2);
    for (const capture of captures)
      expect(capture).toMatchObject({
        frozen: true,
        mutated: false,
        unchanged: true,
        sameReview: true,
      });
    expect(captures[0].observations).toBeLessThan(captures.at(-1).observations);
  } finally {
    await page.close();
  }
});
it('collection settled notification waits for canceled readers before releasing metadata', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'collectMode', 'blocked');
      Reflect.set(window, 'settledReaders', []);
      Reflect.get(window, 'scanHost').onCollectionSettled = () => {
        Reflect.get(window, 'settledReaders').push(Reflect.get(window, 'closedReaders'));
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'collectCalls') === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'settledReaders'))).toEqual([]);
    await page.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'settledReaders').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'settledReaders'))).toEqual([2]);
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
  } finally {
    await page.close();
  }
});
it('inline automatic query filters before probes and publishes observational progress without a modal', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'inlineProgress', []);
      Reflect.set(window, 'modalCalls', 0);
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        Reflect.set(window, 'modalCalls', Reflect.get(window, 'modalCalls') + 1);
        return show.call(this);
      };
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) => {
        Reflect.get(window, 'inlineProgress').push(event);
        throw new Error('observational failure');
      };
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: ' Alpha   1 ',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'modalCalls'))).toBe(0);
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(11);
    const events = await page.evaluate(() => Reflect.get(window, 'inlineProgress'));
    expect(events.at(-1)).toMatchObject({
      query: 'Alpha 1',
      presentation: 'inline',
      checked: 11,
      published: 11,
      busy: false,
    });
    const names = await page.evaluate(() =>
      Reflect.get(window, 'commits').flatMap(
        (entry: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          entry.staged.sources.flatMap((source) =>
            source.candidates.map((channel) => channel.name),
          ),
      ),
    );
    expect(names).toHaveLength(11);
    expect(names.every((name: string) => name.includes('Alpha 1'))).toBe(true);
  } finally {
    await page.close();
  }
});
it('inline Stop joins admitted probes and Continue retains query while a different query requires Rescan', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'partial');
      Reflect.set(window, 'inlineProgress', []);
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) =>
        Reflect.get(window, 'inlineProgress').push(event);
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Alpha 1',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 11);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(11);
    const before = await page.evaluate(() => ({
      probes: Reflect.get(window, 'probes').length,
      collects: Reflect.get(window, 'collectCalls'),
    }));
    await page.evaluate(() =>
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      }),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    expect(
      await page.evaluate(() => Reflect.get(window, 'inlineProgress').at(-1).scopeRefusal),
    ).toBe('query-changed');
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(before.probes);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collects);
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    await page.evaluate(() =>
      Reflect.get(window, 'scan').rescanAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      }),
    );
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Other');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(
      before.collects + 2,
    );
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});
it('inline cold checkpoint refuses a different query before checking without opening recovery modal', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Alpha 1',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'completed');
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'coldProgress', []);
      Reflect.set(window, 'probes', []);
      Reflect.get(window, 'scanHost').onProgress = (event: unknown) =>
        Reflect.get(window, 'coldProgress').push(event);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan')!,
          Reflect.get(window, 'scanHost'),
        ),
      );
      await Reflect.get(window, 'scan').prepareAutomaticEntry();
      Reflect.get(window, 'scan').startAutomatic(undefined, {
        query: 'Other',
        presentation: 'inline',
      });
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').automaticQuery)).toBe('Alpha 1');
    expect(await page.evaluate(() => Reflect.get(window, 'coldProgress').at(-1))).toMatchObject({
      scopeRefusal: 'query-changed',
      presentation: 'inline',
    });
    expect(await page.locator('dialog').evaluate((node) => (node as HTMLDialogElement).open)).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});
it('initial durable collection waits for actual ACK before any probe and loadedjob avoidsinitialrewrite', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.save;
      host.checkpoint.save = async (...args: unknown[]) => {
        Reflect.set(window, 'initialEntered', true);
        await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toMatchObject({
      observations: [],
      publishedKeys: [],
      platform: 'Fixture',
      observerProfile: 'inspection-v1',
    });
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'scanHost');
      host.checkpoint.save = async () => ({ committed: true, checkpointRevision: '2' });
      await Reflect.get(window, 'scan').stopAutomatic();
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'probes', []);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(document.getElementById('scan'), host),
      );
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
  } finally {
    await page.close();
  }
});
it.each(['failure', 'cas'])(
  'initial durable %s prevents allprobes andpublication',
  async (mode) => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((mode) => {
        const host = Reflect.get(window, 'scanHost');
        host.checkpoint.save = async () => {
          throw new Error(mode === 'cas' ? 'catalog-revision-stale' : 'Controlled write failure');
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, mode);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().phase === 'failed',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toBeNull();
    } finally {
      await page.close();
    }
  },
);
it('Stop joins heldinitialwrite and retainslateirreversibleACK withoutobsoleteprobes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.save;
      let first = true;
      host.checkpoint.save = async (...args: unknown[]) => {
        if (first) {
          first = false;
          Reflect.set(window, 'initialEntered', true);
          await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        }
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    await page.evaluate(() => {
      Reflect.set(window, 'stopDone', false);
      Reflect.set(
        window,
        'stopWork',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'stopDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.evaluate(() => Reflect.get(window, 'stopWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toMatchObject({
      observations: [],
      publishedKeys: [],
    });
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointRevision'))).toBe('2');
  } finally {
    await page.close();
  }
});
it('wholecapture refusal isexplicitRAM-only andemptyjobneverstartsprobeorwrites', async () => {
  for (const empty of [false, true]) {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((empty) => {
        Reflect.set(window, 'candidateCount', empty ? -1 : 1);
        Reflect.set(window, 'commitAdvances', true);
        const host = Reflect.get(window, 'scanHost');
        host.checkpoint.prepare = async () => null;
        Reflect.get(window, 'scan').startAutomatic();
      }, empty);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().phase === 'completed',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(empty ? 0 : 1);
      if (!empty)
        expect(await page.getByRole('alert').textContent()).toContain('restart requires Rescan');
    } finally {
      await page.close();
    }
  }
});
it('initial mutation write also prevents probes until exact ACK', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      const host = Reflect.get(window, 'scanHost'),
        save = host.checkpoint.saveMutation;
      host.checkpoint.saveMutation = async (...args: unknown[]) => {
        Reflect.set(window, 'initialEntered', true);
        await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        return save(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'initialMutationAcks'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'initialMutationAcks'))).toEqual([
      { revision: '1' },
    ]);
  } finally {
    await page.close();
  }
});
it('Stop joins canceled initialpreparation then saves with freshsignal without obsoleteprobes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      const host = Reflect.get(window, 'scanHost'),
        prepare = host.checkpoint.prepare;
      let first = true;
      host.checkpoint.prepare = async (...args: unknown[]) => {
        if (first) {
          first = false;
          Reflect.set(window, 'initialEntered', true);
          await new Promise((resolve) => Reflect.set(window, 'releaseInitial', resolve));
        }
        return prepare(...args);
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'initialEntered'));
    await page.evaluate(() => {
      Reflect.set(window, 'stopDone', false);
      Reflect.set(
        window,
        'stopWork',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'stopDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopDone'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseInitial')());
    await page.evaluate(() => Reflect.get(window, 'stopWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
  } finally {
    await page.close();
  }
});
it('Stop owns late episode setup and joins its disposal before becoming available', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'episodeDisposed', false);
      Reflect.get(window, 'scanHost').beginSelectionEpisode = async () => {
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseEpisodeSetup', resolve));
        return {
          episodeId: 'late-episode',
          dispose: async () => {
            await new Promise<void>((resolve) =>
              Reflect.set(window, 'releaseEpisodeDispose', resolve),
            );
            Reflect.set(window, 'episodeDisposed', true);
          },
        };
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseEpisodeSetup') === 'function',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'episodeStopDone', false);
      Reflect.set(
        window,
        'episodeStop',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(() => Reflect.set(window, 'episodeStopDone', true)),
      );
      Reflect.get(window, 'releaseEpisodeSetup')();
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseEpisodeDispose') === 'function',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'episodeStopDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseEpisodeDispose')());
    await page.evaluate(() => Reflect.get(window, 'episodeStop'));
    expect(await page.evaluate(() => Reflect.get(window, 'episodeDisposed'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
  } finally {
    await page.close();
  }
});
