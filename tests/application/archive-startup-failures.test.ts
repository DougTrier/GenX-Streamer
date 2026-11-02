/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createArchivePlayer,
  type ArchivePlayerHost,
} from '../../src/application/genxtra/archive-player';
import {
  ArchivePlaybackFailureError,
  type ArchivePlaybackReceipt,
} from '../../src/platform/archive-playback';
import {
  archiveStartupFailureFacts,
  type ArchiveStartupPhase,
} from '../../src/diagnostics/archive-startup';
import type { ArchiveSelection } from '../../src/platform/archive-catalog';

const choice: ArchiveSelection = {
  titleRef: 'a'.repeat(64),
  fileRef: 'b'.repeat(64),
  expectedRevision: '1',
  title: 'Offline fixture',
  fileTitle: 'Offline video',
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function fixture() {
  const state = { scope: 'root', revision: '1' };
  const receipt: ArchivePlaybackReceipt = {
    kind: 'started',
    schemaVersion: 1,
    sessionGeneration: '1',
    mediaUrl: `http://127.0.0.1:23456/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
    leaseMs: 60000,
    cleanupPending: false,
  };
  const host = {
    player: {
      select: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      seekWhenReady: vi.fn(async () => ({ ok: true as const })),
    },
    playback: {
      start: vi.fn(async () => receipt),
      stop: vi.fn(async (sessionGeneration: string) => ({
        schemaVersion: 1 as const,
        sessionGeneration,
        stopped: true as const,
        cleanupPending: false as const,
      })),
      renew: vi.fn(async (sessionGeneration: string) => ({
        schemaVersion: 1 as const,
        sessionGeneration,
        renewed: true as const,
        leaseMs: 60000 as const,
      })),
      retryCleanup: vi.fn(async () => {}),
    },
    bookmarks: {
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: '1',
        supported: true,
        revision: '1',
        position: null as null | {
          positionMs: number;
          durationMs: number;
          observedMs: number;
          completed: boolean;
        },
      })),
      save: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: '1',
        committed: true as const,
        revision: '2',
        changed: true,
      })),
    },
    chooseResume: vi.fn(async () => 'resume' as 'resume' | 'restart' | 'cancel'),
    readyScope: () => state.scope,
    catalogRevision: () => state.revision,
    beforeStart: vi.fn(async () => {}),
    beginPlaybackIntent: () => ({ prepare, release: vi.fn() }),
    startFailed: vi.fn<(phase: ArchiveStartupPhase, error: unknown) => void>(),
  } satisfies ArchivePlayerHost;
  const prepare = vi.fn(async () => {});
  const owner = createArchivePlayer(host);
  cleanups.push(() => owner.dispose());
  const bookmarked = () =>
    host.bookmarks.read.mockResolvedValue({
      schemaVersion: 1,
      sessionGeneration: '1',
      supported: true,
      revision: '1',
      position: { positionMs: 5000, durationMs: 60000, observedMs: 1, completed: false },
    });
  return { host, owner, prepare, state, bookmarked };
}

it.each([
  'release',
  'guide',
  'before-start',
  'allocate',
  'bookmark',
  'resume-choice',
  'bookmark-reset',
  'decode',
  'resume-seek',
] as const)(
  'observes one original startup failure in the %s phase before cleanup',
  async (phase) => {
    const f = fixture();
    const failure = new Error('https://private.invalid/secret?password=never-export');
    if (phase === 'release') f.host.playback.retryCleanup.mockRejectedValueOnce(failure);
    if (phase === 'guide') f.prepare.mockRejectedValueOnce(failure);
    if (phase === 'before-start') f.host.beforeStart.mockRejectedValueOnce(failure);
    if (phase === 'allocate') f.host.playback.start.mockRejectedValueOnce(failure);
    if (phase === 'bookmark') f.host.bookmarks.read.mockRejectedValueOnce(failure);
    if (phase === 'resume-choice') {
      f.bookmarked();
      f.host.chooseResume.mockRejectedValueOnce(failure);
    }
    if (phase === 'bookmark-reset') {
      f.bookmarked();
      f.host.chooseResume.mockResolvedValueOnce('restart');
      f.host.bookmarks.save.mockRejectedValueOnce(failure);
    }
    if (phase === 'decode') f.host.player.select.mockRejectedValueOnce(failure);
    if (phase === 'resume-seek') {
      f.bookmarked();
      f.host.player.seekWhenReady.mockRejectedValueOnce(failure);
    }
    await expect(f.owner.select(choice)).rejects.toThrow();
    expect(f.host.startFailed).toHaveBeenCalledOnce();
    const [observedPhase, observed] = f.host.startFailed.mock.calls[0];
    expect(observedPhase).toBe(phase);
    const facts = archiveStartupFailureFacts(observedPhase, observed);
    expect(facts).toMatchObject({ initiator: 'startup', startupPhase: phase });
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|password|127\.0\.0\.1|[a-f0-9]{32}/u);
    expect(f.host.playback.stop).toHaveBeenCalledTimes(
      ['bookmark', 'resume-choice', 'bookmark-reset', 'decode', 'resume-seek'].includes(phase)
        ? 1
        : 0,
    );
  },
);

it('keeps a closed native allocation reason and reports an unowned AbortError', async () => {
  const f = fixture();
  f.host.playback.start.mockRejectedValueOnce(
    new ArchivePlaybackFailureError('public-archive-rate-limited'),
  );
  await expect(f.owner.select(choice)).rejects.toBeInstanceOf(ArchivePlaybackFailureError);
  expect(archiveStartupFailureFacts(...f.host.startFailed.mock.calls[0])).toMatchObject({
    startupPhase: 'allocate',
    startupReason: 'rate-limit',
  });
  f.host.startFailed.mockClear();
  f.host.beforeStart.mockRejectedValueOnce(new DOMException('private token', 'AbortError'));
  await expect(f.owner.select(choice)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.host.startFailed).toHaveBeenCalledOnce();
  expect(archiveStartupFailureFacts(...f.host.startFailed.mock.calls[0])).toMatchObject({
    startupPhase: 'before-start',
    startupReason: 'cancelled',
  });
});

it.each(['stop', 'caller', 'root', 'catalog'] as const)(
  'does not report owned %s invalidation as a startup failure',
  async (kind) => {
    const f = fixture(),
      held = gate(),
      caller = new AbortController();
    f.host.beforeStart.mockImplementationOnce(async () => {
      await held.promise;
    });
    const work = f.owner.select(choice, caller.signal).catch((error: unknown) => error);
    await flush();
    expect(f.host.beforeStart).toHaveBeenCalledOnce();
    let stopped: Promise<void> | undefined;
    if (kind === 'stop') stopped = f.owner.stop();
    if (kind === 'caller') caller.abort();
    if (kind === 'root') f.state.scope = 'replacement';
    if (kind === 'catalog') f.state.revision = '2';
    held.resolve();
    expect(await work).toMatchObject({ name: 'AbortError' });
    await stopped;
    expect(f.host.startFailed).not.toHaveBeenCalled();
    expect(f.host.playback.start).not.toHaveBeenCalled();
  },
);

it('keeps explicit Resume cancel quiet and isolates a throwing diagnostics observer', async () => {
  const f = fixture();
  f.bookmarked();
  f.host.chooseResume.mockResolvedValueOnce('cancel');
  await expect(f.owner.select(choice)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.host.startFailed).not.toHaveBeenCalled();
  f.host.beforeStart.mockRejectedValueOnce(new Error('original failure'));
  f.host.startFailed.mockImplementationOnce(() => {
    throw new Error('observer failed');
  });
  await expect(f.owner.select(choice)).rejects.toThrow('could not start');
  expect(f.host.startFailed).toHaveBeenCalledOnce();
});

it('does not mistake an invalid Resume chooser result for an owned cancellation', async () => {
  const f = fixture();
  f.bookmarked();
  f.host.chooseResume.mockResolvedValueOnce('invalid' as never);
  await expect(f.owner.select(choice)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.host.startFailed).toHaveBeenCalledOnce();
  expect(f.host.startFailed.mock.calls[0][0]).toBe('resume-choice');
});
