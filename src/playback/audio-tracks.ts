/** Actual provider/browser audio metadata only. Unknown labels stay null. */
export interface AudioTrackChoice {
  id: string;
  index: number;
  name: string | null;
  language: string | null;
  description: string | null;
  kind: string | null;
  selected: boolean;
  providerDefault: boolean | null;
}
export interface AudioTracksSnapshot {
  source: 'hls' | 'native' | null;
  mode: 'provider-default' | 'manual';
  selectable: boolean;
  providerDefaultAvailable: boolean;
  /** Scoped setting identity for menus; not an additional provider audio track. */
  providerDefaultId: string;
  trackCount: number;
  truncated: boolean;
  tracks: readonly Readonly<AudioTrackChoice>[];
}
export const MAX_AUDIO_TRACKS = 64;
