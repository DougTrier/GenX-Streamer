import type { AudioTracksSnapshot } from '../playback/audio-tracks';

export const AUDIO_HEALTH_CHANGE = 'audio-health-change';
const faultNames = [
  'audioTrackLoadError',
  'audioTrackLoadTimeOut',
  'fragLoadError',
  'fragLoadTimeOut',
  'fragParsingError',
  'fragDecryptError',
  'keyLoadError',
  'keyLoadTimeOut',
  'bufferAppendingError',
  'bufferAppendError',
  'bufferAppendNoProgress',
] as const;
export type AudioFault = (typeof faultNames)[number];
export interface AudioHealthSnapshot {
  readonly schemaVersion: 1;
  /** Positive observation only; unknown does not mean a video-only source. */
  readonly audioCodecObserved: true | null;
  readonly audioBufferObserved: true | null;
  readonly decodedBytes: number | null;
  /** Per-observation delta, never proof of audible sound or synchronization. */
  readonly decodedByteDelta: number | null;
  readonly muted: boolean;
  readonly volume: number | null;
  readonly trackCount: number | null;
  readonly selectedTrackIndex: number | null;
  readonly faults: readonly Readonly<{
    detail: AudioFault;
    count: number;
    lastElapsedMs: number | null;
  }>[];
}
interface Reader {
  read(): Readonly<AudioHealthSnapshot> | null;
}
const readers = new WeakMap<HTMLVideoElement, Reader>();
export function readAudioHealth(video: HTMLVideoElement): Readonly<AudioHealthSnapshot> | null {
  try {
    return readers.get(video)?.read() ?? null;
  } catch {
    return null;
  }
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Attachment-owned observations only. Never diagnoses silence, restarts, or fetches media. */
export function createBrowserAudioHealth(
  video: HTMLVideoElement,
  options: {
    current(): boolean;
    now?(): number;
  },
) {
  let closed = false,
    activatedAt: number | null = null;
  let codecObserved: true | null = null,
    bufferObserved: true | null = null;
  let previousBytes: number | null = null,
    trackIdentity: string | null = null;
  let trackCount: number | null = null,
    selectedTrackIndex: number | null = null;
  let selectedGroup: string | null = null;
  let snapshot: Readonly<AudioHealthSnapshot> | null = null;
  const faults = new Map<AudioFault, { count: number; lastElapsedMs: number | null }>();
  const active = () => !closed && readers.get(video) === api && options.current();
  const now = () => {
    const value = (options.now ?? (() => performance.now()))();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  function sample(): void {
    if (!active()) return;
    let bytes: number | null = null;
    try {
      bytes = counter(
        (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: unknown })
          .webkitAudioDecodedByteCount,
      );
    } catch {
      /* Optional WebView evidence. */
    }
    const delta =
      bytes !== null && previousBytes !== null && bytes >= previousBytes
        ? bytes - previousBytes
        : null;
    previousBytes = bytes;
    snapshot = Object.freeze({
      schemaVersion: 1 as const,
      audioCodecObserved: codecObserved,
      audioBufferObserved: bufferObserved,
      decodedBytes: bytes,
      decodedByteDelta: delta,
      muted: video.muted === true,
      volume:
        Number.isFinite(video.volume) && video.volume >= 0 && video.volume <= 1
          ? video.volume
          : null,
      trackCount,
      selectedTrackIndex,
      faults: Object.freeze(
        faultNames
          .filter((detail) => faults.has(detail))
          .map((detail) => Object.freeze({ detail, ...faults.get(detail)! })),
      ),
    });
    video.dispatchEvent(new CustomEvent(AUDIO_HEALTH_CHANGE, { detail: snapshot }));
  }
  const api: Reader = { read: () => (active() ? snapshot : null) };
  return {
    activate(): void {
      readers.set(video, api);
      activatedAt = now();
      sample();
    },
    sample,
    tracks(value: Readonly<AudioTracksSnapshot> | null, group?: unknown): void {
      if (!active()) return;
      const selected = value?.tracks.find((track) => track.selected);
      const identity = selected?.id ?? null;
      if (identity !== trackIdentity) previousBytes = null;
      trackIdentity = identity;
      trackCount = counter(value?.trackCount);
      selectedTrackIndex = counter(selected?.index);
      selectedGroup = typeof group === 'string' && group.length <= 256 ? group : null;
      sample();
    },
    codecs(value: unknown): void {
      if (!active()) return;
      if (record(record(value)?.audio)) codecObserved = true;
      sample();
    },
    buffers(value: unknown): void {
      if (!active()) return;
      if (record(record(record(value)?.tracks)?.audio)) bufferObserved = true;
      sample();
    },
    fault(value: unknown): void {
      if (!active()) return;
      const data = record(value);
      if (!data || data.fatal !== false || !faultNames.includes(data.details as AudioFault)) return;
      const detail = data.details as AudioFault;
      const context = record(data.context),
        frag = record(data.frag);
      const audio = detail.startsWith('audioTrack')
        ? context?.type === 'audioTrack' &&
          selectedTrackIndex !== null &&
          context.id === selectedTrackIndex &&
          selectedGroup !== null &&
          context.groupId === selectedGroup
        : detail.startsWith('buffer')
          ? data.sourceBufferName === 'audio' || data.parent === 'audio'
          : frag?.type === 'audio';
      if (!audio) return;
      const at = now();
      faults.set(detail, {
        count: Math.min(65535, (faults.get(detail)?.count ?? 0) + 1),
        lastElapsedMs:
          at !== null && activatedAt !== null && at >= activatedAt
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(at - activatedAt))
            : null,
      });
      sample();
    },
    dispose(): void {
      closed = true;
      snapshot = null;
      faults.clear();
      if (readers.get(video) === api) {
        readers.delete(video);
        video.dispatchEvent(new CustomEvent(AUDIO_HEALTH_CHANGE, { detail: null }));
      }
    },
  };
}
