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
 * The playback controller's types (engines, events, snapshots) and the
 * pure helpers it uses. Re-exported by controller.ts.
 */
import { type AudioTracksSnapshot } from './audio-tracks';

export interface ChannelSelection {
  id: string;
  name: string;
  url: string;
  mediaKind?: 'hls' | 'media';
  mediaMime?: string;
  /** Transient credential-free CORS for an explicitly issued media capability. */
  crossOrigin?: 'anonymous';
  /** Explicit finite playback; ordinary channels retain live-end failure behavior. */
  playMode?: 'on-demand';
  /** How much a live stream buffers (a paid account's choice); default balanced. */
  buffer?: 'fast' | 'balanced' | 'smooth';
  /** A longer first-start window (ms, 20–45 s) for sources that may make a
   *  start wait, such as a one-connection provider still closing the last channel. */
  startupMs?: number;
}

/** Transient, local recovery authority. Never enters engine DTOs or snapshots. */
export interface RecoveryPlan {
  urls: readonly string[];
  /** Recheck recovery authority even when restarting the same endpoint. */
  beforeRetry?: (selection: ChannelSelection, signal: AbortSignal) => Promise<void>;
  /** Withdraw/transition publication only when the endpoint actually changes. */
  beforeCandidate?: (selection: ChannelSelection, signal: AbortSignal) => Promise<void>;
}

/** Window for an on-demand seek, which must fetch a new range of a remote file. */
export const VOD_SEEK_MS = 45_000;

export type PlaybackState =
  | 'idle'
  | 'connecting'
  | 'playing'
  | 'buffering'
  | 'paused'
  | 'reconnecting'
  | 'failed'
  | 'disposed';

export interface PlaybackSnapshot {
  state: PlaybackState;
  selection: ChannelSelection | null;
  error: string | null;
  failure?: PlaybackFailure | null;
  pauseReason?: 'background' | null;
  audioTracks?: Readonly<AudioTracksSnapshot> | null;
}

export type FailureCode =
  | 'access'
  | 'unsupported'
  | 'missing'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'decode'
  | 'policy'
  | 'unknown';

export type FailurePhase =
  | 'unknown'
  | 'connect'
  | 'headers'
  | 'body'
  | 'startup-progress'
  | 'buffering-progress'
  | 'decode'
  | 'capability';

export interface PlaybackFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Observed HTTP response only; never inferred from provider text. */
  httpStatus?: number;
  phase?: FailurePhase;
  evidence?: 'native' | 'http' | 'media' | 'opaque' | 'observed-progress';
  /** The stream's picture needs the device's own player (Android hands it over). */
  nativeFormat?: 'mpeg2';
}

export type EngineEvent =
  | { type: 'audio-tracks'; snapshot: Readonly<AudioTracksSnapshot> | null }
  | { type: 'progress' }
  | { type: 'decoded-progress'; evidence: DecodedProgressEvidence }
  | { type: 'buffering' }
  | { type: 'ended' }
  | { type: 'capability'; mediaKind: 'hls' | 'media'; mediaMime?: string }
  | { type: 'error'; failure: PlaybackFailure };

export interface PlaybackEngine {
  start(selection: ChannelSelection, signal: AbortSignal): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  readAudioTracks?(): Readonly<AudioTracksSnapshot> | null;
  setAudioTrack?(id: string | null): boolean;
  readVODposition?(): number | null;
  readVODduration?(): number | null;
  /** Must settle and remove temporary work on the captured signal's abort. */
  seekVOD?(
    seconds: number,
    signal: AbortSignal,
  ): Promise<'seeked' | 'out-of-range' | 'unavailable'>;
  /** Live instant replay within the player's own back buffer (REPLAY01). */
  liveReplay?(): LiveReplayEngine | null;
  dispose(): void | Promise<void>;
}

/** Seconds on the player's media timeline (docs/instant-replay.md). */
export interface ReplayWindow {
  /** Oldest buffered moment of the range holding the position (the players
   *  keep about REPLAY_REACH_SECONDS behind what they play). */
  start: number;
  /** Newest buffered moment. */
  end: number;
  position: number;
  /** One picture: measured from the decoder, 1/30 s until known. */
  frameSeconds: number;
}

export interface LiveReplayEngine {
  window(): ReplayWindow | null;
  /** Settles true once the picture at `seconds` is shown; false otherwise. */
  seek(seconds: number, signal: AbortSignal): Promise<boolean>;
  /** Below 1x the sound is muted; the viewer's own Mute is left as it is. */
  setRate(rate: number): void;
  setPaused(paused: boolean): void;
  /** Normal speed and sound, playing at the live edge. */
  leave(): void;
}

/** How far behind the live picture a replay can jump (owner decision,
 *  October 21, 2026). */
export const REPLAY_REACH_SECONDS = 30;

/** A replay this far behind live (long pauses, slow speeds) returns to live,
 *  which also bounds what a continuous live download buffers meanwhile. */
export const REPLAY_BEHIND_LIMIT_SECONDS = 60;

/** Replay is offered once this much is buffered behind the playing position. */
export const REPLAY_MINIMUM_SECONDS = 2;

export const REPLAY_RATES = [0.125, 0.25, 0.5, 1] as const;

/** Clamp a measured frame period; 1/30 s when unknown. */
export function replayFrameSeconds(measured: number | null | undefined): number {
  return typeof measured === 'number' && Number.isFinite(measured) && measured > 0
    ? Math.min(0.1, Math.max(1 / 120, measured))
    : 1 / 30;
}

/** The replayable part of a player's buffered ranges: the range holding the
 *  playing position; null when the position lies outside every range. How
 *  far back a replay may go is measured from the live picture, by the replay
 *  itself (its live point keeps moving while it runs). */
export function replayWindowFrom(
  ranges: ReadonlyArray<readonly [number, number]>,
  position: number,
  frameSeconds: number,
): ReplayWindow | null {
  if (!Number.isFinite(position) || position < 0 || ranges.length > 64) return null;
  let newest = -Infinity;
  for (const [start, end] of ranges) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
    newest = Math.max(newest, end);
  }
  const holding = ranges.find(([start, end]) => start - 0.1 <= position && position <= end + 0.1);
  if (!holding) return null;
  return {
    start: holding[0],
    end: newest,
    position,
    frameSeconds: replayFrameSeconds(frameSeconds),
  };
}

/** Enough lies behind the playing position to start a replay. */
export const replayAvailable = (window: ReplayWindow | null): window is ReplayWindow =>
  !!window && window.position - window.start >= REPLAY_MINIMUM_SECONDS;

export const VOD_POSITION_LIMIT = 7 * 24 * 60 * 60;

export type SeekOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid-position' | 'out-of-range' | 'superseded' | 'failed';
    };

export type EngineFactory = (emit: (event: EngineEvent) => void) => PlaybackEngine;

export interface VODReleaseObservation {
  selectionId: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  reason: 'paused' | 'background' | 'failed' | 'completed' | 'stopped' | 'replaced' | 'disposed';
}

export interface DecodedSample {
  mediaTime: number;
  decodedFrames: number;
  width: number;
  height: number;
}

export interface DecodedProgressEvidence {
  kind: 'decoded';
  before: DecodedSample;
  after: DecodedSample;
  elapsedMilliseconds: number;
}

export interface DecodedPlaybackObservation {
  selection: ChannelSelection;
  attempt: Readonly<object>;
  evidence: DecodedProgressEvidence;
}

export function validDecodedProgress(evidence: DecodedProgressEvidence): boolean {
  return (
    evidence.kind === 'decoded' &&
    Number.isFinite(evidence.elapsedMilliseconds) &&
    evidence.elapsedMilliseconds > 0 &&
    evidence.elapsedMilliseconds <= 120000 &&
    [evidence.before, evidence.after].every(
      (sample) =>
        Number.isFinite(sample.mediaTime) &&
        sample.mediaTime >= 0 &&
        sample.mediaTime <= Number.MAX_SAFE_INTEGER &&
        Number.isSafeInteger(sample.decodedFrames) &&
        sample.decodedFrames >= 0 &&
        Number.isInteger(sample.width) &&
        sample.width > 0 &&
        sample.width <= 32768 &&
        Number.isInteger(sample.height) &&
        sample.height > 0 &&
        sample.height <= 32768,
    ) &&
    evidence.after.mediaTime > evidence.before.mediaTime &&
    evidence.after.decodedFrames > evidence.before.decodedFrames
  );
}

export interface PlaybackClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const clock: PlaybackClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
