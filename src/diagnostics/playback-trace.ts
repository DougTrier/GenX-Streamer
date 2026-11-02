// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { invoke } from '@tauri-apps/api/core';
import type { PlaybackSnapshot } from '../playback/controller';
import { normalizeLiveBufferTelemetry, type LiveBufferTelemetry } from '../playback/live-buffer';
export type PlaybackTraceMode = 'free' | 'paid' | 'genxtra' | 'web' | 'application';
export type TraceValues = Record<string, number | boolean | string | null | number[]>;
export interface PlaybackTraceReport {
  schemaVersion: 1;
  version: string;
  build: number;
  platform: string;
  active: boolean;
  startedAtMs: number;
  untilMs: number;
  droppedEvents: number;
  records: {
    timestampMs: number;
    elapsedMs: number;
    record: { mode: PlaybackTraceMode; event: string; values: TraceValues };
  }[];
}
let active = false,
  until = 0,
  pending = 0,
  web = false,
  interrupted = false;
let tail: Promise<unknown> = Promise.resolve();
let frontendDroppedEvents = 0;
const BUFFER_SAMPLE_AGE_MS = 5000;
let bufferSample: {
  mode: PlaybackTraceMode;
  at: number;
  policy: string;
  values: TraceValues;
} | null = null;
function freshBufferValues(mode: PlaybackTraceMode): TraceValues {
  const at = Date.now();
  if (bufferSample && (at < bufferSample.at || at - bufferSample.at >= BUFFER_SAMPLE_AGE_MS))
    bufferSample = null;
  return bufferSample?.mode === mode ? bufferSample.values : {};
}

/** UI polling enriches the existing five-second sample; it never adds a periodic record. */
export function recordLiveBufferSample(
  mode: PlaybackTraceMode,
  telemetry: Readonly<LiveBufferTelemetry> | null,
): void {
  try {
    if (!telemetry || !traceEnabled()) {
      bufferSample = null;
      return;
    }
    if (!['free', 'paid', 'genxtra', 'web', 'application'].includes(mode)) {
      bufferSample = null;
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(telemetry);
    const keys = [
      'incomingBitsPerSecond',
      'bufferedSeconds',
      'targetSeconds',
      'mode',
      'capability',
    ];
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]),
      ) ||
      keys.some((key) => !descriptors[key])
    ) {
      bufferSample = null;
      return;
    }
    const safe = Object.create(null) as Record<string, unknown>;
    for (const key of keys) safe[key] = descriptors[key]!.value;
    const measured = normalizeLiveBufferTelemetry(safe);
    if (!measured) {
      bufferSample = null;
      return;
    }
    freshBufferValues(mode);
    const previous = bufferSample;
    const policy = `${measured.mode}:${measured.targetSeconds ?? 'unknown'}`;
    const values: TraceValues = {
      incomingMediaBitsPerSecond: measured.incomingBitsPerSecond,
      bufferTargetSeconds: measured.targetSeconds,
      manualBuffer: measured.mode === 'manual',
      ...(measured.bufferedSeconds !== null
        ? { bufferedAheadMs: measured.bufferedSeconds * 1000 }
        : {}),
    };
    bufferSample = { mode, at: Date.now(), policy, values };
    if (previous?.mode === mode && previous.policy !== policy)
      recordPlaybackTrace(mode, 'sample', {});
  } catch {
    bufferSample = null;
  } // Optional measurement can never interfere with playback.
}
export type TraceInterruptionReason =
  'validation' | 'storage' | 'worker' | 'application-closing' | 'unknown';
let interruptionReason: TraceInterruptionReason | null = null;
/** Keep native rejection categories; never reflect arbitrary bridge error text. */
export function playbackTraceFailureReason(error: unknown): TraceInterruptionReason {
  let token: unknown = error;
  if (typeof token !== 'string') {
    try {
      token =
        token && typeof token === 'object'
          ? Object.getOwnPropertyDescriptor(token, 'message')?.value
          : null;
    } catch {
      token = null;
    }
  }
  switch (token) {
    case 'playback-trace-invalid':
      return 'validation';
    case 'playback-trace-write':
    case 'playback-trace-path':
    case 'playback-trace-encode':
      return 'storage';
    case 'playback-trace-worker':
      return 'worker';
    case 'application-closing':
      return 'application-closing';
    default:
      return 'unknown';
  }
}
let signature = '',
  selectionIdentity = '',
  sequence = 0;
const command = (action: string, record?: unknown) =>
  invoke<PlaybackTraceReport>('playback_trace', {
    request: { action, ...(record ? { record } : {}) },
  });
export const traceEnabled = () => active && Date.now() < until;
export const webTraceActive = () => web;
export const traceInterrupted = () => interrupted;
export const traceInterruptionReason = () => interruptionReason;
/** Routine delivery facts only. Errors/state changes bypass this sampler. */
export function createPlaybackDeliverySampler(): (now: number) => boolean {
  let previous: number | null = null;
  return (now) => {
    if (!Number.isFinite(now) || now < 0) return false;
    if (previous !== null && now >= previous && now - previous < 5000) return false;
    previous = now;
    return true;
  };
}
export function recordPlaybackTrace(
  mode: PlaybackTraceMode,
  event: string,
  values: TraceValues,
): void {
  if (!traceEnabled()) return;
  if (pending >= 16) {
    frontendDroppedEvents++;
    return;
  }
  // Bind measurements when the sample is observed, not when a queued IPC later runs.
  const bufferValues = event === 'sample' ? { ...freshBufferValues(mode) } : {};
  pending++;
  tail = tail
    .catch(() => undefined)
    .then(() =>
      command('record', {
        mode,
        event,
        values: { ...values, ...bufferValues, frontendDroppedEvents },
      }),
    )
    .catch((error: unknown) => {
      if (!interrupted) interruptionReason = playbackTraceFailureReason(error);
      interrupted = true;
      active = false;
    })
    .finally(() => pending--);
}
export function playbackTraceMode(
  snapshot: Pick<PlaybackSnapshot, 'selection'>,
): PlaybackTraceMode {
  const id = snapshot.selection?.id ?? '';
  return id.startsWith('archive-')
    ? 'genxtra'
    : id.startsWith('account-') || id.startsWith('vod:')
      ? 'paid'
      : 'free';
}
export function recordPlaybackState(snapshot: PlaybackSnapshot): void {
  if (!traceEnabled()) return;
  // Identities are used only in memory to detect switches. Never export them.
  const identity = snapshot.selection?.id ?? '';
  if (identity !== selectionIdentity) {
    selectionIdentity = identity;
    sequence++;
  }
  const next = `${sequence}:${snapshot.state}:${snapshot.failure?.code ?? ''}`;
  if (next === signature) return;
  signature = next;
  const allowed = [
    'network',
    'dns',
    'tls',
    'timeout',
    'decode',
    'unsupported',
    'missing',
    'access',
    'policy',
    'unknown',
    'cancelled',
  ];
  recordPlaybackTrace(
    playbackTraceMode(snapshot),
    snapshot.state === 'reconnecting'
      ? 'recovery'
      : snapshot.state === 'failed'
        ? 'error'
        : 'state',
    {
      state: snapshot.state,
      channelSequence: sequence,
      ...(snapshot.failure
        ? {
            code: allowed.includes(snapshot.failure.code) ? snapshot.failure.code : 'unknown',
            phase: snapshot.failure.phase ?? 'unknown',
            evidence: snapshot.failure.evidence ?? 'unknown',
            ...(snapshot.failure.httpStatus ? { httpStatus: snapshot.failure.httpStatus } : {}),
          }
        : {}),
    },
  );
}
export function recordWebTrace(action: string, rect?: number[]): void {
  if (action === 'open') web = true;
  if (action === 'close') web = false;
  recordPlaybackTrace('web', rect ? 'geometry' : 'navigation', {
    state: web ? 'open' : 'closed',
    ...(rect ? { expectedCss: rect } : {}),
  });
}
export const playbackTrace = {
  async start() {
    await tail;
    const report = await command('start');
    frontendDroppedEvents = 0;
    bufferSample = null;
    active = report.active;
    until = report.untilMs;
    signature = '';
    selectionIdentity = '';
    sequence = 0;
    interrupted = false;
    interruptionReason = null;
    return report;
  },
  async stop() {
    active = false;
    bufferSample = null;
    await tail;
    return command('stop');
  },
  async clear() {
    active = false;
    bufferSample = null;
    await tail;
    return command('clear');
  },
  async read() {
    await tail;
    return command('read');
  },
  async dispose() {
    // Native cleanup may already refuse new IPC. Join existing writes only;
    // native recording has no worker/timer and never resumes on process restart.
    active = false;
    bufferSample = null;
    await tail;
  },
  async exportAndroid(): Promise<{ path: string }> {
    await tail;
    return invoke('export_playback_trace');
  },
};

/** Source-choice facts only: no feed identity, addresses, account data or scores. */
export function recordSourceChoice(
  mode: 'free' | 'paid',
  facts: { candidateCount: number; sourceChanged: boolean; available?: boolean },
): void {
  recordPlaybackTrace(mode, 'source-choice', {
    candidateCount: facts.candidateCount,
    sourceChanged: facts.sourceChanged,
    detail: facts.available === false ? 'equivalence-unavailable' : 'source-selected',
  });
}
