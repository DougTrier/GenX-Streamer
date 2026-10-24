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

export interface ProgramCountdown {
  kind: 'starts-in' | 'scheduled-now' | 'ended' | 'unknown';
  text: string;
}

/** Schedule time is an instant, independent of local zone and decoder state. */
export function programCountdown(
  startMs: number | null,
  stopMs: number | null,
  nowMs: number,
): ProgramCountdown {
  if (
    startMs === null ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(nowMs) ||
    Math.abs(startMs) > 8.64e15 ||
    Math.abs(nowMs) > 8.64e15 ||
    (stopMs !== null &&
      (!Number.isSafeInteger(stopMs) || stopMs <= startMs || Math.abs(stopMs) > 8.64e15))
  )
    return { kind: 'unknown', text: 'Schedule time unavailable.' };
  if (nowMs < startMs) {
    const seconds = Math.ceil((startMs - nowMs) / 1000);
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const remaining =
      seconds < 60
        ? `${seconds}s`
        : days
          ? `${days}d ${hours % 24}h ${minutes % 60}m`
          : hours
            ? `${hours}h ${minutes % 60}m`
            : `${minutes}m`;
    return { kind: 'starts-in', text: `Starts in ${remaining}` };
  }
  if (stopMs !== null && nowMs >= stopMs) return { kind: 'ended', text: 'Ended' };
  return {
    kind: 'scheduled-now',
    text: stopMs === null ? 'Scheduled start passed · End unknown' : 'Scheduled now',
  };
}
