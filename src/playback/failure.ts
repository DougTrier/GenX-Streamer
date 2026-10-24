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

import type { FailurePhase, PlaybackFailure } from './controller';

/** HTTP-date or decimal delay-seconds only; malformed hints use normal retry policy. */
function retryDelay(value: string | null | undefined, now: number): number | undefined {
  if (typeof value !== 'string' || value.length > 128 || !Number.isFinite(now)) return;
  const text = value.replace(/^[\t ]+|[\t ]+$/g, '');
  if (!text || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return;
  if (/^[0-9]+$/u.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  // Admit the three HTTP date grammars, not Date.parse's permissive numeric/ISO forms.
  const day = '(Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const month = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const time = '([0-9]{2}):([0-9]{2}):([0-9]{2})';
  const modern = new RegExp(`^${day}, ([0-9]{2}) ${month} ([0-9]{4}) ${time} GMT$`).exec(text);
  const obsolete = new RegExp(
    `^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-${month}-([0-9]{2}) ${time} GMT$`,
  ).exec(text);
  const ascii = new RegExp(`^${day} ${month} (?:([0-9]{2})| ([0-9])) ${time} ([0-9]{4})$`).exec(
    text,
  );
  const match = modern ?? obsolete;
  if (!match && !ascii) return;
  const fields = match
    ? match.slice(1)
    : [ascii![1], ascii![3] ?? ascii![4], ascii![2], ascii![8], ascii![5], ascii![6], ascii![7]];
  const [weekday, date, monthName, year, hour, minute, second] = fields;
  const timestamp = Date.parse(text.endsWith('GMT') ? text : `${text} GMT`);
  if (!Number.isFinite(timestamp)) return;
  const parsed = new Date(timestamp);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Date.parse can normalize impossible dates or ignore the stated weekday.
  if (
    parsed.getUTCDate() !== Number(date) ||
    months[parsed.getUTCMonth()] !== monthName ||
    (obsolete ? parsed.getUTCFullYear() % 100 : parsed.getUTCFullYear()) !== Number(year) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    days[parsed.getUTCDay()] !== weekday?.slice(0, 3)
  )
    return;
  const milliseconds = timestamp - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

export function classifyHttpFailure(
  status: number,
  retryAfter?: string | null,
  now = Date.now(),
): PlaybackFailure {
  const observedStatus =
    Number.isInteger(status) && status >= 300 && status <= 599 ? { httpStatus: status } : {};
  if (status >= 300 && status < 400)
    return {
      code: 'unsupported',
      message: [300, 301, 302, 303, 305, 307, 308].includes(status)
        ? 'The source returned a redirect the app could not follow. Check its address or choose another stream.'
        : 'The source returned an unsupported response. Check its address or choose another stream.',
      retryable: false,
      evidence: 'http',
      ...observedStatus,
    };
  if (status === 401 || status === 403)
    return {
      code: 'access',
      message: 'Access to this stream was refused. Check the source or choose another channel.',
      retryable: false,
      evidence: 'http',
      ...observedStatus,
    };
  if (status === 404 || status === 410)
    return {
      code: 'missing',
      message:
        'The source could not find this stream. Refresh saved sources or choose another channel.',
      retryable: false,
      evidence: 'http',
      ...observedStatus,
    };
  const retryAfterMs = retryDelay(retryAfter, now);
  return {
    code: status ? 'network' : 'unknown',
    message:
      status === 429 || status === 503
        ? 'The source is busy. Try again later.'
        : 'The stream could not be reached. Check your connection or try another channel.',
    retryable: status === 0 || status === 408 || status === 429 || status >= 500,
    retryAfterMs,
    evidence: status ? 'http' : 'opaque',
    ...observedStatus,
  };
}

/** Only known native categories survive. Raw provider errors never become messages. */
export function classifyTransportFailure(error: unknown): PlaybackFailure {
  const directRecord = typeof error === 'object' && error !== null;
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return {
      code: 'timeout',
      message: 'The source did not respond in time. Retry or choose another stream.',
      retryable: true,
      phase: 'unknown',
      evidence: 'opaque',
    };
  if (typeof error === 'string' && error.length <= 1024 && error.startsWith('{')) {
    try {
      error = JSON.parse(error);
    } catch {
      /* Opaque errors remain unknown. */
    }
  }
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const category = typeof error === 'string' ? error : record?.category;
  const phase: FailurePhase = ['connect', 'headers', 'body', 'unknown'].includes(
    String(record?.phase),
  )
    ? (record?.phase as FailurePhase)
    : 'unknown';
  if (
    record &&
    typeof record.status === 'number' &&
    Number.isInteger(record.status) &&
    record.status >= 300 &&
    record.status <= 599
  )
    return {
      ...classifyHttpFailure(
        record.status,
        typeof record.retryAfter === 'string' && record.retryAfter.length <= 256
          ? record.retryAfter
          : null,
      ),
      phase,
    };
  const messages: Record<string, Pick<PlaybackFailure, 'code' | 'message' | 'retryable'>> = {
    'tls-failure': {
      code: 'tls',
      message:
        'The source has a secure connection problem. Choose another stream or contact its provider.',
      retryable: false,
    },
    'dns-failure': {
      code: 'dns',
      message:
        'The source address could not be found. Check your connection or try another stream.',
      retryable: true,
    },
    'connectivity-failure': {
      code: 'network',
      message: 'The source could not be connected. Check your connection or try another stream.',
      retryable: true,
    },
    'network-failure': {
      code: 'network',
      message: 'The stream connection failed. Check your connection or try another stream.',
      retryable: true,
    },
    timeout: {
      code: 'timeout',
      message:
        phase === 'body'
          ? 'The media download did not finish in time. Retry or choose another stream.'
          : phase === 'headers'
            ? 'The source response did not arrive in time. Retry or choose another stream.'
            : 'The source did not respond in time. Retry or choose another stream.',
      retryable: true,
    },
  };
  if (typeof category === 'string' && Object.hasOwn(messages, category))
    return { ...messages[category], phase, evidence: 'native' };
  if (
    typeof category === 'string' &&
    ([
      'url-policy-refused',
      'redirect-refused',
      'range-refused',
      'http-refused',
      'invalid-url',
    ].includes(category) ||
      (directRecord && category === 'source-policy-refused'))
  )
    return {
      code: 'policy',
      message:
        'This source request is refused by the network policy. Check its source settings or choose another stream.',
      retryable: false,
      phase,
      evidence: 'native',
    };
  if (
    typeof category === 'string' &&
    [
      'media-too-large',
      'playlist-too-large',
      'playlist-invalid-utf8',
      'invalid-json',
      'invalid-text',
      'json-too-large',
    ].includes(category)
  )
    return {
      code: 'unsupported',
      message: 'The source returned unsupported or oversized playback data. Choose another stream.',
      retryable: false,
      phase,
      evidence: 'native',
    };
  return { ...classifyHttpFailure(0), phase: 'unknown' };
}
