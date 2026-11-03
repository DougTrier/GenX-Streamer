/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import Hls, { type ErrorData } from 'hls.js';
import { createHlsLiveWindowRecovery } from '../../src/platform/hls-live-window-recovery';
import { createResourceOwners } from '../../src/playback/resource-owners';

afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const owners = createResourceOwners();
  const signal = new AbortController();
  const video = { currentTime: 1 };
  let current = true;
  const hls = {
    levels: [{ details: { live: true, requestScheduled: 2000 } }],
    liveSyncPosition: 10,
    loadLevel: 0,
    loadingEnabled: true,
    on: (event: string, listener: (...args: unknown[]) => void) => handlers.set(event, listener),
    off: (event: string) => handlers.delete(event),
    stopLoad: vi.fn(),
    startLoad: vi.fn(() => handlers.get(Hls.Events.LEVEL_LOADING)?.('', { level: 0 })),
    pauseBuffering: vi.fn(),
    resumeBuffering: vi.fn(),
  };
  const fail = vi.fn(),
    observe = vi.fn();
  const recover = createHlsLiveWindowRecovery({
    hls: hls as unknown as Hls,
    events: Hls.Events,
    video: video as HTMLVideoElement,
    signal: signal.signal,
    owners,
    current: () => current,
    fail,
    observe,
  });
  const error = {
    details: 'fragLoadError',
    response: { code: 404 },
    frag: { type: 'main', level: 0 },
  } as ErrorData;
  return {
    hls,
    video,
    signal,
    owners,
    fail,
    observe,
    recover,
    error,
    handlers,
    stale: () => {
      current = false;
    },
  };
}
const empty = (owners: ReturnType<typeof createResourceOwners>) =>
  Object.values(owners.snapshot().counts).every((value) => value === 0);

it('bounds a missing fresh response and retains the original fragment HTTP evidence', () => {
  const s = setup();
  expect(s.recover(s.error)).toBe(true);
  vi.advanceTimersByTime(2000);
  expect(s.hls.startLoad).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(s.hls.startLoad).toHaveBeenCalledExactlyOnceWith(-1);
  vi.advanceTimersByTime(5000);
  expect(s.fail).toHaveBeenCalledExactlyOnceWith(s.error);
  expect(s.observe).toHaveBeenCalledExactlyOnceWith(s.error);
  expect(s.video.currentTime).toBe(1);
  expect(s.recover(s.error)).toBe(false);
  expect(empty(s.owners)).toBe(true);
});
it('aborts before refresh without a late restart or active resource', () => {
  const s = setup();
  s.recover(s.error);
  const late = s.handlers.get(Hls.Events.LEVEL_LOADED)!;
  s.signal.abort();
  vi.runAllTimers();
  late('', { level: 0, details: { live: true } });
  expect(s.hls.startLoad).not.toHaveBeenCalled();
  expect(s.hls.resumeBuffering).not.toHaveBeenCalled();
  expect(s.fail).not.toHaveBeenCalled();
  expect(s.video.currentTime).toBe(1);
  expect(empty(s.owners)).toBe(true);
});
it('ignores an older matching playlist response before its own fresh request starts', () => {
  const s = setup();
  s.recover(s.error);
  const loaded = s.handlers.get(Hls.Events.LEVEL_LOADED)!;
  loaded('', { level: 0, details: { live: true }, stats: { loading: { start: 0 } } });
  expect(s.video.currentTime).toBe(1);
  expect(s.hls.resumeBuffering).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2001);
  expect(s.hls.startLoad).toHaveBeenCalledOnce();
  loaded('', { level: 0, details: { live: true }, stats: { loading: { start: 0 } } });
  expect(s.video.currentTime).toBe(1);
  s.signal.abort();
  expect(empty(s.owners)).toBe(true);
});
it('rejects stale engine ownership during the held response', () => {
  const s = setup();
  s.recover(s.error);
  vi.advanceTimersByTime(2001);
  s.stale();
  s.handlers.get(Hls.Events.LEVEL_LOADED)!('', { level: 0, details: { live: true } });
  vi.runAllTimers();
  expect(s.hls.resumeBuffering).not.toHaveBeenCalled();
  expect(s.fail).not.toHaveBeenCalled();
  expect(s.video.currentTime).toBe(1);
  expect(empty(s.owners)).toBe(true);
});
it('requires the matching fresh live rendition and resumes only at its observed sync point', () => {
  const s = setup();
  s.recover(s.error);
  vi.advanceTimersByTime(2001);
  const loaded = s.handlers.get(Hls.Events.LEVEL_LOADED)!;
  loaded('', { level: 1, details: { live: true } });
  expect(s.video.currentTime).toBe(1);
  loaded('', { level: 0, details: { live: true }, stats: { loading: { start: 2001 } } });
  expect(s.video.currentTime).toBe(10);
  expect(s.hls.resumeBuffering).toHaveBeenCalledOnce();
  expect(s.fail).not.toHaveBeenCalled();
  expect(empty(s.owners)).toBe(true);
});
it('relinquishes an old fragment wait to an actual new rendition without resetting the budget', async () => {
  const s = setup();
  s.recover(s.error);
  const late = s.handlers.get(Hls.Events.LEVEL_LOADED)!;
  s.hls.loadLevel = 1;
  s.hls.loadingEnabled = false;
  s.handlers.get(Hls.Events.LEVEL_SWITCHING)!('', { level: 1 });
  await Promise.resolve();
  vi.runAllTimers();
  late('', { level: 0, details: { live: true } });
  expect(s.hls.startLoad).toHaveBeenCalledExactlyOnceWith(-1);
  expect(s.hls.resumeBuffering).toHaveBeenCalledOnce();
  expect(s.fail).not.toHaveBeenCalled();
  expect(s.video.currentTime).toBe(1);
  expect(s.recover(s.error)).toBe(false);
  expect(empty(s.owners)).toBe(true);
});
