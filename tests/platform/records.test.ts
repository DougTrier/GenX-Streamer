import { beforeEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, isTauri: () => true }));
import {
  readRecordPair,
  readScanHealth,
  writeRecord,
  writeRecordPair,
  writeHealth,
  isRecordRevisionConflict,
  readScanCheckpoint,
  writeScanCheckpoint,
  discardScanCheckpoint,
} from '../../src/platform/records';
import { isNativeWriteNotCommittedError } from '../../src/platform/native-write-refusal';
const pair = {
  catalog: '{}',
  preferences: '{}',
  health: '{"schemaVersion":1,"records":[]}',
  expectedCatalogRevision: '7',
  expectedHealthRevision: '3',
};
const receipt = { committed: true, catalogRevision: '8', healthRevision: '3' };
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  bridge.invoke.mockReset();
});
describe('native record transaction bridge', () => {
  it('preserves only joined known noncommit write refusals through redacted record failure translation', async () => {
    for (const code of ['application-closing', 'canceled']) {
      bridge.invoke.mockRejectedValue(code);
      expect(
        isNativeWriteNotCommittedError(
          await writeRecord('preferences', '{}').catch((error) => error),
        ),
      ).toBe(true);
      expect(
        isNativeWriteNotCommittedError(await writeRecordPair(pair).catch((error) => error)),
      ).toBe(true);
    }
    bridge.invoke.mockRejectedValue(new Error('application-closing'));
    const error = await writeRecord('preferences', '{}').catch((error) => error);
    expect(isNativeWriteNotCommittedError(error)).toBe(false);
    expect(error.message).toContain('Storage could not confirm');
  });
  it('maps the actual checkpoint stale code exactly without leaking arbitrary diagnostics', async () => {
    bridge.invoke.mockRejectedValue('scan-checkpoint-revision-stale');
    await expect(writeScanCheckpoint('{}', '7', '0')).rejects.toMatchObject({
      name: 'RecordRevisionConflictError',
      message: 'Saved checkpoint changed. Review again before saving.',
    });
    const secret = 'https://private.invalid/token?scan-checkpoint-revision-stale';
    bridge.invoke.mockRejectedValue(secret);
    const error = await writeScanCheckpoint('{}', '7', '0').catch((failure: unknown) => failure);
    expect(isRecordRevisionConflict(error)).toBe(false);
    expect((error as Error).message).not.toContain(secret);
  });
  it('reads scan health with atomic revisions without cloning catalog or preferences', async () => {
    const health = { health: pair.health, catalogRevision: '7', healthRevision: '3' };
    bridge.invoke.mockResolvedValue({
      ...health,
      get catalog() {
        throw new Error('Catalog must not cross scan health boundary.');
      },
      get preferences() {
        throw new Error('Preferences must not cross scan health boundary.');
      },
    });
    expect(await readScanHealth()).toEqual(health);
    expect(bridge.invoke).toHaveBeenCalledWith('read_scan_health');
    for (const invalid of [
      null,
      {},
      { ...health, health: 5 },
      { ...health, catalogRevision: '-1' },
      { ...health, healthRevision: '9223372036854775808' },
    ]) {
      bridge.invoke.mockResolvedValue(invalid);
      await expect(readScanHealth()).rejects.toThrow();
    }
  });
  it('classifies only exact native revision refusals, never arbitrary diagnostics or missing receipts', async () => {
    for (const code of ['health-revision-stale', 'catalog-revision-stale']) {
      bridge.invoke.mockRejectedValue(code);
      const error = await writeHealth(pair.health, '7', '3').catch((reason: unknown) => reason);
      expect(isRecordRevisionConflict(error)).toBe(true);
    }
    for (const diagnostic of [
      'https://provider.invalid/secret?code=health-revision-stale',
      'prefix health-revision-stale',
      { message: 'health-revision-stale' },
      'health-revision-required',
    ]) {
      bridge.invoke.mockRejectedValue(diagnostic);
      const error = await writeHealth(pair.health, '7', '3').catch((reason: unknown) => reason);
      expect(isRecordRevisionConflict(error)).toBe(false);
      expect(error).toMatchObject({
        message: expect.stringContaining('Storage could not confirm'),
      });
      expect(String(error)).not.toContain('provider.invalid');
    }
    bridge.invoke.mockResolvedValue({
      committed: true,
      catalogRevision: 'invalid',
      healthRevision: '3',
    });
    const invalid = await writeHealth(pair.health, '7', '3').catch((error: unknown) => error);
    expect(isRecordRevisionConflict(invalid)).toBe(false);
    const canceled = new AbortController();
    canceled.abort();
    const abort = await writeHealth(pair.health, '7', '3', canceled.signal).catch(
      (error: unknown) => error,
    );
    expect(isRecordRevisionConflict(abort)).toBe(false);
  });
  it('awaits health-only native settlement and preserves a committed receipt after abort', async () => {
    const save = deferred(),
      cancel = deferred();
    bridge.invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : save.promise,
    );
    const controller = new AbortController();
    let settled = false;
    const pending = writeHealth(pair.health, '7', '3', controller.signal);
    void pending.then(() => {
      settled = true;
    });
    controller.abort();
    save.resolve(receipt);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(undefined);
    expect(await pending).toEqual(receipt);
  });
  it('publishes health-only with both explicit guards and no catalog/preferences fields', async () => {
    bridge.invoke.mockResolvedValue(receipt);
    expect(await writeHealth(pair.health, '7', '3')).toEqual(receipt);
    expect(bridge.invoke).toHaveBeenCalledWith('write_health', {
      health: pair.health,
      expectedCatalogRevision: '7',
      expectedHealthRevision: '3',
      requestId: expect.any(String),
    });
    bridge.invoke.mockClear();
    await expect(writeRecordPair({ ...pair, expectedHealthRevision: undefined })).rejects.toThrow(
      'both saved revisions',
    );
    await expect(writeHealth(pair.health, '7', '03')).rejects.toThrow('revision');
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('reads one coherent bounded pair with decimal revisions', async () => {
    const saved = {
      catalog: pair.catalog,
      preferences: pair.preferences,
      health: pair.health,
      catalogRevision: '9007199254740993',
      healthRevision: '3',
    };
    bridge.invoke.mockResolvedValue(saved);
    expect(await readRecordPair()).toMatchObject(saved);
    expect(bridge.invoke).toHaveBeenCalledWith('read_record_pair');
    bridge.invoke.mockResolvedValue({ ...saved, catalogRevision: '01' });
    await expect(readRecordPair()).rejects.toThrow();
    bridge.invoke.mockResolvedValue({ ...saved, health: undefined });
    await expect(readRecordPair()).rejects.toThrow();
  });
  it('passes separate health/CAS and returns the actual paired receipt', async () => {
    bridge.invoke.mockResolvedValue(receipt);
    expect(await writeRecordPair(pair)).toEqual(receipt);
    expect(bridge.invoke).toHaveBeenCalledWith('write_record_pair', {
      ...pair,
      requestId: expect.any(String),
    });
  });
  it('single catalog publication never rewrites preferences', async () => {
    bridge.invoke.mockResolvedValue(receipt);
    expect(await writeRecord('catalog', '{}', undefined, '7')).toEqual(receipt);
    expect(bridge.invoke).toHaveBeenCalledWith('write_record_receipt', {
      name: 'catalog',
      contents: '{}',
      expectedCatalogRevision: '7',
      requestId: expect.any(String),
    });
  });
  it('refuses pre-canceled and oversized input before invocation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(writeRecordPair(pair, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      writeRecordPair({ ...pair, health: 'x'.repeat(20 * 1024 * 1024 + 1) }),
    ).rejects.toThrow('bounds');
    await expect(writeRecord('catalog', '{}', undefined, '-1')).rejects.toThrow();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('joins actual save and cancellation settlement before reporting canceled', async () => {
    const save = deferred(),
      cancel = deferred();
    bridge.invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : save.promise,
    );
    const controller = new AbortController();
    let settled = false;
    const pending = writeRecordPair(pair, controller.signal);
    const captured = pending.catch((error: unknown) => error);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    save.reject(new Error('Controlled native failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(undefined);
    expect(await captured).toMatchObject({ name: 'AbortError' });
    expect(bridge.invoke).toHaveBeenCalledWith('cancel_playlist', {
      requestId: expect.any(String),
    });
  });
  it('keeps a durable commit successful despite late cancellation', async () => {
    const save = deferred();
    bridge.invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist' ? Promise.resolve() : save.promise,
    );
    const controller = new AbortController();
    const pending = writeRecordPair(pair, controller.signal);
    controller.abort();
    save.resolve(receipt);
    expect(await pending).toEqual(receipt);
  });
  it('does not label a malformed commit reply canceled or expose raw provider diagnostics', async () => {
    const save = deferred();
    bridge.invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist' ? Promise.resolve() : save.promise,
    );
    const controller = new AbortController();
    const pending = writeRecordPair(pair, controller.signal);
    controller.abort();
    save.resolve({ committed: true, catalogRevision: 'broken', healthRevision: '3' });
    await expect(pending).rejects.not.toMatchObject({ name: 'AbortError' });
    bridge.invoke.mockRejectedValue(new Error('Controlled private diagnostic'));
    const failure = await writeRecordPair(pair).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: expect.stringContaining('Storage could not confirm'),
    });
  });
});

describe('native operational scan checkpoint bridge', () => {
  it('uses guarded dedicated commands and requires a checkpoint revision receipt', async () => {
    bridge.invoke.mockResolvedValue({ ...receipt, checkpointRevision: '4' });
    expect((await writeScanCheckpoint('{"schemaVersion":1}', '7', '3')).checkpointRevision).toBe(
      '4',
    );
    expect(bridge.invoke).toHaveBeenCalledWith(
      'write_scan_checkpoint',
      expect.objectContaining({
        checkpoint: '{"schemaVersion":1}',
        expectedCatalogRevision: '7',
        expectedCheckpointRevision: '3',
        requestId: expect.any(String),
      }),
    );
    await discardScanCheckpoint('owned-job', '7', '4');
    expect(bridge.invoke).toHaveBeenCalledWith(
      'discard_scan_checkpoint',
      expect.objectContaining({
        jobId: 'owned-job',
        expectedCatalogRevision: '7',
        expectedCheckpointRevision: '4',
      }),
    );
    bridge.invoke.mockResolvedValue(receipt);
    await expect(writeScanCheckpoint('{}', '7', '4')).rejects.toThrow('revision');
  });
  it('preserves omission on ordinary writes and passes validated tagged paired mutation only with both guards', async () => {
    bridge.invoke.mockResolvedValue({ ...receipt, checkpointRevision: '4' });
    await writeRecordPair(pair);
    expect(bridge.invoke.mock.calls[0][1]).not.toHaveProperty('scanCheckpoint');
    await writeRecordPair({
      ...pair,
      scanCheckpoint: { kind: 'save', checkpoint: '{}' },
      expectedCheckpointRevision: '3',
    });
    expect(bridge.invoke.mock.calls[1][1]).toMatchObject({
      scanCheckpoint: { kind: 'save', checkpoint: '{}' },
      expectedCheckpointRevision: '3',
    });
    bridge.invoke.mockClear();
    await expect(
      writeRecordPair({ ...pair, scanCheckpoint: { kind: 'save', checkpoint: '{}' } }),
    ).rejects.toThrow('both');
    await expect(
      writeRecordPair({
        ...pair,
        scanCheckpoint: { kind: 'discard', jobId: 'owned', checkpoint: 'unexpected' } as never,
        expectedCheckpointRevision: '3',
      }),
    ).rejects.toThrow();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('reads only bounded operational state and classifies exact checkpoint conflicts', async () => {
    bridge.invoke.mockResolvedValue({
      checkpoint: null,
      checkpointStatus: 'absent',
      jobId: null,
      checkpointRevision: '0',
      catalogRevision: '7',
    });
    expect(await readScanCheckpoint()).toEqual({
      checkpoint: null,
      checkpointStatus: 'absent',
      jobId: null,
      checkpointRevision: '0',
      catalogRevision: '7',
    });
    bridge.invoke.mockRejectedValue('checkpoint-revision-stale');
    expect(
      isRecordRevisionConflict(await writeScanCheckpoint('{}', '7', '0').catch((error) => error)),
    ).toBe(true);
    bridge.invoke.mockRejectedValue('https://private.invalid/?checkpoint-revision-stale');
    const error = await writeScanCheckpoint('{}', '7', '0').catch((error) => error);
    expect(isRecordRevisionConflict(error)).toBe(false);
    expect(String(error)).not.toContain('private.invalid');
  });
});
