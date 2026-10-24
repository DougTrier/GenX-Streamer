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
 * Scan screen in a real browser: automatic scans, publication windows and
 * selection episodes.
 */
import { expect, it } from 'vitest';
import { useScanUiBrowser, fixture, installSelectionEpisode } from './scan-ui-browser.fixture';

useScanUiBrowser();

it('Scan checks every one of 2001 candidates and Save needs no individual selections', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 2001);
      Reflect.set(window, 'probeFailName', 'Alpha 2000');
    });
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Save selected channels' }).isEnabled(), {
        timeout: 10000,
      })
      .toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(2001);
    expect(await page.getByRole('checkbox').count()).toBe(0);
    expect(await page.getByLabel('Candidate channels').locator('li').count()).toBe(50);
    expect(await page.getByRole('status').textContent()).toContain(
      '2000 channels responded. 1 could not be verified',
    );
    expect(await page.getByLabel('Scan review action').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Save selected channels' }).click();
    await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    const saved = await page.evaluate(() => Reflect.get(window, 'commits')[0]);
    expect(saved.staged.sources[0].candidates).toHaveLength(2000);
    expect(saved.health.observations).toHaveLength(2000);
    expect(
      saved.health.observations.every((o: { verdict: string }) => o.verdict === 'Reachable'),
    ).toBe(true);
  } finally {
    await page.close();
  }
});
it('automatic Scan cancellation joins the current probe and never checks later candidates or enables Save', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'probeMode', 'partial'));
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'probes').length >= 2);
    const started = await page.evaluate(() => Reflect.get(window, 'probes').length);
    expect(started).toBeLessThanOrEqual(5);
    await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Scan configured sources' }).isDisabled()).toBe(
      true,
    );
    await expect
      .poll(() => page.getByRole('button', { name: 'Scan configured sources' }).isDisabled())
      .toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(started - 1);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(started);
    expect(await page.getByLabel('Candidate channels').textContent()).toContain('Alpha 0');
    expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
      true,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
  } finally {
    await page.close();
  }
});
for (const outcome of ['responded', 'none', 'cancel'] as const) {
  it(`one-action automatic save ${outcome} retains checked publication ownership`, async () => {
    const page = await fixture(true, true);
    try {
      await page.evaluate((mode) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'commitAdvances', true);
        if (mode === 'none') Reflect.set(window, 'probeFailName', 'Alpha 0');
        if (mode === 'cancel') Reflect.set(window, 'probeMode', 'blocked');
        Reflect.get(window, 'scan').startAutomatic();
      }, outcome);
      if (outcome === 'cancel') {
        await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
        await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      }
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
      );
      expect(await page.getByLabel('Search scan results').isVisible()).toBe(false);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isVisible()).toBe(
        false,
      );
      expect(await page.getByText('Advanced', { exact: true }).isVisible()).toBe(false);
      const commits = await page.evaluate(() => Reflect.get(window, 'commits'));
      expect(commits).toHaveLength(outcome === 'responded' ? 1 : 0);
      if (outcome === 'responded') {
        expect(commits[0].staged.sources[0].candidates).toHaveLength(1);
        expect(commits[0].health.observations[0].verdict).toBe('Reachable');
        expect(await page.getByRole('status').textContent()).toBe('1 channel saved.');
      }
      if (outcome === 'none')
        expect(await page.getByRole('status').textContent()).toBe(
          'No channels responded. Nothing was added.',
        );
      if (outcome === 'cancel')
        expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(1);
    } finally {
      await page.close();
    }
  });
}
it('automatic hidden progress keeps checking and stopped scan resumes without recollection or duplicate batches', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'partial');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length >= 16);
    const dialog = page.getByRole('dialog', { name: 'Review source scan' });
    await dialog.getByRole('button', { name: 'Close scan review' }).click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    const before = await page.evaluate(() => Reflect.get(window, 'probes').length);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(before);
    await dialog.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
    );
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('20 channels saved.', { exact: true }).waitFor();
    const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    const commits = await page.evaluate(() => Reflect.get(window, 'commits'));
    expect(
      commits.flatMap((entry: { staged: { sources: { candidates: unknown[] }[] } }) =>
        entry.staged.sources.flatMap((source) => source.candidates),
      ),
    ).toHaveLength(20);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('negotiated publication windows ACK first64 then four logical chunks once after Stop joins', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      Reflect.set(window, 'windowCheckpointKeys', []);
      host.checkpoint.prepareMutation = async (
        snapshot: { publishedKeys: string[] },
        signal: AbortSignal,
        _revision: string,
        limit: number,
        keys?: readonly string[],
      ) => {
        if (keys)
          Reflect.get(window, 'windowCheckpointKeys').push({
            cumulative: snapshot.publishedKeys.length,
            keys: [...keys],
            limit,
          });
        return { kind: 'save', checkpoint: await host.checkpoint.prepare(snapshot, signal) };
      };
      host.checkpoint.saveMutation = async (
        mutation: { checkpoint: string },
        revision: string,
        checkpointRevision: string,
        signal: AbortSignal,
      ) => host.checkpoint.save(mutation.checkpoint, revision, checkpointRevision, signal);
      const begin = host.beginSelectionEpisode;
      host.beginSelectionEpisode = async (...args: unknown[]) => ({
        ...(await begin(...args)),
        supportsWindow: true,
      });
      const commit = host.commit;
      Reflect.set(window, 'windows', []);
      host.commitWindow = async (
        chunks: { staged: unknown; health?: unknown }[],
        revision: string,
        signal: AbortSignal,
        checkpoint: unknown,
        episodeId: string,
      ) => {
        Reflect.get(window, 'windows').push(chunks);
        if (Reflect.get(window, 'windows').length === 2)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseWindow', resolve));
        return commit(
          chunks[0]!.staged,
          revision,
          signal,
          chunks[0]!.health,
          checkpoint,
          episodeId,
        );
      };
      Reflect.set(window, 'candidateCount', 320);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(() => Reflect.get(window, 'windows').length === 2);
    const sizes = await page.evaluate(() =>
      Reflect.get(window, 'windows').map((chunks: { health: { candidates: unknown[] } }[]) =>
        chunks.map((chunk) => chunk.health.candidates.length),
      ),
    );
    expect(sizes).toEqual([[64], [64, 64, 64, 64]]);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'windowCheckpointKeys').map(
          (entry: { cumulative: number; keys: string[]; limit: number }) => ({
            cumulative: entry.cumulative,
            newlyPublished: entry.keys.length,
            limit: entry.limit,
          }),
        ),
      ),
    ).toEqual([
      { cumulative: 64, newlyPublished: 64, limit: 256 },
      { cumulative: 320, newlyPublished: 256, limit: 256 },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(64);
    await page.evaluate(() => {
      Reflect.set(window, 'stopJoined', false);
      Reflect.get(window, 'scan')
        .stopAutomatic()
        .then(() => Reflect.set(window, 'stopJoined', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'stopJoined'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseWindow')());
    await page.waitForFunction(() => Reflect.get(window, 'stopJoined'));
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(320);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      320,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('an unnegotiated episode keeps64-entry legacy commits even when a window hook exists', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      host.commitWindow = async () => {
        throw new Error('Window must not be dispatched');
      };
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 130,
    );
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'commits').map(
          (commit: { health: { candidates: unknown[] } }) => commit.health.candidates.length,
        ),
      ),
    ).toEqual([64, 64, 2]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('a known predispatch size refusal preserves unACKed checks for explicit smaller Continue', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      const begin = host.beginSelectionEpisode;
      host.beginSelectionEpisode = async (...args: unknown[]) => ({
        ...(await begin(...args)),
        supportsWindow: true,
      });
      const commit = host.commit;
      Reflect.set(window, 'windowSizes', []);
      host.commitWindow = async (
        chunks: { staged: unknown; health: { candidates: unknown[] } }[],
        revision: string,
        signal: AbortSignal,
        checkpoint: unknown,
        episodeId: string,
      ) => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.health.candidates.length, 0);
        Reflect.get(window, 'windowSizes').push(size);
        if (size > 64) throw new (Reflect.get(window, 'ScanUI').SourceScanWindowSizeError)();
        return commit(
          chunks[0]!.staged,
          revision,
          signal,
          chunks[0]!.health,
          checkpoint,
          episodeId,
        );
      };
      Reflect.set(window, 'candidateCount', 320);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().phase === 'failed',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(64);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      64,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'windowSizes'))).toEqual([64, 256]);
    const checkedKeys = await page.evaluate(() => Reflect.get(window, 'probes'));
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'scanHost'),
        load = host.checkpoint.load;
      host.checkpoint.load = async (signal: AbortSignal) => {
        const saved = await load(signal);
        // Real wire omits undefined; collection may fill previously unknown format metadata.
        const parsed = JSON.parse(JSON.stringify(saved.parsed));
        for (const definition of parsed.sourceDefinitions) {
          definition.source.contentKind = 'catalog';
          definition.source.mediaMime = 'audio/x-mpegurl';
        }
        return { ...saved, parsed };
      };
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 320,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual(checkedKeys);
    expect(await page.evaluate(() => Reflect.get(window, 'windowSizes'))).toEqual([
      64, 256, 64, 64, 64, 64,
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('one selection episode owns multiple automatic publications after initial checkpoint ACK', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 130);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 130,
      undefined,
      { timeout: 6000 },
    );
    expect(await page.evaluate(() => Reflect.get(window, 'selectionEpisodes'))).toEqual([
      {
        episodeId: 'episode-1',
        generation: expect.any(Number),
        revision: 'review-1',
        sources: 2,
        scopes: 1,
        initialAcknowledged: true,
      },
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'commitEpisodes'))).toEqual([
      'episode-1',
      'episode-1',
      'episode-1',
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
    ]);
  } finally {
    await page.close();
  }
});
it('Stop reconciles admitted settled observations blocked behind publisher capacity before durable ACK and Continue', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installSelectionEpisode(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 80);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 80 &&
        Reflect.get(window, 'commits').length === 1 &&
        Reflect.get(window, 'scan').snapshot().checked < 80,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(() => {
      Reflect.set(window, 'stoppingCapacity', Reflect.get(window, 'scan').stopAutomatic());
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'resolveCommit')());
    await page.evaluate(() => Reflect.get(window, 'stoppingCapacity'));
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
    ]);
    const counts = await page.evaluate(() => ({
      snapshot: Reflect.get(window, 'scan').snapshot(),
      settled: Reflect.get(window, 'persisted').observations.length,
      responded: Reflect.get(window, 'persisted').observations.filter(
        (record: { verdict: string }) => ['Reachable', 'PlayedHere'].includes(record.verdict),
      ).length,
      published: Reflect.get(window, 'persisted').publishedKeys.length,
      firstAckNames: Reflect.get(window, 'commits')[0].staged.sources.flatMap(
        (source: { candidates: { name: string }[] }) =>
          source.candidates.map((candidate) => candidate.name),
      ),
    }));
    expect(counts.settled).toBe(80);
    expect(counts.responded).toBe(80);
    expect(counts.firstAckNames).toHaveLength(64);
    expect(counts.published).toBe(counts.firstAckNames.length);
    expect(counts.snapshot).toMatchObject({
      busy: false,
      checked: counts.settled,
      responded: counts.responded,
      published: counts.published,
    });
    await page.evaluate(() => {
      Reflect.set(window, 'commitMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 80,
      undefined,
      { timeout: 6000 },
    );
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(80);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
    const batches = await page.evaluate(() =>
      Reflect.get(window, 'commits').map(
        (commit: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          commit.staged.sources.flatMap((source) =>
            source.candidates.map((candidate) => candidate.name),
          ),
      ),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commitEpisodes'))).toEqual([
      'episode-1',
      'episode-2',
    ]);
    expect(await page.evaluate(() => Reflect.get(window, 'selectionDisposals'))).toEqual([
      'episode-1',
      'episode-2',
    ]);
    expect(batches.map((batch: string[]) => batch.length)).toEqual([64, 16]);
    expect(new Set(batches.flat()).size).toBe(80);
  } finally {
    await page.close();
  }
});
it('automatic batches publish while later probes are pending, retain acknowledged channels on Cancel and Resume only remaining work', async () => {
  const page = await fixture(true, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeMode', 'batch');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'commits').length === 1 && Reflect.get(window, 'probes').length === 20,
      undefined,
      { timeout: 6000 },
    );
    expect(
      await page.evaluate(
        () => Reflect.get(window, 'commits')[0].staged.sources[0].candidates.length,
      ),
    ).toBe(16);
    const dialog = page.getByRole('dialog', { name: 'Review source scan' });
    await dialog.getByRole('button', { name: 'Cancel operation' }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Done'),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'closedProbes'))).toBe(4);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'normal');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.getByText('20 channels saved.', { exact: true }).waitFor();
    const state = await page.evaluate(() => ({
      commits: Reflect.get(window, 'commits'),
      probes: Reflect.get(window, 'probes'),
    }));
    expect(state.commits).toHaveLength(2);
    expect(state.commits[1].staged.sources[0].candidates).toHaveLength(4);
    expect(state.probes).toHaveLength(24);
    expect(
      new Set(
        state.commits.flatMap((entry: { health: { observations: { channelId: string }[] } }) =>
          entry.health.observations.map((observation) => observation.channelId),
        ),
      ).size,
    ).toBe(20);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
