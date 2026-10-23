import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  prepareCapture,
  parseCapture,
  prepareStoredCapture,
  prepareInitialProgressCapture,
  parseStoredCapture,
  restoreReferencedCapture,
  parseStoredCaptureWithPacked,
  restorePackedCapture,
  parseScanCheckpointCapabilities,
  prepareInitialPackedProgressCapture,
} from '../../src/application/scan-checkpoint-capture-service';
import type { ScanCheckpointCaptureInput } from '../../src/application/scan-checkpoint-capture';
import { checkpointFixture } from '../discovery/helpers/scan-checkpoint';
import { scanReconstructionFailureCode } from '../../src/discovery/scan-checkpoint';
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown;
  terminated = 0;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(value: unknown) {
    if (FakeWorker.failPost) throw new Error('sentinel');
    this.posted = structuredClone(value);
  }
  terminate() {
    expect([this.onmessage, this.onerror, this.onmessageerror]).toEqual([null, null, null]);
    this.terminated++;
  }
}
const input = {} as ScanCheckpointCaptureInput;
const current = () => FakeWorker.instances.at(-1)!;
beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failPost = false;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());
it.each(['{}', null])(
  'terminates before prepare settlement including deliberate null refusal',
  async (reply) => {
    const pending = prepareCapture(input, new AbortController().signal),
      worker = current();
    worker.onmessage?.({ data: { operation: 'prepare', ok: true, value: reply } } as MessageEvent);
    expect(await pending).toBe(reply);
    expect(worker.terminated).toBe(1);
    worker.onerror?.();
    expect(worker.terminated).toBe(1);
  },
);
it('loads a checkpoint through the parse operation and terminates before returning', async () => {
  const pending = parseCapture('saved', new AbortController().signal),
    worker = current(),
    parsed = await checkpointFixture();
  expect(worker.posted).toEqual({ operation: 'parse', input: 'saved' });
  worker.onmessage?.({ data: { operation: 'parse', ok: true, value: parsed } } as MessageEvent);
  expect(await pending).toEqual(parsed);
  expect(worker.terminated).toBe(1);
});
it('abort joins via termination and ignores late success and failures', async () => {
  const controller = new AbortController(),
    pending = prepareCapture(input, controller.signal),
    worker = current();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  worker.onmessage?.({ data: { operation: 'prepare', ok: true, value: null } } as MessageEvent);
  worker.onerror?.();
  await rejected;
  expect(worker.terminated).toBe(1);
});
it.each(['post', 'error', 'messageerror', 'refusal', 'wrong-operation', 'invalid'] as const)(
  'rejects %s without leaking worker or diagnostic payload',
  async (kind) => {
    FakeWorker.failPost = kind === 'post';
    const pending = prepareCapture(input, new AbortController().signal),
      worker = current();
    const rejected = expect(pending).rejects.toThrow(/Scan checkpoint/u);
    if (kind === 'error') worker.onerror?.();
    if (kind === 'messageerror') worker.onmessageerror?.();
    if (kind === 'refusal')
      worker.onmessage?.({
        data: { operation: 'prepare', ok: false, error: 'secret' },
      } as MessageEvent);
    if (kind === 'wrong-operation')
      worker.onmessage?.({ data: { operation: 'parse', ok: true, value: null } } as MessageEvent);
    if (kind === 'invalid')
      worker.onmessage?.({ data: { operation: 'prepare', ok: true, value: {} } } as MessageEvent);
    await rejected;
    expect(worker.terminated).toBe(1);
  },
);
it('an already aborted request never acquires a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareCapture(input, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(FakeWorker.instances).toHaveLength(0);
});

it('retires all callback and abort-listener roots across repeated capture settlements', async () => {
  for (let index = 0; index < 128; index++) {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = prepareCapture(input, controller.signal);
    const worker = current();
    const staleMessage = worker.onmessage!;
    expect(FakeWorker.instances.filter((entry) => entry.terminated === 0)).toHaveLength(1);
    if (index % 3 === 0) {
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await rejected;
    } else if (index % 3 === 1) {
      const rejected = expect(pending).rejects.toThrow('could not finish');
      worker.onerror!();
      await rejected;
    } else {
      worker.onmessage!({ data: { operation: 'prepare', ok: true, value: '{}' } } as MessageEvent);
      await pending;
    }
    staleMessage({ data: { operation: 'prepare', ok: true, value: '{}' } } as MessageEvent);
    expect(worker.terminated).toBe(1);
    expect(FakeWorker.instances.filter((entry) => entry.terminated === 0)).toHaveLength(0);
    expect(
      FakeWorker.instances.every(
        (entry) => !entry.onmessage && !entry.onerror && !entry.onmessageerror,
      ),
    ).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    add.mockRestore();
    remove.mockRestore();
  }
});

it('v2 operations terminate their owned worker before returning or aborting reconstruction', async () => {
  const signal = new AbortController().signal;
  const prepared = prepareStoredCapture(input, signal);
  let worker = current();
  expect(worker.posted).toEqual({ operation: 'prepare-stored', input });
  worker.onmessage?.({
    data: { operation: 'prepare-stored', ok: true, value: 'url-free' },
  } as MessageEvent);
  expect(await prepared).toBe('url-free');
  expect(worker.terminated).toBe(1);
  const parsed = parseStoredCapture('url-free', signal);
  worker = current();
  const ref = {
    ...(await checkpointFixture()),
    schemaVersion: 2 as const,
    reviewDigest: '0'.repeat(64),
  };
  worker.onmessage?.({ data: { operation: 'parse-stored', ok: true, value: ref } } as MessageEvent);
  expect(await parsed).toEqual(ref);
  expect(worker.terminated).toBe(1);
  const controller = new AbortController();
  const restoring = restoreReferencedCapture(
    ref as unknown as Parameters<typeof restoreReferencedCapture>[0],
    ref.review,
    controller.signal,
  );
  worker = current();
  const late = worker.onmessage;
  const aborted = expect(restoring).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await aborted;
  expect(worker.terminated).toBe(1);
  late?.({
    data: { operation: 'restore-reference', ok: true, value: await checkpointFixture() },
  } as MessageEvent);
  expect(worker.terminated).toBe(1);
});

it('initial progress worker returns only the full seed plus bounded identity and terminates before settlement', async () => {
  const pending = prepareInitialProgressCapture(input, new AbortController().signal),
    worker = current();
  expect(worker.posted).toEqual({ operation: 'prepare-progress-initial', input });
  const value = {
    checkpoint: 'full v2 seed',
    reviewDigest: 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
  };
  worker.onmessage?.({
    data: { operation: 'prepare-progress-initial', ok: true, value },
  } as MessageEvent);
  expect(await pending).toEqual(value);
  expect(worker.terminated).toBe(1);
  const malformed = prepareInitialProgressCapture(input, new AbortController().signal),
    other = current();
  const rejected = expect(malformed).rejects.toThrow('reply is invalid');
  other.onmessage?.({
    data: {
      operation: 'prepare-progress-initial',
      ok: true,
      value: { ...value, review: 'forbidden' },
    },
  } as MessageEvent);
  await rejected;
  expect(other.terminated).toBe(1);
});

it('packed parse is explicit while legacy consumer refuses v3 and terminates', async () => {
  const { preparePackedScanCheckpoint } = await import('../../src/discovery/scan-checkpoint');
  const { checkpointProviders } = await import('../discovery/helpers/scan-checkpoint');
  const c = await checkpointFixture();
  const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = c;
  const packed = await preparePackedScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  const legacy = parseStoredCapture('wire', new AbortController().signal),
    old = current();
  old.onmessage?.({ data: { operation: 'parse-stored', ok: true, value: packed } } as MessageEvent);
  await expect(legacy).rejects.toThrow('reply is invalid');
  expect(old.terminated).toBe(1);
  const pending = parseStoredCaptureWithPacked('wire', new AbortController().signal),
    worker = current();
  expect(worker.posted).toEqual({ operation: 'parse-stored-packed', input: 'wire' });
  worker.onmessage?.({
    data: { operation: 'parse-stored-packed', ok: true, value: packed },
  } as MessageEvent);
  expect(await pending).toEqual(packed);
  expect(worker.terminated).toBe(1);
  const controller = new AbortController(),
    restore = restorePackedCapture(packed, c.review, controller.signal),
    restorer = current();
  expect(restorer.posted).toEqual({
    operation: 'restore-packed-reference',
    input: { reference: packed, review: c.review },
  });
  controller.abort();
  await expect(restore).rejects.toMatchObject({ name: 'AbortError' });
  expect(restorer.terminated).toBe(1);
});
it('capability parsing enables packed only for exact additive version3 acknowledgement', () => {
  expect(parseScanCheckpointCapabilities({ schemaVersion: 1, advance: 1 })).toEqual({
    advance: true,
    packedReference: false,
  });
  expect(
    parseScanCheckpointCapabilities({ schemaVersion: 1, advance: 1, packedReference: 3 }),
  ).toEqual({ advance: true, packedReference: true });
  for (const bad of [
    null,
    {},
    [],
    { schemaVersion: 1, packedReference: 3 },
    { schemaVersion: 1, advance: 1, packedReference: 2 },
    { schemaVersion: 1, advance: 1, packedReference: 3, unknown: 1 },
    Object.create({ schemaVersion: 1, advance: 1, packedReference: 3 }),
  ])
    expect(parseScanCheckpointCapabilities(bad)).toEqual({
      advance: false,
      packedReference: false,
    });
});

it('packed producer worker operation is explicit and owned before reply', async () => {
  const pending = prepareInitialPackedProgressCapture(input, new AbortController().signal),
    worker = current();
  expect(worker.posted).toEqual({ operation: 'prepare-progress-initial-packed', input });
  const result = {
    checkpoint: '{"schemaVersion":3}',
    reviewDigest: 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
  };
  worker.onmessage?.({
    data: { operation: 'prepare-progress-initial-packed', ok: true, value: result },
  } as MessageEvent);
  expect(await pending).toEqual(result);
  expect(worker.terminated).toBe(1);
  const controller = new AbortController(),
    canceled = prepareInitialPackedProgressCapture(input, controller.signal),
    held = current();
  controller.abort();
  await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
  expect(held.terminated).toBe(1);
});

it.each(['restore-reference', 'restore-packed-reference'] as const)(
  '%s preserves only a typed allowlisted failure after retiring its worker',
  async (operation) => {
    const c = await checkpointFixture();
    const pending =
      operation === 'restore-reference'
        ? restoreReferencedCapture(c as never, c.review, new AbortController().signal)
        : restorePackedCapture(c as never, c.review, new AbortController().signal);
    const worker = current();
    worker.onmessage!({
      data: {
        operation,
        ok: false,
        reconstructionFailure: 'original-url-missing',
        error: 'secret URL',
      },
    } as MessageEvent);
    const failure: unknown = await pending.catch((error: unknown) => error);
    expect(scanReconstructionFailureCode(failure)).toBe('original-url-missing');
    expect(String(failure)).not.toContain('secret');
    expect(worker.terminated).toBe(1);
  },
);

it.each([
  { operation: 'restore-reference', ok: false, reconstructionFailure: 'https://secret.invalid' },
  {
    operation: 'restore-packed-reference',
    ok: false,
    reconstructionFailure: 'original-url-missing',
  },
  { operation: 'restore-reference', ok: 0, reconstructionFailure: 'original-url-missing' },
])('rejects forged restoration refusal generically and retires transport', async (reply) => {
  const c = await checkpointFixture();
  const pending = restoreReferencedCapture(c as never, c.review, new AbortController().signal);
  const worker = current();
  worker.onmessage!({ data: reply } as MessageEvent);
  const failure: unknown = await pending.catch((error: unknown) => error);
  expect(scanReconstructionFailureCode(failure)).toBeNull();
  expect(String(failure)).toContain('could not be prepared or read');
  expect(String(failure)).not.toContain('secret');
  expect(worker.terminated).toBe(1);
});

it('does not classify a preparation failure as restoration', async () => {
  const pending = prepareCapture(input, new AbortController().signal);
  const worker = current();
  worker.onmessage!({
    data: { operation: 'prepare', ok: false, reconstructionFailure: 'original-url-missing' },
  } as MessageEvent);
  const failure: unknown = await pending.catch((error: unknown) => error);
  expect(scanReconstructionFailureCode(failure)).toBeNull();
  expect(worker.terminated).toBe(1);
});
