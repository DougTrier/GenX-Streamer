import { describe, expect, it, vi } from 'vitest';
import { createChannelLogos } from '../../src/application/channel-logos';
import {
  createChannelLogoAdapter,
  validateChannelLogos,
  type ChannelLogoImage,
  type ChannelLogoReply,
} from '../../src/platform/channel-logos';

const image = (channelId: string): ChannelLogoImage => ({
  channelId,
  providerId: 'Controlled.us',
  mimeType: 'image/png',
  width: 32,
  height: 32,
  byteLength: 3,
  dataUrl: 'data:image/png;base64,AAAA',
});
const reply = (ids: string[], images = ids.map(image)): ChannelLogoReply => ({
  schemaVersion: 1,
  catalogRevision: '3',
  attemptedChannelIds: ids,
  images,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function settle() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}

describe('channel artwork native boundary', () => {
  it('admits only requested identities, same revision, bounded raster data and exact keys', () => {
    expect(validateChannelLogos(reply(['a']), ['a'], '3').images).toHaveLength(1);
    for (const value of [
      { ...reply(['a']), catalogRevision: '4' },
      { ...reply(['a']), sourceUrl: 'https://example.invalid' },
      reply(['b']),
      reply(['a', 'a']),
      reply(['a'], [image('b')]),
      reply(['a'], [image('a'), image('a')]),
      reply(['a'], [{ ...image('a'), dataUrl: 'https://example.invalid/logo.png' }]),
      reply(['a'], [{ ...image('a'), width: 513, height: 512 }]),
      reply(['a'], [{ ...image('a'), byteLength: 4 }]),
      reply(['a'], [{ ...image('a'), mimeType: 'image/svg+xml' } as unknown as ChannelLogoImage]),
    ])
      expect(() => validateChannelLogos(value, ['a'], '3')).toThrow();
  });

  it('retains the original command and cancellation acknowledgment before settling abort', async () => {
    const original = deferred<unknown>(),
      cancel = deferred<unknown>();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : original.promise,
    );
    const native = createChannelLogoAdapter({ invoke, idFactory: () => 'controlled' });
    const abort = new AbortController();
    let settled = false;
    const outcome = native
      .read(['a'], '3', abort.signal)
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    abort.abort();
    await settle();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['channel_logos', 'cancel_playlist']);
    expect(settled).toBe(false);
    original.resolve(reply(['a']));
    await settle();
    expect(settled).toBe(false);
    cancel.resolve(undefined);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });
});

describe('channel artwork ownership', () => {
  it('does no network work until a visible configured channel is requested', async () => {
    const read = vi.fn(async (ids: readonly string[]) => reply([...ids]));
    const changed = vi.fn();
    const owner = createChannelLogos({
      native: { read },
      readyScope: () => ({ key: 'root:3', revision: '3' }),
      changed,
    });
    await settle();
    expect(read).not.toHaveBeenCalled();
    owner.visible([]);
    await settle();
    expect(read).not.toHaveBeenCalled();
    owner.visible([{ id: 'a' }]);
    await settle();
    expect(owner.get({ id: 'a' })).toBe(image('a').dataUrl);
    expect(changed).toHaveBeenCalledOnce();
    await owner.dispose();
  });

  it('joins obsolete scrolling work before dispatching its replacement and never publishes stale images', async () => {
    const first = deferred<ChannelLogoReply>();
    const requests: { ids: readonly string[]; signal: AbortSignal }[] = [];
    const read = vi.fn(async (ids: readonly string[], _revision: string, signal: AbortSignal) => {
      requests.push({ ids, signal });
      return requests.length === 1 ? first.promise : reply([...ids]);
    });
    const owner = createChannelLogos({
      native: { read },
      readyScope: () => ({ key: 'root:3', revision: '3' }),
      changed() {},
    });
    owner.visible([{ id: 'a' }]);
    await settle();
    owner.visible([{ id: 'b' }]);
    await settle();
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests).toHaveLength(1);
    first.resolve(reply(['a']));
    await settle();
    expect(requests).toHaveLength(2);
    expect(owner.get({ id: 'a' })).toBeNull();
    expect(owner.get({ id: 'b' })).not.toBeNull();
    await owner.dispose();
  });

  it('clears images when the storage scope changes even if canonical IDs repeat', async () => {
    let scope = 'root-1:3';
    const owner = createChannelLogos({
      native: { read: async (ids) => reply([...ids]) },
      readyScope: () => ({ key: scope, revision: '3' }),
      changed() {},
    });
    owner.visible([{ id: 'a' }]);
    await settle();
    expect(owner.get({ id: 'a' })).not.toBeNull();
    scope = 'root-2:3';
    expect(owner.get({ id: 'a' })).toBeNull();
    owner.visible([]);
    expect(owner.snapshot().images).toBe(0);
    await owner.dispose();
  });

  it('keeps only 32 images across scrolling and bounds native requests to 32 IDs', async () => {
    const read = vi.fn(async (ids: readonly string[]) => reply([...ids]));
    const owner = createChannelLogos({
      native: { read },
      readyScope: () => ({ key: 'root:3', revision: '3' }),
      changed() {},
    });
    for (let batch = 0; batch < 5; batch++) {
      owner.visible(Array.from({ length: 40 }, (_, n) => ({ id: `${batch}-${n}` })));
      await settle();
      expect(owner.snapshot().images).toBeLessThanOrEqual(32);
    }
    expect(read.mock.calls.every(([ids]) => ids.length === 32)).toBe(true);
    await owner.dispose();
  });

  it('does not negative-cache unattempted IDs after a partial batch deadline', async () => {
    const read = vi.fn(async (ids: readonly string[]) =>
      read.mock.calls.length === 1 ? reply(['a'], []) : reply([...ids]),
    );
    const owner = createChannelLogos({
      native: { read },
      readyScope: () => ({ key: 'root:3', revision: '3' }),
      changed() {},
    });
    owner.visible([{ id: 'a' }, { id: 'b' }]);
    await settle();
    owner.visible([{ id: 'b' }]);
    await settle();
    expect(read.mock.calls[1][0]).toEqual(['b']);
    expect(owner.get({ id: 'b' })).not.toBeNull();
    await owner.dispose();
  });

  it('suspension waits for original work and blocks delayed results', async () => {
    const held = deferred<ChannelLogoReply>();
    const owner = createChannelLogos({
      native: { read: () => held.promise },
      readyScope: () => ({ key: 'root:3', revision: '3' }),
      changed: vi.fn(),
    });
    owner.visible([{ id: 'a' }]);
    await settle();
    let stopped = false;
    const stopping = owner.suspend().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    held.resolve(reply(['a']));
    await stopping;
    expect(owner.snapshot()).toEqual({ images: 0, bytes: 0, inFlight: false, visible: 0 });
    await owner.dispose();
  });
});
