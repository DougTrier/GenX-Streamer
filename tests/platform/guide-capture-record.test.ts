import { expect, it, vi } from 'vitest';
import {
  readGuideCaptureRecord,
  readIndexedDbGuideCaptureRecord,
  validateGuideCaptureRecord,
} from '../../src/platform/guide-capture-record';
const snapshot = {
  catalog: '{"schemaVersion":1}',
  preferences: '{"schemaVersion":1}',
  catalogRevision: '7',
};
function fixture() {
  const original = new Map<string, unknown>(
    Object.entries({ ...snapshot, health: 'private-health', scanCheckpoint: 'private-checkpoint' }),
  );
  const captured = new Map(original),
    keys: string[] = [],
    transactions: unknown[][] = [];
  const tx = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    objectStore: vi.fn(() => ({
      get: (key: string) => {
        keys.push(key);
        return {
          get result() {
            return captured.get(key);
          },
        };
      },
    })),
  };
  const database = {
    transaction: (...args: unknown[]) => {
      transactions.push(args);
      return tx;
    },
  } as unknown as IDBDatabase;
  return { original, captured, keys, transactions, tx, database };
}
it('reads exactly three fields in one readonly atomic snapshot without health/checkpoint or mutations', async () => {
  const f = fixture(),
    before = new Map(f.original),
    pending = readIndexedDbGuideCaptureRecord(f.database);
  f.original.set('catalogRevision', '8');
  f.original.set('catalog', 'changed');
  f.tx.oncomplete!();
  expect(await pending).toEqual(snapshot);
  expect(f.keys).toEqual(['catalog', 'preferences', 'catalogRevision']);
  expect(f.transactions).toEqual([['records', 'readonly']]);
  expect(f.tx.objectStore).toHaveBeenCalledWith('records');
  expect(f.captured).toEqual(before);
});
it.each(['01', '-1', '1.5', '9223372036854775808', 1, null, undefined])(
  'refuses invalid revision %s',
  (value) =>
    expect(() => validateGuideCaptureRecord({ ...snapshot, catalogRevision: value })).toThrow(
      'invalid',
    ),
);
it.each([
  null,
  [],
  {},
  Object.create(snapshot),
  { ...snapshot, health: 'forbidden' },
  { ...snapshot, catalog: 42 },
  { ...snapshot, preferences: '' },
  { ...snapshot, preferences: 'x'.repeat(20 * 1024 * 1024 + 1) },
])('refuses malformed wire envelopes without decoding or accepting surplus records', (value) =>
  expect(() => validateGuideCaptureRecord(value)).toThrow('invalid'),
);
it('accepts nullable absent records and maximum canonical revision', () =>
  expect(
    validateGuideCaptureRecord({
      catalog: null,
      preferences: null,
      catalogRevision: '9223372036854775807',
    }),
  ).toEqual({ catalog: null, preferences: null, catalogRevision: '9223372036854775807' }));
it.each(['abort', 'error', 'corrupt'] as const)(
  'failed %s read leaves old records unchanged',
  async (kind) => {
    const f = fixture(),
      before = new Map(f.original),
      pending = readIndexedDbGuideCaptureRecord(f.database);
    const refused = expect(pending).rejects.toThrow(/snapshot/u);
    if (kind === 'corrupt') {
      f.captured.set('catalogRevision', 'invalid');
      f.tx.oncomplete!();
    } else if (kind === 'abort') f.tx.onabort!();
    else {
      f.tx.onerror!();
      f.tx.onabort!();
    }
    await refused;
    expect(f.original).toEqual(before);
  },
);
it('native adapter calls only the dedicated command and joins a read that settles after cancellation', async () => {
  let settle!: (value: unknown) => void;
  const controller = new AbortController(),
    invoke = vi.fn(() => new Promise((resolve) => (settle = resolve))),
    openDatabase = vi.fn();
  const pending = readGuideCaptureRecord(
    { isNative: () => true, invoke, openDatabase },
    controller.signal,
  );
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  settle(snapshot);
  await refused;
  expect(invoke).toHaveBeenCalledExactlyOnceWith('read_guide_capture');
  expect(openDatabase).not.toHaveBeenCalled();
});
it('browser adapter uses the narrow read and pre-aborted admission starts no work', async () => {
  const f = fixture(),
    invoke = vi.fn(),
    openDatabase = vi.fn(async () => f.database);
  const host = { isNative: () => false, invoke, openDatabase };
  const pending = readGuideCaptureRecord(host);
  await Promise.resolve();
  f.tx.oncomplete!();
  expect(await pending).toEqual(snapshot);
  expect(invoke).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(readGuideCaptureRecord(host, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(openDatabase).toHaveBeenCalledTimes(1);
});
