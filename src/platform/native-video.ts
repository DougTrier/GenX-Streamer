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

import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  normalizeLiveBufferTelemetry,
  type LiveBufferPreference,
  type LiveBufferTelemetry,
} from '../playback/live-buffer';

/** One embedded track as Media3 lists it ("group:index" identity). */
export interface NativeVideoTrack {
  id: string;
  label: string;
  language: string;
  selected: boolean;
  supported: boolean;
  channels?: number;
}
export interface NativeVideoStatus {
  session: number;
  state: 'closed' | 'idle' | 'buffering' | 'ready' | 'ended' | 'error';
  playing: boolean;
  positionMs: number;
  /** -1 while unknown. */
  durationMs: number;
  /** A fixed failure code (never provider text). */
  error?: 'network' | 'access' | 'missing' | 'unsupported' | 'decode' | 'unknown';
  audio: NativeVideoTrack[];
  text: NativeVideoTrack[];
  /** 'unsupported': the stream has video, but no decoder here can show it. */
  picture?: 'shown' | 'unsupported';
  /** Live only: stream positions, which stay put while the live window slides. */
  streamMs?: number;
  streamBufferedMs?: number;
  /** Live only: playback speed. */
  rate?: number;
  /** Live only: one picture in microseconds; 0 while unknown. */
  frameMicros?: number;
  renderedFrames?: number;
  audioRenderedFrames?: number;
  videoWidth?: number;
  videoHeight?: number;
  liveWindowRecoveries?: number;
  httpStatus?: number;
  /** Measured player ingress and buffered media; missing on older/unsupported hosts. */
  liveBuffer?: LiveBufferTelemetry;
}
export interface NativeVideoRequest {
  action:
    | 'open'
    | 'place'
    | 'play'
    | 'pause'
    | 'seek'
    | 'volume'
    | 'audio'
    | 'text'
    | 'status'
    | 'close'
    | 'replay'
    | 'buffer';
  session: number;
  url?: string;
  /** [left, top, width, height]; CSS pixels with viewport, legacy view pixels without it. */
  rect?: [number, number, number, number];
  /** CSS viewport measured with rect; Android maps it to the actual WebView exactly once. */
  viewport?: [number, number];
  positionMs?: number;
  volume?: number;
  track?: string;
  /** Open only: the address is a live channel's HLS relay. */
  hls?: boolean;
  /** GenXtra only: native side must authorize the exact active Archive proxy URL. */
  archive?: boolean;
  /** Paid live channel: open only the account owner's exact active loopback grant. */
  accountLive?: boolean;
  /** Public live: exact active native-live relay grant, HLS or progressive. */
  publicLive?: boolean;
  /** Replay only (docs/instant-replay.md): a speed, a stream position, play or pause. */
  rate?: number;
  streamMs?: number;
  playing?: boolean;
  /** Open or buffer only; applies to the existing session without replacing media. */
  liveBuffer?: LiveBufferPreference;
}
export type NativeVideoBridge = (request: NativeVideoRequest) => Promise<NativeVideoStatus>;

/** Android only: Paid TV movies and episodes play natively there. */
export const nativeVideoAvailable = (): boolean =>
  isTauri() && /Android/i.test(navigator.userAgent);

const invalid = () => new Error('Native player reply is invalid.');
const STATES = new Set(['closed', 'idle', 'buffering', 'ready', 'ended', 'error']);
const ERRORS = new Set(['network', 'access', 'missing', 'unsupported', 'decode', 'unknown']);
function track(value: unknown): NativeVideoTrack {
  if (!value || typeof value !== 'object') throw invalid();
  const row = value as Record<string, unknown>;
  const text = (v: unknown, limit: number) => typeof v === 'string' && v.length <= limit;
  if (
    !text(row.id, 64) ||
    !/^\d{1,4}:\d{1,4}$/u.test(row.id as string) ||
    !text(row.label, 256) ||
    !text(row.language, 32) ||
    typeof row.selected !== 'boolean' ||
    typeof row.supported !== 'boolean' ||
    (row.channels !== undefined &&
      (!Number.isSafeInteger(row.channels) || (row.channels as number) < 0))
  )
    throw invalid();
  return {
    id: row.id as string,
    label: row.label as string,
    language: row.language as string,
    selected: row.selected,
    supported: row.supported,
    ...(row.channels !== undefined ? { channels: row.channels as number } : {}),
  };
}
export function validateNativeVideoStatus(value: unknown, session: number): NativeVideoStatus {
  if (!value || typeof value !== 'object') throw invalid();
  const row = value as Record<string, unknown>;
  if (row.session !== session || typeof row.state !== 'string' || !STATES.has(row.state))
    throw invalid();
  if (row.state === 'closed')
    return {
      session,
      state: 'closed',
      playing: false,
      positionMs: 0,
      durationMs: -1,
      audio: [],
      text: [],
    };
  const count = (v: unknown) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0);
  const liveBuffer =
    row.liveBuffer === undefined ? undefined : normalizeLiveBufferTelemetry(row.liveBuffer);
  if (row.liveBuffer !== undefined && liveBuffer === null) throw invalid();
  if (
    (row.httpStatus !== undefined &&
      (!Number.isSafeInteger(row.httpStatus) ||
        (row.httpStatus as number) < 100 ||
        (row.httpStatus as number) > 599)) ||
    !count(row.streamMs) ||
    !count(row.streamBufferedMs) ||
    !count(row.frameMicros) ||
    !count(row.renderedFrames) ||
    !count(row.audioRenderedFrames) ||
    !count(row.videoWidth) ||
    !count(row.videoHeight) ||
    !count(row.liveWindowRecoveries) ||
    (row.rate !== undefined &&
      !(typeof row.rate === 'number' && Number.isFinite(row.rate) && row.rate > 0 && row.rate <= 4))
  )
    throw invalid();
  const audio = Array.isArray(row.audio) ? row.audio : null;
  const text = Array.isArray(row.text) ? row.text : null;
  if (
    typeof row.playing !== 'boolean' ||
    !Number.isSafeInteger(row.positionMs) ||
    (row.positionMs as number) < 0 ||
    !Number.isSafeInteger(row.durationMs) ||
    (row.durationMs as number) < -1 ||
    (row.error !== undefined && !ERRORS.has(row.error as string)) ||
    (row.picture !== undefined && row.picture !== 'shown' && row.picture !== 'unsupported') ||
    !audio ||
    !text ||
    audio.length > 64 ||
    text.length > 64
  )
    throw invalid();
  return {
    session,
    state: row.state as NativeVideoStatus['state'],
    playing: row.playing,
    positionMs: row.positionMs as number,
    durationMs: row.durationMs as number,
    ...(liveBuffer !== undefined && liveBuffer !== null ? { liveBuffer } : {}),
    ...(row.error !== undefined ? { error: row.error as NativeVideoStatus['error'] } : {}),
    ...(row.picture !== undefined
      ? { picture: row.picture as NonNullable<NativeVideoStatus['picture']> }
      : {}),
    ...(row.streamMs !== undefined ? { streamMs: row.streamMs as number } : {}),
    ...(row.streamBufferedMs !== undefined
      ? { streamBufferedMs: row.streamBufferedMs as number }
      : {}),
    ...(row.rate !== undefined ? { rate: row.rate as number } : {}),
    ...(row.frameMicros !== undefined ? { frameMicros: row.frameMicros as number } : {}),
    ...Object.fromEntries(
      [
        'renderedFrames',
        'audioRenderedFrames',
        'videoWidth',
        'videoHeight',
        'liveWindowRecoveries',
        'httpStatus',
      ]
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, row[key]]),
    ),
    audio: audio.map(track),
    text: text.map(track),
  };
}
export function createNativeVideoBridge(
  call: (request: NativeVideoRequest) => Promise<unknown> = (request) =>
    invoke('native_video', { request }),
): NativeVideoBridge {
  return async (request) => {
    const reply = await call(request);
    if (request.action === 'close')
      return validateNativeVideoStatus(
        { session: request.session, state: 'closed' },
        request.session,
      );
    return validateNativeVideoStatus(reply, request.session);
  };
}
