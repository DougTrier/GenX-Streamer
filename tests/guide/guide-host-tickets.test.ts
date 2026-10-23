import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  sources: vi.fn(),
  preview: vi.fn(),
  matched: vi.fn(),
  manual: vi.fn(),
  cache: vi.fn(),
  discard: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../src/guide/native', () => ({
  nativeGuide: {
    sources: api.sources,
    commitIfMatched: api.matched,
    commitAndMatch: api.manual,
    commit: api.cache,
    discard: api.discard,
  },
  previewNativeGuide: api.preview,
  readSelectedGuide: vi.fn(),
  readChannelGuideCoverage: vi.fn(),
}));
import { createGuideHost } from '../../src/application/guide-host';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.sources.mockResolvedValue([
    { id: 'source', kind: 'url', location: 'https://fixture.invalid/guide', revision: 2 },
  ]);
  api.preview.mockResolvedValue({ ticket: 'ticket', sourceRevision: 2 });
  api.matched.mockResolvedValue({ committed: true, matched: 1, unmatched: 0 });
  api.cache.mockResolvedValue(3);
  api.discard.mockResolvedValue(undefined);
});
async function setup() {
  const changed = vi.fn();
  const host = createGuideHost({
    channels: () => [],
    selectedChannel: () => null,
    watch: async () => {},
    onChanged: changed,
  });
  const signal = new AbortController().signal;
  await host.preview({ sourceId: 'source' }, signal);
  return { host, signal, changed };
}
it('cache-only publication owns the ticket, survives late abort and never performs an unfenced mapping', async () => {
  const { host, changed } = await setup();
  const pending = deferred<number>();
  api.cache.mockReturnValue(pending.promise);
  const abort = new AbortController();
  const work = host.publishCachedPreview('ticket', 2, abort.signal);
  abort.abort();
  await expect(host.discardPreview('ticket')).rejects.toThrow('still being saved');
  pending.resolve(3);
  await work;
  expect(api.cache).toHaveBeenCalledExactlyOnceWith('ticket', 2, false);
  expect(api.matched).not.toHaveBeenCalled();
  expect(api.manual).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  await expect(
    host.publishCachedPreview('ticket', 2, new AbortController().signal),
  ).rejects.toThrow('changed');
});
it.each([true, false])(
  'consumes a definitive matched=%s native ticket and never reuses its revision',
  async (committed) => {
    const { host, signal, changed } = await setup();
    const receipt = { committed, matched: committed ? 1 : 0, unmatched: committed ? 0 : 1 };
    api.matched.mockResolvedValue(receipt);
    expect(await host.commitMatchedPreview('ticket', 2, '9', signal)).toEqual(receipt);
    expect(api.matched).toHaveBeenCalledExactlyOnceWith('ticket', 2, '9', undefined);
    await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).rejects.toThrow('expired');
    await expect(host.commitPreview('ticket', signal)).rejects.toThrow('expired');
    expect(api.matched).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(committed ? 1 : 0);
  },
);
it('retains uncertain native failures and malformed receipts for retry or explicit discard', async () => {
  const { host, signal, changed } = await setup();
  api.matched.mockRejectedValueOnce(new Error('Fixture transport rejected'));
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).rejects.toThrow();
  api.matched.mockResolvedValueOnce({ committed: false, matched: 1, unmatched: 0 });
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).rejects.toThrow(
    'receipt is invalid',
  );
  expect(changed).not.toHaveBeenCalled();
  api.discard.mockRejectedValueOnce(new Error('Fixture cleanup rejected'));
  await expect(host.discardPreview('ticket')).rejects.toThrow();
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).resolves.toEqual({
    committed: true,
    matched: 1,
    unmatched: 0,
  });
  expect(api.matched).toHaveBeenCalledTimes(3);
});
it('explicit acknowledged discard releases uncertain tickets while rejected discard stays retryable', async () => {
  const { host, signal } = await setup();
  api.matched.mockRejectedValueOnce(new Error('Fixture uncertain failure'));
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).rejects.toThrow();
  api.discard.mockRejectedValueOnce(new Error('Fixture uncertain cleanup'));
  await expect(host.discardPreview('ticket')).rejects.toThrow();
  await host.discardPreview('ticket');
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).rejects.toThrow('expired');
  expect(api.discard).toHaveBeenCalledTimes(2);
});
it('rejects stale guide revision or pre-admission cancellation without consuming its ticket', async () => {
  const { host, signal } = await setup();
  await expect(host.commitMatchedPreview('ticket', 1, '9', signal)).rejects.toThrow(
    'revision changed',
  );
  const canceled = new AbortController();
  canceled.abort();
  await expect(host.commitMatchedPreview('ticket', 2, '9', canceled.signal)).rejects.toHaveProperty(
    'name',
    'AbortError',
  );
  expect(api.matched).not.toHaveBeenCalled();
  await expect(host.commitMatchedPreview('ticket', 2, '9', signal)).resolves.toHaveProperty(
    'committed',
    true,
  );
});
it.each([true, false])(
  'joins an admitted commit and returns definitive outcome %s despite late cancellation',
  async (committed) => {
    const { host, changed } = await setup();
    const pending = deferred<{ committed: boolean; matched: number; unmatched: number }>();
    api.matched.mockReturnValue(pending.promise);
    const abort = new AbortController();
    const work = host.commitMatchedPreview('ticket', 2, '9', abort.signal);
    abort.abort();
    await expect(host.discardPreview('ticket')).rejects.toThrow('still being saved');
    await expect(host.commitPreview('ticket', new AbortController().signal)).rejects.toThrow(
      'still being saved',
    );
    await expect(
      host.commitMatchedPreview('ticket', 2, '9', new AbortController().signal),
    ).rejects.toThrow('still being saved');
    expect(api.discard).not.toHaveBeenCalled();
    expect(api.manual).not.toHaveBeenCalled();
    pending.resolve({ committed, matched: committed ? 1 : 0, unmatched: committed ? 0 : 1 });
    expect(await work).toHaveProperty('committed', committed);
    expect(changed).toHaveBeenCalledTimes(committed ? 1 : 0);
    await expect(
      host.commitMatchedPreview('ticket', 2, '9', new AbortController().signal),
    ).rejects.toThrow('expired');
  },
);
