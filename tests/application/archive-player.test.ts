import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArchivePlayer,
  ArchivePlayerCleanupError,
  ArchiveFileRemovedError,
} from '../../src/application/archive-player';
import {
  createArchivePlayback,
  type ArchivePlaybackReceipt,
  ArchivePlaybackFailureError,
} from '../../src/platform/archive-playback';
import type { OwnedNativeRuntime } from '../../src/platform/owned-native-command';
import type { ArchiveSelection } from '../../src/platform/archive-catalog';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const selection: ArchiveSelection = {
  titleRef: 'a'.repeat(64),
  fileRef: 'b'.repeat(64),
  expectedRevision: '1',
  title: 'Fixture series',
  fileTitle: 'Fixture episode',
};
function started(generation = '1'): ArchivePlaybackReceipt {
  return {
    kind: 'started',
    schemaVersion: 1,
    sessionGeneration: generation,
    mediaUrl: `http://127.0.0.1:23456/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
    leaseMs: 60000,
    cleanupPending: false,
  };
}
function stopped(generation: string) {
  return {
    schemaVersion: 1,
    sessionGeneration: generation,
    stopped: true,
    cleanupPending: false,
  } as const;
}
function fixture(invoke?: OwnedNativeRuntime['invoke'], disposeHook?: () => void | Promise<void>) {
  const events: string[] = [];
  const emitters: ((event: EngineEvent) => void)[] = [];
  let revision = '1',
    scope: string | null = 'root-1',
    issued = 0;
  const nativeStop = deferred<void>();
  const runtime: OwnedNativeRuntime = {
    invoke: vi.fn(
      invoke ??
        (async (command, args) => {
          const request = args?.request as { sessionGeneration?: string } | undefined;
          if (command === 'start_archive_playback') return started(String(++issued));
          if (command === 'stop_archive_playback') {
            events.push(`native-stop-${request!.sessionGeneration}`);
            nativeStop.resolve();
            return stopped(request!.sessionGeneration!);
          }
          if (command === 'renew_archive_playback')
            return {
              schemaVersion: 1,
              sessionGeneration: request!.sessionGeneration!,
              renewed: true,
              leaseMs: 60000,
            };
          if (command === 'cancel_playlist') return true;
          throw new Error('Unexpected native fixture command.');
        }),
    ),
  };
  const player = new PlaybackController((emit) => {
    emitters.push(emit);
    return {
      start: async (chosen) => {
        expect(chosen.playMode).toBe('on-demand');
        expect(chosen.crossOrigin).toBe('anonymous');
        events.push('decoder-start');
      },
      pause: () => {},
      resume: async () => {},
      setMuted: () => {},
      setVolume: () => {},
      dispose: () => {
        events.push('decoder-dispose');
        return disposeHook?.();
      },
    };
  });
  const archive = createArchivePlayer({
    player,
    playback: createArchivePlayback(runtime),
    readyScope: () => scope,
    catalogRevision: () => revision,
    beforeStart: async () => {
      events.push('public-account-sharing-joined');
    },
  });
  return {
    archive,
    player,
    runtime,
    events,
    nativeStop,
    emit: (event: EngineEvent) => emitters.at(-1)!(event),
    emitAt: (index: number, event: EngineEvent) => emitters[index]!(event),
    revision: (value: string) => {
      revision = value;
    },
    scope: (value: string | null) => {
      scope = value;
    },
    close: async () => {
      await archive.dispose();
      await player.dispose();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Archive single-player lifecycle', () => {
  it.each(['connecting', 'playing'] as const)(
    'idle Archive cleanup preserves a %s public channel background pause',
    async (state) => {
      let emit!: (event: EngineEvent) => void;
      const engineDispose = vi.fn(async () => {});
      const player = new PlaybackController((events) => {
        emit = events;
        return {
          start: async () => {},
          pause: () => {},
          resume: async () => {},
          setMuted: () => {},
          setVolume: () => {},
          dispose: engineDispose,
        };
      });
      const retryCleanup = vi.fn(async () => {});
      const archive = createArchivePlayer({
        player,
        readyScope: () => 'root',
        catalogRevision: () => '1',
        beforeStart: async () => {},
        playback: {
          start: vi.fn(async () => started()),
          stop: vi.fn(async (generation) => stopped(generation)),
          renew: vi.fn(),
          retryCleanup,
        },
      });
      const live = {
        id: 'public-channel',
        name: 'Public channel',
        url: 'https://fixture.invalid/live',
      };
      try {
        await player.select(live);
        if (state === 'playing') emit({ type: 'progress' });
        expect(player.snapshot.state).toBe(state);
        await Promise.all([archive.stop(), player.suspend()]);
        expect(player.snapshot).toMatchObject({
          state: 'paused',
          pauseReason: 'background',
          selection: live,
        });
        await archive.stop();
        await archive.dispose();
        expect(player.snapshot.state).toBe('paused');
        expect(player.snapshot.selection).toEqual(live);
        expect(engineDispose).toHaveBeenCalledTimes(1);
        expect(retryCleanup).toHaveBeenCalledTimes(3);
      } finally {
        await archive.dispose();
        await player.dispose();
      }
    },
  );

  it('finite EOF releases decoder before exact native Stop and preserves selected metadata', async () => {
    const f = fixture();
    try {
      await f.archive.select(selection);
      expect(f.archive.allowsRequest(started().mediaUrl)).toBe(true);
      expect(f.archive.allowsRequest(`${started().mediaUrl}?other=1`)).toBe(false);
      f.emit({ type: 'progress' });
      f.emit({ type: 'ended' });
      await f.nativeStop.promise;
      expect(f.player.snapshot.state).toBe('idle');
      expect(f.events.indexOf('decoder-dispose')).toBeLessThan(f.events.indexOf('native-stop-1'));
      // No autoplay or new native acquisition follows EOF.
      expect(f.events.filter((event) => event === 'decoder-start')).toHaveLength(1);
      expect(selection.fileTitle).toBe('Fixture episode');
      expect(f.archive.allowsRequest(started().mediaUrl)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('unrelated index revisions preserve current capability and renewal', async () => {
    const f = fixture();
    try {
      await f.archive.select(selection);
      f.emit({ type: 'progress' });
      f.revision('2');
      expect(f.archive.allowsHttp(started().mediaUrl)).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.runtime.invoke).toHaveBeenCalledWith(
        'renew_archive_playback',
        expect.objectContaining({
          request: { schemaVersion: 1, sessionGeneration: '1' },
        }),
      );
      expect(f.archive.selection?.fileRef).toBe(selection.fileRef);
      expect(f.events).not.toContain('native-stop-1');
    } finally {
      await f.close();
    }
  });

  it('late allocation after cancellation joins both cancel and exact compensating Stop', async () => {
    const allocated = deferred<ArchivePlaybackReceipt>(),
      cancellation = deferred<boolean>();
    const entered = deferred<void>(),
      stopEntered = deferred<void>(),
      released = deferred<unknown>();
    let stops = 0;
    const f = fixture(async (command) => {
      if (command === 'start_archive_playback') {
        entered.resolve();
        return allocated.promise;
      }
      if (command === 'cancel_playlist') return cancellation.promise;
      if (command === 'stop_archive_playback') {
        stops++;
        stopEntered.resolve();
        return released.promise;
      }
      throw new Error('Unexpected fixture command.');
    });
    const signal = new AbortController();
    const selecting = f.archive.select(selection, signal.signal);
    const rejection = expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await entered.promise;
      signal.abort();
      allocated.resolve(started());
      await Promise.resolve();
      await Promise.resolve();
      expect(stops).toBe(0); // Actual cancel RPC has not joined yet.
      cancellation.resolve(true);
      await stopEntered.promise;
      expect(f.events).not.toContain('decoder-start');
      let settled = false;
      void selecting
        .catch(() => {})
        .then(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      released.resolve(stopped('1'));
      await rejection;
      expect(f.archive.selection).toBeNull();
      expect(stops).toBe(1);
    } finally {
      cancellation.resolve(true);
      allocated.resolve(started());
      released.resolve(stopped('1'));
      await selecting.catch(() => {});
      await f.close();
    }
  });

  it('failed native Stop retains cleanup ownership, refuses replacement, and can retry', async () => {
    let stops = 0,
      starts = 0,
      rejectStops = true;
    const f = fixture(async (command, args) => {
      if (command === 'start_archive_playback') {
        starts++;
        return started();
      }
      if (command === 'stop_archive_playback') {
        stops++;
        if (rejectStops) throw new Error('Fixture stop did not join.');
        return stopped((args!.request as { sessionGeneration: string }).sessionGeneration);
      }
      if (command === 'cancel_playlist') return true;
      throw new Error('Unexpected fixture command.');
    });
    try {
      await f.archive.select(selection);
      await expect(f.archive.stop()).rejects.toBeInstanceOf(ArchivePlayerCleanupError);
      expect(f.archive.selection?.fileRef).toBe(selection.fileRef);
      expect(f.archive.allowsRequest(started().mediaUrl)).toBe(false);
      await expect(f.archive.select(selection)).rejects.toBeInstanceOf(ArchivePlayerCleanupError);
      expect(starts).toBe(1);
      rejectStops = false;
      await f.archive.retryCleanup();
      expect(f.archive.selection).toBeNull();
      expect(stops).toBeGreaterThan(1);
    } finally {
      rejectStops = false;
      await f.close();
    }
  });

  it('cancellation before admission creates no native session or decoder', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(f.archive.select(selection, abort.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(f.runtime.invoke).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

it('confirmed-dead COMMIT awaits reconciliation and retains its receipt after a private callback failure', async () => {
  const callback = deferred<void>();
  const entered = deferred<void>();
  const receipt = {
    kind: 'confirmedDead' as const,
    schemaVersion: 1 as const,
    committed: true as const,
    revision: '2',
    confirmedDead: 1,
    titleCount: 0,
  };
  const player = { select: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const playback = {
    start: vi.fn(async () => receipt),
    stop: vi.fn(async () => {
      throw Error('No native session should exist');
    }),
    renew: vi.fn(async () => {
      throw Error('No renewal should exist');
    }),
    retryCleanup: vi.fn(async () => {}),
  };
  const archive = createArchivePlayer({
    player,
    playback,
    readyScope: () => 'root',
    catalogRevision: () => '1',
    beforeStart: async () => {},
    confirmedDead: async () => {
      entered.resolve();
      await callback.promise;
    },
  });
  let settled = false;
  const result = archive.select(selection).catch((error) => {
    settled = true;
    return error;
  });
  try {
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    callback.reject(Error('private https://fixture.invalid/secret-token'));
    const error = await result;
    expect(error).toBeInstanceOf(ArchiveFileRemovedError);
    expect(error.receipt).toEqual(receipt);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(player.select).not.toHaveBeenCalled();
    expect(playback.stop).not.toHaveBeenCalled();
    expect(archive.selection).toBeNull();
  } finally {
    callback.resolve();
    await result;
    await archive.dispose();
  }
});

it('unvalidated startup failure never exports a private host error as its cause', async () => {
  const privateError = Error('private https://fixture.invalid/secret-token');
  const archive = createArchivePlayer({
    player: { select: async () => {}, stop: async () => {} },
    readyScope: () => 'root',
    catalogRevision: () => '1',
    beforeStart: async () => {
      throw privateError;
    },
    playback: {
      start: async () => started(),
      stop: async (generation) => stopped(generation),
      renew: async (generation) => ({
        schemaVersion: 1,
        sessionGeneration: generation,
        renewed: true,
        leaseMs: 60000,
      }),
      retryCleanup: async () => {},
    },
  });
  try {
    const error = await archive.select(selection).catch((error) => error);
    expect(error.message).toBe(
      'This Archive file could not start. Reload its files or select another.',
    );
    expect(error.cause).toBeUndefined();
    expect(error).not.toBe(privateError);
  } finally {
    await archive.dispose();
  }
});

it('a whitelisted start refusal survives the player without decoder attachment or a deletion claim', async () => {
  const f = fixture(async (command) => {
    if (command === 'start_archive_playback') throw 'archive-proxy-path-unverified';
    return true;
  });
  try {
    const error = await f.archive.select(selection).catch((error) => error);
    expect(error).toBeInstanceOf(ArchivePlaybackFailureError);
    expect(error.category).toBe('path');
    expect(error.cause).toBeUndefined();
    expect(f.events).not.toContain('decoder-start');
    expect(f.archive.selection).toBeNull();
  } finally {
    await f.close();
  }
});

it('a trusted native cleanup refusal takes priority over a simultaneous selection cancellation', async () => {
  const signal = new AbortController();
  const archive = createArchivePlayer({
    player: { select: async () => {}, stop: async () => {} },
    readyScope: () => 'root',
    catalogRevision: () => '1',
    beforeStart: async () => {},
    playback: {
      start: async () => {
        signal.abort();
        throw new ArchivePlaybackFailureError('archive-proxy-work-join-failed');
      },
      stop: async (generation) => stopped(generation),
      renew: async (generation) => ({
        schemaVersion: 1,
        sessionGeneration: generation,
        renewed: true,
        leaseMs: 60000,
      }),
      retryCleanup: async () => {},
    },
  });
  try {
    await expect(archive.select(selection, signal.signal)).rejects.toBeInstanceOf(
      ArchivePlayerCleanupError,
    );
  } finally {
    await archive.dispose();
  }
});

it('failed decoder guidance survives held original cleanup and held exact native Stop', async () => {
  const decoderEntered = deferred<void>(),
    decoderReleased = deferred<void>(),
    nativeEntered = deferred<void>(),
    nativeReleased = deferred<unknown>();
  const f = fixture(
    async (command) => {
      if (command === 'start_archive_playback') return started();
      if (command === 'stop_archive_playback') {
        nativeEntered.resolve();
        return nativeReleased.promise;
      }
      return true;
    },
    () => {
      decoderEntered.resolve();
      return decoderReleased.promise;
    },
  );
  try {
    await f.archive.select(selection);
    f.emit({ type: 'progress' });
    f.emit({
      type: 'error',
      failure: { code: 'access', message: 'The video server refused access.', retryable: false },
    });
    await decoderEntered.promise;
    expect(f.player.snapshot.state).toBe('failed');
    expect(f.player.snapshot.error).toBe('The video server refused access.');
    expect(f.archive.allowsRequest(started().mediaUrl)).toBe(false);
    expect(f.runtime.invoke).not.toHaveBeenCalledWith('stop_archive_playback', expect.anything());
    decoderReleased.resolve();
    await nativeEntered.promise;
    expect(f.player.snapshot.state).toBe('failed');
    expect(f.archive.selection?.fileRef).toBe(selection.fileRef);
    nativeReleased.resolve(stopped('1'));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.player.snapshot.state).toBe('failed');
    expect(f.player.snapshot.error).toBe('The video server refused access.');
    expect(f.archive.selection).toEqual(selection);
    expect(f.archive.allowsHttp(started().mediaUrl)).toBe(false);
  } finally {
    decoderReleased.resolve();
    nativeReleased.resolve(stopped('1'));
    await f.close();
  }
});

it('failed native cleanup retains failed guidance and exact choice until explicit Stop retry', async () => {
  let failed = true;
  const attempted = deferred<void>();
  const f = fixture(async (command, args) => {
    if (command === 'start_archive_playback') return started();
    if (command === 'stop_archive_playback') {
      attempted.resolve();
      if (failed) throw Error('private stop error');
      return stopped((args!.request as { sessionGeneration: string }).sessionGeneration);
    }
    return true;
  });
  try {
    await f.archive.select(selection);
    f.emit({
      type: 'error',
      failure: { code: 'unsupported', message: 'This video cannot be decoded.', retryable: false },
    });
    await attempted.promise;
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(f.player.snapshot.state).toBe('failed');
    expect(f.player.snapshot.error).toBe('This video cannot be decoded.');
    expect(f.archive.selection?.fileRef).toBe(selection.fileRef);
    expect(f.archive.allowsRequest(started().mediaUrl)).toBe(false);
    failed = false;
    await f.archive.stop();
    expect(f.archive.selection).toBeNull();
    expect(f.player.snapshot.state).toBe('idle');
  } finally {
    failed = false;
    await f.close();
  }
});

it('retry/new-selection race cannot resurrect failed choice or release a newer Archive session', async () => {
  let starts = 0;
  const oldStopped = deferred<void>(),
    releaseOld = deferred<unknown>();
  const f = fixture(async (command, args) => {
    if (command === 'start_archive_playback') return started(String(++starts));
    if (command === 'stop_archive_playback') {
      const gen = (args!.request as { sessionGeneration: string }).sessionGeneration;
      if (gen === '1') {
        oldStopped.resolve();
        return releaseOld.promise;
      }
      return stopped(gen);
    }
    return true;
  });
  const replacement = { ...selection, fileRef: 'e'.repeat(64), fileTitle: 'Another video' };
  try {
    await f.archive.select(selection);
    f.emit({
      type: 'error',
      failure: { code: 'access', message: 'Access refused.', retryable: false },
    });
    await oldStopped.promise;
    const retried = f.archive.select(f.archive.selection!);
    const retriedOutcome = retried.catch(() => {});
    const newer = f.archive.select(replacement);
    releaseOld.resolve(stopped('1'));
    await retriedOutcome;
    await newer;
    f.emit({ type: 'progress' });
    expect(f.player.snapshot.state).toBe('playing');
    expect(f.archive.selection?.fileRef).toBe(replacement.fileRef);
    f.emitAt(0, {
      type: 'error',
      failure: { code: 'access', message: 'Obsolete failure.', retryable: false },
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.player.snapshot.state).toBe('playing');
    expect(f.archive.selection?.fileRef).toBe(replacement.fileRef);
    expect(f.runtime.invoke).not.toHaveBeenCalledWith(
      'stop_archive_playback',
      expect.objectContaining({ request: { schemaVersion: 1, sessionGeneration: '2' } }),
    );
    await f.archive.stop();
    expect(f.archive.selection).toBeNull();
  } finally {
    releaseOld.resolve(stopped('1'));
    await f.close();
  }
});

// Bookmark ownership uses a controlled decoder so held saves and prompt leases can be ordered exactly.
describe('Archive exact-proof bookmarks', () => {
  function bookmarkFixture() {
    let releaseObserver:
      ((o: import('../../src/playback/controller').VODReleaseObservation) => void) | undefined;
    let position = 90,
      revision = '2',
      serial = 0;
    const duration = 200;
    const events: string[] = [];
    const player = {
      select: vi.fn(async () => {
        events.push('decoder-select');
      }),
      stop: vi.fn(async () => {
        events.push('decoder-stop');
      }),
      currentVODposition: () => position,
      currentVODduration: () => duration,
      subscribeVODRelease: (fn: typeof releaseObserver) => {
        releaseObserver = fn;
        return () => {
          releaseObserver = undefined;
        };
      },
      seekWhenReady: vi.fn(async () => ({ ok: true as const })),
    };
    const bookmarks = {
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: String(serial),
        supported: true,
        revision,
        position: { positionMs: 90000, durationMs: 200000, completed: false, observedMs: 0 },
      })),
      save: vi.fn(
        async (
          request: import('../../src/platform/archive-bookmarks').ArchiveBookmarkSaveRequest,
        ) => {
          events.push(`save-${request.positionMs}`);
          revision = String(BigInt(request.expectedRevision) + 1n);
          return {
            schemaVersion: 1 as const,
            sessionGeneration: request.sessionGeneration,
            committed: true as const,
            revision,
            changed: true,
          };
        },
      ),
    };
    const playback = {
      start: vi.fn(async () => started(String(++serial))),
      stop: vi.fn(async (g: string) => {
        events.push(`native-stop-${g}`);
        return stopped(g);
      }),
      renew: vi.fn(async (g: string) => ({
        schemaVersion: 1 as const,
        sessionGeneration: g,
        renewed: true as const,
        leaseMs: 60000 as const,
      })),
      retryCleanup: vi.fn(async () => {}),
    };
    const chooseResume = vi.fn(async () => 'resume' as 'resume' | 'restart' | 'cancel');
    const bookmarkFailed = vi.fn();
    const archive = createArchivePlayer({
      player,
      playback,
      bookmarks,
      chooseResume,
      bookmarkFailed,
      readyScope: () => 'root',
      catalogRevision: () => '1',
      beforeStart: async () => {},
    });
    return {
      archive,
      player,
      bookmarks,
      playback,
      chooseResume,
      bookmarkFailed,
      events,
      position: (p: number) => (position = p),
      observe: (reason: import('../../src/playback/controller').VODReleaseObservation['reason']) =>
        releaseObserver?.({
          selectionId: `archive-${selection.fileRef}`,
          positionSeconds: position,
          durationSeconds: duration,
          reason,
        }),
    };
  }
  it('observes decoder/save overlap and retains each actual join before native Stop completes', async () => {
    const f = bookmarkFixture();
    await f.archive.select(selection);
    const decoder = deferred<void>();
    const saved =
      deferred<import('../../src/platform/archive-bookmarks').ArchiveBookmarkSaveReceipt>();
    const native = deferred<ReturnType<typeof stopped>>();
    f.player.stop.mockImplementationOnce(() => decoder.promise);
    f.bookmarks.save.mockImplementationOnce(() => saved.promise);
    f.playback.stop.mockImplementationOnce(() => native.promise);
    f.position(100);
    const stop = f.archive.stop();
    await vi.advanceTimersByTimeAsync(0);
    const held = f.archive.releaseTimings();
    expect(held.active.map((span) => span.phase)).toContain('archive-decoder-stop');
    expect(held.active.map((span) => span.phase)).toContain('archive-bookmark-save');
    expect(f.playback.stop).not.toHaveBeenCalled();
    decoder.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.archive.releaseTimings().active.map((span) => span.phase)).toContain(
      'archive-bookmark-join',
    );
    expect(f.playback.stop).not.toHaveBeenCalled();
    saved.resolve({
      schemaVersion: 1,
      sessionGeneration: '1',
      committed: true,
      revision: '3',
      changed: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.archive.releaseTimings().active.map((span) => span.phase)).toContain(
      'archive-native-stop',
    );
    expect(held.active.every((span) => span.outcome === 'pending')).toBe(true);
    native.resolve(stopped('1'));
    await stop;
    const trace = f.archive.releaseTimings();
    expect(trace.active).toEqual([]);
    const saveSpan = trace.completed.find((span) => span.phase === 'archive-bookmark-save')!;
    const nativeSpan = trace.completed.find((span) => span.phase === 'archive-native-stop')!;
    expect(saveSpan.endedMs).toBeLessThanOrEqual(nativeSpan.startedMs);
    expect(trace.completed.at(-1)).toMatchObject({
      phase: 'archive-stop-total',
      outcome: 'fulfilled',
    });
    expect(JSON.stringify(trace)).not.toMatch(/Fixture|127\.0\.0\.1|root|bbbbbbbb/);
    await f.archive.dispose();
  });
  it('renews exact capability while explicit choice is held and never selects before Resume', async () => {
    const f = bookmarkFixture(),
      choice = deferred<'resume'>();
    f.chooseResume.mockImplementation(() => choice.promise);
    const selected = f.archive.select(selection);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.player.select).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40000);
    expect(f.playback.renew).toHaveBeenCalledTimes(2);
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    choice.resolve('resume');
    await selected;
    expect(f.player.seekWhenReady).toHaveBeenCalledWith(90, expect.any(AbortSignal));
    await f.archive.dispose();
  });
  it('joins an original independent save before nativeStop and coalesces repeated paused captures', async () => {
    const f = bookmarkFixture();
    await f.archive.select(selection);
    const saved =
      deferred<import('../../src/platform/archive-bookmarks').ArchiveBookmarkSaveReceipt>();
    f.bookmarks.save.mockImplementationOnce(() => saved.promise);
    f.position(100);
    f.observe('paused');
    await Promise.resolve();
    f.position(101);
    f.observe('paused');
    f.position(102);
    f.observe('paused');
    const stopping = f.archive.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.playback.stop).not.toHaveBeenCalled();
    saved.resolve({
      schemaVersion: 1,
      sessionGeneration: '1',
      committed: true,
      revision: '3',
      changed: true,
    });
    await stopping;
    expect(f.bookmarks.save.mock.calls.map((c) => c[0].positionMs)).toEqual([100000, 102000]);
    expect(f.bookmarks.save.mock.calls[1][0].expectedRevision).toBe('3');
    expect(f.events.at(-1)).toBe('native-stop-1');
    await f.archive.dispose();
  });
  it('Cancel and failed Resume never overwrite the previous position with initial zero', async () => {
    const f = bookmarkFixture();
    f.chooseResume.mockResolvedValueOnce('cancel');
    await expect(f.archive.select(selection)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.player.select).not.toHaveBeenCalled();
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    f.position(0);
    f.player.seekWhenReady.mockResolvedValueOnce({ ok: false, reason: 'failed' } as never);
    // An unconfirmed resume seek keeps the video playing and only reports it.
    await f.archive.select(selection);
    expect(f.bookmarkFailed).toHaveBeenCalledTimes(1);
    expect(f.playback.stop).toHaveBeenCalledTimes(1);
    // Below the saved position nothing is saved, so the bookmark is preserved.
    f.observe('paused');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    await f.archive.dispose();
  });
  it('explicit Restart commits zero before decoder selection and failures retain previous bookmark without hidden retry', async () => {
    const f = bookmarkFixture();
    f.chooseResume.mockResolvedValue('restart');
    await f.archive.select(selection);
    expect(f.events.indexOf('save-0')).toBeLessThan(f.events.indexOf('decoder-select'));
    expect(f.player.seekWhenReady).not.toHaveBeenCalled();
    f.bookmarks.save.mockRejectedValueOnce(new Error('private provider text'));
    f.position(110);
    f.observe('paused');
    await vi.advanceTimersByTimeAsync(0);
    f.position(115);
    f.observe('paused');
    await f.archive.stop();
    expect(f.bookmarks.save).toHaveBeenCalledTimes(2);
    expect(f.bookmarkFailed).toHaveBeenCalledTimes(1);
    expect(f.bookmarkFailed.mock.calls[0][0]).not.toContain('private');
    expect(f.playback.stop).toHaveBeenCalled();
    await f.archive.dispose();
  });
  it('completion is terminal and unrelated later release cannot overwrite it', async () => {
    const f = bookmarkFixture();
    await f.archive.select(selection);
    f.position(200);
    f.observe('completed');
    f.position(0);
    f.observe('stopped');
    await f.archive.stop();
    expect(f.bookmarks.save).toHaveBeenCalledTimes(1);
    expect(f.bookmarks.save.mock.calls[0][0]).toMatchObject({
      positionMs: 200000,
      completed: true,
    });
    await f.archive.dispose();
  });
  it('replacement cancels a held Resume seek and joins its original without saving zero or stopping the new proof', async () => {
    const f = bookmarkFixture(),
      held = deferred<{ ok: true }>(),
      entered = deferred<void>();
    f.position(0);
    f.player.seekWhenReady.mockImplementationOnce(async () => {
      entered.resolve();
      return held.promise;
    });
    const old = f.archive.select(selection);
    const oldOutcome = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    f.chooseResume.mockResolvedValue('cancel');
    const newer = f.archive.select({ ...selection, fileRef: 'e'.repeat(64) });
    const newOutcome = expect(newer).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.playback.start).toHaveBeenCalledTimes(1);
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    held.resolve({ ok: true });
    await oldOutcome;
    await newOutcome;
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    expect(f.playback.stop.mock.calls.map((c) => c[0])).toEqual(['1', '2']);
    await f.archive.dispose();
  });
  it('ignores obsolete release identities and saves the replacement proof with its own CAS', async () => {
    const f = bookmarkFixture();
    await f.archive.select(selection);
    f.position(105);
    await f.archive.select({ ...selection, fileRef: 'e'.repeat(64) });
    const count = f.bookmarks.save.mock.calls.length;
    f.observe('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bookmarks.save).toHaveBeenCalledTimes(count);
    f.position(120);
    await f.archive.stop();
    expect(f.bookmarks.save.mock.calls.at(-1)![0]).toMatchObject({
      sessionGeneration: '2',
      positionMs: 120000,
    });
    await f.archive.dispose();
  });
  it('lease renewal performs no periodic storage writes; Stop saves the last lifecycle position', async () => {
    const f = bookmarkFixture();
    await f.archive.select(selection);
    f.position(150);
    await vi.advanceTimersByTimeAsync(180000);
    expect(f.playback.renew).toHaveBeenCalledTimes(9);
    expect(f.bookmarks.save).not.toHaveBeenCalled();
    await f.archive.stop();
    expect(f.bookmarks.save).toHaveBeenCalledTimes(1);
    expect(f.bookmarks.save.mock.calls[0][0]).toMatchObject({ positionMs: 150000 });
    await f.archive.dispose();
  });
});

it('offline saved choice survives Stop/background metadata retention and never dispatches online startup', async () => {
  const commands: string[] = [];
  let issued = 0;
  const f = fixture(async (command, args) => {
    commands.push(command);
    if (command === 'start_archive_download_playback') {
      expect(args?.request).toEqual({
        schemaVersion: 1,
        downloadRef: 'e'.repeat(64),
        expectedRevision: '7',
      });
      return started(String(++issued));
    }
    const request = args?.request as { sessionGeneration: string };
    if (command === 'stop_archive_playback') return stopped(request.sessionGeneration);
    if (command === 'renew_archive_playback')
      return {
        schemaVersion: 1,
        sessionGeneration: request.sessionGeneration,
        renewed: true,
        leaseMs: 60000,
      };
    if (command === 'cancel_playlist') return true;
    throw Error('Unexpected online/provider request');
  });
  try {
    f.revision('999');
    await f.archive.selectSaved(
      {
        downloadRef: 'e'.repeat(64),
        fileRef: selection.fileRef,
        titleRef: selection.titleRef,
        title: selection.title,
        fileTitle: selection.fileTitle,
        fileName: 'episode.mp4',
        sizeBytes: '100',
        completedMs: 1000,
        integrity: 'sha1-verified',
        available: true,
      },
      '7',
    );
    const retained = f.archive.selection!;
    expect(retained).toMatchObject({
      downloadRef: 'e'.repeat(64),
      downloadRevision: '7',
      expectedRevision: '7',
    });
    await f.archive.stop();
    f.revision('1000');
    await f.archive.select(retained);
    expect(commands.filter((c) => c === 'start_archive_download_playback')).toHaveLength(2);
    expect(commands).not.toContain('start_archive_playback');
    expect(f.events.filter((e) => e === 'decoder-start')).toHaveLength(2);
    expect(f.events.filter((e) => e === 'public-account-sharing-joined')).toHaveLength(2);
  } finally {
    await f.close();
  }
});
it('malformed local selection cannot turn an online file into a local allocation', async () => {
  const f = fixture();
  try {
    await expect(
      f.archive.select({ ...selection, downloadRef: undefined, downloadRevision: undefined }),
    ).rejects.toThrow();
    await expect(
      f.archive.select({ ...selection, downloadRef: 'e'.repeat(64), downloadRevision: '2' }),
    ).rejects.toThrow();
    expect(f.runtime.invoke).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
