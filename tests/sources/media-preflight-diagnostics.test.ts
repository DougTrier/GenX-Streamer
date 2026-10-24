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

import { expect, it } from 'vitest';
import { createMediaPreflightDiagnostics } from '../../src/sources/media-preflight-diagnostics';
const negative = { status: 'unavailable' as const, reasonCode: 'dns-failure', checkedResources: 1 };
it('counts successes but retains only the last64 frozen negative scalar receipts', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 1000 });
  observer.record({
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 2,
  });
  const initial = observer.snapshot();
  expect(initial.receipts).toBe(1);
  expect(initial.negatives).toEqual([]);
  for (let index = 0; index < 65; index++) observer.record(negative);
  const snapshot = observer.snapshot();
  expect(snapshot).toMatchObject({ receipts: 66, negativeReceipts: 65, overflow: false });
  expect(snapshot.negatives).toHaveLength(64);
  expect(snapshot.negatives[0].ordinal).toBe(3);
  expect(snapshot.negatives[63].ordinal).toBe(66);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.negatives)).toBe(true);
  expect(snapshot.negatives.every(Object.isFrozen)).toBe(true);
  expect(initial.negatives).toEqual([]);
});
it('redacts unknown reason data and never copies arbitrary receipt fields', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 1000 });
  observer.record({
    ...negative,
    reasonCode: 'https://secret.invalid/token',
    ...{ url: 'private', requestId: 'private', retryAfter: 'private', error: 'private' },
  });
  expect(observer.snapshot().negatives).toEqual([
    {
      ordinal: 1,
      timestampMs: 1000,
      status: 'unavailable',
      reasonCode: 'unknown',
      httpStatus: null,
      checkedResources: 1,
    },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain('private');
  expect(JSON.stringify(observer.snapshot())).not.toContain('secret');
});
it('saturates counters explicitly without losing the bounded history or regressing ordinals', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 0, counterLimit: 2 });
  observer.record(negative);
  observer.record(negative);
  expect(observer.snapshot().overflow).toBe(false);
  observer.record(negative);
  expect(observer.snapshot()).toMatchObject({ receipts: 2, negativeReceipts: 2, overflow: true });
  expect(observer.snapshot().negatives.map((row) => row.ordinal)).toEqual([1, 2, 2]);
});
it('cancellation, malformed scalars, or failed clocks never throw or mutate observation state', () => {
  const observer = createMediaPreflightDiagnostics({
    now: () => {
      throw new Error('private');
    },
  });
  expect(() => observer.record(negative)).not.toThrow();
  expect(observer.snapshot().receipts).toBe(0);
  const valid = createMediaPreflightDiagnostics({ now: () => 0 });
  valid.record(negative, true);
  valid.record({ ...negative, checkedResources: 9 });
  valid.record({ ...negative, httpStatus: 600 });
  valid.record({ ...negative, checkedResources: -1 });
  expect(valid.snapshot()).toMatchObject({ receipts: 0, negativeReceipts: 0, negatives: [] });
});
const retry = {
  headerRetryCount: 1 as const,
  headerRetryReason: 'network-failure' as const,
  checkedResources: 2,
};
it('retains only last64 owned retry scalars and counts final successful receipts independently', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 1234 });
  const before = observer.snapshot();
  for (let i = 0; i < 65; i++)
    observer.record({
      status: i % 2 === 0 ? 'resources-responded' : 'unavailable',
      reasonCode: 'network-failure',
      ...retry,
      ...{ url: 'private', requestId: 'private', error: 'private' },
    });
  const result = observer.snapshot();
  expect(result).toMatchObject({
    receipts: 65,
    negativeReceipts: 32,
    retriedReceipts: 65,
    successfulRetryReceipts: 33,
    overflow: false,
  });
  expect(result.retries).toHaveLength(64);
  expect(result.retries[0]!.ordinal).toBe(2);
  expect(result.retries[63]!.ordinal).toBe(65);
  expect(result.retries[63]).toEqual({
    ordinal: 65,
    timestampMs: 1234,
    status: 'resources-responded',
    headerRetryCount: 1,
    headerRetryReason: 'network-failure',
  });
  expect(Object.isFrozen(result.retries)).toBe(true);
  expect(result.retries.every(Object.isFrozen)).toBe(true);
  expect(before.retries).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('retry success requires actual responded final status and both histories remain independent', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 1 });
  observer.record({ ...negative, ...retry });
  observer.record({ status: 'unverified', reasonCode: 'format-unverified', ...retry });
  observer.record({
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 2,
  });
  expect(observer.snapshot()).toMatchObject({
    receipts: 3,
    negativeReceipts: 2,
    retriedReceipts: 2,
    successfulRetryReceipts: 0,
  });
  expect(observer.snapshot().negatives).toHaveLength(2);
  expect(observer.snapshot().retries).toHaveLength(2);
});
it('saturates retry and successful retry counters exactly and preserves capped ordinals', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 0, counterLimit: 2 });
  const success = {
    status: 'resources-responded' as const,
    reasonCode: 'media-resources-responded',
    ...retry,
  };
  observer.record(success);
  observer.record(success);
  expect(observer.snapshot().overflow).toBe(false);
  observer.record(success);
  expect(observer.snapshot()).toMatchObject({
    receipts: 2,
    retriedReceipts: 2,
    successfulRetryReceipts: 2,
    negativeReceipts: 0,
    overflow: true,
  });
  expect(observer.snapshot().retries.map((r) => r.ordinal)).toEqual([1, 2, 2]);
});
it('refuses incoherent retry metadata, canceled retries and failed clocks without any increments', () => {
  const observer = createMediaPreflightDiagnostics({ now: () => 0 });
  const initial = observer.snapshot();
  for (const change of [
    { headerRetryCount: 1 },
    { headerRetryReason: 'network-failure' },
    { headerRetryCount: 0, headerRetryReason: 'network-failure' },
    { headerRetryCount: 2, headerRetryReason: 'network-failure' },
    { headerRetryCount: 1, headerRetryReason: 'https://secret.invalid' },
    { headerRetryCount: NaN, headerRetryReason: 'network-failure' },
    { headerRetryCount: undefined, headerRetryReason: undefined },
    { ...retry, checkedResources: 1 },
  ])
    observer.record({ ...negative, ...change } as never);
  observer.record({ ...negative, ...retry }, true);
  expect(observer.snapshot()).toEqual(initial);
  const badClock = createMediaPreflightDiagnostics({ now: () => NaN });
  badClock.record({
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    ...retry,
  });
  expect(badClock.snapshot().receipts).toBe(0);
  const accessor = { ...negative, ...retry };
  let reads = 0;
  Object.defineProperty(accessor, 'headerRetryReason', {
    get: () => {
      reads++;
      return 'network-failure';
    },
  });
  observer.record(accessor);
  expect(reads).toBe(0);
  expect(observer.snapshot()).toEqual(initial);
});
