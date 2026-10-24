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
import { defaultPreferences } from '../../src/preferences';
import { createOwnedSelectionActor } from '../../src/discovery/selection-session-worker';
import {
  createSelectionSession,
  type SelectionSessionCommand,
  type SelectionSessionReply,
  type SelectionWindowRequest,
} from '../../src/discovery/selection-session';
import { prepareOwnedNativeScanBatch } from '../../src/discovery/prepare-selection';
import {
  validatePreparedSelectionWindow,
  validateSelectionWindowRequest,
  admitSelectionWindowBytes,
  isSelectionWindowSizeError,
} from '../../src/discovery/selection-window';
import { applyCatalogPatch } from '../../src/discovery/catalog-patch';
import { boundedJsonUtf8Bytes } from '../../src/data-transfer/json-byte-admission';
import { MAX_PLAYLIST_BYTES } from '../../src/catalog/parser';
import type { CatalogRecord } from '../../src/catalog';

const source = {
  id: 's',
  name: 'Public',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog',
};
const seed = () => ({
  catalog: { schemaVersion: 1 as const, sources: [source], channels: [] },
  catalogRevision: '10',
  scope: [{ source, fingerprint: 'scope' }],
});
function input(start = 0, chunks = 4, size = 64, revision = '10'): SelectionWindowRequest {
  return {
    schemaVersion: 1,
    expectedCatalogRevision: revision,
    preferences: defaultPreferences(),
    chunks: Array.from({ length: chunks }, (_, c) => ({
      selection: {
        sessionRevision: 'logical',
        failedSourceIds: [],
        sources: [
          {
            sourceId: 's',
            fingerprint: 'scope',
            candidates: Array.from({ length: size }, (_, i) => {
              const id = start + c * size + i;
              return {
                sourceId: 's',
                providerId: `p-${id}`,
                name: `Channel ${id}`,
                category: 'News',
                urls: [`https://fixture.invalid/${id}`],
              };
            }),
          },
        ],
      },
    })),
  };
}
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
class LinkedWorker {
  onmessage: ((event: MessageEvent<SelectionSessionReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  actor: ReturnType<typeof createOwnedSelectionActor> | null = null;
  bootstraps = 0;
  maxSelection = 0;
  stopped = false;
  constructor(readonly bootstrapGate = Promise.resolve()) {}
  postMessage(raw: SelectionSessionCommand) {
    const message = structuredClone(raw);
    if (message.kind === 'cancel') {
      this.actor?.cancel();
      return;
    }
    const work = (async () => {
      if (message.kind === 'bootstrap') {
        this.bootstraps++;
        await this.bootstrapGate;
        this.actor = createOwnedSelectionActor(message.bootstrap);
        return;
      }
      if (!this.actor) throw new Error('fixture-not-ready');
      if (message.kind === 'prepare-window') {
        this.maxSelection = Math.max(
          this.maxSelection,
          message.input.chunks.reduce(
            (n, c) => n + c.selection.sources.reduce((m, s) => m + s.candidates.length, 0),
            0,
          ),
        );
        return this.actor.prepareWindow(message.input);
      }
      if (message.kind === 'ack-window') {
        this.actor.acknowledgeWindow(message.preparationId, message.receipt);
        return;
      }
      if (message.kind === 'quarantine') {
        this.actor.quarantine();
        return;
      }
      if (message.kind === 'dispose') {
        await this.actor.dispose();
        return;
      }
      throw new Error('fixture-command');
    })();
    void work.then(
      (value) =>
        this.onmessage?.({
          data: {
            requestId: message.requestId,
            ok: true,
            ...(value === undefined ? {} : { value }),
          },
        } as MessageEvent<SelectionSessionReply>),
      () =>
        this.onmessage?.({
          data: { requestId: message.requestId, ok: false, code: 'selection-session-refused' },
        } as MessageEvent<SelectionSessionReply>),
    );
  }
  terminate() {
    this.stopped = true;
  }
}
it('one window plans four exact sequential64 patches but advances only after one durable ACK', async () => {
  const actor = createOwnedSelectionActor(seed());
  const request = input();
  const result = await actor.prepareWindow(request);
  expect(result.totalSelectionCount).toBe(256);
  expect(
    result.chunks.map((chunk) => [
      chunk.catalogPatch.baseChannelCount,
      chunk.catalogPatch.finalChannelCount,
    ]),
  ).toEqual([
    [0, 64],
    [64, 128],
    [128, 192],
    [192, 256],
  ]);
  let base: CatalogRecord = seed().catalog;
  for (const chunk of result.chunks) base = applyCatalogPatch(base, chunk.catalogPatch, [source]);
  expect(base.channels).toHaveLength(256);
  await expect(actor.prepareWindow(input(256))).rejects.toThrow('refused');
  actor.acknowledgeWindow(result.preparationId, {
    committed: true,
    catalogRevision: '11',
    healthRevision: '1',
  });
  const next = await actor.prepareWindow(input(256, 1, 1, '11'));
  expect(next.chunks[0].catalogPatch.baseChannelCount).toBe(256);
  await actor.dispose();
});
it('hundreds of logical chunks use one bootstrap and bounded pending envelopes', async () => {
  const worker = new LinkedWorker(),
    owner = createSelectionSession(seed(), () => worker);
  let revision = 10;
  for (let i = 0; i < 50; i++) {
    const result = await owner.prepareWindow(
      input(i * 4, 4, 1, String(revision)),
      new AbortController().signal,
    );
    expect(result.chunks).toHaveLength(4);
    await owner.acknowledgeWindow(result.preparationId, {
      committed: true,
      catalogRevision: String(++revision),
      healthRevision: String(i),
    });
  }
  expect(worker.bootstraps).toBe(1);
  expect(worker.maxSelection).toBe(4);
  await owner.dispose();
  expect(worker.stopped).toBe(true);
});
it('captures bounded caller input before held bootstrap and returned mutations cannot change pending mirror', async () => {
  const gate = held(),
    worker = new LinkedWorker(gate.promise),
    owner = createSelectionSession(seed(), () => worker);
  const request = input(0, 1, 1);
  const work = owner.prepareWindow(request, new AbortController().signal);
  request.chunks[0].selection.sources[0].candidates[0].name = 'Mutated';
  request.preferences.favorites.push('later');
  gate.release();
  const result = await work;
  expect(result.chunks[0].catalogPatch.channels[0].name).toBe('Channel 0');
  expect(result.nextPreferences.favorites).toEqual([]);
  result.chunks[0].catalogPatch.channels[0].name = 'Returned mutation';
  await owner.acknowledgeWindow(result.preparationId, {
    committed: true,
    catalogRevision: '11',
    healthRevision: '0',
  });
  const next = await owner.prepareWindow(input(0, 1, 1, '11'), new AbortController().signal);
  expect(next.chunks[0].catalogPatch.channels).toHaveLength(0);
  await owner.dispose();
});
it('same authoritative revision accepts a true no-op window; forged or lost ACK quarantines', async () => {
  const actor = createOwnedSelectionActor(seed());
  const first = await actor.prepareWindow(input(0, 1, 1));
  actor.acknowledgeWindow(first.preparationId, {
    committed: true,
    catalogRevision: '11',
    healthRevision: '0',
  });
  const noop = await actor.prepareWindow(input(0, 1, 1, '11'));
  expect(noop.chunks[0].catalogPatch.channels).toHaveLength(0);
  actor.acknowledgeWindow(noop.preparationId, {
    committed: true,
    catalogRevision: '11',
    healthRevision: '1',
  });
  const pending = await actor.prepareWindow(input(1, 1, 1, '11'));
  expect(() =>
    actor.acknowledgeWindow(pending.preparationId, {
      committed: true,
      catalogRevision: '13',
      healthRevision: '2',
    }),
  ).toThrow();
  await expect(actor.prepareWindow(input(2, 1, 1, '11'))).rejects.toThrow();
  await actor.dispose();
});
it('cancel joins held preparation and refuses the whole provisional window without advancing base', async () => {
  const gate = held(),
    entered = held();
  let calls = 0;
  const actor = createOwnedSelectionActor(seed(), async (...args) => {
    if (++calls === 2) {
      entered.release();
      await gate.promise;
    }
    return prepareOwnedNativeScanBatch(...args);
  });
  const abort = new AbortController(),
    work = actor.prepareWindow(input(0, 2, 1), abort.signal);
  const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  abort.abort();
  gate.release();
  await refused;
  const retry = await actor.prepareWindow(input(0, 1, 1));
  expect(retry.chunks[0].catalogPatch.baseChannelCount).toBe(0);
  await actor.dispose();
});
it('invalid fourth chunk and malformed result prefixes refuse whole admission', async () => {
  const actor = createOwnedSelectionActor(seed());
  const bad = input(0, 4, 1);
  bad.chunks[3].selection.sources[0].fingerprint = 'foreign';
  await expect(actor.prepareWindow(bad)).rejects.toThrow();
  const good = await actor.prepareWindow(input(0, 1, 1));
  const malformed = structuredClone(good);
  malformed.chunks = [
    ...malformed.chunks,
    {
      ...malformed.chunks[0],
      catalogPatch: { ...malformed.chunks[0].catalogPatch, baseChannelCount: 0 },
    },
  ];
  expect(() => validatePreparedSelectionWindow(malformed, [source])).toThrow();
  await actor.dispose();
});
it('legacy actor preparation still refuses65 and new windows refuse a fifth chunk or byte overflow', async () => {
  const actor = createOwnedSelectionActor(seed());
  await expect(actor.prepareWindow(input(0, 5, 1))).rejects.toThrow();
  await expect(actor.prepareWindow(input(0, 1, 65))).rejects.toThrow();
  const big = input(0, 4, 64);
  for (const chunk of big.chunks)
    for (const candidate of chunk.selection.sources[0].candidates)
      candidate.urls = Array.from(
        { length: 16 },
        () => 'https://fixture.invalid/' + 'x'.repeat(16000),
      );
  await expect(actor.prepareWindow(big)).rejects.toThrow();
  const legacy = input(0, 1, 65).chunks[0];
  await expect(
    actor.prepare({ ...legacy, preferences: defaultPreferences(), expectedCatalogRevision: '10' }),
  ).rejects.toThrow();
  await actor.dispose();
});

it('strips repeated full reconciliation scopes before wire size admission and keeps cached variants', async () => {
  const variants = {
    sourceId: 's',
    ambiguousProviderKeys: [],
    ambiguousMetadataKeys: Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify(['s', `Historical ${i} ${'x'.repeat(1200)}`, 'News', '']),
    ),
  };
  expect(boundedJsonUtf8Bytes([variants], MAX_PLAYLIST_BYTES)).toBeLessThan(MAX_PLAYLIST_BYTES);
  const request = input(0, 4, 1);
  for (const chunk of request.chunks) chunk.selection.sources[0].reconciliationScope = variants;
  expect(() => validateSelectionWindowRequest(request)).toThrow();
  const worker = new LinkedWorker();
  const owner = createSelectionSession(
    { ...seed(), reconciliationScopes: [variants] },
    () => worker,
  );
  const result = await owner.prepareWindow(request, new AbortController().signal);
  expect(result.chunks.map((chunk) => chunk.catalogPatch.finalChannelCount)).toEqual([1, 2, 3, 4]);
  await owner.acknowledgeWindow(result.preparationId, {
    committed: true,
    catalogRevision: '11',
    healthRevision: '0',
  });
  await owner.dispose();
  expect(worker.stopped).toBe(true);
});
it('brands only actual byte overflow, not count limits, invalid data, or forged errors', () => {
  let actual: unknown;
  try {
    admitSelectionWindowBytes('x'.repeat(MAX_PLAYLIST_BYTES));
  } catch (error) {
    actual = error;
  }
  expect(isSelectionWindowSizeError(actual)).toBe(true);
  expect(isSelectionWindowSizeError(new Error((actual as Error).message))).toBe(false);
  expect(isSelectionWindowSizeError(Object.create(Object.getPrototypeOf(actual)))).toBe(false);
  for (const value of [input(0, 5, 1), input(0, 1, 65)]) {
    let error: unknown;
    try {
      validateSelectionWindowRequest(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(isSelectionWindowSizeError(error)).toBe(false);
  }
  let invalid: unknown;
  try {
    admitSelectionWindowBytes({ field: undefined });
  } catch (error) {
    invalid = error;
  }
  expect(invalid).toBeInstanceOf(Error);
  expect(isSelectionWindowSizeError(invalid)).toBe(false);
});
it('oversized successful worker reply is branded, retires the worker, and cannot advance its mirror', async () => {
  const actor = createOwnedSelectionActor(seed());
  const result = await actor.prepareWindow(input(0, 1, 1));
  result.chunks[0].catalogPatch.channels[0].name = 'x'.repeat(MAX_PLAYLIST_BYTES);
  class OversizedReplyWorker extends LinkedWorker {
    override postMessage(message: SelectionSessionCommand) {
      if (message.kind === 'prepare-window') {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              requestId: message.requestId,
              ok: true,
              value: result,
            },
          } as MessageEvent<SelectionSessionReply>),
        );
        return;
      }
      super.postMessage(message);
    }
  }
  const worker = new OversizedReplyWorker(),
    owner = createSelectionSession(seed(), () => worker);
  const error = await owner
    .prepareWindow(input(0, 1, 1), new AbortController().signal)
    .catch((caught: unknown) => caught);
  expect(isSelectionWindowSizeError(error)).toBe(true);
  expect(worker.stopped).toBe(true);
  await expect(owner.prepareWindow(input(0, 1, 1), new AbortController().signal)).rejects.toThrow();
  await owner.dispose();
  await actor.dispose();
});
it('transport reconstructs size refusal only for a matched window operation and joins disposal', async () => {
  class RefusalWorker extends LinkedWorker {
    mode: 'window-size' | 'generic' | 'worker-error' = 'window-size';
    override postMessage(message: SelectionSessionCommand) {
      if (message.kind === 'prepare-window' || message.kind === 'prepare') {
        queueMicrotask(() => {
          if (this.mode === 'worker-error') {
            this.onerror?.();
            return;
          }
          this.onmessage?.({
            data: {
              requestId: message.requestId + 10000,
              ok: false,
              code: 'selection-window-size',
            },
          } as MessageEvent<SelectionSessionReply>);
          this.onmessage?.({
            data: {
              requestId: message.requestId,
              ok: false,
              code: this.mode === 'generic' ? 'selection-session-refused' : 'selection-window-size',
            },
          } as MessageEvent<SelectionSessionReply>);
        });
        return;
      }
      super.postMessage(message);
    }
  }
  for (const mode of ['window-size', 'generic', 'worker-error'] as const) {
    const worker = new RefusalWorker();
    worker.mode = mode;
    const owner = createSelectionSession(seed(), () => worker);
    const error = await owner
      .prepareWindow(input(0, 1, 1), new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(isSelectionWindowSizeError(error)).toBe(mode === 'window-size');
    await owner.dispose();
    expect(worker.stopped).toBe(true);
  }
  const worker = new RefusalWorker(),
    owner = createSelectionSession(seed(), () => worker);
  const request = input(0, 1, 1);
  const error = await owner
    .prepare(
      {
        ...request.chunks[0],
        preferences: request.preferences,
        expectedCatalogRevision: '10',
      },
      new AbortController().signal,
    )
    .catch((caught: unknown) => caught);
  expect(isSelectionWindowSizeError(error)).toBe(false);
  await owner.dispose();
});
