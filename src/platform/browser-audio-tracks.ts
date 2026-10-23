import type Hls from 'hls.js';
import type { Events } from 'hls.js';
import { MAX_AUDIO_TRACKS, type AudioTracksSnapshot } from '../playback/audio-tracks';
import type { ResourceOwners } from '../playback/resource-owners';
import { boundedUtf8Text } from './bounded-text';

export const AUDIO_TRACKS_CHANGE = 'audio-tracks-change';
export interface AudioControls {
  read(): Readonly<AudioTracksSnapshot> | null;
  set(id: string | null): boolean;
}
const controls = new WeakMap<HTMLVideoElement, AudioControls>();
export function readAudioTracks(video: HTMLVideoElement): Readonly<AudioTracksSnapshot> | null {
  try {
    return controls.get(video)?.read() ?? null;
  } catch {
    return null;
  }
}
export function setAudioTrack(video: HTMLVideoElement, id: string | null): boolean {
  try {
    return controls.get(video)?.set(id) ?? false;
  } catch {
    return false;
  }
}
/**
 * Another player's audio tracks for this picture (the native on-demand player):
 * the audio menu reads them like the web player's. Returns the release.
 */
export function registerAudioControls(video: HTMLVideoElement, api: AudioControls): () => void {
  controls.set(video, api);
  video.dispatchEvent(new Event(AUDIO_TRACKS_CHANGE));
  return () => {
    if (controls.get(video) !== api) return;
    controls.delete(video);
    video.dispatchEvent(new Event(AUDIO_TRACKS_CHANGE));
  };
}
interface NativeTrack {
  enabled: boolean;
  label?: unknown;
  language?: unknown;
  kind?: unknown;
  description?: unknown;
}
interface NativeTrackList extends EventTarget {
  readonly length: number;
  readonly [index: number]: NativeTrack;
}
interface Entry {
  handle: object;
  index: number;
  name: string | null;
  language: string | null;
  kind: string | null;
  description: string | null;
  providerDefault: boolean | null;
}
const label = (value: unknown): string | null =>
  boundedUtf8Text(value, 256) && !/[\p{Cc}\p{Cf}]/u.test(value) && !value.includes('://')
    ? value
    : null;

/** An attachment owns its actual track listeners and opaque option identities. */
export function createBrowserAudioTracks(
  video: HTMLVideoElement,
  options: {
    current(): boolean;
    canSelect(): boolean;
    emit(snapshot: Readonly<AudioTracksSnapshot> | null): void;
    owners: ResourceOwners;
  },
) {
  const nonce = crypto.randomUUID();
  let closed = false;
  let hls: Hls | null = null;
  let native: NativeTrackList | null = null;
  let source: AudioTracksSnapshot['source'] = null;
  let roster = 0;
  let entries: Entry[] = [];
  let trackCount = 0;
  let initial: object[] = [];
  let mode: AudioTracksSnapshot['mode'] = 'provider-default';
  const bindings: Array<() => void> = [];
  const nativeBindings: Array<() => void> = [];
  const active = () => !closed && controls.get(video) === api && options.current();
  const nativeList = (): NativeTrackList | null => {
    const value = (video as HTMLVideoElement & { audioTracks?: NativeTrackList }).audioTracks;
    return value &&
      Number.isSafeInteger(value.length) &&
      value.length >= 0 &&
      typeof value.addEventListener === 'function' &&
      typeof value.removeEventListener === 'function'
      ? value
      : null;
  };
  const bind = (
    target: EventTarget,
    name: string,
    listener: EventListener,
    nativeOwned = false,
  ) => {
    target.addEventListener(name, listener);
    const release = options.owners.acquire('videoListeners');
    (nativeOwned ? nativeBindings : bindings).push(() => {
      target.removeEventListener(name, listener);
      release();
    });
  };
  const releaseBindings = (owned: Array<() => void>): boolean => {
    const failed: Array<() => void> = [];
    for (const remove of owned) {
      try {
        remove();
      } catch {
        failed.push(remove);
      }
    }
    owned.splice(0, owned.length, ...failed);
    return failed.length === 0;
  };
  function rebuild(force = false): void {
    if (!active()) return;
    const next: Entry[] = [];
    if (hls) {
      const tracks = Array.isArray(hls.audioTracks) ? hls.audioTracks : [];
      trackCount = tracks.length;
      for (let index = 0; index < Math.min(tracks.length, MAX_AUDIO_TRACKS); index++) {
        const track = tracks[index];
        if (!track || typeof track !== 'object') continue;
        next.push({
          handle: track,
          index,
          name: label(track.name),
          language: label(track.lang),
          kind: null,
          description: null,
          providerDefault: typeof track.default === 'boolean' ? track.default : null,
        });
      }
    } else if (native) {
      trackCount = native.length;
      for (let index = 0; index < Math.min(native.length, MAX_AUDIO_TRACKS); index++) {
        const track = native[index];
        if (!track || typeof track !== 'object' || typeof track.enabled !== 'boolean') continue;
        next.push({
          handle: track,
          index,
          name: label(track.label),
          language: label(track.language),
          kind: label(track.kind),
          description: label(track.description),
          providerDefault: null,
        });
      }
    } else trackCount = 0;
    if (
      force ||
      next.length !== entries.length ||
      next.some((entry, index) => {
        const old = entries[index];
        return (
          entry.handle !== old?.handle ||
          entry.index !== old.index ||
          entry.name !== old.name ||
          entry.language !== old.language ||
          entry.kind !== old.kind ||
          entry.description !== old.description ||
          entry.providerDefault !== old.providerDefault
        );
      })
    )
      roster++;
    entries = next;
    if (
      mode === 'provider-default' &&
      initial.length &&
      initial.every((handle) => !entries.some((entry) => entry.handle === handle))
    )
      initial = [];
    // Preserve only actual initial selections/defaults, never choose the first unknown track.
    if (initial.length === 0 && mode === 'provider-default') {
      if (hls) {
        const selected = entries.find((entry) => entry.index === hls!.audioTrack);
        if (selected) initial = [selected.handle];
      } else if (native)
        initial = entries
          .filter((entry) => (entry.handle as NativeTrack).enabled)
          .map((entry) => entry.handle);
    }
  }
  function providerDefault(): Entry[] {
    if (hls) {
      const advertised = entries.filter((entry) => entry.providerDefault === true);
      return advertised.length
        ? [advertised[0]]
        : entries.filter((entry) => initial.includes(entry.handle)).slice(0, 1);
    }
    return entries.filter((entry) => initial.includes(entry.handle));
  }
  function read(): Readonly<AudioTracksSnapshot> | null {
    if (!active()) return null;
    rebuild();
    return Object.freeze({
      source,
      mode,
      selectable:
        options.canSelect() && entries.length > 0 && !(native && trackCount > MAX_AUDIO_TRACKS),
      providerDefaultAvailable: providerDefault().length > 0,
      providerDefaultId: `audio-${nonce}-${roster}-default`,
      trackCount,
      truncated: trackCount > MAX_AUDIO_TRACKS,
      tracks: Object.freeze(
        entries.map((entry) =>
          Object.freeze({
            id: `audio-${nonce}-${roster}-${entry.index}`,
            index: entry.index,
            name: entry.name,
            language: entry.language,
            description: entry.description,
            kind: entry.kind,
            selected: hls
              ? entry.index === hls.audioTrack
              : !!(entry.handle as NativeTrack).enabled,
            providerDefault: entry.providerDefault,
          }),
        ),
      ),
    });
  }
  function publish(force = false): void {
    if (!active()) return;
    rebuild(force);
    const snapshot = read();
    options.emit(snapshot);
    if (active()) video.dispatchEvent(new CustomEvent(AUDIO_TRACKS_CHANGE, { detail: snapshot }));
  }
  function set(id: string | null): boolean {
    if (!active() || !options.canSelect()) return false;
    rebuild();
    const isDefault = id === null || id === `audio-${nonce}-${roster}-default`;
    const chosen = isDefault
      ? providerDefault()
      : entries.filter((entry) => id === `audio-${nonce}-${roster}-${entry.index}`);
    if (!chosen.length || (!isDefault && chosen.length !== 1)) return false;
    const selectedRoster = roster;
    const chosenHandles = new Set(chosen.map((entry) => entry.handle));
    const previousMode = mode;
    mode = isDefault ? 'provider-default' : 'manual';
    try {
      if (hls) {
        const entry = chosen[0];
        if (hls.audioTracks[entry.index] !== entry.handle) {
          mode = previousMode;
          return false;
        }
        hls.audioTrack = entry.index;
        if (hls.audioTrack !== entry.index) {
          mode = previousMode;
          publish();
          return false;
        }
      } else if (native) {
        // A bounded partial native list cannot safely disable an unseen enabled track.
        if (
          native.length > MAX_AUDIO_TRACKS ||
          entries.length !== native.length ||
          entries.some((entry) => native![entry.index] !== entry.handle)
        ) {
          mode = previousMode;
          return false;
        }
        for (const entry of entries) {
          if (!active() || roster !== selectedRoster || native[entry.index] !== entry.handle)
            return false;
          (entry.handle as NativeTrack).enabled = chosenHandles.has(entry.handle);
        }
        if (
          entries.some(
            (entry) => (entry.handle as NativeTrack).enabled !== chosenHandles.has(entry.handle),
          )
        ) {
          mode = previousMode;
          publish();
          return false;
        }
      } else {
        mode = previousMode;
        return false;
      }
    } catch {
      mode = previousMode;
      publish();
      return false;
    }
    if (!active() || roster !== selectedRoster) return false;
    publish();
    return true;
  }
  const api: AudioControls = { read, set };
  return {
    activate(): void {
      controls.set(video, api);
      publish(true);
    },
    read,
    set,
    refresh(): void {
      publish();
    },
    attachHls(
      instance: Hls,
      events: { AUDIO_TRACKS_UPDATED: Events; AUDIO_TRACK_SWITCHED: Events },
    ): void {
      hls = instance;
      native = null;
      source = 'hls';
      const updated = () => {
        if (!active()) return;
        rebuild(true);
        if (mode === 'provider-default' && options.canSelect()) {
          const defaults = providerDefault();
          if (
            defaults.length &&
            instance.audioTracks[defaults[0].index] === defaults[0].handle &&
            instance.audioTrack !== defaults[0].index
          )
            instance.audioTrack = defaults[0].index;
        }
        publish();
      };
      const switched = () => publish();
      for (const [event, listener] of [
        [events.AUDIO_TRACKS_UPDATED, updated],
        [events.AUDIO_TRACK_SWITCHED, switched],
      ] as const) {
        instance.on(event, listener);
        const release = options.owners.acquire('hlsListeners');
        bindings.push(() => {
          instance.off(event, listener);
          release();
        });
      }
      publish(true);
    },
    attachNative(): void {
      source = 'native';
      const refresh = () => {
        if (!active()) return;
        const list = nativeList();
        if (list !== native) {
          if (!releaseBindings(nativeBindings)) {
            native = null;
            initial = [];
            publish(true);
            return;
          }
          native = list;
          initial = [];
          if (list) {
            bind(list, 'addtrack', () => publish(true), true);
            bind(list, 'removetrack', () => publish(true), true);
            bind(list, 'change', () => publish(), true);
          }
        }
        publish(true);
      };
      bind(video, 'loadedmetadata', refresh);
      refresh();
    },
    dispose(): void {
      closed = true;
      if (controls.get(video) === api) {
        controls.delete(video);
        options.emit(null);
        video.dispatchEvent(new CustomEvent(AUDIO_TRACKS_CHANGE, { detail: null }));
      }
      entries = [];
      initial = [];
      const ordinaryReleased = releaseBindings(bindings);
      const nativeReleased = releaseBindings(nativeBindings);
      if (!ordinaryReleased || !nativeReleased)
        throw new Error('Audio track cleanup did not finish. Retry stopping playback.');
      hls = native = null;
    },
  };
}
