import { describe, it, expect, vi } from 'vitest';
import {
  createHealthInspector,
  type HealthCheckBudgetMs,
  type NativeHealthInspection,
} from '../../src/sources/health-inspection';
const bytes = (s: string) => new TextEncoder().encode(s);
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;
describe('single health inspection across platforms', () => {
  it('does not trust media MIME while an error-page prefix arrives in separate chunks', async () => {
    for (const fragments of [
      ['<', 'html>denied</html>'],
      [' ', '<', '?xml version="1.0"?><error/>'],
      ['\uFEFF', '<', 'html>denied</html>'],
    ]) {
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (reads < fragments.length) controller.enqueue(bytes(fragments[reads++]));
            else controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const inspection = createHealthInspector({
        fetch: async () => new Response(stream, { headers: { 'Content-Type': 'video/mp4' } }),
      });
      expect((await inspection('https://fixture.invalid', false, signal())).kind).toBe(
        'unsupported',
      );
      expect(reads).toBe(fragments.length);
    }
  });
  it('returns actual non2xx status and bounded RetryAfter without reading error bodies', async () => {
    let pulled = 0,
      cancelled = 0;
    const body = new ReadableStream(
      {
        pull() {
          pulled++;
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const fetcher = vi.fn(
      async () => new Response(body, { status: 429, headers: { 'Retry-After': '7' } }),
    );
    expect(
      await createHealthInspector({ fetch: fetcher })('https://fixture.invalid', false, signal()),
    ).toEqual({ status: 429, retryAfter: '7' });
    expect(pulled).toBe(0);
    expect(cancelled).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    for (const size of [128, 129]) {
      const inspect = createHealthInspector({
        fetch: async () =>
          new Response(null, { status: 503, headers: { 'Retry-After': '9'.repeat(size) } }),
      });
      expect((await inspect('https://fixture.invalid', false, signal())).retryAfter?.length).toBe(
        size === 128 ? 128 : undefined,
      );
    }
  });
  it('uses body evidence without filename guessing or a second GET', async () => {
    for (const [body, mime, kind] of [
      ['#EXTM3U\n#EXTINF:-1,Fixture\nopaque\n', 'video/mp4', 'catalog'],
      ['#EXTM3U\n#EXT-X-TARGETDURATION:2\n', 'text/plain', 'hls'],
      ['<html>denied</html>', 'video/mp4', 'unsupported'],
    ] as const) {
      const fetcher = vi.fn(async () => new Response(body, { headers: { 'Content-Type': mime } }));
      expect(
        (
          await createHealthInspector({ fetch: fetcher })(
            'https://fixture.invalid/no-extension',
            false,
            signal(),
            45000,
          )
        ).kind,
      ).toBe(kind);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    let canceled = false,
      reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          reads++;
          const chunk = new Uint8Array(65536);
          chunk.set(bytes('ftyp'), 4);
          c.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await createHealthInspector({ fetch: async () => new Response(stream) })(
      'https://fixture.invalid',
      false,
      signal(),
    );
    expect(result).toMatchObject({ status: 200, kind: 'media', mime: 'video/mp4' });
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
  });
  it('bounds finite catalog declarations/UTF8 and unknown bodies', async () => {
    const oversized = createHealthInspector({
      fetch: async () => new Response('#EXTM3U\n', { headers: { 'Content-Length': '20971521' } }),
    });
    await expect(oversized('https://fixture.invalid', false, signal())).rejects.toThrow('20 MiB');
    const invalid = new Uint8Array([...bytes('#EXTM3U\n'), 255]);
    await expect(
      createHealthInspector({ fetch: async () => new Response(invalid) })(
        'https://fixture.invalid',
        false,
        signal(),
      ),
    ).rejects.toThrow('encoding');
    let reads = 0,
      canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          reads++;
          c.enqueue(bytes('x'.repeat(8192)));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    expect(
      (
        await createHealthInspector({ fetch: async () => new Response(stream) })(
          'https://fixture.invalid',
          false,
          signal(),
        )
      ).kind,
    ).toBe('unsupported');
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
  });
  it('refuses credentials/ungranted HTTP/invalid budgets before I/O and unsafe redirects', async () => {
    const fetcher = vi.fn(async () => new Response());
    const inspect = createHealthInspector({ fetch: fetcher });
    for (const url of [
      'file:///private',
      'https://user:secret@fixture.invalid',
      'http://fixture.invalid',
    ])
      await expect(inspect(url, false, signal())).rejects.toThrow();
    await expect(
      inspect('https://fixture.invalid', false, signal(), 1000 as HealthCheckBudgetMs),
    ).rejects.toThrow('budget');
    expect(fetcher).not.toHaveBeenCalled();
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://fixture.invalid/target' } }),
    );
    await expect(
      createHealthInspector({ fetch: redirect })('https://fixture.invalid', false, signal()),
    ).rejects.toThrow('HTTP');
    expect(redirect).toHaveBeenCalledOnce();
    const opaque = new Response();
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    await expect(
      createHealthInspector({ fetch: async () => opaque })(
        'https://fixture.invalid',
        false,
        signal(),
      ),
    ).rejects.toThrow('redirect safely');
  });
  it('passes exact native budget/registry args and validates native response shape', async () => {
    const inspect = vi.fn<NativeHealthInspection['inspect']>(async () => ({
        status: 403,
        retryAfter: '5',
      })),
      cancel = vi.fn(async () => undefined);
    const adapter = createHealthInspector({ native: { inspect, cancel } });
    expect(
      await adapter('https://fixture.invalid/source?token=keep#remove', false, signal(), 60000),
    ).toEqual({ status: 403, retryAfter: '5' });
    expect(inspect.mock.calls[0][0]).toMatchObject({
      url: 'https://fixture.invalid/source?token=keep',
      allowHttp: false,
      budgetMs: 60000,
      requestId: expect.any(String),
    });
    expect(cancel).not.toHaveBeenCalled();
    for (const response of [
      { status: 200, kind: 'decoded' },
      { status: 403, kind: 'media' },
      { status: 200, retryAfter: 'x'.repeat(129) },
      { status: 200, privateUrl: 'secret' },
    ]) {
      await expect(
        createHealthInspector({ native: { inspect: async () => response, cancel } })(
          'https://fixture.invalid',
          false,
          signal(),
        ),
      ).rejects.toThrow('invalid');
    }
  });
  it('caller cancel joins actual native invocation and cancel cleanup before settling', async () => {
    const input = deferred<unknown>(),
      cleanup = deferred<void>(),
      external = new AbortController();
    const cancel = vi.fn(() => cleanup.promise);
    const adapter = createHealthInspector({ native: { inspect: () => input.promise, cancel } });
    const pending = adapter('https://fixture.invalid', false, external.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    external.abort();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    input.resolve({ status: 200, kind: 'media' });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(settled).toBe(false);
    cleanup.resolve();
    await rejected;
    expect(settled).toBe(true);
  });
  it('configured deadline waits settlement; extended budget permits delayed responses', async () => {
    vi.useFakeTimers();
    try {
      const input = deferred<unknown>(),
        cancel = vi.fn(async () => undefined);
      const pending = createHealthInspector({ native: { inspect: () => input.promise, cancel } })(
        'https://fixture.invalid',
        false,
        signal(),
        20000,
      );
      const rejected = expect(pending).rejects.toBe('timeout');
      await vi.advanceTimersByTimeAsync(20000);
      expect(cancel).toHaveBeenCalledOnce();
      input.resolve({ status: 200, kind: 'media' });
      await rejected;
      const long = createHealthInspector({
        fetch: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(new Response('#EXTM3U\n#EXT-X-TARGETDURATION:2\n')), 30000);
          }),
      })('https://fixture.invalid', false, signal(), 45000);
      await vi.advanceTimersByTimeAsync(30000);
      expect((await long).kind).toBe('hls');
    } finally {
      vi.useRealTimers();
    }
  });
  it('redacts unexpected fetch/native error diagnostics while preserving timeout category', async () => {
    await expect(
      createHealthInspector({
        fetch: async () => {
          throw new Error('https://private.invalid/?secret=credential');
        },
      })('https://fixture.invalid', false, signal()),
    ).rejects.not.toThrow('credential');
    await expect(
      createHealthInspector({
        native: {
          inspect: async () => {
            throw 'timeout';
          },
          cancel: async () => undefined,
        },
      })('https://fixture.invalid', false, signal()),
    ).rejects.toBe('timeout');
  });
});
