import type { ChannelSelection, EngineFactory, PlaybackEngine } from './controller';

/** Paid TV movies and episodes (the account player's on-demand selections). */
export const accountOnDemand = (selection: ChannelSelection): boolean =>
  selection.playMode === 'on-demand' && /^vod:(movie|episode):/u.test(selection.id);

/**
 * Picks the engine when a selection starts: the native player for the
 * selections `useNative` accepts (Android Paid TV movies and episodes, whose
 * embedded languages and subtitles the WebView cannot expose), the web player
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
      inner = prepare(native && useNative(selection) ? native(emit) : web(webEmit));
      return inner;
    };
    return {
      start: async (selection, signal) => {
        started = { selection, signal };
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
