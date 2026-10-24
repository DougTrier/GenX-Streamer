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
 * Scan screen in a real browser: checkpoint mutation acknowledgements,
 * closing and disposing.
 */
import { expect, it } from 'vitest';
import {
  useScanUiBrowser,
  continueFixture,
  fixture,
  installMutationSeam,
} from './scan-ui-browser.fixture';

useScanUiBrowser();

for (const action of ['stop', 'dispose', 'catalog', 'profile'] as const)
  it(`Continue comparison yields to ${action} and rechecks ownership before retaining RAM`, async () => {
    const page = await continueFixture(false, false, 130);
    try {
      const before = await page.evaluate(() => ({
        probes: Reflect.get(window, 'probes').length,
        commits: Reflect.get(window, 'commits').length,
        collects: Reflect.get(window, 'collectCalls'),
      }));
      await page.evaluate(() => {
        const host = Reflect.get(window, 'scanHost'),
          load = host.checkpoint.load;
        host.onProgress = (progress: unknown) => Reflect.set(window, 'yieldedProgress', progress);
        host.checkpoint.load = async (signal: AbortSignal) => {
          const saved = await load(signal);
          const realTimeout = window.setTimeout;
          // Hold only the first zero-delay comparison slice. The timer itself executes;
          // its continuation remains owned until the test explicitly releases it.
          window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (delay !== 0) return realTimeout(callback, delay, ...args);
            window.setTimeout = realTimeout;
            return realTimeout(
              () =>
                Reflect.set(window, 'releaseComparisonSlice', () => {
                  if (typeof callback !== 'function')
                    throw new Error('Expected owned comparison callback');
                  callback(...args);
                }),
              0,
            );
          }) as typeof window.setTimeout;
          return { ...saved, parsed: JSON.parse(JSON.stringify(saved.parsed)) };
        };
        Reflect.set(window, 'badContinueReply', false);
        Reflect.set(
          window,
          'yieldedContinue',
          Reflect.get(window, 'scan').continueAutomatic({ presentation: 'inline' }),
        );
      });
      await page.waitForFunction(
        () => typeof Reflect.get(window, 'releaseComparisonSlice') === 'function',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      await page.evaluate((kind) => {
        if (kind === 'catalog') Reflect.set(window, 'revision', 'changed-during-comparison');
        else if (kind === 'profile') Reflect.set(window, 'profile', 'changed-during-comparison');
        else {
          const scan = Reflect.get(window, 'scan');
          Reflect.set(window, 'comparisonActionDone', false);
          Reflect.set(
            window,
            'comparisonAction',
            (kind === 'stop' ? scan.stopAutomatic() : scan.dispose()).then(() =>
              Reflect.set(window, 'comparisonActionDone', true),
            ),
          );
        }
      }, action);
      if (action === 'stop' || action === 'dispose') {
        expect(await page.evaluate(() => Reflect.get(window, 'comparisonActionDone'))).toBe(false);
        expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      }
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseComparisonSlice')();
        await Reflect.get(window, 'yieldedContinue');
        await Reflect.get(window, 'comparisonAction');
      });
      expect(
        await page.evaluate(() => ({
          probes: Reflect.get(window, 'probes').length,
          commits: Reflect.get(window, 'commits').length,
          collects: Reflect.get(window, 'collectCalls'),
        })),
      ).toEqual(before);
      if (action === 'catalog' || action === 'profile')
        expect(
          await page.evaluate(() => Reflect.get(window, 'yieldedProgress').resumeRefusal),
        ).toBe('changed');
    } finally {
      await page.evaluate(() => Reflect.get(window, 'scan').dispose());
      await page.close();
    }
  });
for (const fails of [false, true])
  it(`owned Stop joins one held checkpoint ${fails ? 'failure' : 'ACK'} and blocks repeated Stop/Continue/Rescan admission`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((rejects) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'probeMode', 'blocked');
        Reflect.set(window, 'rejectMutationSave', rejects);
        Reflect.get(window, 'scan').startAutomatic();
      }, fails);
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan'),
          first = scan.stopAutomatic(),
          second = scan.stopAutomatic();
        Reflect.set(window, 'sameStopPromise', first === second);
        Reflect.set(
          window,
          'stopOutcome',
          first.then(
            () => 'ACK',
            () => 'failed',
          ),
        );
      });
      await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
      expect(await page.evaluate(() => Reflect.get(window, 'sameStopPromise'))).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Scan configured sources', exact: true })
          .isVisible(),
      ).toBe(false);
      await page.evaluate(() => {
        const scan = Reflect.get(window, 'scan');
        scan.startAutomatic(undefined, { query: 'Different' });
        scan.rescanAutomatic(undefined, { query: 'Different' });
        Reflect.set(window, 'entrySettled', false);
        Reflect.set(
          window,
          'stopEntry',
          scan.prepareAutomaticEntry().then(
            (state: unknown) => {
              Reflect.set(window, 'entrySettled', true);
              return state;
            },
            () => {
              Reflect.set(window, 'entrySettled', true);
              return 'failed';
            },
          ),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'entrySettled'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'probes').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'collectCalls'))).toBe(2);
      expect(await page.evaluate(() => Reflect.get(window, 'checkpointDiscards'))).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
      await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
      expect(await page.evaluate(() => Reflect.get(window, 'stopOutcome'))).toBe(
        fails ? 'failed' : 'ACK',
      );
      await page.evaluate(() => Reflect.get(window, 'stopEntry'));
      expect(await page.evaluate(() => Reflect.get(window, 'scan').snapshot().busy)).toBe(false);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual(
        fails ? [] : [{ revision: '47', exactSubmitted: true }],
      );
      if (fails)
        expect(await page.getByRole('alert').textContent()).toContain(
          'Saved scan could not be updated',
        );
    } finally {
      await page.close();
    }
  });
it('paired checkpoint mutation ACK waits for actual catalog publication and uses its exact revision', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'commitMode', 'blocked');
      Reflect.set(window, 'commitAdvances', true);
      const host = Reflect.get(window, 'scanHost'),
        original = host.commit;
      host.commit = async (...args: unknown[]) => {
        const receipt = await original(...args);
        Reflect.set(window, 'checkpointRevision', '42');
        return { ...receipt, checkpointRevision: '42' };
      };
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'commits').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'resolveCommit')());
    await page.waitForFunction(() => Reflect.get(window, 'mutationAcks').length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([
      { revision: '42', exactSubmitted: true },
    ]);
  } finally {
    await page.close();
  }
});
it('dispose and suspend join an already-admitted held Stop save without deadlock or new writes', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() =>
      Reflect.set(window, 'heldStop', Reflect.get(window, 'scan').stopAutomatic()),
    );
    await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
    await page.evaluate(() => {
      Reflect.set(window, 'disposeSettled', false);
      const scan = Reflect.get(window, 'scan');
      Reflect.set(
        window,
        'heldDispose',
        Promise.all([scan.suspend(), scan.dispose()]).then(() => {
          Reflect.set(window, 'disposeSettled', true);
        }),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposeSettled'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationPrepareRevisions'))).toEqual([
      '1', // Initial checkpoint is already durably acknowledged.
    ]);
    await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
    await page.evaluate(() => Reflect.get(window, 'heldDispose'));
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves').length)).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([
      { revision: '47', exactSubmitted: true },
    ]);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});
it('close waits for held checkpoint preparation rejection without saving, ACKing or changing the prior checkpoint', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() => Reflect.get(window, 'scan').stopAutomatic());
    const previous = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')));
    await installMutationSeam(page);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'scanHost');
      host.checkpoint.prepareMutation = () =>
        new Promise((_resolve, reject) => {
          Reflect.set(window, 'rejectHeldPreparation', reject);
        });
      Reflect.set(window, 'heldStop', Reflect.get(window, 'scan').stopAutomatic());
    });
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'rejectHeldPreparation') === 'function',
    );
    await page.evaluate(() => {
      Reflect.set(window, 'disposeSettled', false);
      Reflect.set(
        window,
        'heldDispose',
        Reflect.get(window, 'scan')
          .dispose()
          .then(() => {
            Reflect.set(window, 'disposeSettled', true);
          }),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'disposeSettled'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    await page.evaluate(() =>
      Reflect.get(window, 'rejectHeldPreparation')(new Error('application-closing')),
    );
    await page.evaluate(() =>
      Promise.all([Reflect.get(window, 'heldStop'), Reflect.get(window, 'heldDispose')]),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'mutationSaves'))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(Reflect.get(window, 'persisted')))).toBe(
      previous,
    );
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(0);
  } finally {
    await page.close();
  }
});
it('close does not swallow a rejected already-dispatched Stop save', async () => {
  const page = await fixture(true, true, false, true);
  try {
    await installMutationSeam(page);
    await page.evaluate(() => {
      Reflect.set(window, 'candidateCount', 1);
      Reflect.set(window, 'probeMode', 'blocked');
      Reflect.set(window, 'rejectMutationSave', true);
      Reflect.get(window, 'scan').startAutomatic();
    });
    await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
    await page.evaluate(() =>
      Reflect.set(
        window,
        'heldStopOutcome',
        Reflect.get(window, 'scan')
          .stopAutomatic()
          .then(
            () => 'resolved',
            () => 'rejected',
          ),
      ),
    );
    await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
    await page.evaluate(() =>
      Reflect.set(
        window,
        'heldDisposeOutcome',
        Reflect.get(window, 'scan')
          .dispose()
          .then(
            () => 'resolved',
            () => 'rejected',
          ),
      ),
    );
    await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
    expect(await page.evaluate(() => Reflect.get(window, 'heldStopOutcome'))).toBe('rejected');
    expect(await page.evaluate(() => Reflect.get(window, 'heldDisposeOutcome'))).toBe('rejected');
    expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    expect(await page.getByRole('dialog', { name: 'Review source scan' }).count()).toBe(1);
  } finally {
    await page.close();
  }
});
for (const mode of ['rejected', 'malformed'] as const)
  it(`paired ${mode} catalog publication never acknowledges prepared checkpoint mutation`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((failureMode) => {
        Reflect.set(window, 'candidateCount', 1);
        const host = Reflect.get(window, 'scanHost');
        host.commit = async () => {
          if (failureMode === 'rejected') throw new Error('Controlled publication failure');
          return { committed: false, revision: '', checkpointRevision: '42' };
        };
        Reflect.get(window, 'scan').startAutomatic();
      }, mode);
      await page.waitForFunction(() => Reflect.get(window, 'scan').snapshot().phase === 'failed');
      expect(await page.evaluate(() => Reflect.get(window, 'submittedMutations').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
    } finally {
      await page.close();
    }
  });
for (const fails of [false, true])
  it(`standalone mutation save ${fails ? 'failure never ACKs' : 'ACKs only after its durable receipt'}`, async () => {
    const page = await fixture(true, true, false, true);
    try {
      await installMutationSeam(page);
      await page.evaluate((rejects) => {
        Reflect.set(window, 'candidateCount', 1);
        Reflect.set(window, 'probeMode', 'blocked');
        Reflect.set(window, 'rejectMutationSave', rejects);
        Reflect.get(window, 'scan').startAutomatic();
      }, fails);
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 1);
      await page.evaluate(() => {
        Reflect.set(
          window,
          'mutationStop',
          Reflect.get(window, 'scan')
            .stopAutomatic()
            .then(
              () => 'settled',
              () => 'refused',
            ),
        );
      });
      await page.waitForFunction(() => Reflect.get(window, 'mutationSaves').length === 1);
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual([]);
      expect(
        await page.evaluate(() => {
          const save = Reflect.get(window, 'mutationSaves')[0];
          return { revision: save.revision, checkpointRevision: save.checkpointRevision };
        }),
      ).toEqual({ revision: 'review-1', checkpointRevision: '1' });
      await page.evaluate(() => Reflect.get(window, 'releaseMutationSave')());
      await page.evaluate(() => Reflect.get(window, 'mutationStop'));
      expect(await page.evaluate(() => Reflect.get(window, 'mutationAcks'))).toEqual(
        fails ? [] : [{ revision: '47', exactSubmitted: true }],
      );
    } finally {
      await page.close();
    }
  });
