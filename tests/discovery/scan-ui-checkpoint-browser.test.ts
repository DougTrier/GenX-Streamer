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
 * Scan screen in a real browser: timeouts, durable checkpoints, entry
 * admission and suspension.
 */
import { expect, it } from 'vitest';
import { useScanUiBrowser, fixture } from './scan-ui-browser.fixture';

useScanUiBrowser();

for (const invalid of ['foreign', 'stale', 'canceled'] as const)
  it(`a ${invalid} probe remains unverified while its settled sibling publishes and cold Continue rechecks only the untrusted key`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await page.evaluate((invalidKind) => {
        Reflect.set(window, 'candidateCount', 2);
        Reflect.set(window, 'parallelOrigins', true);
        Reflect.set(window, 'commitAdvances', true);
        Reflect.set(window, 'badProbeReply', true);
        const host = Reflect.get(window, 'scanHost'),
          probe = host.probe,
          prepare = host.checkpoint.prepare;
        host.probe = async (...args: unknown[]) => {
          const reply = await probe(...args);
          if (Reflect.get(window, 'badProbeReply') && reply.channelId.endsWith(':1'))
            return invalidKind === 'foreign'
              ? { ...reply, fingerprint: 'foreign' }
              : invalidKind === 'stale'
                ? { ...reply, observedAt: 1699999999999 }
                : { ...reply, evidence: { kind: 'canceled' } };
          return reply;
        };
        host.checkpoint.prepare = async (
          snapshot: { observations: { verdict: string }[] },
          signal: AbortSignal,
        ) => {
          if (
            snapshot.observations.some((observation) =>
              ['NotChecked', 'Canceled'].includes(observation.verdict),
            )
          )
            throw new Error('Unsettled checkpoint observations are forbidden');
          return prepare(snapshot, signal);
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, invalid);
      await page.waitForFunction(
        () =>
          !Reflect.get(window, 'scan').snapshot().busy &&
          Reflect.get(window, 'scan').snapshot().checked === 1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
        checked: 1,
        responded: 1,
        published: 1,
      });
      await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'persisted').observations.map(
            (observation: { verdict: string }) => observation.verdict,
          ),
        ),
      ).toEqual(['Reachable']);
      expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
        1,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(1);
      await page.evaluate(async () => {
        await Reflect.get(window, 'scan').dispose();
        Reflect.set(window, 'badProbeReply', false);
        Reflect.set(
          window,
          'scan',
          Reflect.get(window, 'ScanUI').mountSourceScan(
            document.getElementById('scan'),
            Reflect.get(window, 'scanHost'),
          ),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
        'unfinished',
      );
      await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'scan').snapshot().published === 2 &&
          !Reflect.get(window, 'scan').snapshot().busy,
      );
      const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
      expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
      expect(probes.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(2);
    } finally {
      await page.close();
    }
  });
it('trusted timeout stays settled and unpublished across Stop and cold Continue while only interrupted keys recheck', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 20);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'probeFailName', 'Alpha 0');
      Reflect.set(window, 'heldTimeoutPeers', 0);
      const host = Reflect.get(window, 'scanHost'),
        probe = host.probe;
      host.probe = async (
        ...args: [candidate: { channel: { name: string } }, signal: AbortSignal, budgetMs?: number]
      ) => {
        const reply = await probe(...args);
        const index = Number(args[0].channel.name.split(' ')[1]);
        if (index >= 17 && !Reflect.get(window, 'timeoutColdResume')) {
          await new Promise<void>((resolve) => {
            args[1].addEventListener(
              'abort',
              () =>
                setTimeout(() => {
                  Reflect.set(window, 'closedProbes', Reflect.get(window, 'closedProbes') + 1);
                  resolve();
                }, 40),
              { once: true },
            );
            Reflect.set(window, 'heldTimeoutPeers', Reflect.get(window, 'heldTimeoutPeers') + 1);
          });
        }
        return reply;
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'heldTimeoutPeers') === 3 &&
        Reflect.get(window, 'persisted')?.publishedKeys.length === 16,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const stopped = await page.evaluate(() => ({
      state: Reflect.get(window, 'scan').snapshot(),
      checkpoint: Reflect.get(window, 'persisted'),
      closed: Reflect.get(window, 'closedProbes'),
    }));
    expect(stopped.closed).toBe(3);
    expect(stopped.state).toMatchObject({ checked: 17, responded: 16, published: 16, busy: false });
    expect(stopped.checkpoint.observations).toHaveLength(17);
    const timeout = stopped.checkpoint.observations.find(
      (item: { verdict: string }) => item.verdict === 'TimedOut',
    );
    expect(timeout.evidence).toEqual({ kind: 'timeout' });
    expect(stopped.checkpoint.publishedKeys).not.toContain(timeout.channelId);
    expect(
      stopped.checkpoint.observations.some((item: { verdict: string }) =>
        ['Canceled', 'NotChecked'].includes(item.verdict),
      ),
    ).toBe(false);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'timeoutColdResume', true);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().checked)).toBe(17);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 19,
      undefined,
      { timeout: 6000 },
    );
    const resumed = await page.evaluate(() => ({
      state: Reflect.get(window, 'scan').snapshot(),
      checkpoint: Reflect.get(window, 'persisted'),
      probes: Reflect.get(window, 'probes'),
      collections: Reflect.get(window, 'collectCalls'),
      names: Reflect.get(window, 'commits').flatMap(
        (commit: { staged: { sources: { candidates: { name: string }[] }[] } }) =>
          commit.staged.sources.flatMap((source) =>
            source.candidates.map((candidate) => candidate.name),
          ),
      ),
    }));
    expect(resumed.state).toMatchObject({ checked: 20, responded: 19, published: 19, busy: false });
    expect(resumed.probes).toHaveLength(23);
    for (let index = 0; index < 20; index++)
      expect(resumed.probes.filter((key: string) => key.endsWith(`:${index}`))).toHaveLength(
        index < 17 ? 1 : 2,
      );
    expect(resumed.collections).toBe(2);
    expect(resumed.checkpoint.observations).toHaveLength(20);
    expect(
      resumed.checkpoint.observations.find(
        (item: { channelId: string }) => item.channelId === timeout.channelId,
      ),
    ).toEqual(timeout);
    expect(resumed.checkpoint.publishedKeys).not.toContain(timeout.channelId);
    expect(resumed.names).not.toContain('Alpha 0');
    expect(new Set(resumed.names).size).toBe(19);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'completed',
    );
  } finally {
    await page.close();
  }
});
it('untrusted checks present paused Continue and cold admission rechecks only the unfinished key', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 2);
      Reflect.set(window, 'parallelOrigins', true);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.set(window, 'untrustedPresentationReply', true);
      const host = Reflect.get(window, 'scanHost'),
        probe = host.probe;
      host.probe = async (
        ...args: [candidate: { channel: { name: string } }, signal: AbortSignal, budgetMs?: number]
      ) => {
        const reply = await probe(...args);
        return Reflect.get(window, 'untrustedPresentationReply') && reply.channelId.endsWith(':1')
          ? { ...reply, evidence: { kind: 'canceled' } }
          : reply;
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().checked === 1,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'paused',
      checked: 1,
      published: 1,
      lastFailure: 'none',
    });
    await expect
      .poll(() => page.getByRole('status').textContent())
      .toContain('Finish scan to retry unfinished checks');
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('Some checks were not confirmed');
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').observations.length)).toBe(1);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'untrustedPresentationReply', false);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(
      () =>
        !Reflect.get(window, 'scan').snapshot().busy &&
        Reflect.get(window, 'scan').snapshot().published === 2,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      phase: 'completed',
      checked: 2,
      published: 2,
      lastFailure: 'none',
    });
    const probes = await page.evaluate(() => Reflect.get(window, 'probes'));
    expect(probes.filter((key: string) => key.endsWith(':0'))).toHaveLength(1);
    expect(probes.filter((key: string) => key.endsWith(':1'))).toHaveLength(2);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
  } finally {
    await page.close();
  }
});
it('durable automatic checkpoint restarts without recollection or acknowledged probes', async () => {
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
        Reflect.get(window, 'commits').length === 1 && Reflect.get(window, 'probes').length === 20,
      undefined,
      { timeout: 6000 },
    );
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').suspend();
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
      Reflect.set(window, 'probeMode', 'normal');
    });
    const beforeEntry = await page.evaluate(() => ({
      collects: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes').length,
      commits: Reflect.get(window, 'commits').length,
    }));
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unfinished',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot())).toMatchObject({
      total: 20,
      checked: 16,
      responded: 16,
      published: 16,
      lastFailure: 'none',
      busy: false,
    });
    expect(
      await page.evaluate(() => ({
        collects: Reflect.get(window, 'collectCalls'),
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
      })),
    ).toEqual(beforeEntry);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 2);
    const result = await page.evaluate(() => ({
      collects: Reflect.get(window, 'collectCalls'),
      probes: Reflect.get(window, 'probes'),
      saved: Reflect.get(window, 'persisted'),
      writes: Reflect.get(window, 'checkpointWrites'),
    }));
    expect(result.collects).toBe(2);
    expect(result.probes).toHaveLength(24);
    expect(new Set(result.probes.slice(0, 16)).size).toBe(16);
    expect(result.probes.slice(20)).toEqual(result.probes.slice(16, 20));
    expect(result.saved.publishedKeys).toHaveLength(20);
    expect(result.writes.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'completed',
    );
  } finally {
    await page.close();
  }
});
it('entry admission coalesces an owned cold read and never probes or reopens a closed dialog', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'checkpointLoadMode', 'blocked');
      const scan = Reflect.get(window, 'scan');
      const first = scan.prepareAutomaticEntry();
      Reflect.set(window, 'entrySame', first === scan.prepareAutomaticEntry());
      Reflect.set(window, 'entryWork', first);
    });
    await page.waitForFunction(() => Reflect.get(window, 'checkpointLoads') === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'entrySame'))).toBe(true);
    await page.getByRole('button', { name: 'Close scan review' }).click();
    await page.evaluate(async () => {
      await Reflect.get(window, 'entryWork');
    });
    expect(
      await page
        .locator('dialog.source-scan-dialog')
        .evaluate((el) => (el as HTMLDialogElement).open),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('fresh entry checks ownership without starting and invalid progress cannot masquerade as fresh', async () => {
  const page = await fixture(true, true, false, true);
  try {
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'fresh',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointLoads'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'activity'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'probes'))).toEqual([]);
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').dispose();
      Reflect.set(window, 'invalidCheckpoint', true);
      Reflect.set(
        window,
        'scan',
        Reflect.get(window, 'ScanUI').mountSourceScan(
          document.getElementById('scan'),
          Reflect.get(window, 'scanHost'),
        ),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'scan').prepareAutomaticEntry())).toBe(
      'unavailable',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'commits'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'scan').rescanAutomatic());
    await page.waitForFunction(() => Reflect.get(window, 'checkpointDiscards').length === 1);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'scan').dispose());
    await page.close();
  }
});
it('invalid durable checkpoint refuses implicit restart and requires exact-owner Rescan', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'invalidCheckpoint', true);
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('could not resume');
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'scan').startAutomatic());
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    await page.getByRole('button', { name: 'Scan configured sources' }).click();
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards')[0].jobId)).toBe(
      'known-invalid',
    );
  } finally {
    await page.close();
  }
});
it('background resumes same hidden automatic owner while explicit Cancel stays stopped', async () => {
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
        Reflect.get(window, 'probes').length === 20 && Reflect.get(window, 'commits').length === 1,
      undefined,
      { timeout: 6000 },
    );
    await page.getByRole('button', { name: 'Close scan review' }).click();
    await page.evaluate(async () => {
      await Reflect.get(window, 'scan').suspend();
      Reflect.set(window, 'probeMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'probes').length === 24 && Reflect.get(window, 'commits').length === 2,
    );
    expect(
      await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(24);
    await page.evaluate(() => {
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').rescanAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 40);
    await page.getByRole('button', { name: 'Cancel operation', includeHidden: true }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('dialog button[aria-label="Scan configured sources"]')
          ?.hasAttribute('disabled'),
    );
    const count = await page.evaluate(() => Reflect.get(window, 'probes').length);
    await page.evaluate(() => Reflect.get(window, 'scan').resume());
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(count);
  } finally {
    await page.close();
  }
});
it('suspension joins a late checkpoint read and resumes collection only on explicit foreground admission', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'checkpointLoadMode', 'blocked');
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitAdvances', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'checkpointLoads') === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').suspend());
    expect(await page.evaluate(() => Reflect.get(window, 'closedCheckpointLoads'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    await page.evaluate(async () => {
      Reflect.set(window, 'checkpointLoadMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
  } finally {
    await page.close();
  }
});
it('checkpoint persistence failure rejects suspension acknowledgement and preserves RAM retry', async () => {
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
        Reflect.get(window, 'probes').length === 20 && Reflect.get(window, 'commits').length === 1,
      undefined,
      { timeout: 6000 },
    );
    const rejected = await page.evaluate(async () => {
      Reflect.set(window, 'checkpointSaveMode', 'fail');
      try {
        await Reflect.get(window, 'scan').suspend();
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'persisted').publishedKeys.length)).toBe(
      16,
    );
    await page.evaluate(async () => {
      Reflect.set(window, 'checkpointSaveMode', 'normal');
      Reflect.set(window, 'probeMode', 'normal');
      await Reflect.get(window, 'scan').resume();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 2);
    expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(24);
  } finally {
    await page.close();
  }
});
it('dispose retains the acknowledged stopped checkpoint without preparing or saving after native admission freezes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const saved = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
    const writes = await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length);
    expect(writes).toBe(2); // Initial checkpoint plus joined Stop checkpoint.
    await page.evaluate(async () => {
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
      await Reflect.get(window, 'scan').dispose();
      await Reflect.get(window, 'scan').dispose();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'forbiddenCheckpointCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'checkpointWrites').length)).toBe(writes);
    expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(saved);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});
