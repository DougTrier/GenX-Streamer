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

import { invoke } from '@tauri-apps/api/core';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** Verdicts the native store accepts: a response, or a failure that counts toward Not responding. */
export type ChannelCheckVerdict =
  | 'Reachable'
  | 'PlayedHere'
  | 'TimedOut'
  | 'AccessDenied'
  | 'UnsupportedHere'
  | 'TemporaryUnavailable';
export const CHANNEL_CHECK_VERDICTS: readonly ChannelCheckVerdict[] = [
  'Reachable',
  'PlayedHere',
  'TimedOut',
  'AccessDenied',
  'UnsupportedHere',
  'TemporaryUnavailable',
];
export interface ChannelCheck {
  channelId: string;
  checkedMs: number;
  okMs: number | null;
  firstFailMs: number | null;
  lastFailMs: number | null;
  verdict: ChannelCheckVerdict;
  notResponding: boolean;
}
export interface ChannelChecks {
  /** Native clock at the read; due times compare against this, not the page clock. */
  nowMs: number;
  checks: ChannelCheck[];
  /** Saved channels carrying the Slow badge (owner design, October 21, 2026). */
  slowChannels: string[];
}
export interface ChannelObservation {
  channelId: string;
  verdict: ChannelCheckVerdict;
}
export const MAX_CHANNEL_CHECK_BATCH = 200;

const refused = () => new Error('Saved channel checks could not be read.');
const time = (value: unknown, nullable: boolean): number | null => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw refused();
  return value as number;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 16384) throw refused();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) throw refused();
  }
  return value;
};

export function validateChannelChecks(raw: unknown): ChannelChecks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refused();
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.checks) || value.checks.length > 200_000)
    throw refused();
  const nowMs = time(value.nowMs, false)!;
  const checks = value.checks.map((item: unknown): ChannelCheck => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw refused();
    const row = item as Record<string, unknown>;
    if (
      !CHANNEL_CHECK_VERDICTS.includes(row.verdict as ChannelCheckVerdict) ||
      typeof row.notResponding !== 'boolean'
    )
      throw refused();
    return {
      channelId: id(row.channelId),
      checkedMs: time(row.checkedMs, false)!,
      okMs: time(row.okMs, true),
      firstFailMs: time(row.firstFailMs, true),
      lastFailMs: time(row.lastFailMs, true),
      verdict: row.verdict as ChannelCheckVerdict,
      notResponding: row.notResponding,
    };
  });
  // Older native builds send no Slow list: no badges.
  if (
    value.slowChannels !== undefined &&
    (!Array.isArray(value.slowChannels) || value.slowChannels.length > 200_000)
  )
    throw refused();
  const slowChannels = ((value.slowChannels as unknown[] | undefined) ?? []).map(id);
  return { nowMs, checks, slowChannels };
}

export function createChannelCheckStore(runtime: OwnedNativeRuntime = { invoke }) {
  return {
    /**
     * A finished scan's checks of saved channels, since `sinceMs`, count like
     * quiet checks (owner decision, October 21, 2026): a failure is one bad
     * day, an answer clears the streak. Matched natively by stream address.
     */
    /** After a Slow pass (`slowPass`), the channels it saved are marked Slow natively. */
    recordFromScan: (sinceMs: number, signal: AbortSignal, slowPass = false): Promise<number> => {
      if (!Number.isSafeInteger(sinceMs) || sinceMs < 0)
        throw new Error('Scan check time is invalid.');
      return invokeOwnedNative(
        runtime,
        'record_scan_channel_checks',
        slowPass ? { sinceMs, slowPass } : { sinceMs },
        {
          signal,
          durable: true,
          validate: (raw) => {
            const value = raw as Record<string, unknown> | null;
            if (
              !value ||
              value.schemaVersion !== 1 ||
              !Number.isSafeInteger(value.recorded) ||
              (value.recorded as number) < 0
            )
              throw new Error('Scan check receipt is invalid.');
            return value.recorded as number;
          },
        },
      );
    },
    /**
     * A saved channel took `startMs` from selection to playing: under 3 s
     * clears its Slow badge, over 5 s sets it (native rule). Resolves whether
     * it now carries the badge, or null when it is not a saved channel.
     */
    recordStart: (
      channelId: string,
      startMs: number,
      signal: AbortSignal,
    ): Promise<boolean | null> => {
      if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > 120_000)
        throw new Error('Channel start time is invalid.');
      return invokeOwnedNative(
        runtime,
        'record_channel_start',
        { channelId: id(channelId), startMs },
        {
          signal,
          durable: true,
          validate: (raw) => {
            const value = raw as Record<string, unknown> | null;
            if (
              !value ||
              value.schemaVersion !== 1 ||
              !(value.slow === null || typeof value.slow === 'boolean')
            )
              throw new Error('Channel start receipt is invalid.');
            return value.slow as boolean | null;
          },
        },
      );
    },
    read: (signal: AbortSignal): Promise<ChannelChecks> =>
      invokeOwnedNative(
        runtime,
        'read_channel_checks',
        {},
        { signal, validate: validateChannelChecks },
      ),
    record: (observations: readonly ChannelObservation[], signal: AbortSignal): Promise<number> => {
      if (
        observations.length === 0 ||
        observations.length > MAX_CHANNEL_CHECK_BATCH ||
        observations.some((o) => !CHANNEL_CHECK_VERDICTS.includes(o.verdict))
      )
        throw new Error('Saved channel checks are invalid.');
      return invokeOwnedNative(
        runtime,
        'record_channel_checks',
        {
          request: {
            schemaVersion: 1,
            observations: observations.map(({ channelId, verdict }) => ({
              channelId: id(channelId),
              verdict,
            })),
          },
        },
        {
          signal,
          durable: true,
          validate: (raw) => {
            const value = raw as Record<string, unknown> | null;
            if (
              !value ||
              value.schemaVersion !== 1 ||
              !Number.isSafeInteger(value.recorded) ||
              (value.recorded as number) < 0 ||
              (value.recorded as number) > observations.length
            )
              throw new Error('Saved channel check receipt is invalid.');
            return value.recorded as number;
          },
        },
      );
    },
  };
}
export type ChannelCheckStore = ReturnType<typeof createChannelCheckStore>;
