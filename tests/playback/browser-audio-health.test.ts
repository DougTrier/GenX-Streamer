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

import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEALTH_CHANGE,
  createBrowserAudioHealth,
  readAudioHealth,
} from '../../src/platform/browser-audio-health';
import type { AudioTracksSnapshot } from '../../src/playback/audio-tracks';

class Video extends EventTarget {
  muted = false;
  volume = 0.8;
  webkitAudioDecodedByteCount: unknown = undefined;
  get element() {
    return this as unknown as HTMLVideoElement;
  }
}
const tracks = (id: string, index = 0): AudioTracksSnapshot => ({
  source: 'hls',
  mode: 'provider-default',
  selectable: true,
  providerDefaultAvailable: true,
  providerDefaultId: 'default',
  trackCount: 1,
  truncated: false,
  tracks: [
    {
      id,
      index,
      name: null,
      language: null,
      kind: null,
      description: null,
      selected: true,
      providerDefault: true,
    },
  ],
});
describe('attachment audio observations (no audible sound or synchronization claims)', () => {
  it('keeps legitimate video-only and unavailable evidence unknown without requiring audio', () => {
    const video = new Video(),
      owner = createBrowserAudioHealth(video.element, { current: () => true });
    owner.activate();
    owner.codecs({ video: {} });
    owner.buffers({ tracks: { video: {} } });
    owner.tracks({ ...tracks('none'), trackCount: 0, tracks: [] });
    expect(readAudioHealth(video.element)).toMatchObject({
      audioCodecObserved: null,
      audioBufferObserved: null,
      decodedBytes: null,
      decodedByteDelta: null,
      trackCount: 0,
      selectedTrackIndex: null,
      faults: [],
    });
    owner.dispose();
  });
  it('observes delayed audio, validates counters and resets delta on track changes/counter rollback', () => {
    const video = new Video(),
      owner = createBrowserAudioHealth(video.element, { current: () => true });
    owner.activate();
    owner.codecs({ audio: {} });
    owner.buffers({ tracks: { audio: {} } });
    owner.tracks(tracks('first'), 'group');
    video.webkitAudioDecodedByteCount = 100;
    owner.sample();
    expect(readAudioHealth(video.element)?.decodedByteDelta).toBeNull();
    video.webkitAudioDecodedByteCount = 140;
    owner.sample();
    expect(readAudioHealth(video.element)).toMatchObject({
      audioCodecObserved: true,
      audioBufferObserved: true,
      decodedByteDelta: 40,
    });
    owner.tracks(tracks('second'), 'group');
    expect(readAudioHealth(video.element)?.decodedByteDelta).toBeNull();
    video.webkitAudioDecodedByteCount = 20;
    owner.sample();
    expect(readAudioHealth(video.element)?.decodedByteDelta).toBeNull();
    for (const invalid of [-1, NaN, Infinity, '20', Number.MAX_SAFE_INTEGER + 1]) {
      video.webkitAudioDecodedByteCount = invalid;
      owner.sample();
      expect(readAudioHealth(video.element)?.decodedBytes).toBeNull();
    }
    owner.dispose();
  });
  it('retains bounded redacted warnings through recovery and continuing video without commands', () => {
    const video = new Video();
    let at = 100;
    const owner = createBrowserAudioHealth(video.element, { current: () => true, now: () => at });
    owner.activate();
    at = 150;
    owner.fault({
      fatal: false,
      details: 'bufferAppendingError',
      sourceBufferName: 'audio',
      error: new Error('secret'),
      reason: 'https://secret.example/token',
    });
    video.webkitAudioDecodedByteCount = 100;
    owner.sample();
    video.webkitAudioDecodedByteCount = 150;
    owner.sample();
    expect(readAudioHealth(video.element)).toMatchObject({
      decodedByteDelta: 50,
      faults: [{ detail: 'bufferAppendingError', count: 1, lastElapsedMs: 50 }],
    });
    at = 250;
    owner.fault({ fatal: false, details: 'bufferAppendingError', sourceBufferName: 'audio' });
    owner.sample();
    const snapshot = readAudioHealth(video.element)!;
    expect(snapshot.faults).toEqual([
      { detail: 'bufferAppendingError', count: 2, lastElapsedMs: 150 },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|https|token/);
    expect(
      Object.isFrozen(snapshot) &&
        Object.isFrozen(snapshot.faults) &&
        Object.isFrozen(snapshot.faults[0]),
    ).toBe(true);
    owner.dispose();
  });
  it('counts only allowlisted audio faults and the actual selected external audio group', () => {
    const video = new Video(),
      owner = createBrowserAudioHealth(video.element, { current: () => true });
    owner.activate();
    owner.tracks(tracks('selected', 2), 'chosen-group');
    for (const data of [
      { details: 'fragLoadError', frag: { type: 'main' } },
      { details: 'bufferAppendingError', sourceBufferName: 'video' },
      { details: 'bufferAppendNoProgress', parent: 'main' },
      { details: 'unknown-secret', parent: 'audio' },
      {
        details: 'audioTrackLoadError',
        context: { type: 'audioTrack', id: 1, groupId: 'chosen-group' },
      },
      {
        details: 'audioTrackLoadError',
        context: { type: 'audioTrack', id: 2, groupId: 'old-group' },
      },
    ])
      owner.fault({ fatal: false, ...data });
    owner.fault({ fatal: true, details: 'fragLoadError', frag: { type: 'audio' } });
    expect(readAudioHealth(video.element)?.faults).toEqual([]);
    owner.fault({
      fatal: false,
      details: 'audioTrackLoadError',
      context: { type: 'audioTrack', id: 2, groupId: 'chosen-group' },
    });
    owner.fault({ fatal: false, details: 'bufferAppendNoProgress', parent: 'audio' });
    owner.fault({ fatal: false, details: 'fragParsingError', frag: { type: 'audio' } });
    expect(readAudioHealth(video.element)?.faults.map((fault) => fault.detail)).toEqual([
      'audioTrackLoadError',
      'fragParsingError',
      'bufferAppendNoProgress',
    ]);
    owner.dispose();
  });
  it('rejects stale A effects after B replaces its attachment and clears only its own reader', () => {
    const video = new Video(),
      events: unknown[] = [];
    video.addEventListener(AUDIO_HEALTH_CHANGE, (event) =>
      events.push((event as CustomEvent).detail),
    );
    const a = createBrowserAudioHealth(video.element, { current: () => true });
    const b = createBrowserAudioHealth(video.element, { current: () => true });
    a.activate();
    b.activate();
    const before = events.length;
    a.fault({ fatal: false, details: 'fragLoadError', frag: { type: 'audio' } });
    a.codecs({ audio: {} });
    a.sample();
    a.dispose();
    expect(events).toHaveLength(before);
    expect(readAudioHealth(video.element)?.faults).toEqual([]);
    expect(readAudioHealth(video.element)?.audioCodecObserved).toBeNull();
    b.dispose();
    b.dispose();
    b.sample();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toBeNull();
    expect(readAudioHealth(video.element)).toBeNull();
  });
  it('suppresses stale generation publication and tolerates absent/throwing optional counters', () => {
    const video = new Video();
    let current = true;
    Object.defineProperty(video, 'webkitAudioDecodedByteCount', {
      get() {
        throw new Error('Not supported');
      },
    });
    const owner = createBrowserAudioHealth(video.element, { current: () => current });
    owner.activate();
    expect(readAudioHealth(video.element)?.decodedBytes).toBeNull();
    current = false;
    owner.sample();
    owner.codecs({ audio: {} });
    expect(readAudioHealth(video.element)).toBeNull();
    owner.dispose();
  });
});
