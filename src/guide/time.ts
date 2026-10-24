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

export type XmltvTime =
  | { status: 'instant'; epochMs: number; precision: 'second' | 'minute' }
  | { status: 'incomplete' | 'unsupported' | 'invalid' };
/** Supported policy: complete second/minute precision, numeric offsets <=14:00; absent offset is UTC. */
export function parseXmltvTime(input: string | null | undefined): XmltvTime {
  if (input === null || input === undefined || input.trim() === '') return { status: 'incomplete' };
  if (input.length > 64) return { status: 'invalid' };
  const matched = /^(\d{4}(?:\d{2}){0,5})(?:\s+([+-]\d{4}|[a-z][\da-z_/:+-]*))?$/i.exec(
    input.trim(),
  );
  if (!matched) return { status: 'invalid' };
  const digits = matched[1];
  const zone = matched[2];
  if (zone && !/^[+-]\d{4}$/.test(zone)) return { status: 'unsupported' };
  const year = Number(digits.slice(0, 4));
  const month = digits.length >= 6 ? Number(digits.slice(4, 6)) : 1;
  const day = digits.length >= 8 ? Number(digits.slice(6, 8)) : 1;
  const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
  const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
  const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return { status: 'invalid' };
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return { status: 'invalid' };
  let offset = 0;
  if (zone) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(3, 5));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return { status: 'invalid' };
    offset = (hours * 60 + minutes) * (zone[0] === '-' ? -1 : 1);
  }
  if (digits.length < 12) return { status: 'incomplete' };
  return {
    status: 'instant',
    epochMs: date.getTime() - offset * 60000,
    precision: digits.length === 14 ? 'second' : 'minute',
  };
}
export function validGuideInstant(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
}
export function formatGuideTime(
  epochMs: number,
  context: { timeZone: string; locale?: string },
): { date: string; time: string; zone: string } {
  if (!validGuideInstant(epochMs)) throw new Error('The guide instant is invalid.');
  if (typeof context.timeZone !== 'string' || !context.timeZone)
    throw new Error('Choose an explicit guide display timezone.');
  try {
    const locale = context.locale ?? 'en-US';
    const timeZone = context.timeZone;
    const date = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(epochMs);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(epochMs);
    const zone = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(epochMs)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!zone) throw new Error('Missing timezone.');
    return { date, time, zone };
  } catch {
    throw new Error('The guide display timezone or locale is unsupported.');
  }
}

/** Include the date and numeric offset so future days and repeated DST hours are distinct. */
export function formatLocalGuideTime(
  epochMs: number,
  context: { timeZone: string; locale?: string } = {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
): string {
  const value = formatGuideTime(epochMs, context);
  return `${value.date} ${value.time} ${value.zone}`;
}

/** Compact local viewing metadata; detailed Guide/Search retain dates and offsets. */
export function formatCompactViewingTime(
  epochMs: number,
  context: { timeZone?: string; locale?: string; nowMs?: number } = {},
): string {
  const nowMs = context.nowMs ?? Date.now();
  if (!validGuideInstant(epochMs) || !validGuideInstant(nowMs))
    throw new Error('The guide instant is invalid.');
  const timeZone = context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const base = new Intl.DateTimeFormat(context.locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    });
    const parts = base.formatToParts(epochMs);
    const onHour = parts.find((part) => part.type === 'minute')?.value === '00';
    const twelveHour = ['h11', 'h12'].includes(base.resolvedOptions().hourCycle ?? '');
    const time =
      onHour && twelveHour
        ? new Intl.DateTimeFormat(context.locale, { timeZone, hour: 'numeric' }).format(epochMs)
        : base.format(epochMs);
    const compact = time.replace(/\s+(?=[AP]M$)/u, '');
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (day.format(epochMs) === day.format(nowMs)) return compact;
    const weekday = new Intl.DateTimeFormat(context.locale, { timeZone, weekday: 'short' }).format(
      epochMs,
    );
    return `${weekday} ${compact}`;
  } catch {
    throw new Error('The guide display timezone or locale is unsupported.');
  }
}
