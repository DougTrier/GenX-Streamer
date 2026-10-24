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

import { describe, expect, it } from 'vitest';
import { createScanRecoveryObserver } from '../../src/application/scan-recovery-observer';
describe('scan recovery scalar observation', () => {
  it('retains the exact admitted counts and fixed refusal without source data', () => {
    const observer = createScanRecoveryObserver(),
      token = observer.begin();
    observer.decoded(token, 2, 169, 81);
    observer.step(token, 'immutable-review');
    const before = observer.snapshot();
    observer.refuse(token, 'immutable-review-changed');
    expect(observer.snapshot()).toMatchObject({
      stage: 'refused',
      reason: 'immutable-review-changed',
      storedVersion: 2,
      checked: 169,
      published: 81,
    });
    expect(before.stage).toBe('immutable-review');
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.keys(before)).toEqual([
      'schemaVersion',
      'generation',
      'stage',
      'reason',
      'storedVersion',
      'checked',
      'published',
      'reconstructionFailure',
    ]);
  });
  it('ignores stale recovery completions and starts each actual attempt with empty counters', () => {
    const observer = createScanRecoveryObserver(),
      old = observer.begin(),
      next = observer.begin();
    observer.refuse(old, 'immutable-review-changed', 'original-url-missing');
    observer.decoded(old, 1, 900, 300);
    observer.step(old, 'accepted');
    expect(observer.snapshot()).toMatchObject({
      generation: 2,
      stage: 'reading',
      reason: 'none',
      storedVersion: null,
      checked: 0,
      published: 0,
      reconstructionFailure: null,
    });
    observer.step(next, 'absent');
    expect(observer.snapshot().stage).toBe('absent');
  });
});

it('records only allowlisted reconstruction details and clears them on the next attempt', () => {
  const observer = createScanRecoveryObserver(),
    token = observer.begin();
  observer.refuse(token, 'immutable-review-changed', 'original-url-missing');
  expect(observer.snapshot().reconstructionFailure).toBe('original-url-missing');
  const next = observer.begin();
  expect(observer.snapshot().reconstructionFailure).toBeNull();
  observer.refuse(next, 'source-unavailable', 'original-url-missing');
  expect(observer.snapshot().reconstructionFailure).toBeNull();
  observer.refuse(next, 'immutable-review-changed', 'https://secret.invalid/token' as never);
  expect(observer.snapshot().reconstructionFailure).toBeNull();
  expect(JSON.stringify(observer.snapshot())).not.toContain('secret');
});
