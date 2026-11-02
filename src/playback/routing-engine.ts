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

import type { ChannelSelection, EngineFactory, PlaybackEngine } from './controller';
import { normalizeLiveBufferPreference } from './live-buffer';

/** Paid TV movies and episodes (the account player's on-demand selections). */
export const accountOnDemand = (selection: ChannelSelection): boolean =>
  selection.playMode === 'on-demand' && /^vod:(movie|episode):/u.test(selection.id);
export const archiveOnDemand = (selection: ChannelSelection): boolean =>
  selection.playMode === 'on-demand' && selection.id.startsWith('archive-');
export const accountLive = (selection: ChannelSelection): boolean =>
  selection.playMode !== 'on-demand' && selection.id.startsWith('account-');
export const nativePlaybackSelection = (
  selection: ChannelSelection,
  preferEmbedded = false,
): boolean =>
  accountOnDemand(selection) ||
  (preferEmbedded && (archiveOnDemand(selection) || accountLive(selection)));

/**
 * Picks the engine when a selection starts: the native player for the
 * selections `useNative` accepts (Android Paid TV movies/episodes and the
 * Fire OS 7 GenXtra/Paid-live capability), the web player
 * for everything else. One inner engine per attempt, as the controller expects.
 *
 * `liveNative` (Android) takes over a live channel whose picture the web
 * player reports it cannot show (MPEG-2): the web engine is released and the
 * same selection starts in the device's own player, once per attempt.
 */
export function createRoutingEngineFactory(
  web: EngineFactory,
  native: EngineFactory | null,
  useNative: (selection: ChannelSelection) => boolean,
  liveNative: EngineFactory | null = null,
  preferNativeLive: (selection: ChannelSelection) => boolean = () => false,
): EngineFactory {
  return (emit) => {
    let inner: PlaybackEngine | null = null;
    let muted = false;
    let volume = 1;
    let started: { selection: ChannelSelection; signal: AbortSignal } | null = null;
    let handedOver = false;
    let disposed = false;
    const prepare = (engine: PlaybackEngine) => {
      engine.setMuted(muted);
      engine.setVolume(volume);
      return engine;
    };
    const handOver = (selection: ChannelSelection, signal: AbortSignal) => {
      handedOver = true;
      const previous = inner;
      const next = prepare(liveNative!(emit));
      inner = next;
      void previous?.dispose();
      void next.start(selection, signal).catch(() => {
        if (inner === next && !signal.aborted && !disposed)
          emit({
            type: 'error',
            failure: {
              code: 'unsupported',
              message:
                'This channel sends its picture as MPEG-2 and this device’s player could not open it. Choose another stream for this channel.',
              retryable: false,
            },
          });
      });
    };
    const webEmit: Parameters<EngineFactory>[0] = (event) => {
      if (
        event.type === 'error' &&
        event.failure.nativeFormat &&
        liveNative &&
        !handedOver &&
        !disposed &&
        started &&
        !started.signal.aborted &&
        started.selection.playMode !== 'on-demand'
      ) {
        handOver(started.selection, started.signal);
        return;
      }
      emit(event);
    };
    const pick = (selection: ChannelSelection) => {
      inner = prepare(
        native && useNative(selection)
          ? native(emit)
          : liveNative && preferNativeLive(selection)
            ? liveNative(emit)
            : web(webEmit),
      );
      return inner;
    };
    return {
      start: async (selection, signal) => {
        started = { selection: { ...selection }, signal };
        try {
          await (inner ?? pick(selection)).start(selection, signal);
        } catch (error) {
          // The released web engine's start may end in an error; the device's
          // player now owns this attempt and reports its own outcome.
          if (!handedOver) throw error;
        }
      },
      pause: () => inner?.pause(),
      resume: async () => {
        await inner?.resume();
      },
      setMuted(value) {
        muted = value;
        inner?.setMuted(value);
      },
      setVolume(value) {
        volume = value;
        inner?.setVolume(value);
      },
      readAudioTracks: () => inner?.readAudioTracks?.() ?? null,
      setAudioTrack: (id) => inner?.setAudioTrack?.(id) ?? false,
      readLiveBuffer: () =>
        disposed || started?.signal.aborted ? null : (inner?.readLiveBuffer?.() ?? null),
      setLiveBuffer: async (value) => {
        const preference = normalizeLiveBufferPreference(value);
        const engine = inner;
        const attempt = started;
        if (!preference || !engine || !attempt || disposed || attempt.signal.aborted) return false;
        const accepted = (await engine.setLiveBuffer?.(preference)) === true;
        if (
          !accepted ||
          inner !== engine ||
          started !== attempt ||
          disposed ||
          attempt.signal.aborted
        )
          return false;
        attempt.selection = { ...attempt.selection, liveBuffer: { ...preference } };
        return true;
      },
      liveReplay: () => inner?.liveReplay?.() ?? null,
      readVODposition: () => inner?.readVODposition?.() ?? null,
      readVODduration: () => inner?.readVODduration?.() ?? null,
      seekVOD: (seconds, signal) =>
        inner?.seekVOD ? inner.seekVOD(seconds, signal) : Promise.resolve('unavailable' as const),
      dispose: () => {
        disposed = true;
        return inner?.dispose();
      },
    };
  };
}
