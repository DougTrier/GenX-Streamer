import { expect, it } from 'vitest';
import { createScanPublicationProjectionReader } from '../../src/platform/scan-resume-publication-projection';
import type { BoundedScanAck } from '../../src/application/bounded-scan-resume';
const source = {
  id: 'source',
  name: 'Owned',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog',
};
const receipt: BoundedScanAck = {
  committed: true,
  planId: 'plan',
  catalogRevision: '3',
  healthRevision: '4',
  checkpointRevision: '5',
  counts: { total: 3, checked: 3, responded: 3, published: 3 },
  acknowledgedIndices: [0, 1, 2],
  publicationIndices: [0, 1, 2],
};
const row = (id: string) => ({
  id,
  sourceId: source.id,
  name: 'Channel ' + id,
  category: 'News',
  urls: ['https://fixture.invalid/' + id],
});
function runtime(change?: (reply: Record<string, unknown>) => void) {
  const calls: string[] = [];
  return {
    calls,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === 'cancel_playlist') return;
      if (command !== 'read_scan_resume_publication_projection')
        throw new Error('Unknown fixture command');
      const request = args?.request as { kind: string; cursor: number; limit: number };
      expect(request.limit).toBe(64);
      const all = request.kind === 'sources' ? [source] : [row('a'), row('b'), row('c')];
      const rows = all.slice(request.cursor, request.cursor + 2);
      const reply = {
        schemaVersion: 1,
        planId: 'plan',
        catalogRevision: '3',
        healthRevision: '4',
        checkpointRevision: '5',
        kind: request.kind,
        cursor: request.cursor,
        nextCursor: request.cursor + rows.length,
        total: all.length,
        rows,
        done: request.cursor + rows.length === all.length,
      };
      change?.(reply);
      return reply;
    },
    idFactory: () => crypto.randomUUID(),
  };
}
it('reads exact byte-prefix pages for only the committed delta with no full record IPC', async () => {
  const backend = runtime();
  const result = await createScanPublicationProjectionReader(backend)(
    receipt,
    [source],
    new AbortController().signal,
  );
  expect(result.channels.map((channel) => channel.id)).toEqual(['a', 'b', 'c']);
  expect(result.sources).toEqual([source]);
  expect(result.wireBytes).toBeGreaterThan(0);
  expect(backend.calls).toEqual(Array(3).fill('read_scan_resume_publication_projection'));
});
for (const mode of [
  'extra',
  'revision',
  'cursor',
  'empty',
  'duplicate',
  'unknown-source',
  'http-grant',
] as const)
  it(`refuses ${mode} without returning partial adoption data`, async () => {
    const backend = runtime((reply) => {
      if (mode === 'extra') reply.catalog = { channels: [] };
      if (mode === 'revision') reply.healthRevision = '99';
      if (mode === 'cursor') reply.nextCursor = 99;
      if (mode === 'empty') {
        reply.rows = [];
        reply.nextCursor = reply.cursor;
        reply.done = false;
      }
      if (reply.kind === 'channels') {
        const rows = reply.rows as ReturnType<typeof row>[];
        if (mode === 'duplicate' && reply.cursor === 2) rows[0]!.id = 'a';
        if (mode === 'unknown-source') rows[0]!.sourceId = 'missing';
        if (mode === 'http-grant') rows[0]!.urls = ['http://fixture.invalid/plain'];
      }
    });
    const original = JSON.stringify(source);
    await expect(
      createScanPublicationProjectionReader(backend)(
        receipt,
        [source],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(source)).toBe(original);
  });
it('rejects a whole oversized page rather than silently omitting its final rows', async () => {
  const backend = runtime((reply) => {
    if (reply.kind === 'channels') {
      reply.rows = Array.from({ length: 64 }, (_, index) => ({
        ...row(String(index)),
        name: 'x'.repeat(16384),
      }));
      reply.nextCursor = 64;
      reply.total = 64;
      reply.done = true;
    }
  });
  await expect(
    createScanPublicationProjectionReader(backend)(receipt, [source], new AbortController().signal),
  ).rejects.toThrow();
});
it('canceled readonly projection joins both admitted RPC and actual cancel before refusing', async () => {
  const abort = new AbortController();
  let finishRead!: () => void, finishCancel!: () => void;
  let settled = false;
  const backend = runtime();
  const reader = createScanPublicationProjectionReader({
    idFactory: () => 'held',
    invoke: async (command, args) => {
      await new Promise<void>((resolve) => {
        if (command === 'cancel_playlist') finishCancel = resolve;
        else finishRead = resolve;
      });
      return backend.invoke(command, args);
    },
  });
  const work = reader(receipt, [source], abort.signal).finally(() => {
    settled = true;
  });
  const refusal = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  abort.abort();
  await Promise.resolve();
  await Promise.resolve();
  finishRead();
  await Promise.resolve();
  expect(settled).toBe(false);
  finishCancel();
  await refusal;
});

it('pages a native version2 240-channel committed projection using strict 64-row replies', async () => {
  const indices = Array.from({ length: 240 }, (_, i) => i),
    calls: number[] = [];
  const ack = {
    ...receipt,
    counts: { total: 240, checked: 240, responded: 240, published: 240 },
    acknowledgedIndices: indices,
    publicationIndices: indices,
  };
  const backend = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('read_scan_resume_publication_projection');
      const r = args?.request as {
        schemaVersion: number;
        kind: string;
        cursor: number;
        limit: number;
      };
      expect(r.schemaVersion).toBe(2);
      expect(r.limit).toBe(64);
      const all = r.kind === 'sources' ? [source] : indices.map((i) => row('channel-' + i));
      const rows = all.slice(r.cursor, r.cursor + r.limit);
      calls.push(rows.length);
      return {
        schemaVersion: 2,
        planId: 'plan',
        catalogRevision: '3',
        healthRevision: '4',
        checkpointRevision: '5',
        kind: r.kind,
        cursor: r.cursor,
        nextCursor: r.cursor + rows.length,
        total: all.length,
        rows,
        done: r.cursor + rows.length === all.length,
      };
    },
  };
  const result = await createScanPublicationProjectionReader(backend)(
    ack,
    [source],
    new AbortController().signal,
  );
  expect(result.channels.length).toBe(240);
  expect(new Set(result.channels.map((c) => c.id)).size).toBe(240);
  expect(calls.every((n) => n <= 64)).toBe(true);
  expect(calls).toHaveLength(5);
});
