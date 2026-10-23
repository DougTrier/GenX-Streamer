import { describe, expect, it, vi } from 'vitest';
import { createSelectedGuideAdapter, validateSelectedGuideSummary } from '../../src/guide/native';
const query = {
  catalogSourceId: 's',
  appChannelId: 'c',
  atMs: 1700000000000,
  requestId: 'owned-query',
};
const reply = () => ({
  ...query,
  catalogRevision: '4',
  databaseRevision: 3,
  mappingStatus: 'mapped',
  mapping: { catalogSourceId: 's', appChannelId: 'c', guideSourceId: 'g', xmltvChannelId: 'xml' },
  sourceRevision: 2,
  publishedRevision: 2,
  updatedMs: query.atMs - 1000,
  coverage: { startMs: query.atMs - 5000, endMs: query.atMs + 100000 },
  cacheStatus: 'current',
  currentStatus: 'current',
  nextStatus: 'next',
  current: { title: 'Current', startMs: query.atMs - 1000, stopMs: query.atMs + 1000 },
  next: { title: 'Next', startMs: query.atMs + 1000, stopMs: null },
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
describe('selected guide native boundary', () => {
  it('requests one exact scoped summary without fetching a page or exposing URLs', async () => {
    const invoke = vi.fn().mockResolvedValue(reply());
    const read = createSelectedGuideAdapter({ invoke, isNative: () => true });
    expect(await read(query, new AbortController().signal)).toEqual(reply());
    expect(invoke.mock.calls).toEqual([['guide_selected_summary', query]]);
  });
  it.each([
    { requestId: 'late-request' },
    { appChannelId: 'other' },
    { atMs: query.atMs + 1 },
    { catalogRevision: '9223372036854775808' },
    { currentStatus: 'unknown-end' },
    { current: { title: 'Fake current', startMs: query.atMs, stopMs: null } },
    { next: { title: 'Past', startMs: query.atMs, stopMs: query.atMs + 1 } },
    {
      mapping: {
        catalogSourceId: 'other',
        appChannelId: 'c',
        guideSourceId: 'g',
        xmltvChannelId: 'x',
      },
    },
    { providerUrl: 'https://secret.invalid/token' },
    { current: { ...reply().current, title: '界'.repeat(6000) } },
  ])('refuses malformed or cross-scope summary (%j)', (change) => {
    expect(() => validateSelectedGuideSummary({ ...reply(), ...change }, query)).toThrow(
      'Program guide response was invalid',
    );
  });
  it('accepts honest unknown-end, stale and missing-mapping states without a pretend program', () => {
    expect(
      validateSelectedGuideSummary(
        {
          ...reply(),
          currentStatus: 'unknown-end',
          current: null,
          cacheStatus: 'stale',
          publishedRevision: 1,
        },
        query,
      ).current,
    ).toBeNull();
    expect(
      validateSelectedGuideSummary(
        {
          ...reply(),
          mappingStatus: 'unmapped',
          mapping: null,
          sourceRevision: null,
          publishedRevision: null,
          cacheStatus: 'unavailable',
          currentStatus: null,
          nextStatus: null,
          current: null,
          next: null,
        },
        query,
      ).mappingStatus,
    ).toBe('unmapped');
  });
  it('joins canceled query and cancellation acknowledgment before rejecting a late success', async () => {
    const result = deferred<unknown>(),
      cancel = deferred<unknown>();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : result.promise,
    );
    const read = createSelectedGuideAdapter({ invoke, isNative: () => true });
    const controller = new AbortController();
    let settled = false;
    const pending = read(query, controller.signal).finally(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    result.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: query.requestId });
  });
  it('failed cancellation cannot acknowledge cleanup or expose native diagnostics', async () => {
    const result = deferred<unknown>();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? Promise.reject('https://secret.invalid') : result.promise,
    );
    const read = createSelectedGuideAdapter({ invoke, isNative: () => true });
    const controller = new AbortController();
    const pending = read(query, controller.signal);
    controller.abort();
    result.resolve(reply());
    await expect(pending).rejects.toThrow(
      'Program guide cancellation could not finish. Retry closing.',
    );
  });
  it('browser preview and pre-aborted calls never invoke native work', async () => {
    const invoke = vi.fn();
    const read = createSelectedGuideAdapter({ invoke, isNative: () => false });
    await expect(read(query, new AbortController().signal)).rejects.toThrow('installed app');
    const controller = new AbortController();
    controller.abort();
    await expect(read(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
