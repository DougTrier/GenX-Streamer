import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackController,
  REPLAY_REACH_SECONDS,
  replayAvailable,
  replayFrameSeconds,
  replayWindowFrom,
  type EngineEvent,
  type LiveReplayEngine,
  type PlaybackEngine,
} from '../../src/playback/controller';
import {
  createNativeLiveEngine,
  type NativeLiveRelay,
} from '../../src/playback/native-live-engine';
import { createRoutingEngineFactory } from '../../src/playback/routing-engine';
import type { NativeVideoRequest, NativeVideoStatus } from '../../src/platform/native-video';
import { createResourceOwners } from '../../src/playback/resource-owners';

// Instant replay (docs/instant-replay.md, REPLAY01): the window rules, the
// controller's ownership guard and the Android player's commands. The web
// player and the dock run against Chrome's decoder in
// tests/ui/live-replay.spec.ts.

describe('replay window (RP01, RP03)', () => {
  it('is the buffered range holding the position', () => {
    // The reach behind live is the replay's own (it moves with the live
    // picture): the window reports what the player keeps.
    expect(replayWindowFrom([[0, 50]], 45, 1 / 25)).toEqual({
      start: 0,
      end: 50,
      position: 45,
      frameSeconds: 1 / 25,
    });
    // A gap: only the range holding the position counts as its start.
    expect(
      replayWindowFrom(
        [
          [0, 10],
          [12, 30],
        ],
        20,
        1 / 30,
      ),
    ).toMatchObject({ start: 12, end: 30 });
    // Outside every range: no window.
    expect(replayWindowFrom([[0, 10]], 11, 1 / 30)).toBeNull();
    expect(replayWindowFrom([], 1, 1 / 30)).toBeNull();
    expect(replayWindowFrom([[0, Number.NaN]], 1, 1 / 30)).toBeNull();
    expect(replayWindowFrom([[5, 2]], 3, 1 / 30)).toBeNull();
    expect(replayWindowFrom([[0, 10]], -1, 1 / 30)).toBeNull();
  });
  it('is offered only with at least 2 s behind the playing position', () => {
    expect(replayAvailable(replayWindowFrom([[10, 20]], 11.9, 1 / 30))).toBe(false);
    expect(replayAvailable(replayWindowFrom([[10, 20]], 12, 1 / 30))).toBe(true);
    expect(replayAvailable(null)).toBe(false);
  });
  it('uses a measured frame period within 1/120 to 1/10 s, else 1/30 s (RP04)', () => {
    expect(replayFrameSeconds(1 / 60)).toBeCloseTo(1 / 60, 9);
    expect(replayFrameSeconds(1 / 500)).toBeCloseTo(1 / 120, 9);
    expect(replayFrameSeconds(1)).toBe(0.1);
    for (const unknown of [null, undefined, 0, -1, Number.NaN, Infinity])
      expect(replayFrameSeconds(unknown)).toBeCloseTo(1 / 30, 9);
  });
});

describe('controller ownership (RP02)', () => {
  function harness() {
    const engines: Array<{ emit: (event: EngineEvent) => void; replay: LiveReplayEngine }> = [];
    const controller = new PlaybackController(
      (emit) => {
        const replay: LiveReplayEngine = {
          window: vi.fn(() => ({ start: 0, end: 20, position: 15, frameSeconds: 1 / 30 })),
          seek: vi.fn(async () => true),
          setRate: vi.fn(),
          setPaused: vi.fn(),
          leave: vi.fn(),
        };
        engines.push({ emit, replay });
        const engine: PlaybackEngine = {
          start: async () => undefined,
          pause: vi.fn(),
          resume: async () => undefined,
          setMuted: vi.fn(),
          setVolume: vi.fn(),
          liveReplay: () => replay,
          dispose: vi.fn(),
        };
        return engine;
      },
      undefined,
      createResourceOwners(),
    );
    return { controller, engines };
  }
  const live = (id: string) => ({ id, name: id, url: `https://example.test/${id}.m3u8` });

  it('offers replay only while a live channel plays', async () => {
    const { controller, engines } = harness();
    expect(controller.liveReplay()).toBeNull();
    await controller.select(live('one'));
    // Connecting: no media progress yet.
    expect(controller.liveReplay()).toBeNull();
    engines[0]!.emit({ type: 'progress' });
    expect(controller.liveReplay()?.window()).toMatchObject({ position: 15 });
    await controller.select({ ...live('film'), playMode: 'on-demand' });
    engines[1]!.emit({ type: 'progress' });
    expect(controller.liveReplay()).toBeNull();
    await controller.dispose();
  });

  it('an older channel’s handle never reaches the new channel', async () => {
    const { controller, engines } = harness();
    await controller.select(live('one'));
    engines[0]!.emit({ type: 'progress' });
    const old = controller.liveReplay()!;
    old.setRate(0.25);
    expect(engines[0]!.replay.setRate).toHaveBeenCalledWith(0.25);
    await controller.select(live('two'));
    engines[1]!.emit({ type: 'progress' });
    expect(old.window()).toBeNull();
    old.setRate(0.125);
    old.setPaused(true);
    old.leave();
    expect(await old.seek(10, new AbortController().signal)).toBe(false);
    for (const engine of engines) {
      expect(engine.replay.setRate).not.toHaveBeenCalledWith(0.125);
      expect(engine.replay.setPaused).not.toHaveBeenCalled();
      expect(engine.replay.leave).not.toHaveBeenCalled();
      expect(engine.replay.seek).not.toHaveBeenCalled();
    }
    await controller.dispose();
  });

  it('pause, stop and failure end the handle; a seek settling after them reports false', async () => {
    const { controller, engines } = harness();
    await controller.select(live('one'));
    engines[0]!.emit({ type: 'progress' });
    let finish!: (shown: boolean) => void;
    vi.mocked(engines[0]!.replay.seek).mockImplementation(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const handle = controller.liveReplay()!;
    const seeking = handle.seek(10, new AbortController().signal);
    controller.pause();
    expect(handle.window()).toBeNull();
    finish(true);
    expect(await seeking).toBe(false);
    await controller.resume();
    engines[0]!.emit({ type: 'progress' });
    expect(controller.liveReplay()).not.toBeNull();
    await controller.stop();
    expect(controller.liveReplay()).toBeNull();
    await controller.dispose();
  });

  it('the routing engine passes replay through to the engine it chose', async () => {
    const replay = { window: () => null } as unknown as LiveReplayEngine;
    const inner: PlaybackEngine = {
      start: async () => undefined,
      pause: () => undefined,
      resume: async () => undefined,
      setMuted: () => undefined,
      setVolume: () => undefined,
      liveReplay: () => replay,
      dispose: () => undefined,
    };
    const routed = createRoutingEngineFactory(
      () => inner,
      null,
      () => false,
    )(() => undefined);
    expect(routed.liveReplay!()).toBeNull();
    await routed.start(live('one'), new AbortController().signal);
    expect(routed.liveReplay!()).toBe(replay);
  });
});

describe('Android player replay (Media3, including Trier MPEG Video)', () => {
  const LIVE = `http://127.0.0.1:41000/media/${'c'.repeat(64)}`;
  function fixture() {
    const requests: NativeVideoRequest[] = [];
    const events: EngineEvent[] = [];
    const now = {
      state: 'ready' as NativeVideoStatus['state'],
      playing: true,
      streamMs: 50_000,
      bufferedMs: 62_000,
      frameMicros: 33_366,
    };
    const status = (session: number): NativeVideoStatus => ({
      session,
      state: now.state,
      playing: now.playing,
      positionMs: 4_000,
      durationMs: 30_000,
      streamMs: now.streamMs,
      streamBufferedMs: now.bufferedMs,
      rate: 1,
      frameMicros: now.frameMicros,
      audio: [],
      text: [],
    });
    let tick: (() => void) | null = null;
    let seeking = false;
    const relay: NativeLiveRelay = {
      open: async () => ({ session: 7, url: LIVE }),
      renew: async () => undefined,
      close: async () => undefined,
    };
    const engine = createNativeLiveEngine(
      (event) => events.push(event),
      {
        bridge: async (request) => {
          requests.push(request);
          // A replay seek buffers until the next status reading.
          if (request.action === 'replay' && request.streamMs !== undefined) {
            now.streamMs = request.streamMs;
            now.state = 'buffering';
            seeking = true;
          }
          if (request.action === 'replay' && request.playing !== undefined)
            now.playing = request.playing;
          if (request.action === 'status' && seeking) {
            seeking = false;
            now.state = 'ready';
          }
          return status(request.session);
        },
        rect: () => [0, 0, 1920, 1080],
        watchRect: () => () => undefined,
        present: () => undefined,
        publish: () => undefined,
        setInterval: (callback) => {
          tick = callback;
          return 1;
        },
        clearInterval: () => {
          tick = null;
        },
      },
      relay,
      () => true,
    );
    return {
      engine,
      requests,
      events,
      now,
      async poll() {
        tick?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      sent: (action: NativeVideoRequest['action']) =>
        requests.filter((request) => request.action === action),
    };
  }
  const channel = { id: 'acc', name: 'ACC Network', url: 'http://203.0.113.4/acc/index.m3u8' };

  it('measures its window in stream positions from where this session began', async () => {
    const f = fixture();
    await f.engine.start(channel, new AbortController().signal);
    f.now.streamMs = 70_000;
    f.now.bufferedMs = 82_000;
    await f.poll();
    const replay = f.engine.liveReplay!()!;
    // Media3 keeps 30 s behind what it plays, from where this session began.
    expect(replay.window()).toEqual({
      start: 50,
      end: 82,
      position: 70,
      frameSeconds: 0.033366,
    });
    // Early in the session the window starts where it began.
    const g = fixture();
    await g.engine.start(channel, new AbortController().signal);
    expect(g.engine.liveReplay!()!.window()).toMatchObject({ start: 50, position: 50 });
    g.now.streamMs = 95_000;
    g.now.bufferedMs = 100_000;
    await g.poll();
    expect(g.engine.liveReplay!()!.window()).toMatchObject({
      start: 95 - REPLAY_REACH_SECONDS,
      position: 95,
    });
  });

  it('slows and mutes, seeks by stream position, pauses, and leaves for live', async () => {
    const f = fixture();
    await f.engine.start(channel, new AbortController().signal);
    f.engine.setVolume(0.6);
    f.now.streamMs = 70_000;
    f.now.bufferedMs = 82_000;
    await f.poll();
    const replay = f.engine.liveReplay!()!;
    replay.setRate(0.25);
    replay.setRate(0.3); // not a replay speed
    expect(f.sent('replay')).toEqual([expect.objectContaining({ action: 'replay', rate: 0.25 })]);
    // RP05: silent below 1x, the viewer's own volume untouched.
    expect(f.sent('volume').at(-1)).toMatchObject({ volume: 0 });
    expect(await replay.seek(60, new AbortController().signal)).toBe(true);
    expect(f.sent('replay').at(-1)).toMatchObject({ streamMs: 60_000 });
    // Outside the window: refused without a command.
    const sent = f.requests.length;
    expect(await replay.seek(40, new AbortController().signal)).toBe(false);
    expect(await replay.seek(90, new AbortController().signal)).toBe(false);
    expect(f.requests).toHaveLength(sent);
    replay.setPaused(true);
    await Promise.resolve();
    expect(f.sent('replay').at(-1)).toMatchObject({ playing: false });
    replay.leave();
    expect(f.sent('play')).toHaveLength(1);
    expect(f.sent('volume').at(-1)).toMatchObject({ volume: 0.6 });
  });

  it('a paused replay showing its picture again is progress, not a stall (RP08)', async () => {
    const f = fixture();
    await f.engine.start(channel, new AbortController().signal);
    const replay = f.engine.liveReplay!()!;
    replay.setPaused(true);
    await Promise.resolve();
    f.events.length = 0;
    f.now.state = 'buffering';
    await f.poll();
    f.now.state = 'ready';
    await f.poll();
    expect(f.events.map((event) => event.type)).toEqual(['buffering', 'progress']);
  });

  it('a controller pause ends the replay and restores the sound', async () => {
    const f = fixture();
    await f.engine.start(channel, new AbortController().signal);
    const replay = f.engine.liveReplay!()!;
    replay.setRate(0.125);
    f.engine.pause();
    expect(f.sent('volume').at(-1)).toMatchObject({ volume: 1 });
    await f.engine.dispose();
    expect(f.engine.liveReplay!()).toBeNull();
  });
});
