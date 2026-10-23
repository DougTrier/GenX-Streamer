import { expect, it } from 'vitest';
import {
  createScanPublicationObserver,
  SCAN_PUBLICATION_STAGES,
  type ScanPublicationPatch,
  type ScanPublicationStage,
  type ScanPublicationFailure,
} from '../../src/application/scan-publication-observer';

it('one handle spans checkpoint preparation and commit, retaining frozen stage snapshots', () => {
  const observer = createScanPublicationObserver();
  const handle = observer.begin({ total: 13256, selected: 256, chunks: 4 });
  const first = observer.snapshot();
  expect(Object.isFrozen(first)).toBe(true);
  expect(observer.resume(handle)).toBe(handle);
  for (const stage of SCAN_PUBLICATION_STAGES) {
    if (stage === 'completed') break;
    observer.step(
      handle,
      stage,
      stage === 'native-dispatch'
        ? { dispatched: true }
        : stage === 'native-settled'
          ? { durableCommitted: true, catalogRevision: '17', healthRevision: '18' }
          : {},
    );
  }
  observer.complete(handle, { checkpointRevision: '19', published: 256 });
  expect(first.stage).toBe('checkpoint-prepare');
  expect(first.dispatched).toBe(false);
  expect(observer.snapshot()).toMatchObject({
    stage: 'completed',
    state: 'completed',
    durableCommitted: true,
    published: 256,
  });
  expect(observer.resume(handle)).toBeNull();
});
it('old and foreign handles cannot mutate a newer attempt, including late ACKs', () => {
  const observer = createScanPublicationObserver();
  const old = observer.begin();
  observer.step(old, 'native-dispatch', { dispatched: true });
  const fresh = observer.begin({ selected: 64 });
  const before = observer.snapshot();
  observer.step(old, 'native-settled', { durableCommitted: true });
  observer.fail(old, 'native-failed');
  observer.complete(old);
  observer.fail(createScanPublicationObserver().begin(), 'unknown');
  expect(observer.snapshot()).toBe(before);
  expect(observer.resume(old)).toBeNull();
  expect(observer.resume(fresh)).toBe(fresh);
});
it('failure retains exact original stage and durable truth, and cannot be overwritten', () => {
  const observer = createScanPublicationObserver(),
    handle = observer.begin();
  observer.step(handle, 'native-settled', { dispatched: true, durableCommitted: true });
  observer.step(handle, 'actor-ack');
  observer.fail(handle, 'ack-failed');
  const failed = observer.snapshot();
  observer.complete(handle);
  observer.step(handle, 'apply-ui');
  expect(observer.snapshot()).toBe(failed);
  expect(failed).toMatchObject({
    stage: 'actor-ack',
    state: 'failed',
    failure: 'ack-failed',
    durableCommitted: true,
  });
});
it('malformed patches refuse atomically without evaluating accessors or storing secrets', () => {
  const observer = createScanPublicationObserver(),
    handle = observer.begin();
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'checked', {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  for (const patch of [
    { checked: 1, total: 100001 },
    { selected: 257 },
    { chunks: 5 },
    { catalogRevision: '01' },
    { healthRevision: 'x'.repeat(1000) },
    { published: NaN },
    { durableCommitted: true },
    { url: 'https://private.invalid/token' },
    accessor,
  ]) {
    const before = observer.snapshot();
    expect(() => observer.step(handle, 'queued', patch as ScanPublicationPatch)).toThrow();
    expect(observer.snapshot()).toBe(before);
  }
  expect(getterCalls).toBe(0);
  expect(() => observer.begin({ checked: -1 })).toThrow();
  expect(observer.resume(handle)).toBe(handle);
  expect(() => observer.fail(handle, 'raw provider error' as ScanPublicationFailure)).toThrow();
  expect(() =>
    observer.step(handle, 'https://secret.invalid' as Exclude<ScanPublicationStage, 'completed'>),
  ).toThrow();
  expect(JSON.stringify(observer.snapshot())).not.toContain('private');
});
it('dispatched completion requires a confirmed durable receipt and receipt flags cannot regress', () => {
  const observer = createScanPublicationObserver(),
    handle = observer.begin();
  observer.step(handle, 'native-dispatch', { dispatched: true });
  const pending = observer.snapshot();
  expect(() => observer.complete(handle)).toThrow();
  expect(observer.snapshot()).toBe(pending);
  expect(() => observer.step(handle, 'native-settled', { dispatched: false })).toThrow();
  observer.step(handle, 'native-settled', { durableCommitted: true });
  expect(() => observer.step(handle, 'actor-ack', { durableCommitted: false })).toThrow();
  observer.complete(handle);
  expect(observer.snapshot().state).toBe('completed');
});
it('durable actor ACK failure survives the following queued failure in a bounded frozen history', () => {
  const observer = createScanPublicationObserver(),
    first = observer.begin();
  observer.step(first, 'actor-ack', { dispatched: true, durableCommitted: true });
  observer.fail(first, 'ack-failed');
  const retained = observer.snapshot();
  const second = observer.begin();
  observer.step(second, 'queued');
  observer.fail(second, 'actor-failed');
  expect(observer.snapshot().failures).toEqual([
    {
      attempt: 1,
      stage: 'actor-ack',
      code: 'ack-failed',
      dispatched: true,
      durableCommitted: true,
    },
    {
      attempt: 2,
      stage: 'queued',
      code: 'actor-failed',
      dispatched: false,
      durableCommitted: false,
    },
  ]);
  expect(Object.isFrozen(observer.snapshot().failures)).toBe(true);
  expect(observer.snapshot().failures.every(Object.isFrozen)).toBe(true);
  const third = observer.begin();
  observer.fail(third, 'unknown');
  expect(observer.snapshot().failures.map((record) => record.attempt)).toEqual([2, 3]);
  expect(retained.failures).toHaveLength(1);
  expect(retained.failures[0].code).toBe('ack-failed');
});

it('accepts all eleven known fields together and bounds wire bytes and signed-i64 revisions', () => {
  const observer = createScanPublicationObserver();
  const handle = observer.begin({
    checked: 100000,
    total: 100000,
    published: 100000,
    selected: 256,
    chunks: 4,
    wireBytes: 20 * 1024 * 1024,
    catalogRevision: '9223372036854775807',
    healthRevision: '0',
    checkpointRevision: null,
    dispatched: true,
    durableCommitted: true,
  });
  expect(observer.snapshot().wireBytes).toBe(20 * 1024 * 1024);
  for (const patch of [
    { wireBytes: 20 * 1024 * 1024 + 1 },
    { wireBytes: -1 },
    { wireBytes: 0.5 },
    { catalogRevision: '9223372036854775808' },
    { catalogRevision: '-1' },
    { healthRevision: '000' },
  ]) {
    const before = observer.snapshot();
    expect(() => observer.step(handle, 'window-admission', patch)).toThrow();
    expect(observer.snapshot()).toBe(before);
  }
  const fresh = observer.begin();
  expect(observer.snapshot().wireBytes).toBe(0);
  observer.complete(fresh);
});
