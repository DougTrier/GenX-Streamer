// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { createBrowserEngine } from '../../src/platform/browser-engine';
import { classifyTransportFailure } from '../../src/playback/failure';
import { type EngineEvent } from '../../src/playback/controller';
import { Video } from './browser-engine.fixture';

const trace = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../src/diagnostics/playback-trace', async (original) => ({
  ...(await original<typeof import('../../src/diagnostics/playback-trace')>()),
  traceEnabled: () => true,
  recordPlaybackTrace: trace.record,
}));
beforeEach(() => trace.record.mockReset());

async function setup(emit: (event: EngineEvent) => void) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const player = {
    on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
    statisticsInfo: {
      loaderType: 'fetch-stream-loader',
      url: 'https://user:secret@provider.invalid/token',
    },
    attachMediaElement: vi.fn(),
    load: vi.fn(),
    pause: vi.fn(),
    unload: vi.fn(),
    detachMediaElement: vi.fn(),
    destroy: vi.fn(),
  };
  const library = {
    isSupported: () => true,
    getFeatureList: () => ({ mseLivePlayback: true }),
    createPlayer: vi.fn(() => player),
    Events: { ERROR: 'error', MEDIA_INFO: 'info' },
    ErrorTypes: { MEDIA_ERROR: 'MediaError', NETWORK_ERROR: 'NetworkError' },
    ErrorDetails: {
      MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported',
      MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported',
    },
  };
  const video = new Video();
  Object.assign(video, {
    currentTime: 27.2,
    readyState: 4,
    networkState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    buffered: { length: 1, start: () => 0, end: () => 45.2 },
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 840, droppedVideoFrames: 1 }),
  });
  const signal = new AbortController();
  const engine = createBrowserEngine(video.element, emit, undefined, {
    loadMpegts: async () => library as unknown as typeof import('mpegts.js').default,
  });
  await engine.start(
    {
      id: 'account-fixture',
      name: 'Fixture',
      url: 'https://example.test/live.ts',
      mediaKind: 'media',
      mediaMime: 'video/mp2t',
    },
    signal.signal,
  );
  return { video, player, handlers, engine, signal };
}

it('records pre-abort facts then preserves the existing retryable network failure policy', async () => {
  const events: EngineEvent[] = [];
  const abort: { current?: () => void } = {};
  const fixture = await setup((event) => {
    events.push(event);
    if (event.type === 'error') abort.current?.();
  });
  abort.current = () => fixture.signal.abort();
  try {
    fixture.handlers.get('error')!('NetworkError', 'Exception', {
      code: -1,
      msg: 'Array buffer allocation failed https://user:secret@provider.invalid/token',
      stack: 'private',
    });
    expect(fixture.signal.signal.aborted).toBe(true);
    expect(fixture.player.unload).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', failure: classifyTransportFailure('network-failure') },
    ]);
    expect(trace.record).toHaveBeenCalledOnce();
    expect(trace.record.mock.calls[0]).toEqual([
      'paid',
      'error',
      expect.objectContaining({
        initiator: 'engine',
        libraryErrorType: 'network',
        ownerAborted: false,
        exceptionKind: 'arraybuffer-allocation',
        loaderKind: 'fetch-stream',
        loaderCode: -1,
        readyState: 4,
        networkState: 2,
        positionMs: 27200,
        totalFrames: 840,
        droppedFrames: 1,
      }),
    ]);
    expect(trace.record.mock.calls[0]![2].bufferedAheadMs).toBeCloseTo(18000);
    expect(JSON.stringify(trace.record.mock.calls)).not.toMatch(/secret|private|https|stack/);
    fixture.handlers.get('error')!('NetworkError', 'Exception', {
      code: 20,
      msg: 'The operation was aborted.',
    });
    expect(trace.record).toHaveBeenCalledOnce();
  } finally {
    await fixture.engine.dispose();
  }
});

it('does not let optional diagnostics failure suppress the original media failure', async () => {
  const events: EngineEvent[] = [];
  const fixture = await setup((event) => events.push(event));
  try {
    trace.record.mockImplementationOnce(() => {
      throw Error('diagnostics refused');
    });
    fixture.handlers.get('error')!('MediaError', 'MediaMSEError', {
      code: 22,
      msg: 'unfamiliar secret',
    });
    expect(events.filter((event) => event.type === 'error')).toEqual([
      {
        type: 'error',
        failure: expect.objectContaining({
          code: 'decode',
          retryable: false,
          evidence: 'media',
          phase: 'decode',
        }),
      },
    ]);
  } finally {
    await fixture.engine.dispose();
  }
});
