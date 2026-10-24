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

import { describe, it, expect } from 'vitest';
import { classifyHttpFailure, classifyTransportFailure } from '../../src/playback/failure';
describe('bounded HTTP Retry-After grammar', () => {
  it.each([
    ' ',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '0x10',
    'Infinity',
    '2026-10-13T00:00:00Z',
    '9\r\nInjected: secret',
    '9'.repeat(129),
  ])('ignores malformed or overlong hint (%#)', (hint) => {
    for (const status of [429, 503]) {
      const failure = classifyHttpFailure(status, hint, 0);
      expect(failure.retryAfterMs).toBeUndefined();
      expect(failure.retryable).toBe(true);
      expect(failure.message).toBe('The source is busy. Try again later.');
    }
  });
  it.each([
    ['0', 0],
    ['9', 9000],
    [' \t09\t ', 9000],
    ['9'.repeat(128), Number('9'.repeat(128)) * 1000],
  ] as const)('preserves bounded decimal seconds (%#)', (hint, expected) => {
    expect(classifyHttpFailure(429, hint, 0).retryAfterMs).toBe(expected);
  });
  it.each([
    'Sun, 06 Nov 1994 08:49:37 GMT',
    'Sunday, 06-Nov-94 08:49:37 GMT',
    'Sun Nov  6 08:49:37 1994',
  ])('preserves HTTP date forms as UTC (%#)', (hint) => {
    const timestamp = Date.UTC(1994, 10, 6, 8, 49, 37);
    expect(classifyHttpFailure(503, hint, timestamp - 9000).retryAfterMs).toBe(9000);
    expect(classifyHttpFailure(503, hint, timestamp + 1).retryAfterMs).toBe(0);
  });
  it.each([
    'Fri, 31 Feb 2023 08:49:37 GMT',
    'Friday, 31-Feb-23 08:49:37 GMT',
    'Fri Feb 31 08:49:37 2023',
    'Thu, 29 Feb 2023 08:49:37 GMT',
    'Sun, 00 Nov 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994 24:00:00 GMT',
    'Sun, 06 Nov 1994 08:60:00 GMT',
    'Sun, 06 Nov 1994 08:49:61 GMT',
    'Mon, 06 Nov 1994 08:49:37 GMT',
  ])('rejects impossible calendar/time or inconsistent weekday (%#)', (hint) => {
    expect(classifyHttpFailure(503, hint, 0).retryAfterMs).toBeUndefined();
  });
  it('preserves a valid leap-day date', () => {
    const instant = Date.UTC(2024, 1, 29, 8, 49, 37);
    expect(
      classifyHttpFailure(503, 'Thu, 29 Feb 2024 08:49:37 GMT', instant - 9000).retryAfterMs,
    ).toBe(9000);
  });
});
describe('redacted exact native playback causes', () => {
  it.each([300, 301, 302, 303, 305, 307, 308])(
    'HTTP%s gives unfollowed redirect guidance without inventing its cause',
    (status) => {
      const direct = classifyHttpFailure(status, '9');
      expect(direct).toMatchObject({ code: 'unsupported', retryable: false, evidence: 'http' });
      expect(direct.message).toMatch(/redirect.*could not follow/);
      expect(direct.message).not.toMatch(/security|policy|geograph|country|certificate/i);
      expect(direct.retryAfterMs).toBeUndefined();
      expect(
        classifyTransportFailure(JSON.stringify({ category: 'http', phase: 'headers', status })),
      ).toEqual({ ...direct, phase: 'headers' });
    },
  );
  it.each([304, 306, 399])('HTTP%s does not falsely label every3xx a redirect', (status) => {
    const failure = classifyHttpFailure(status);
    expect(failure).toMatchObject({ code: 'unsupported', retryable: false, evidence: 'http' });
    expect(failure.message).not.toMatch(/redirect|security|geograph/i);
  });
  it.each(['invalid-text', 'invalid-json'])(
    'invalid %s metadata is unsupported rather than a network guess',
    (category) => {
      expect(classifyTransportFailure(category)).toMatchObject({
        code: 'unsupported',
        retryable: false,
      });
    },
  );
  it('browser-owned timeout is established without guessing a network phase', () => {
    expect(classifyTransportFailure(new DOMException('deadline', 'TimeoutError'))).toMatchObject({
      code: 'timeout',
      phase: 'unknown',
      evidence: 'opaque',
    });
  });
  it.each([
    ['tls-failure', 'tls', false],
    ['dns-failure', 'dns', true],
    ['connectivity-failure', 'network', true],
    ['url-policy-refused', 'policy', false],
    ['redirect-refused', 'policy', false],
    ['range-refused', 'policy', false],
  ] as const)('preserves %s', (category, code, retryable) => {
    expect(classifyTransportFailure(category)).toMatchObject({
      code,
      retryable,
      phase: 'unknown',
      evidence: 'native',
    });
  });
  it.each(['headers', 'body', 'connect'] as const)(
    'preserves only observed timeout %s phase',
    (phase) => {
      expect(
        classifyTransportFailure(JSON.stringify({ category: 'timeout', phase })),
      ).toMatchObject({ code: 'timeout', phase });
    },
  );
  it('retains busy inspection Retry-After without fetching an error body', () => {
    expect(
      classifyTransportFailure(
        JSON.stringify({ category: 'http-error', phase: 'headers', status: 429, retryAfter: '9' }),
      ),
    ).toMatchObject({ code: 'network', phase: 'headers', retryAfterMs: 9000 });
  });
  it.each([
    new TypeError('opaque https://secret.invalid/token'),
    'tls',
    'dns',
    'https://secret.invalid/token',
    '{not json}',
    { category: 'untrusted', phase: 'body', message: 'private token' },
  ])('opaque data has no invented DNS/TLS evidence', (value) => {
    const failure = classifyTransportFailure(value);
    expect(failure.code).toBe('unknown');
    expect(failure.evidence).toBe('opaque');
    expect(JSON.stringify(failure)).not.toMatch(/secret|private|token/);
  });
  it('HTTP403 does not invent a geographic restriction', () => {
    const failure = classifyTransportFailure({
      category: 'http-error',
      status: 403,
      phase: 'headers',
    });
    expect(failure.code).toBe('access');
    expect(failure.message).not.toMatch(/geograph|region|country/i);
  });
});

it('admits exact internal preflight evidence without treating provider response text as policy', () => {
  expect(
    classifyTransportFailure({
      category: 'source-policy-refused',
      phase: 'unknown',
    }),
  ).toMatchObject({
    code: 'policy',
    retryable: false,
    phase: 'unknown',
    evidence: 'native',
  });
  for (const value of [
    JSON.stringify({ category: 'source-policy-refused', phase: 'unknown' }),
    'source-policy-refused',
    'source-policy-refused https://private.invalid/secret',
    { category: 'source-policy-refused-extra', phase: 'body' },
    { message: 'source-policy-refused', phase: 'body' },
  ]) {
    const failure = classifyTransportFailure(value);
    expect(failure).toMatchObject({ code: 'unknown', evidence: 'opaque' });
    expect(JSON.stringify(failure)).not.toMatch(/private|secret/);
  }
});
