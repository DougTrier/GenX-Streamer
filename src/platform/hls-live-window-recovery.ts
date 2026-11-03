/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import type Hls from 'hls.js';
import type { ErrorData, LevelLoadedData, LevelLoadingData, LevelSwitchingData } from 'hls.js';
import type { ResourceOwners } from '../playback/resource-owners';

/** One existing-player resync, only for a missing main fragment in a live playlist. */
export function createHlsLiveWindowRecovery(options: {
  hls: Hls;
  events: typeof Hls.Events;
  video: HTMLVideoElement;
  signal: AbortSignal;
  owners: ResourceOwners;
  current: () => boolean;
  fail: (error: ErrorData) => void;
  observe: (error: ErrorData) => void;
}): (error: ErrorData) => boolean {
  const { hls, events, signal, owners } = options;
  let used = false;
  let cancelPending: (() => void) | null = null;
  return (error) => {
    // A second fatal error takes the established terminal/failover path.
    cancelPending?.();
    const fragment = error.frag;
    const level = fragment?.level;
    const details = typeof level === 'number' ? hls.levels[level]?.details : null;
    if (
      used ||
      !options.current() ||
      signal.aborted ||
      error.details !== 'fragLoadError' ||
      ![404, 410].includes(error.response?.code ?? 0) ||
      fragment?.type !== 'main' ||
      typeof level !== 'number' ||
      !details?.live
    )
      return false;
    used = true;
    // startLoad resumes fragment loading synchronously. Wait for the existing
    // rendition's scheduled refresh so LEVEL_LOADING can pause it first.
    const delay = Math.max(0, Math.ceil(details.requestScheduled - performance.now()) + 1);
    if (!Number.isFinite(delay) || delay > 8000) return false;
    let active = true;
    let refreshStartedAt: number | null = null;
    let refreshLoading = false;
    const releaseTimer = owners.acquire('loaderTimers');
    const releaseStartTimer = owners.acquire('loaderTimers');
    const releaseAbort = owners.acquire('abortListeners');
    const releaseLoading = owners.acquire('hlsListeners');
    const releaseLoaded = owners.acquire('hlsListeners');
    const releaseSwitching = owners.acquire('hlsListeners');
    const cancel = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      clearTimeout(startTimer);
      signal.removeEventListener('abort', cancel);
      hls.off(events.LEVEL_LOADING, loading);
      hls.off(events.LEVEL_LOADED, loaded);
      hls.off(events.LEVEL_SWITCHING, switching);
      releaseTimer();
      releaseStartTimer();
      releaseAbort();
      releaseLoading();
      releaseLoaded();
      releaseSwitching();
      cancelPending = null;
    };
    const fail = () => {
      const current = options.current() && !signal.aborted;
      cancel();
      if (current) options.fail(error);
    };
    const loading = (_event: unknown, data: LevelLoadingData) => {
      if (active && refreshStartedAt !== null && data.level === level) {
        refreshLoading = true;
        hls.pauseBuffering();
      }
    };
    const switching = (_event: unknown, data: LevelSwitchingData) => {
      if (!active || data.level === level) return;
      cancel();
      // Manual quality or ABR now owns another rendition in this same player.
      // Its success must not later receive the old fragment's timeout/error.
      queueMicrotask(() => {
        if (!options.current() || signal.aborted || hls.loadLevel !== data.level) return;
        try {
          if (!hls.loadingEnabled) hls.startLoad(-1);
          hls.resumeBuffering();
        } catch {
          options.fail(error);
        }
      });
    };
    const loaded = (_event: unknown, data: LevelLoadedData) => {
      if (!active || data.level !== level) return;
      if (!options.current() || signal.aborted) {
        cancel();
        return;
      }
      const requestStartedAt = data.stats?.loading.start;
      if (
        !refreshLoading ||
        refreshStartedAt === null ||
        !Number.isFinite(requestStartedAt) ||
        requestStartedAt < refreshStartedAt
      )
        return;
      const position = hls.liveSyncPosition;
      if (!data.details.live || position === null || !Number.isFinite(position)) {
        fail();
        return;
      }
      cancel();
      try {
        // Public startLoad refreshes the live rendition without detach. Wait
        // for that response before moving to its actual live-sync position.
        options.video.currentTime = position;
        hls.resumeBuffering();
      } catch {
        options.fail(error);
      }
    };
    cancelPending = cancel;
    signal.addEventListener('abort', cancel, { once: true });
    hls.on(events.LEVEL_LOADING, loading);
    hls.on(events.LEVEL_LOADED, loaded);
    hls.on(events.LEVEL_SWITCHING, switching);
    const timer = setTimeout(fail, delay + 5000);
    const startTimer = setTimeout(() => {
      releaseStartTimer();
      if (!active) return;
      if (!options.current() || signal.aborted) {
        cancel();
        return;
      }
      try {
        refreshStartedAt = performance.now();
        hls.startLoad(-1);
        hls.pauseBuffering();
      } catch {
        fail();
      }
    }, delay);
    options.observe(error);
    try {
      hls.stopLoad();
    } catch {
      fail();
    }
    return true;
  };
}
