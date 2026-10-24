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
