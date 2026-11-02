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

import { inspectSource } from '../platform/records';
import { invoke } from '@tauri-apps/api/core';
import type { ChannelSelection, EngineEvent, PlaybackEngine } from './controller';
import { createNativeVodEngine, type NativeEngineHost } from './native-vod-engine';

/** GenX's loopback relay for a live channel (src-tauri/src/playback/native_live.rs). */
export interface NativeLiveRelay {
  open(
    url: string,
    allowHttp: boolean,
    progressive?: boolean,
  ): Promise<{ session: number; url: string }>;
  renew(session: number): Promise<void>;
  close(session: number): Promise<void>;
}
export const nativeLiveRelay: NativeLiveRelay = {
  open: (url, allowHttp, progressive = false) =>
    invoke('native_live_open', { url, allowHttp, progressive }),
  renew: (session) => invoke('native_live_renew', { session }),
  close: (session) => invoke('native_live_close', { session }),
};
/** The relay's lease is 60 s; renew well inside it while the channel plays. */
export const LIVE_RELAY_RENEW_MS = 20_000;

/**
 * A live channel in the device's own player (Android): channels whose MPEG-2
 * picture the web player cannot show. The player opens only the loopback
 * relay GenX starts for this channel, which ends with the engine.
 */
export function createNativeLiveEngine(
  emit: (event: EngineEvent) => void,
  host: NativeEngineHost,
  relay: NativeLiveRelay,
  allowHttp: (url: string) => boolean,
  /** The channel plays, but this device cannot decode its sound. */
  onSilent: () => void = () => undefined,
  /** The channel's sound plays, but this device cannot decode its picture. */
  onPictureUnsupported: () => void = () => undefined,
  inspect: typeof inspectSource = inspectSource,
): PlaybackEngine {
  const every = host.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const stopEvery =
    host.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let silentReported = false;
  const player = createNativeVodEngine(
    (event) => {
      if (
        event.type === 'audio-tracks' &&
        event.snapshot &&
        event.snapshot.trackCount > 0 &&
        !event.snapshot.selectable &&
        !silentReported
      ) {
        silentReported = true;
        onSilent();
      }
      emit(event);
    },
    host,
    { live: true, onPictureUnsupported },
  );
  let session = 0;
  let renewal: unknown = null;
  let disposed = false;
  const release = async () => {
    if (renewal !== null) stopEvery(renewal);
    renewal = null;
    const owned = session;
    session = 0;
    if (owned) await relay.close(owned).catch(() => undefined);
  };
  return {
    async start(selection: ChannelSelection, signal: AbortSignal) {
      signal.throwIfAborted();
      const allowed = allowHttp(selection.url);
      // A known format survives retries. Probe only an unknown public source;
      // account streams use their existing owner and never pass through here.
      const kind = selection.mediaKind ?? (await inspect(selection.url, allowed, signal)).kind;
      signal.throwIfAborted();
      if (kind !== 'hls' && kind !== 'media') throw new Error('native-live-format-unsupported');
      const opened =
        kind === 'media'
          ? await relay.open(selection.url, allowed, true)
          : await relay.open(selection.url, allowed);
      session = opened.session;
      if (disposed || signal.aborted) {
        await release();
        throw new DOMException('Native live start canceled.', 'AbortError');
      }
      renewal = every(() => {
        if (session) void relay.renew(session).catch(() => undefined);
      }, LIVE_RELAY_RENEW_MS);
      await player.start({ ...selection, url: opened.url, mediaKind: kind }, signal);
    },
    pause: () => player.pause(),
    resume: () => player.resume(),
    setMuted: (muted) => player.setMuted(muted),
    setVolume: (volume) => player.setVolume(volume),
    readAudioTracks: () => player.readAudioTracks?.() ?? null,
    setAudioTrack: (id) => player.setAudioTrack?.(id) ?? false,
    readLiveBuffer: () => (!disposed ? (player.readLiveBuffer?.() ?? null) : null),
    setLiveBuffer: (preference) =>
      !disposed ? (player.setLiveBuffer?.(preference) ?? false) : false,
    liveReplay: () => player.liveReplay?.() ?? null,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await player.dispose();
      await release();
    },
  };
}
