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
import { classifyScanFailure } from '../../src/ui/scan/source-scan-model';
describe('redacted scan failure classification', () => {
  it.each([
    'catalog-revision-stale',
    'health-revision-stale',
    'checkpoint-revision-stale',
    'Saved catalog changed. Review again before saving.',
  ])('classifies exact CAS code %s', (message) =>
    expect(classifyScanFailure(new Error(message))).toBe('catalog-cas'),
  );
  it.each(['Scan changed', 'Scan checkpoint changed', 'Health observer changed'])(
    'classifies exact configuration change %s',
    (message) => expect(classifyScanFailure(new Error(message))).toBe('configuration-changed'),
  );
  it('keeps cancellation acknowledgment failure distinct from ordinary abort', () => {
    expect(
      classifyScanFailure(new Error('Channel check cancellation could not be confirmed.')),
    ).toBe('cancel-ack');
    expect(
      classifyScanFailure(new DOMException('https://private.invalid/token', 'AbortError')),
    ).toBe('canceled');
  });
  it('refuses substring guesses and exports no secret-bearing message', () => {
    for (const failure of [
      new Error('catalog-revision-stale https://private.invalid/token'),
      { message: 'Scan changed' },
      new Error('capacity secret'),
      null,
    ])
      expect(classifyScanFailure(failure)).toBe('other');
    expect(classifyScanFailure(new Error('https://private.invalid/token'), true)).toBe(
      'publish-failed',
    );
  });
  it('classifies actual bounded admission and malformed receipt codes', () => {
    expect(classifyScanFailure('scan-checkpoint-target-validation-limit')).toBe('capacity');
    expect(classifyScanFailure(new Error('Missing durable receipt'))).toBe('publish-failed');
  });
});
