/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivePlayer } from '../../src/application/genxtra/archive-player';
import { createAccountPlaybackSelection } from '../../src/application/accounts/account-playback-selection';
import { createGuidePlaybackIntents } from '../../src/application/playback/guide-playback-intent';
import type { ArchiveSelection } from '../../src/platform/archive-catalog';

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const choice: ArchiveSelection = {
  titleRef: 'a'.repeat(64),
  fileRef: 'b'.repeat(64),
  expectedRevision: '1',
  title: 'Local fixture',
  fileTitle: 'Local fixture file',
};
const owners: Array<ReturnType<typeof createArchivePlayer>> = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
});

function fixture() {
  const guide = held<void>();
  const decoder = held<void>();
  const events: string[] = [];
  const intents = createGuidePlaybackIntents({
    prepare: () => guide.promise,
    wake: () => void events.push(`wake-${intents.pending}`),
  });
  const start = vi.fn(async () => ({
    kind: 'started' as const,
    schemaVersion: 1 as const,
    sessionGeneration: '1',
    mediaUrl: `http://127.0.0.1:23456/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
    leaseMs: 60000 as const,
    cleanupPending: false as const,
  }));
  const host = {
    player: {
      select: vi.fn(async () => {
        events.push('decode');
        await decoder.promise;
      }),
      stop: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
    },
    readyScope: () => 'root-1',
    catalogRevision: () => '1',
    beforeStart: vi.fn(async () => {}),
    beginPlaybackIntent: () => intents.begin(),
    playback: {
      start,
      stop: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: '1',
        stopped: true as const,
        cleanupPending: false as const,
      })),
      renew: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: '1',
        renewed: true as const,
        leaseMs: 60000 as const,
      })),
      retryCleanup: vi.fn(async () => {}),
    },
  };
  const archive = createArchivePlayer(host);
  owners.push(archive);
  const account = vi.fn(async () => {
    events.push('private-acquire');
    await decoder.promise;
  });
  const env = {
    archivePlayer: archive,
    accountPlayer: { selectAccount: account, selectVod: account },
    admitForegroundPlayback() {},
    clearArchiveResume() {},
    backgroundLiveChoice: null,
    pendingPublicPlayback: null,
    pendingAccountPlayback: null,
    sharingBridge: { host: { snapshot: () => ({ generation: 1 }) }, stop: async () => {} },
  };
  const selections = createAccountPlaybackSelection(
    env as unknown as Parameters<typeof createAccountPlaybackSelection>[0],
  );
  const settle = async () => {
    guide.resolve();
    decoder.resolve();
    await Promise.resolve();
  };
  return { guide, decoder, intents, start, host, archive, account, selections, settle, events };
}

describe('joined Guide admission before media acquisition', () => {
  it('keeps an Archive intent busy before native acquisition and through decoder admission', async () => {
    const f = fixture();
    const work = f.archive.select(choice);
    try {
      await vi.waitFor(() => expect(f.intents.pending).toBe(1));
      expect(f.start).not.toHaveBeenCalled();
      f.guide.resolve();
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(f.intents.pending).toBe(1);
      f.decoder.resolve();
      await work;
      expect(f.intents.pending).toBe(0);
    } finally {
      await f.settle();
      await work.catch(() => {});
    }
  });
  it.each(['live', 'vod'] as const)(
    'joins Guide cleanup before actual Paid %s selection entry',
    async (kind) => {
      const f = fixture();
      const work =
        kind === 'live'
          ? f.selections.selectAccountPlayback({} as never, {} as never)
          : f.selections.playAccountVod({} as never, {} as never);
      try {
        await vi.waitFor(() => expect(f.intents.pending).toBe(1));
        expect(f.account).not.toHaveBeenCalled();
        f.guide.resolve();
        await vi.waitFor(() => expect(f.account).toHaveBeenCalledOnce());
        expect(f.intents.pending).toBe(1);
        f.decoder.resolve();
        await work;
        expect(f.intents.pending).toBe(0);
      } finally {
        await f.settle();
        await work.catch(() => {});
      }
    },
  );
  it('does not run an obsolete handoff after Stop while quiescence is pending', async () => {
    const f = fixture();
    const acquire = vi.fn(async () => {});
    const work = f.archive.handoff(acquire);
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.intents.pending).toBe(1));
      const stop = f.archive.stop();
      f.guide.resolve();
      await expect(work).rejects.toThrow();
      await stop;
      expect(acquire).not.toHaveBeenCalled();
      expect(f.intents.pending).toBe(0);
    } finally {
      await f.settle();
      await work.catch(() => {});
    }
  });
  it('keeps the last pending media intent busy when a prior choice is superseded', async () => {
    const f = fixture();
    const oldAcquire = vi.fn(async () => {});
    const newAcquire = vi.fn(async () => {
      await f.decoder.promise;
    });
    const first = f.archive.handoff(oldAcquire);
    void first.catch(() => {});
    const second = f.archive.handoff(newAcquire);
    try {
      expect(f.intents.pending).toBe(2);
      f.guide.resolve();
      await vi.waitFor(() => expect(newAcquire).toHaveBeenCalledOnce());
      expect(oldAcquire).not.toHaveBeenCalled();
      expect(f.intents.pending).toBe(1);
      f.decoder.resolve();
      await second;
      await first.catch(() => {});
      expect(f.intents.pending).toBe(0);
    } finally {
      await f.settle();
      await Promise.allSettled([first, second]);
    }
  });
  it('preserves a failed admission and releases its busy intent exactly once', async () => {
    const failure = new Error('Owned fixture cleanup unconfirmed');
    const wakes: number[] = [];
    const intents = createGuidePlaybackIntents({
      prepare: async () => {
        throw failure;
      },
      wake: () => void wakes.push(intents.pending),
    });
    const owner = intents.begin();
    await expect(owner.prepare()).rejects.toBe(failure);
    expect(intents.pending).toBe(1);
    owner.release();
    owner.release();
    expect(intents.pending).toBe(0);
    await Promise.resolve();
    expect(wakes).toEqual([]);
    await expect(owner.prepare()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('observes a rejected background wake without replacing the admission failure', async () => {
    const failure = new Error('Fixture cleanup still unconfirmed');
    const wakeFailed = vi.fn();
    const intents = createGuidePlaybackIntents({
      prepare: async () => {
        throw failure;
      },
      wake: async () => {
        throw failure;
      },
      wakeFailed,
    });
    const owner = intents.begin();
    await expect(owner.prepare()).rejects.toBe(failure);
    owner.release();
    await vi.waitFor(() => expect(wakeFailed).toHaveBeenCalledExactlyOnceWith(failure));
    expect(intents.pending).toBe(0);
  });
  it('does not detach the original failure when its background notice also throws', async () => {
    const failure = new Error('Fixture retained Guide failure');
    const wakeFailed = vi.fn(() => {
      throw new Error('Fixture notice unavailable');
    });
    const intents = createGuidePlaybackIntents({
      prepare: async () => {
        throw failure;
      },
      wake: async () => {
        throw failure;
      },
      wakeFailed,
    });
    const owner = intents.begin();
    await expect(owner.prepare()).rejects.toBe(failure);
    owner.release();
    await vi.waitFor(() => expect(wakeFailed).toHaveBeenCalledExactlyOnceWith(failure));
    await expect(owner.prepare()).rejects.toMatchObject({ name: 'AbortError' });
    expect(intents.pending).toBe(0);
  });
  it('retains an unknown cleanup refusal across later intents instead of waking new writers', async () => {
    const failure = new Error('Fixture original cleanup uncertain');
    const prepare = vi.fn(async () => {
      throw failure;
    });
    const wake = vi.fn();
    const wakeFailed = vi.fn();
    const intents = createGuidePlaybackIntents({ prepare, wake, wakeFailed });
    const first = intents.begin();
    await expect(first.prepare()).rejects.toBe(failure);
    first.release();
    await vi.waitFor(() => expect(wakeFailed).toHaveBeenCalledExactlyOnceWith(failure));
    const next = intents.begin();
    await expect(next.prepare()).rejects.toBe(failure);
    next.release();
    expect(prepare).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
  });
  it('refuses a concurrent apparent success after another admission reports unknown cleanup', async () => {
    const heldSuccess = held<void>();
    const failure = new Error('Fixture concurrent cleanup uncertain');
    let calls = 0;
    const intents = createGuidePlaybackIntents({
      prepare: async () => {
        if (++calls === 1) await heldSuccess.promise;
        else throw failure;
      },
      wake() {},
    });
    const first = intents.begin();
    const second = intents.begin();
    const waiting = first.prepare();
    await expect(second.prepare()).rejects.toBe(failure);
    heldSuccess.resolve();
    await expect(waiting).rejects.toBe(failure);
    first.release();
    second.release();
  });
  it('retains an uncertain background wake result before the next admission', async () => {
    const failure = new Error('Fixture wake cleanup uncertain');
    const wakeFailed = vi.fn();
    const prepare = vi.fn(async () => {});
    const intents = createGuidePlaybackIntents({
      prepare,
      wake: async () => {
        throw failure;
      },
      wakeFailed,
    });
    const first = intents.begin();
    await first.prepare();
    first.release();
    await vi.waitFor(() => expect(wakeFailed).toHaveBeenCalledExactlyOnceWith(failure));
    const next = intents.begin();
    await expect(next.prepare()).rejects.toBe(failure);
    next.release();
    expect(prepare).toHaveBeenCalledOnce();
  });
  it('does not reuse an earlier fulfilled prepare after another intent reports unknown cleanup', async () => {
    const failure = new Error('Fixture later cleanup uncertain');
    let calls = 0;
    const intents = createGuidePlaybackIntents({
      prepare: async () => {
        if (++calls === 2) throw failure;
      },
      wake() {},
    });
    const first = intents.begin();
    await first.prepare();
    const next = intents.begin();
    await expect(next.prepare()).rejects.toBe(failure);
    await expect(first.prepare()).rejects.toBe(failure);
    first.release();
    next.release();
  });
});
