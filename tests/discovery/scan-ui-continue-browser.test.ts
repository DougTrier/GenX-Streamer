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
 * Scan screen in a real browser: Continue and Rescan.
 */
import { expect, it } from 'vitest';
import { useScanUiBrowser, continueFixture, fixture } from './scan-ui-browser.fixture';

useScanUiBrowser();

for (const drift of ['none', 'checkpoint', 'catalog', 'profile', 'invalid'] as const)
  it(`a null-prepared RAM-only Continue admits only its current owned scope with ${drift} drift`, async () => {
    const page = await continueFixture(false, true);
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
      }));
      expect(await page.evaluate(() => Reflect.get(window, 'persisted'))).toBeNull();
      await page.evaluate(async (change) => {
        if (change === 'checkpoint') Reflect.set(window, 'checkpointRevision', '1');
        if (change === 'catalog') Reflect.set(window, 'revision', 'foreign-catalog');
        if (change === 'profile') Reflect.set(window, 'profile', 'foreign-profile');
        if (change === 'invalid') Reflect.set(window, 'invalidCheckpoint', true);
        Reflect.set(window, 'badContinueReply', false);
        Reflect.get(window, 'scanHost').onProgress = (progress: unknown) =>
          Reflect.set(window, 'ramContinueProgress', progress);
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, drift);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collects);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites'))).toEqual([]);
      if (drift === 'none') {
        expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().published)).toBe(2);
        expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(
          before.probes + 1,
        );
        expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(
          before.commits + 1,
        );
      } else {
        expect(
          await page.evaluate(() => Reflect.get(window, 'ramContinueProgress').resumeRefusal),
        ).toBeDefined();
        expect(
          await page.evaluate(() => ({
            probes: Reflect.get(window, 'probes').length,
            commits: Reflect.get(window, 'commits').length,
            collects: Reflect.get(window, 'collectCalls'),
          })),
        ).toEqual(before);
      }
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
for (const change of [
  'url',
  'key',
  'order',
  'source-location',
  'http-grant',
  'declared-format',
] as const)
  it(`Continue refuses changed immutable ${change} despite an unchanged job and checkpoint revision`, async () => {
    const page = await continueFixture(change === 'declared-format');
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
        revision: Reflect.get(window, 'checkpointRevision'),
      }));
      await page.evaluate(async (kind) => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.onProgress = (progress: unknown) => Reflect.set(window, 'captureRefusal', progress);
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal),
            parsed = structuredClone(saved.parsed);
          if (kind === 'url') parsed.review.candidates[1].channel.urls[0] += '/different';
          else if (kind === 'key') parsed.review.candidates[1].key += '-different';
          else if (kind === 'order') parsed.review.candidates.reverse();
          else if (kind === 'source-location')
            parsed.sourceDefinitions[0].source.location += '/different';
          else if (kind === 'http-grant') parsed.sourceDefinitions[0].source.allowHttp = true;
          else parsed.sourceDefinitions[0].source.contentKind = 'media';
          return { ...saved, parsed };
        };
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, change);
      expect(await page.evaluate(() => Reflect.get(window, 'captureRefusal').resumeRefusal)).toBe(
        'changed',
      );
      expect(
        await page.evaluate(() => ({
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          collects: Reflect.get(window, 'collectCalls'),
          revision: Reflect.get(window, 'checkpointRevision'),
        })),
      ).toEqual(before);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
for (const race of ['missing', 'changed', 'completed', 'refused'] as const)
  it(`Continue never collects a fresh scan when ${race} changes after entry preparation`, async () => {
    const page = await continueFixture();
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
        'unfinished',
      );
      const before = await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        discards: Reflect.get(window, 'checkpointDiscards').length,
        counts: Reflect.get(window, 'scan').snapshot(),
      }));
      await page.evaluate(async (reason) => {
        Reflect.set(window, 'resumeProgress', []);
        Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
          Reflect.get(window, 'resumeProgress').push(p);
        if (reason === 'missing') Reflect.set(window, 'persisted', null);
        else if (reason === 'refused') Reflect.set(window, 'invalidCheckpoint', true);
        else if (reason === 'changed')
          Reflect.set(
            window,
            'checkpointRevision',
            String(Number(Reflect.get(window, 'checkpointRevision')) + 1),
          );
        else {
          const cp = Reflect.get(window, 'persisted');
          const key = cp.review.candidates[1].key;
          cp.observations.push({ ...cp.observations[0], channelId: key });
          cp.publishedKeys.push(key);
        }
        await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      }, race);
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          discards: Reflect.get(window, 'checkpointDiscards').length,
        })),
      ).toEqual({
        collect: before.collect,
        probes: before.probes,
        commits: before.commits,
        discards: before.discards,
      });
      expect(
        await page.evaluate(() => Reflect.get(window, 'resumeProgress').at(-1).resumeRefusal),
      ).toBe(race === 'refused' ? 'unavailable' : race);
      await page.evaluate(async () => {
        const scan = Reflect.get(window, 'scan');
        await scan.continueAutomatic({ presentation: 'inline' });
        scan.startAutomatic(undefined, { presentation: 'inline' });
      });
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
        })),
      ).toEqual({ collect: before.collect, probes: before.probes });
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
        lastFailure: 'other',
        total: before.counts.total,
        checked: before.counts.checked,
        responded: before.counts.responded,
        published: before.counts.published,
      });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('structural unfinished summary cannot authorize fresh collection after its checkpoint disappears', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(async () => {
      const scan = Reflect.get(window, 'scan');
      document.querySelector<HTMLDialogElement>('dialog.source-scan-dialog')!.close();
      Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
        Reflect.set(window, 'continueProgress', p);
      scan.presentSavedSummary(
        {
          schemaVersion: 1,
          checkpointStatus: 'valid',
          storedVersion: 3,
          total: 20,
          checked: 10,
          responded: 8,
          published: 8,
          unfinished: true,
          catalogRevision: '0',
          checkpointRevision: '0',
        },
        scan.snapshot().generation,
      );
      await scan.continueAutomatic({ presentation: 'inline' });
    });
    expect(await page.evaluate(() => Reflect.get(window, 'continueProgress'))).toMatchObject({
      resumeRefusal: 'missing',
      total: 20,
      checked: 10,
      responded: 8,
      published: 8,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards'))).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('Continue double-click owns one fresh admission and checks only the same job remaining key', async () => {
  const page = await continueFixture();
  try {
    const before = await page.evaluate(() => ({
      collect: Reflect.get(window, 'collectCalls'),
      loads: Reflect.get(window, 'checkpointLoads'),
      job: Reflect.get(window, 'persisted').jobId,
    }));
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost'),
        load = host.checkpoint.load;
      host.checkpoint.load = async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseContinueRead', resolve));
        return load(signal);
      };
      Reflect.set(window, 'badContinueReply', false);
      const scan = Reflect.get(window, 'scan');
      const first = scan.continueAutomatic({ presentation: 'inline' });
      Reflect.set(
        window,
        'continueSamePromise',
        first === scan.continueAutomatic({ presentation: 'inline' }),
      );
      Reflect.set(window, 'continuePromise', first);
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseContinueRead') === 'function',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'continueSamePromise'))).toBe(true);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseContinueRead')();
      await Reflect.get(window, 'continuePromise');
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      published: 2,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(before.collect);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').jobId)).toBe(before.job);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointLoads'))).toBe(
      before.loads + 1,
    );
    const keys = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(keys.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    expect(keys.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
for (const action of ['stop', 'dispose'] as const)
  it(`Continue ${action} joins a held actual admission and suppresses obsolete completion`, async () => {
    const page = await continueFixture();
    try {
      const before = await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        writes: Reflect.get(window, 'checkpointWrites').length,
      }));
      await page.evaluate(() => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal);
          await new Promise<void>((resolve) =>
            Reflect.set(window, 'releaseJoinedContinue', resolve),
          );
          return saved;
        };
        Reflect.set(
          window,
          'admissionPromise',
          Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' }),
        );
      });
      await page.waitForFunction(
        () => typeof Reflect.get(window, 'releaseJoinedContinue') === 'function',
      );
      await page.evaluate((action) => {
        Reflect.set(window, 'continueShutdownSettled', false);
        const scan = Reflect.get(window, 'scan');
        const joined = action === 'stop' ? scan.stopAutomatic() : scan.dispose();
        Reflect.set(
          window,
          'continueShutdown',
          joined.then(() => Reflect.set(window, 'continueShutdownSettled', true)),
        );
      }, action);
      expect(await page.evaluate(() => Reflect.get(window, 'continueShutdownSettled'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(
        before.writes,
      );
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseJoinedContinue')();
        await Reflect.get(window, 'admissionPromise');
        await Reflect.get(window, 'continueShutdown');
      });
      expect(
        await page.evaluate(() => ({
          collect: Reflect.get(window, 'collectCalls'),
          probes: Reflect.get(window, 'probes').length,
        })),
      ).toEqual({ collect: before.collect, probes: before.probes });
      expect(await page.evaluate(() => Reflect.get(window, 'continueShutdownSettled'))).toBe(true);
      if (action === 'dispose')
        expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(
          before.writes,
        );
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
it('admitted Continue retains new durable published counts when later checkpoint persistence fails', async () => {
  const page = await continueFixture();
  try {
    await page.evaluate(async () => {
      Reflect.set(window, 'badContinueReply', false);
      Reflect.set(window, 'checkpointSaveMode', 'fail');
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      published: 2,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      2,
    );
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('failed explicit Rescan discard retains definitive Continue refusal and all saved records', async () => {
  const page = await continueFixture();
  try {
    await page.evaluate(async () => {
      Reflect.get(window, 'scanHost').onProgress = (p: unknown) =>
        Reflect.set(window, 'rescanProgress', p);
      Reflect.set(window, 'invalidCheckpoint', true);
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      Reflect.get(window, 'scanHost').checkpoint.discard = async () => {
        throw new Error('private-discard-failure');
      };
      Reflect.get(window, 'scan').rescanAutomatic(undefined, { presentation: 'inline' });
    });
    await page.waitForFunction(() => !Reflect.get(window, 'scan').snapshot().busy);
    expect(await page.evaluate(() => Reflect.get(window, 'rescanProgress').resumeRefusal)).toBe(
      'unavailable',
    );
    const before = await page.evaluate(() => ({
      collect: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes').length,
      commits: Reflect.get(window, 'commits').length,
    }));
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' });
      Reflect.get(window, 'scan').startAutomatic(undefined, { presentation: 'inline' });
    });
    expect(
      await page.evaluate(() => ({
        collect: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
      })),
    ).toEqual(before);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
