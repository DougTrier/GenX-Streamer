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
import { defaultPreferences } from '../../src/preferences';
import {
  createScanBatchCommitAdapter,
  validateScanBatch,
  type ScanBatch,
} from '../../src/platform/scan-batch-commit';
import { invokeOwnedNative } from '../../src/platform/owned-native-command';

const source = {
  id: 'source',
  name: 'Fixture',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog',
  allowHttp: false,
};
const channel = {
  id: 'channel',
  sourceId: source.id,
  name: 'Fixture channel',
  category: 'News',
  urls: ['https://fixture.invalid/live'],
};
function batch(): ScanBatch {
  return {
    schemaVersion: 1,
    catalogPatch: {
      schemaVersion: 1,
      baseSourceCount: 0,
      finalSourceCount: 1,
      baseChannelCount: 0,
      finalChannelCount: 1,
      sources: [source],
      channels: [channel],
    },
    authorizedSources: [source],
    nextPreferences: defaultPreferences(),
    incomingHealth: [],
    expectedCatalogRevision: '2',
    expectedHealthRevision: '3',
  };
}
const receipt = { committed: true, catalogRevision: '2', healthRevision: '3' };
const capability = { schemaVersion: 1, scanBatch: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('native compact scan commit boundary', () => {
  it('maps both exact checkpoint conflict codes and redacts lookalike diagnostics', async () => {
    for (const code of ['checkpoint-revision-stale', 'scan-checkpoint-revision-stale']) {
      const adapter = createScanBatchCommitAdapter({
        isNative: () => true,
        invoke: async (command) => {
          if (command === 'scan_batch_capabilities') return capability;
          throw code;
        },
      });
      await adapter.capabilities();
      await expect(adapter.commit(batch())).rejects.toMatchObject({
        name: 'RecordRevisionConflictError',
        message: 'Saved checkpoint changed. Review again before saving.',
      });
    }
    const secret = 'https://private.invalid/token?scan-checkpoint-revision-stale';
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async (command) => {
        if (command === 'scan_batch_capabilities') return capability;
        throw secret;
      },
    });
    await adapter.capabilities();
    const failure = await adapter.commit(batch()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).not.toBe('RecordRevisionConflictError');
    expect((failure as Error).message).not.toContain(secret);
  });
  it('browser does not negotiate or dispatch native work', async () => {
    const adapter = createScanBatchCommitAdapter({
      isNative: () => false,
      invoke: async () => {
        throw new Error('Unexpected native invocation');
      },
    });
    expect(await adapter.capabilities()).toBeNull();
    await expect(adapter.commit(batch())).rejects.toThrow();
  });
  it('only exact known missing-command codes permit legacy fallback', async () => {
    for (const failure of ['scan-batch-unsupported', 'Command scan_batch_capabilities not found']) {
      const adapter = createScanBatchCommitAdapter({
        isNative: () => true,
        invoke: async () => {
          throw failure;
        },
      });
      expect(await adapter.capabilities()).toBeNull();
    }
    for (const value of [
      { schemaVersion: 1, scanBatch: 2 },
      { ...capability, url: 'https://private.invalid' },
      null,
    ]) {
      const adapter = createScanBatchCommitAdapter({
        isNative: () => true,
        invoke: async () => value,
      });
      await expect(adapter.capabilities()).rejects.toThrow('contract');
    }
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async () => {
        throw 'https://private.invalid/secret';
      },
    });
    await expect(adapter.capabilities()).rejects.toThrow('Existing channels are retained');
  });
  it('negotiates once and reads scalar revisions with a retained request ID only', async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      idFactory: () => 'owned',
      invoke: async (command, args) => {
        calls.push({ command, args });
        return command === 'scan_batch_capabilities'
          ? capability
          : { schemaVersion: 1, catalogRevision: '12', healthRevision: '4' };
      },
    });
    await adapter.capabilities();
    await adapter.capabilities();
    expect(await adapter.revisions()).toEqual({
      schemaVersion: 1,
      catalogRevision: '12',
      healthRevision: '4',
    });
    expect(calls).toEqual([
      { command: 'scan_batch_capabilities', args: { requestId: 'owned' } },
      { command: 'read_scan_commit_revisions', args: { requestId: 'owned' } },
    ]);
  });
  it('refuses hostile cardinality, source grants, unknown fields and missing mutation CAS before dispatch', () => {
    const current = batch();
    for (const value of [
      { ...current, catalogText: 'forbidden full catalog' },
      { ...current, catalogPatch: { ...current.catalogPatch, channels: Array(65).fill(channel) } },
      {
        ...current,
        catalogPatch: { ...current.catalogPatch, sources: [{ ...source, allowHttp: true }] },
      },
      {
        ...current,
        catalogPatch: { ...current.catalogPatch, channels: [{ ...channel, sourceId: 'foreign' }] },
      },
      { ...current, incomingHealth: Array(65).fill({}) },
      { ...current, expectedCheckpointRevision: '1' },
      { ...current, expectedCatalogRevision: '01' },
    ])
      expect(() => validateScanBatch(value)).toThrow();
  });
  it('validates unchanged semantic receipts and refuses stale or malformed receipts without fallback', async () => {
    for (const returned of [receipt, { ...receipt, catalogRevision: '4', healthRevision: '5' }]) {
      const adapter = createScanBatchCommitAdapter({
        isNative: () => true,
        invoke: async (command) => (command === 'scan_batch_capabilities' ? capability : returned),
      });
      await adapter.capabilities();
      expect(await adapter.commit(batch())).toEqual(returned);
    }
    for (const returned of [
      { ...receipt, catalogRevision: '1' },
      { ...receipt, committed: false },
      { ...receipt, extra: 'secret' },
    ]) {
      const commands: string[] = [];
      const adapter = createScanBatchCommitAdapter({
        isNative: () => true,
        invoke: async (command) => {
          commands.push(command);
          return command === 'scan_batch_capabilities' ? capability : returned;
        },
      });
      await adapter.capabilities();
      await expect(adapter.commit(batch())).rejects.toThrow();
      expect(commands).toEqual(['scan_batch_capabilities', 'commit_scan_batch']);
    }
  });
  it('requires a checkpoint receipt when a validated mutation was dispatched', async () => {
    const commands: string[] = [];
    const current = {
      ...batch(),
      scanCheckpoint: { kind: 'discard' as const, jobId: 'owned-job' },
      expectedCheckpointRevision: '7',
    };
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async (command) => {
        commands.push(command);
        return command === 'scan_batch_capabilities' ? capability : receipt;
      },
    });
    await adapter.capabilities();
    await expect(adapter.commit(current)).rejects.toThrow();
    expect(commands).toEqual(['scan_batch_capabilities', 'commit_scan_batch']);
  });
  it('admits exactly sixty-four canonical incoming records, captures immutable validated input, and rejects foreign health', () => {
    const current = batch();
    current.catalogPatch.channels = Array.from({ length: 64 }, (_, index) => ({
      ...channel,
      id: `channel-${index}`,
    }));
    current.catalogPatch.finalChannelCount = 64;
    current.incomingHealth = current.catalogPatch.channels.map((entry) => ({
      schemaVersion: 1,
      channelId: entry.id,
      sourceId: source.id,
      checkedUrlOrdinal: 0,
      targetFingerprint: 'a'.repeat(64),
      platform: 'Fixture',
      observerProfile: 'fixture-v1',
      observedAt: 100,
      verdict: 'Reachable',
      evidence: { kind: 'http', status: 200, contentRecognized: true },
      origin: 'local',
    }));
    const captured = validateScanBatch(current);
    expect(captured.incomingHealth).toHaveLength(64);
    current.catalogPatch.channels[0]!.name = 'Changed after capture';
    expect(captured.catalogPatch.channels[0]!.name).toBe('Fixture channel');
    current.incomingHealth[0]!.sourceId = 'foreign';
    expect(() => validateScanBatch(current)).toThrow();
  });
  it('dispatches health for an unchanged saved target absent from the patch, leaving full-catalog validation to native', async () => {
    const current = batch();
    current.catalogPatch = {
      schemaVersion: 1,
      baseSourceCount: 1,
      finalSourceCount: 1,
      baseChannelCount: 1,
      finalChannelCount: 1,
      sources: [],
      channels: [],
    };
    current.incomingHealth = [
      {
        schemaVersion: 1,
        channelId: channel.id,
        sourceId: source.id,
        checkedUrlOrdinal: 0,
        targetFingerprint: 'a'.repeat(64),
        platform: 'Fixture',
        observerProfile: 'fixture-v1',
        observedAt: 100,
        verdict: 'Reachable',
        evidence: { kind: 'http', status: 200, contentRecognized: true },
        origin: 'local',
      },
    ];
    const commands: string[] = [];
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async (command, args) => {
        commands.push(command);
        if (command === 'scan_batch_capabilities') return capability;
        expect((args?.batch as ScanBatch).catalogPatch.channels).toEqual([]);
        expect((args?.batch as ScanBatch).incomingHealth[0]?.channelId).toBe(channel.id);
        return receipt;
      },
    });
    await adapter.capabilities();
    expect(await adapter.commit(current)).toEqual(receipt);
    expect(commands).toEqual(['scan_batch_capabilities', 'commit_scan_batch']);
  });
  it('rejects unauthorized health sources, declared patch source mismatch, and malformed targets with static typed guidance', () => {
    const current = batch();
    const health = {
      schemaVersion: 1 as const,
      channelId: channel.id,
      sourceId: source.id,
      checkedUrlOrdinal: 0,
      targetFingerprint: 'a'.repeat(64),
      platform: 'Fixture',
      observerProfile: 'fixture-v1',
      observedAt: 100,
      verdict: 'Reachable' as const,
      evidence: { kind: 'http' as const, status: 200, contentRecognized: true },
      origin: 'local' as const,
    };
    const other = { ...source, id: 'other', location: 'https://fixture.invalid/other' };
    for (const record of [
      { ...health, sourceId: 'unknown' },
      { ...health, sourceId: other.id },
      { ...health, checkedUrlOrdinal: 16 },
      { ...health, targetFingerprint: '' },
      { ...health, url: 'https://private.invalid/secret' },
    ]) {
      const malformed = {
        ...current,
        authorizedSources: [source, other],
        incomingHealth: [record],
      };
      expect(() => validateScanBatch(malformed)).toThrowError(
        expect.objectContaining({
          name: 'ScanBatchValidationError',
          code: 'scan-batch-invalid',
        }),
      );
      try {
        validateScanBatch(malformed);
      } catch (error) {
        expect((error as Error).message).toContain('saved channels are retained');
        expect((error as Error).message).not.toContain('private.invalid');
      }
    }
  });
  it('late abort waits for actual invoke and cancellation settlement; durable COMMIT wins', async () => {
    const write = deferred<unknown>(),
      cancel = deferred<unknown>();
    let entered = false;
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async (command) => {
        if (command === 'scan_batch_capabilities') return capability;
        if (command === 'cancel_playlist') return cancel.promise;
        entered = true;
        return write.promise;
      },
    });
    await adapter.capabilities();
    const controller = new AbortController();
    let settled = false;
    const work = adapter.commit(batch(), controller.signal).finally(() => {
      settled = true;
    });
    expect(entered).toBe(true);
    controller.abort();
    cancel.reject(new Error('Controlled cancellation rejection'));
    await Promise.resolve();
    expect(settled).toBe(false);
    write.resolve(receipt);
    expect(await work).toEqual(receipt);
  });
  it('read abort cancellation failure waits for actual read then refuses ownership confirmation', async () => {
    const read = deferred<unknown>(),
      cancel = deferred<unknown>();
    const runtime = {
      invoke: async (command: string) =>
        command === 'cancel_playlist' ? cancel.promise : read.promise,
    };
    const controller = new AbortController();
    let settled = false;
    const work = invokeOwnedNative(
      runtime,
      'read',
      {},
      { signal: controller.signal, validate: (value) => value },
    ).finally(() => {
      settled = true;
    });
    const refused = expect(work).rejects.toThrow('cancellation could not be confirmed');
    controller.abort();
    cancel.reject(new Error('Controlled cancellation rejection'));
    await Promise.resolve();
    expect(settled).toBe(false);
    read.resolve({ revision: '1' });
    await refused;
  });
  it('pre-abort never dispatches and exact CAS errors stay redacted typed conflicts', async () => {
    let calls = 0;
    const adapter = createScanBatchCommitAdapter({
      isNative: () => true,
      invoke: async (command) => {
        calls++;
        if (command === 'scan_batch_capabilities') return capability;
        throw 'health-revision-stale';
      },
    });
    await adapter.capabilities();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.commit(batch(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
    await expect(adapter.commit(batch())).rejects.toMatchObject({
      name: 'RecordRevisionConflictError',
    });
  });
});
