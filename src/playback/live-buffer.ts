/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */

export const LIVE_BUFFER_MIN_SECONDS = 1;
export const LIVE_BUFFER_MAX_SECONDS = 20;
export const LIVE_BUFFER_STEP_SECONDS = 1;

export type LiveBufferPreference = { mode: 'auto' } | { mode: 'manual'; targetSeconds: number };

/** Measured transport delivery, not Wi-Fi capacity or advertised rendition bitrate. */
export interface LiveBufferTelemetry {
  incomingBitsPerSecond: number | null;
  bufferedSeconds: number | null;
  targetSeconds: number | null;
  mode: 'auto' | 'manual';
  capability: 'controlled' | 'observe-only' | 'unavailable';
}

/** Invalid persisted or bridge input is refused rather than silently clamped. */
export function normalizeLiveBufferPreference(value: unknown): LiveBufferPreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.mode === 'auto' && Object.keys(row).every((key) => key === 'mode'))
    return { mode: 'auto' };
  if (
    row.mode === 'manual' &&
    Object.keys(row).every((key) => key === 'mode' || key === 'targetSeconds') &&
    typeof row.targetSeconds === 'number' &&
    Number.isInteger(row.targetSeconds) &&
    row.targetSeconds >= LIVE_BUFFER_MIN_SECONDS &&
    row.targetSeconds <= LIVE_BUFFER_MAX_SECONDS
  )
    return { mode: 'manual', targetSeconds: row.targetSeconds };
  return null;
}

/** Copy only the closed scalar DTO; no URL, identity or mutable engine handle escapes. */
export function normalizeLiveBufferTelemetry(value: unknown): LiveBufferTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const numberOrNull = (v: unknown, maximum: number): v is number | null =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= maximum);
  if (
    (row.mode !== 'auto' && row.mode !== 'manual') ||
    typeof row.capability !== 'string' ||
    !['controlled', 'observe-only', 'unavailable'].includes(row.capability) ||
    !numberOrNull(row.incomingBitsPerSecond, 1e12) ||
    !numberOrNull(row.bufferedSeconds, 7 * 24 * 3600) ||
    !numberOrNull(row.targetSeconds, LIVE_BUFFER_MAX_SECONDS) ||
    (row.targetSeconds !== null && row.targetSeconds < LIVE_BUFFER_MIN_SECONDS) ||
    (row.mode === 'manual' &&
      !normalizeLiveBufferPreference({ mode: 'manual', targetSeconds: row.targetSeconds }))
  )
    return null;
  return {
    incomingBitsPerSecond: row.incomingBitsPerSecond,
    bufferedSeconds: row.bufferedSeconds,
    targetSeconds: row.targetSeconds,
    mode: row.mode,
    capability: row.capability as LiveBufferTelemetry['capability'],
  };
}

const SAMPLE_AGE_MS = 12_000;
const SAMPLE_LIMIT = 8;

/** Recent, duration-weighted successful transfer measurements. Idle/stale is unknown. */
export function createMeasuredTransportRate(now: () => number) {
  let samples: Array<{ at: number; bits: number; milliseconds: number }> = [];
  const fresh = (): number | null => {
    const at = now();
    if (!Number.isFinite(at) || at < 0 || samples.some((sample) => sample.at > at)) {
      samples = [];
      return null;
    }
    samples = samples.filter((sample) => at - sample.at <= SAMPLE_AGE_MS);
    return at;
  };
  const transfer = (bytes: number, milliseconds: number): void => {
    const at = fresh();
    if (
      at === null ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > 2 ** 40 ||
      !Number.isFinite(milliseconds) ||
      milliseconds < 1 ||
      milliseconds > 120_000
    )
      return;
    samples.push({ at, bits: bytes * 8, milliseconds });
    samples = samples.slice(-SAMPLE_LIMIT);
  };
  return {
    transfer,
    rate(bitsPerSecond: number): void {
      if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0 || bitsPerSecond > 1e12) {
        samples = [];
        return;
      }
      transfer(Math.round(bitsPerSecond / 8), 1000);
    },
    read(): number | null {
      if (fresh() === null || !samples.length) return null;
      const rate =
        (samples.reduce((total, sample) => total + sample.bits, 0) * 1000) /
        samples.reduce((total, sample) => total + sample.milliseconds, 0);
      return Number.isFinite(rate) && rate > 0 && rate <= 1e12 ? rate : null;
    },
    /** Quantized completed-payload rate over elapsed wall time, including gaps. */
    readPayloadWindow(): number | null {
      const at = fresh();
      if (at === null || !samples.length) return null;
      const start = Math.max(
        at - SAMPLE_AGE_MS,
        Math.min(...samples.map((sample) => sample.at - sample.milliseconds)),
      );
      const elapsed = at - start;
      const rate = (samples.reduce((total, sample) => total + sample.bits, 0) * 1000) / elapsed;
      return elapsed > 0 && Number.isFinite(rate) && rate > 0 && rate <= 1e12 ? rate : null;
    },
    clear(): void {
      samples = [];
    },
  };
}
