import { expect, it, vi } from 'vitest';
import {
  createScanCheckpointSummaryAdapter,
  validateScanCheckpointSummary,
  ScanCheckpointSummaryReadError,
  ScanCheckpointSummaryValidationError,
} from '../../src/platform/scan-checkpoint-summary';

const valid = () => ({
  schemaVersion: 1,
  checkpointStatus: 'valid',
  storedVersion: 3,
  total: 100000,
  checked: 100000,
  responded: 40000,
  published: 39999,
  unfinished: true,
  catalogRevision: '9223372036854775807',
  checkpointRevision: '0',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('rejects inconsistent unfinished flags for pending checks or unpublished responses', () => {
  for (const input of [
    { ...valid(), unfinished: false },
    { ...valid(), checked: 99999, published: 40000, unfinished: false },
    { ...valid(), published: 40000, unfinished: true },
  ])
    expect(() => validateScanCheckpointSummary(input)).toThrow(
      ScanCheckpointSummaryValidationError,
    );
  expect(
    validateScanCheckpointSummary({ ...valid(), published: 40000, unfinished: false }).unfinished,
  ).toBe(false);
});

it.each([1, 2, 3])(
  'admits version%s and unfinished checked-total equality without claiming Resume',
  (version) => {
    const input = { ...valid(), storedVersion: version };
    const result = validateScanCheckpointSummary(input);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.published = 0;
    expect(result.published).toBe(39999);
    expect(Object.keys(result)).toHaveLength(10);
  },
);
it.each(['absent', 'invalid'])('admits only empty %s metadata', (status) => {
  const input = {
    ...valid(),
    checkpointStatus: status,
    storedVersion: null,
    total: 0,
    checked: 0,
    responded: 0,
    published: 0,
    unfinished: false,
  };
  expect(validateScanCheckpointSummary(input).checkpointStatus).toBe(status);
  for (const change of [{ total: 1 }, { storedVersion: 3 }, { unfinished: true }])
    expect(() => validateScanCheckpointSummary({ ...input, ...change })).toThrow(
      ScanCheckpointSummaryValidationError,
    );
});
it.each([
  { schemaVersion: 2 },
  { checkpointStatus: 'resumable' },
  { storedVersion: null },
  { storedVersion: 4 },
  { total: 100001 },
  { checked: -1 },
  { responded: 1.5 },
  { published: NaN },
  { unfinished: 1 },
  { checked: 40000, responded: 40001 },
  { published: 40001 },
  { total: 99999 },
  { catalogRevision: '01' },
  { checkpointRevision: '-1' },
  { catalogRevision: '9223372036854775808' },
  { checkpointRevision: 0 },
  { checkpointRevision: 'https://private.invalid/token' },
  { url: 'https://private.invalid/token' },
])('rejects hostile metadata without retaining payload (%#)', (change) => {
  const failure = (() => {
    try {
      validateScanCheckpointSummary({ ...valid(), ...change });
    } catch (error) {
      return error;
    }
  })();
  expect(failure).toBeInstanceOf(ScanCheckpointSummaryValidationError);
  expect(String(failure)).not.toContain('private.invalid');
});
it('rejects missing keys, prototypes and accessors without executing getters or coercion', () => {
  const getter = vi.fn(() => 'valid');
  const accessor = { ...valid() };
  Object.defineProperty(accessor, 'checkpointStatus', { get: getter });
  expect(() => validateScanCheckpointSummary(accessor)).toThrow();
  const coercion = vi.fn(() => 'valid');
  expect(() =>
    validateScanCheckpointSummary({ ...valid(), checkpointStatus: { toString: coercion } }),
  ).toThrow();
  const missing = { ...valid() } as Record<string, unknown>;
  delete missing.total;
  expect(() => validateScanCheckpointSummary(missing)).toThrow();
  expect(() => validateScanCheckpointSummary(Object.assign(Object.create({}), valid()))).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(coercion).not.toHaveBeenCalled();
});
it('uses the actual read command and request ID, distinguishing read failure from absence', async () => {
  const invoke = vi.fn(async () => valid());
  const adapter = createScanCheckpointSummaryAdapter({
    isNative: () => true,
    invoke,
    idFactory: () => 'owned-read',
  });
  expect((await adapter.read()).checkpointStatus).toBe('valid');
  expect(invoke).toHaveBeenCalledWith('read_scan_checkpoint_summary', { requestId: 'owned-read' });
  const refused = createScanCheckpointSummaryAdapter({
    isNative: () => true,
    invoke: async () => {
      throw 'https://private.invalid/token';
    },
  });
  await expect(refused.read()).rejects.toBeInstanceOf(ScanCheckpointSummaryReadError);
  await expect(refused.read()).rejects.not.toThrow('private.invalid');
});
it('never dispatches in browser or with a pre-aborted signal', async () => {
  const invoke = vi.fn(async () => valid());
  const browser = createScanCheckpointSummaryAdapter({ isNative: () => false, invoke });
  await expect(browser.read()).rejects.toBeInstanceOf(ScanCheckpointSummaryReadError);
  const signal = AbortSignal.abort();
  const native = createScanCheckpointSummaryAdapter({ isNative: () => true, invoke });
  await expect(native.read(signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(invoke).not.toHaveBeenCalled();
});
it('joins the real read and cancellation before rejecting late success as canceled', async () => {
  const read = deferred<unknown>(),
    cancel = deferred<unknown>();
  const invoke = vi.fn((command: string) =>
    command === 'cancel_playlist' ? cancel.promise : read.promise,
  );
  const adapter = createScanCheckpointSummaryAdapter({
    isNative: () => true,
    invoke,
    idFactory: () => 'owned-read',
  });
  const controller = new AbortController();
  let settled = false;
  const pending = adapter.read(controller.signal).finally(() => {
    settled = true;
  });
  const refusal = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: 'owned-read' });
  cancel.resolve(undefined);
  await Promise.resolve();
  expect(settled).toBe(false);
  read.resolve(valid());
  await refusal;
});
it('unconfirmed cancellation rejects after actual read and cancellation settle', async () => {
  const read = deferred<unknown>(),
    cancel = deferred<unknown>();
  const adapter = createScanCheckpointSummaryAdapter({
    isNative: () => true,
    invoke: (command) => (command === 'cancel_playlist' ? cancel.promise : read.promise),
  });
  const controller = new AbortController();
  const pending = adapter.read(controller.signal);
  const refusal = expect(pending).rejects.toThrow(
    'Native command cancellation could not be confirmed.',
  );
  controller.abort();
  cancel.reject('https://private.invalid/token');
  read.resolve(valid());
  await refusal;
});
