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
  createScanWindowCommitAdapter,
  validateScanWindow,
  type ScanWindow,
} from '../../src/platform/scan-window-commit';
import { validateScanBatch } from '../../src/platform/scan-batch-commit';

const source = {
  id: 'source',
  name: 'Fixture',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog',
};
const capability = { schemaVersion: 1, scanWindow: 1, maxChunks: 4 };
function window(): ScanWindow {
  return {
    schemaVersion: 1,
    authorizedSources: [source],
    nextPreferences: defaultPreferences(),
    expectedCatalogRevision: '2',
    expectedHealthRevision: '3',
    chunks: Array.from({ length: 4 }, (_, group) => ({
      catalogPatch: {
        schemaVersion: 1 as const,
        baseSourceCount: group ? 1 : 0,
        finalSourceCount: 1,
        baseChannelCount: group * 64,
        finalChannelCount: (group + 1) * 64,
        sources: group ? [] : [source],
        channels: Array.from({ length: 64 }, (_, index) => ({
          id: `channel-${group * 64 + index}`,
          sourceId: source.id,
          name: 'Fixture',
          category: 'News',
          urls: ['https://fixture.invalid/live'],
        })),
      },
      incomingHealth: [],
    })),
  };
}
describe('atomic scan window transport', () => {
  it('reports only fixed native refusal codes after the actual command settles', async () => {
    for (const raw of [
      'sqlite-storage-full',
      'sqlite-operation-failed',
      'https://private.invalid/?token=secret',
      { message: 'sqlite-storage-full' },
    ]) {
      const seen: string[] = [];
      const adapter = createScanWindowCommitAdapter({
        isNative: () => true,
        invoke: async (command) => {
          if (command === 'scan_window_capabilities') return capability;
          throw raw;
        },
      });
      await adapter.capabilities();
      await expect(
        adapter.commit(window(), undefined, (code) => {
          seen.push(code);
          throw Error('observer failure');
        }),
      ).rejects.toThrow('Existing channels are retained');
      expect(seen).toEqual([
        typeof raw === 'string' && raw.startsWith('sqlite-') ? raw : 'native-refusal-unclassified',
      ]);
    }
  });
  it('does not publish a refusal observation before held cancellation has joined', async () => {
    let rejectWrite!: (error: unknown) => void, finishCancel!: () => void;
    const write = new Promise((_, reject) => {
      rejectWrite = reject;
    });
    const cancel = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const seen: string[] = [];
    const adapter = createScanWindowCommitAdapter({
      isNative: () => true,
      invoke: async (command) =>
        command === 'scan_window_capabilities'
          ? capability
          : command === 'cancel_playlist'
            ? cancel
            : write,
    });
    await adapter.capabilities();
    const controller = new AbortController();
    const job = adapter.commit(window(), controller.signal, (code) => seen.push(code));
    const observed = job.catch((error: unknown) => error);
    controller.abort();
    rejectWrite('sqlite-storage-full');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
    finishCancel();
    expect(await observed).toBeInstanceOf(DOMException);
    // The canceled ownership path never forwards an error that could suggest safe replay.
    expect(seen).toEqual([]);
  });
  it('admits four ordered chunks without relaxing legacy 64 limits', () => {
    expect(validateScanWindow(window()).chunks).toHaveLength(4);
    const current = window();
    expect(() =>
      validateScanBatch({
        ...current,
        chunks: undefined,
        catalogPatch: {
          ...current.chunks[0].catalogPatch,
          channels: current.chunks.flatMap((chunk) => chunk.catalogPatch.channels),
        },
        incomingHealth: [],
      }),
    ).toThrow();
  });
  it('refuses hostile late chunks and aggregate bytes before native dispatch', async () => {
    const calls: string[] = [];
    const adapter = createScanWindowCommitAdapter({
      isNative: () => true,
      invoke: async (command) => {
        calls.push(command);
        return capability;
      },
    });
    await adapter.capabilities();
    for (const mutate of [
      (value: ScanWindow) => {
        value.chunks = [];
      },
      (value: ScanWindow) => {
        value.chunks = [...value.chunks, value.chunks[0]];
      },
      (value: ScanWindow) => {
        value.chunks[3].catalogPatch.baseChannelCount = 0;
      },
      (value: ScanWindow) => {
        value.chunks[3].catalogPatch.channels.push(value.chunks[0].catalogPatch.channels[0]);
      },
      (value: ScanWindow) => {
        value.chunks[3].catalogPatch.sources.push({ ...source, allowHttp: true });
      },
      (value: ScanWindow) => {
        (value as unknown as Record<string, unknown>).unexpected = 'x';
      },
      (value: ScanWindow) => {
        value.chunks[3].catalogPatch.channels[0].name = 'x'.repeat(20 * 1024 * 1024);
      },
    ]) {
      const value = window();
      mutate(value);
      await expect(adapter.commit(value)).rejects.toThrow();
    }
    expect(calls).toEqual(['scan_window_capabilities']);
  });
  it('falls back only for the exact missing capability response', async () => {
    const adapter = createScanWindowCommitAdapter({
      isNative: () => true,
      invoke: async () => {
        throw 'Command scan_window_capabilities not found';
      },
    });
    expect(await adapter.capabilities()).toBeNull();
    for (const value of [{ ...capability, extra: true }, { ...capability, maxChunks: 5 }, null]) {
      const hostile = createScanWindowCommitAdapter({
        isNative: () => true,
        invoke: async () => value,
      });
      await expect(hostile.capabilities()).rejects.toThrow();
    }
  });
  it('accepts only one scalar durable revision step and never replays an invalid ACK', async () => {
    for (const receipt of [
      { committed: true, catalogRevision: '2', healthRevision: '3' },
      { committed: true, catalogRevision: '3', healthRevision: '4' },
      { committed: true, catalogRevision: '6', healthRevision: '7' },
      { committed: false, catalogRevision: '3', healthRevision: '4' },
    ]) {
      const calls: string[] = [];
      const adapter = createScanWindowCommitAdapter({
        isNative: () => true,
        invoke: async (command) => {
          calls.push(command);
          return command === 'scan_window_capabilities' ? capability : receipt;
        },
      });
      await adapter.capabilities();
      if (receipt.committed && Number(receipt.catalogRevision) <= 3)
        expect(await adapter.commit(window())).toEqual(receipt);
      else await expect(adapter.commit(window())).rejects.toThrow();
      expect(calls).toEqual(['scan_window_capabilities', 'commit_scan_window']);
    }
  });
  it('joins held cancellation and retains a post-COMMIT ACK', async () => {
    let finishWrite!: (value: unknown) => void, finishCancel!: () => void;
    const write = new Promise((resolve) => {
      finishWrite = resolve;
    });
    const cancel = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const adapter = createScanWindowCommitAdapter({
      isNative: () => true,
      invoke: async (command) =>
        command === 'scan_window_capabilities'
          ? capability
          : command === 'cancel_playlist'
            ? cancel
            : write,
    });
    await adapter.capabilities();
    const abort = new AbortController();
    let settled = false;
    const job = adapter.commit(window(), abort.signal).finally(() => {
      settled = true;
    });
    abort.abort();
    finishWrite({ committed: true, catalogRevision: '3', healthRevision: '4' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCancel();
    expect(await job).toEqual({ committed: true, catalogRevision: '3', healthRevision: '4' });
  });
});
