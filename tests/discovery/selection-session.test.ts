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
  createSelectionSession,
  type SelectionSessionCommand,
  type SelectionSessionReply,
  type SelectionSessionRequest,
} from '../../src/discovery/selection-session';
import { createOwnedSelectionActor } from '../../src/discovery/selection-session-worker';
import { prepareOwnedNativeScanBatch } from '../../src/discovery/prepare-selection';
import { createHealthObservation } from '../../src/discovery/health';
import type { Source } from '../../src/catalog';
const source: Source = {
  id: 'source',
  name: 'Public',
  kind: 'url',
  location: 'https://fixture.invalid/catalog',
};
const seed = () => ({
  catalog: { schemaVersion: 1 as const, sources: [source], channels: [] },
  catalogRevision: '10',
  scope: [{ source, fingerprint: 'captured' }],
});
const request = (i = 0, revision = '10'): SelectionSessionRequest => ({
  expectedCatalogRevision: revision,
  preferences: defaultPreferences(),
  selection: {
    sessionRevision: `logical-${i}`,
    failedSourceIds: [],
    sources: [
      {
        sourceId: source.id,
        fingerprint: 'captured',
        candidates: [
          {
            sourceId: source.id,
            providerId: `p${i}`,
            name: `Channel ${i}`,
            category: 'News',
            urls: [`https://fixture.invalid/${i}`],
          },
        ],
      },
    ],
  },
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
class Transport {
  onmessage: ((event: MessageEvent<SelectionSessionReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: SelectionSessionCommand[] = [];
  terminated = false;
  postMessage(message: SelectionSessionCommand) {
    this.messages.push(structuredClone(message));
  }
  terminate() {
    expect(this.onmessage).toBeNull();
    expect(this.onerror).toBeNull();
    expect(this.onmessageerror).toBeNull();
    this.terminated = true;
  }
  reply(id: number, value?: unknown) {
    this.onmessage?.({
      data: { requestId: id, ok: true, ...(value === undefined ? {} : { value }) },
    } as MessageEvent<SelectionSessionReply>);
  }
}
describe('owned selection preparation session', () => {
  it('captures only the bounded batch before awaiting a held bootstrap, isolating caller mutation', async () => {
    const worker = new Transport();
    const session = createSelectionSession(seed(), () => worker);
    const input = request();
    input.preferences.favorites = ['original'];
    const job = session.prepare(input, new AbortController().signal);
    input.selection.sources[0].candidates[0].name = 'mutated';
    input.preferences.favorites.push('later');
    expect(worker.messages).toHaveLength(1);
    worker.reply(1);
    await session.ready;
    await Promise.resolve();
    const command = worker.messages.find((m) => m.kind === 'prepare')!;
    if (command.kind === 'prepare') {
      expect(command.input.selection.sources[0].candidates[0].name).toBe('Channel 0');
      expect(command.input.preferences.favorites).toEqual(['original']);
    }
    if (command.kind !== 'prepare') throw new Error('Missing preparation');
    const actor = createOwnedSelectionActor(seed());
    const batch = await actor.prepare(command.input);
    worker.reply(command.requestId, batch);
    expect((await job).preparationId).toBe(batch.preparationId);
    const ack = session.acknowledge(batch.preparationId, {
      committed: true,
      catalogRevision: '11',
      healthRevision: '1',
    });
    actor.acknowledge(batch.preparationId, {
      committed: true,
      catalogRevision: '11',
      healthRevision: '1',
    });
    worker.reply(worker.messages.at(-1)!.requestId);
    await ack;
    const close = session.dispose();
    await Promise.resolve();
    await Promise.resolve();
    worker.reply(worker.messages.at(-1)!.requestId);
    await close;
    await actor.dispose();
  });
  it('joins held service work before termination, and quarantine blocks subsequent admission', async () => {
    const worker = new Transport();
    const session = createSelectionSession(seed(), () => worker);
    worker.reply(1);
    await session.ready;
    const job = session.prepare(request(), new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = worker.messages.at(-1)!.requestId;
    const rejected = expect(job).rejects.toThrow();
    const close = session.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.terminated).toBe(false);
    const dispose = worker.messages.find((m) => m.kind === 'dispose')!;
    worker.onmessage?.({
      data: { requestId: id, ok: false, code: 'canceled' },
    } as MessageEvent<SelectionSessionReply>);
    await rejected;
    worker.reply(dispose.requestId);
    await close;
    expect(worker.terminated).toBe(true);
  });
  it('advances one mirror across 400 real batches only after ACK, with small replies and current preferences', async () => {
    const actor = createOwnedSelectionActor(seed());
    for (let i = 0; i < 400; i++) {
      const input = request(i, String(10 + i));
      input.preferences.favorites = ['retained-favorite'];
      const batch = await actor.prepare(input);
      expect(batch.catalogPatch.baseChannelCount).toBe(i);
      expect(batch.catalogPatch.channels).toHaveLength(1);
      expect(batch.nextPreferences.favorites).toEqual(['retained-favorite']);
      expect(batch).not.toHaveProperty('catalogText');
      expect(batch).not.toHaveProperty('healthText');
      await expect(actor.prepare(input)).rejects.toThrow();
      actor.acknowledge(batch.preparationId, {
        committed: true,
        catalogRevision: String(11 + i),
        healthRevision: '1',
      });
    }
    await actor.dispose();
    await expect(actor.prepare(request())).rejects.toThrow();
  });
  it('preserves cached variant identity, removals/favorites and remaps only incoming reviewed health', async () => {
    const bootstrap = seed();
    const candidate = request().selection.sources[0].candidates[0];
    const channel = { ...candidate, id: 'retained' };
    const base = {
      ...bootstrap,
      catalog: {
        ...bootstrap.catalog,
        channels: [
          channel,
          { ...channel, id: 'other-variant', urls: ['https://fixture.invalid/other'] },
        ],
      },
      reconciliationScopes: [
        {
          sourceId: source.id,
          ambiguousProviderKeys: [JSON.stringify([source.id, 'p0'])],
          ambiguousMetadataKeys: [],
        },
      ],
    };
    const input = request();
    input.preferences.favorites = ['retained'];
    input.preferences.removedChannels = ['other-variant'];
    input.review = {
      platform: 'windows',
      observerProfile: 'inspection-v1',
      candidates: [
        {
          key: 'key',
          sourceId: source.id,
          sourceFingerprint: 'captured',
          sessionRevision: input.selection.sessionRevision,
          channel: candidate,
        },
      ],
      observations: [
        createHealthObservation(
          { channelId: 'key', sourceId: source.id, fingerprint: 'captured' },
          { platform: 'windows', observedAt: 100 },
          { kind: 'http', status: 200, contentRecognized: true },
        ),
      ],
    };
    const actor = createOwnedSelectionActor(base);
    const batch = await actor.prepare(input);
    expect(batch.catalogPatch.channels).toHaveLength(0);
    expect(batch.catalogPatch.finalChannelCount).toBe(2);
    expect(batch.incomingHealth).toHaveLength(1);
    expect(batch.incomingHealth[0].channelId).toBe('retained');
    expect(batch.nextPreferences.favorites).toEqual(['retained']);
    expect(batch.nextPreferences.removedChannels).toEqual(['other-variant']);
    actor.acknowledge(batch.preparationId, {
      committed: true,
      catalogRevision: '10',
      healthRevision: '1',
    });
    expect(() =>
      actor.acknowledge(batch.preparationId, {
        committed: true,
        catalogRevision: '10',
        healthRevision: '1',
      }),
    ).toThrow();
    await actor.dispose();
  });
  it('accepts a same-revision authoritative no-op and preserves existing channel identity', async () => {
    const actor = createOwnedSelectionActor(seed());
    const first = await actor.prepare(request());
    actor.acknowledge(first.preparationId, {
      committed: true,
      catalogRevision: '11',
      healthRevision: '1',
    });
    const next = await actor.prepare(request(0, '11'));
    expect(next.catalogPatch.channels).toHaveLength(0);
    actor.acknowledge(next.preparationId, {
      committed: true,
      catalogRevision: '11',
      healthRevision: '2',
    });
    const third = await actor.prepare(request(1, '11'));
    expect(third.catalogPatch.baseChannelCount).toBe(1);
    await actor.dispose();
  });
  it('reconstructs bootstrap variants and historical MIME without repeating descriptors', async () => {
    const bootstrap = seed();
    bootstrap.scope[0].source = { ...source, mediaMime: 'text/plain; charset=utf-8' };
    const variants = {
      sourceId: source.id,
      ambiguousProviderKeys: [JSON.stringify([source.id, 'p0'])],
      ambiguousMetadataKeys: [],
    };
    const input = request();
    const actor = createOwnedSelectionActor({ ...bootstrap, reconciliationScopes: [variants] });
    const actual = await actor.prepare(input);
    const expected = await prepareOwnedNativeScanBatch(
      bootstrap.catalog,
      input.preferences,
      {
        ...input.selection,
        sources: input.selection.sources.map((s) => ({ ...s, reconciliationScope: variants })),
      },
      bootstrap.scope,
      undefined,
      new AbortController().signal,
    );
    expect(actual.catalogPatch.channels.map((c) => ({ ...c, id: 'opaque' }))).toEqual(
      expected.catalogPatch.channels.map((c) => ({ ...c, id: 'opaque' })),
    );
    expect(actual.catalogPatch.sources).toEqual(expected.catalogPatch.sources);
    await actor.dispose();
  });
  it.each(['12', '9', 'invalid'])(
    'quarantines impossible or lost ACK revision %s',
    async (revision) => {
      const actor = createOwnedSelectionActor(seed());
      const batch = await actor.prepare(request());
      expect(() =>
        actor.acknowledge(batch.preparationId, {
          committed: true,
          catalogRevision: revision,
          healthRevision: '1',
        }),
      ).toThrow();
      await expect(actor.prepare(request())).rejects.toThrow();
      await actor.dispose();
    },
  );
  it('joins noncooperative preparation on cancellation/disposal and rejects late result', async () => {
    const gate = deferred();
    const actor = createOwnedSelectionActor(seed(), async (...args) => {
      await gate.promise;
      return prepareOwnedNativeScanBatch(...args);
    });
    const abort = new AbortController();
    const job = actor.prepare(request(), abort.signal);
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    let disposed = false;
    const close = actor.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.release();
    await rejected;
    await close;
    await expect(actor.prepare(request())).rejects.toThrow();
  });
  it('posts bootstrap once, strips full variants, and disposes after worker failure without a new request', async () => {
    const worker = new Transport();
    const session = createSelectionSession(seed(), () => worker);
    worker.reply(1);
    await session.ready;
    const input = request();
    input.selection.sources[0].reconciliationScope = {
      sourceId: source.id,
      ambiguousProviderKeys: [],
      ambiguousMetadataKeys: [],
    };
    const pending = session.prepare(input, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const message = worker.messages.at(-1)!;
    expect(message.kind).toBe('prepare');
    if (message.kind === 'prepare') {
      expect(message.input).not.toHaveProperty('catalog');
      expect(message.input.selection.sources[0]).not.toHaveProperty('reconciliationScope');
    }
    const rejected = expect(pending).rejects.toThrow();
    worker.onerror?.();
    await rejected;
    const count = worker.messages.length;
    await session.quarantine();
    await session.dispose();
    expect(worker.messages).toHaveLength(count);
    expect(worker.terminated).toBe(true);
  });
  it('rejects late successful preparation after abort and joins a disposal acknowledgement', async () => {
    const worker = new Transport();
    const session = createSelectionSession(seed(), () => worker);
    worker.reply(1);
    await session.ready;
    const abort = new AbortController();
    const job = session.prepare(request(), abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = worker.messages.at(-1)!.requestId;
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    worker.reply(id, { schemaVersion: 1, preparationId: 'late' });
    await rejected;
    expect(worker.messages.some((m) => m.kind === 'quarantine')).toBe(true);
    const close = session.dispose();
    await Promise.resolve();
    await Promise.resolve();
    const dispose = worker.messages.find((m) => m.kind === 'dispose')!;
    worker.reply(dispose.requestId);
    await close;
    expect(worker.terminated).toBe(true);
  });
  it('refuses an oversized batch before worker admission and malformed matched reply fails closed', async () => {
    const worker = new Transport();
    const session = createSelectionSession(seed(), () => worker);
    worker.reply(1);
    await session.ready;
    const input = request();
    input.selection.sources[0].candidates = Array.from(
      { length: 65 },
      () => input.selection.sources[0].candidates[0],
    );
    await expect(session.prepare(input, new AbortController().signal)).rejects.toThrow();
    expect(worker.messages).toHaveLength(1);
    const job = session.prepare(request(), new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const rejected = expect(job).rejects.toThrow();
    worker.reply(worker.messages.at(-1)!.requestId, {});
    await rejected;
    await session.dispose();
    expect(worker.terminated).toBe(true);
  });
});
