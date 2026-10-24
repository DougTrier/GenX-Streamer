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

/**
 * What the browser engine tests share: the scripted video element, events and
 * selections. The hls.js mocks stay in each test file (vi.mock is hoisted there).
 */
import { vi } from 'vitest';
import { type EngineEvent } from '../../src/playback/controller';

export class Video extends EventTarget {
  textTracks: Array<{ kind: string; mode: string; cues: object[]; removeCue(cue: object): void }> =
    [];
  paused = false;
  seeking = false;
  readyState = 2;
  currentTime = 0;
  muted = false;
  volume = 1;
  src = '';
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  seekable = { length: 0, start: () => 50, end: () => 100 };
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
    if (name === 'crossorigin') this.crossOrigin = null;
  });
  canPlayType = (_mime: string): string => '';
  get element() {
    return this as unknown as HTMLVideoElement;
  }
}

export const stateEvents = (events: EngineEvent[]): EngineEvent[] =>
  events.filter((event) => event.type !== 'capability' && event.type !== 'audio-tracks');

export const selection = {
  id: '1',
  name: 'Fixture',
  url: 'https://example.test/live',
  mediaKind: 'hls' as const,
};

export const profiles = [
  [undefined, 20, 40, undefined, 1024 * 1024],
  ['balanced', 20, 40, undefined, 1024 * 1024],
  ['fast', 10, 20, 2, 512 * 1024],
  ['smooth', 45, 90, 5, 3 * 1024 * 1024],
  // An unknown value falls back to the balanced baseline.
  ['huge', 20, 40, undefined, 1024 * 1024],
] as const;

export const live = {
  id: 'live',
  name: 'Live',
  url: 'https://example.test/live.mp4',
  mediaKind: 'media' as const,
  mediaMime: 'video/mp4',
};

export function element(ahead: { seconds: number }) {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  Object.defineProperty(video, 'buffered', {
    get: () => ({
      length: 1,
      start: () => 0,
      end: () => video.currentTime + ahead.seconds,
    }),
  });
  return video;
}

export const played = (video: Video) => {
  video.currentTime += 1;
  video.dispatchEvent(new Event('timeupdate'));
};
