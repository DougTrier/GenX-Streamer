import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LoaderContextType,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js';
import {
  createNativeHlsLoader,
  createNativeHlsSession,
  decodeMediaFrame,
  type NativeMediaPayload,
  type NativeMediaRequest,
} from '../../src/platform/native-hls-loader';
import { createResourceOwners } from '../../src/playback/resource-owners';

const context = (url = 'https://source.test/opaque'): LoaderContext => ({
  url,
  responseType: 'arraybuffer',
  type: LoaderContextType.MEDIA_FRAGMENT,
});
const configuration: LoaderConfiguration = {
  loadPolicy: {
    maxTimeToFirstByteMs: 8000,
    maxLoadTimeMs: 15000,
    timeoutRetry: null,
    errorRetry: null,
  },
  maxRetry: 0,
  timeout: 15000,
  retryDelay: 0,
  maxRetryDelay: 0,
};
function callbacks(): LoaderCallbacks<LoaderContext> {
  return { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('native HLS loader ownership', () => {
  it.each([
    [{ version: 1, firstByteMs: 20, completeMs: 80 }, 120],
    [undefined, 100],
    [{ version: 1, firstByteMs: 90, completeMs: 80 }, 100],
    [{ version: 1, firstByteMs: -1, completeMs: 80 }, 100],
    [{ version: 1, firstByteMs: 20, completeMs: 500 }, 100],
    [{ version: 1, firstByteMs: NaN, completeMs: 80 }, 100],
  ])(
    'uses bounded native first-byte timing without calling full download TTFB',
    async (timing, first) => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(200);
      const session = createNativeHlsSession({
        allowHttp: () => false,
        transport: {
          load: async () => ({ status: 200, headers: {}, data: [1], timing }) as NativeMediaPayload,
          cancel: vi.fn(async () => {}),
        },
      });
      const loader = new session.Loader();
      const events = callbacks();
      loader.load(context(), configuration, events);
      await flush();
      expect(events.onSuccess).toHaveBeenCalledOnce();
      expect(loader.stats.loading).toEqual({ start: 100, first, end: 200 });
      loader.destroy();
      session.close();
      await session.settled();
    },
  );
  it('joins previously destroyed loaders and refuses new loads after session close', async () => {
    const owners = createResourceOwners();
    let complete!: (payload: NativeMediaPayload) => void;
    const load = vi.fn(
      () =>
        new Promise<NativeMediaPayload>((resolve) => {
          complete = resolve;
        }),
    );
    const session = createNativeHlsSession({
      owners,
      allowHttp: () => false,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    const loader = new session.Loader();
    loader.load(context(), configuration, callbacks());
    loader.destroy();
    session.close();
    expect(() => new session.Loader()).toThrow('closed');
    loader.load(context(), configuration, callbacks());
    expect(load).toHaveBeenCalledOnce();
    let settled = false;
    const joined = session.settled().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(owners.snapshot().counts.nativeLoads).toBe(1);
    complete({ status: 200, headers: {}, data: [1] });
    await joined;
    expect(owners.snapshot().counts.nativeLoads).toBe(0);
    expect(owners.snapshot().counts.drainTimers).toBe(0);
  });
  it('counts overlapping reused-loader operations and releases timeout/cancel exactly once', async () => {
    vi.useFakeTimers();
    const owners = createResourceOwners();
    const finishes: Array<(payload: NativeMediaPayload) => void> = [];
    const session = createNativeHlsSession({
      owners,
      allowHttp: () => false,
      transport: {
        load: () =>
          new Promise((resolve) => {
            finishes.push(resolve);
          }),
        cancel: vi.fn(async () => {}),
      },
    });
    const loader = new session.Loader();
    const events = callbacks();
    loader.load(context(), configuration, events);
    loader.load(context(), configuration, events);
    expect(owners.snapshot().counts.nativeLoads).toBe(2);
    expect(owners.snapshot().counts.loaderTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(owners.snapshot().counts.loaderTimers).toBe(0);
    expect(events.onTimeout).toHaveBeenCalledOnce();
    session.close();
    for (const finish of finishes) finish({ status: 200, headers: {}, data: [1] });
    await session.settled();
    expect(events.onSuccess).not.toHaveBeenCalled();
    expect(owners.snapshot().counts.nativeLoads).toBe(0);
    expect(owners.snapshot().counts.nativeCancels).toBe(0);
    expect(owners.snapshot().highWater.nativeLoads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps actual load and cancel operations counted after logical abort until both settle', async () => {
    const owners = createResourceOwners();
    let finishLoad!: (payload: NativeMediaPayload) => void;
    let finishCancel!: () => void;
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      owners,
      transport: {
        load: () =>
          new Promise((resolve) => {
            finishLoad = resolve;
          }),
        cancel: () =>
          new Promise((resolve) => {
            finishCancel = resolve;
          }),
      },
    });
    const loader = new Type();
    loader.load(context(), configuration, callbacks());
    try {
      expect(owners.snapshot().counts.nativeLoads).toBe(1);
      loader.destroy();
      expect(owners.snapshot().counts.nativeLoaders).toBe(0);
      expect(owners.snapshot().counts.loaderTimers).toBe(0);
      expect(owners.snapshot().counts.nativeLoads).toBe(1);
      expect(owners.snapshot().counts.nativeCancels).toBe(1);
      finishCancel();
      await flush();
      expect(owners.snapshot().counts.nativeLoads).toBe(1);
      expect(owners.snapshot().counts.nativeCancels).toBe(0);
    } finally {
      loader.destroy();
      finishCancel?.();
      finishLoad({ status: 200, headers: {}, data: [1] });
      await flush();
    }
    expect(owners.snapshot().counts.nativeLoads).toBe(0);
    expect(owners.snapshot().acquired.nativeLoads).toBe(owners.snapshot().released.nativeLoads);
  });
  it('loads the HLS.js 0/0 fragment sentinel without Range and refuses invalid nonzero ranges', async () => {
    const load = vi.fn(async (_request: NativeMediaRequest) => ({
      status: 200,
      headers: {},
      data: [1, 2],
    }));
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    const loader = new Type();
    const events = callbacks();
    loader.load({ ...context(), rangeStart: 0, rangeEnd: 0 }, configuration, events);
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(load.mock.calls[0]![0]).not.toHaveProperty('range');
    expect(events.onSuccess).toHaveBeenCalledOnce();
    for (const [start, end] of [
      [1, 1],
      [5, 0],
      [-1, 2],
    ]) {
      const refused = callbacks();
      loader.load({ ...context(), rangeStart: start, rangeEnd: end }, configuration, refused);
      expect(refused.onError).toHaveBeenCalledOnce();
    }
    expect(load).toHaveBeenCalledOnce();
    loader.destroy();
  });
  it('returns parsed bounded JSON for content steering contexts', async () => {
    const value = { VERSION: 1, TTL: 300, 'PATHWAY-PRIORITY': ['primary'] };
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: {
        load: async () => ({
          status: 200,
          headers: {},
          data: [...new TextEncoder().encode(JSON.stringify(value))],
        }),
        cancel: vi.fn(async () => {}),
      },
    });
    const loader = new Type();
    const events = callbacks();
    loader.load({ ...context(), responseType: 'json' }, configuration, events);
    await flush();
    expect(events.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ data: value }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Response),
    );
    expect(events.onError).not.toHaveBeenCalled();
    loader.destroy();
  });
  it('rejects malformed, invalid UTF-8, and oversized JSON without returning raw metadata', async () => {
    for (const [data, reason] of [
      [[...new TextEncoder().encode('{private-token')], 'invalid-json'],
      [[255], 'invalid-json'],
      [[...new TextEncoder().encode('null')], 'invalid-json'],
      [new Array<number>(1024 * 1024 + 1).fill(32), 'json-too-large'],
    ] as const) {
      const Type = createNativeHlsLoader({
        allowHttp: () => false,
        transport: {
          load: async () => ({ status: 200, headers: {}, data: [...data] }),
          cancel: vi.fn(async () => {}),
        },
      });
      const loader = new Type();
      const events = callbacks();
      loader.load({ ...context(), responseType: 'json' }, configuration, events);
      await flush();
      expect(events.onSuccess).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledExactlyOnceWith(
        { code: 0, text: reason },
        expect.any(Object),
        expect.any(Response),
        expect.any(Object),
      );
      loader.destroy();
    }
  });
  it('loads byte ranges with exclusive HLS rangeEnd and actual response headers', async () => {
    const load = vi.fn(async () => ({
      status: 206,
      headers: { 'content-range': 'bytes 20-29/40' },
      data: Array.from({ length: 10 }, (_, index) => index),
    }));
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    const loader = new Type();
    const events = callbacks();
    const item = { ...context(), rangeStart: 20, rangeEnd: 30 };
    loader.load(item, configuration, events);
    await flush();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'bytes=20-29', allowHttp: false }),
    );
    expect(events.onSuccess).toHaveBeenCalledOnce();
    expect(events.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ code: 206, data: expect.any(ArrayBuffer) }),
      expect.objectContaining({ loaded: 10, retry: 0 }),
      item,
      expect.any(Response),
    );
    expect(loader.getResponseHeader('Content-Range')).toBe('bytes 20-29/40');
    loader.destroy();
  });
  it('preserves refusal and Retry-After for controller policy without hidden retries', async () => {
    const load = vi.fn(async () => ({ status: 429, headers: { 'retry-after': '30' }, data: [] }));
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    const loader = new Type();
    const events = callbacks();
    loader.load(context(), configuration, events);
    await flush();
    expect(events.onError).toHaveBeenCalledWith(
      { code: 429, text: 'source-http-error' },
      expect.any(Object),
      expect.any(Response),
      expect.any(Object),
    );
    const details = vi.mocked(events.onError).mock.calls[0]![2] as Response;
    expect(details.headers.get('Retry-After')).toBe('30');
    expect(load).toHaveBeenCalledOnce();
    loader.destroy();
  });
  it('preserves final manifest URL so relative resources resolve after redirects', async () => {
    const finalUrl = 'https://cdn.test/path/opaque';
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: {
        load: async () => ({
          status: 200,
          headers: {},
          data: [...new TextEncoder().encode('#EXTM3U\n')],
          url: finalUrl,
        }),
        cancel: vi.fn(async () => {}),
      },
    });
    const loader = new Type();
    const events = callbacks();
    loader.load({ ...context(), responseType: 'text' }, configuration, events);
    await flush();
    expect(events.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ url: finalUrl, data: '#EXTM3U\n' }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Response),
    );
    loader.destroy();
  });
  it('aborts native request exactly once and suppresses stale completion/error callbacks', async () => {
    let resolve!: (value: NativeMediaPayload) => void;
    const load = vi.fn(
      (_request: NativeMediaRequest) =>
        new Promise<NativeMediaPayload>((done) => {
          resolve = done;
        }),
    );
    const cancel = vi.fn(async () => {});
    const Type = createNativeHlsLoader({ allowHttp: () => false, transport: { load, cancel } });
    const loader = new Type();
    const events = callbacks();
    loader.load(context(), configuration, events);
    const requestId = load.mock.calls[0]![0].requestId;
    loader.abort();
    loader.abort();
    loader.destroy();
    resolve({ status: 200, headers: {}, data: [1, 2] });
    await flush();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(events.onAbort).toHaveBeenCalledOnce();
    expect(events.onSuccess).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(loader.stats.aborted).toBe(true);
  });
  it('cancels transport when the coordinated loader timeout elapses', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: { load: () => new Promise(() => {}), cancel },
    });
    const loader = new Type();
    const events = callbacks();
    loader.load(context(), configuration, events);
    await vi.advanceTimersByTimeAsync(15000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(events.onTimeout).toHaveBeenCalledOnce();
    loader.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails HTTP without explicit permission and never requests embedded credentials', async () => {
    const load = vi.fn(async () => ({ status: 200, headers: {}, data: [] }));
    const Type = createNativeHlsLoader({
      allowHttp: () => false,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    for (const url of ['http://source.test/opaque', 'https://user:secret@source.test/opaque']) {
      const loader = new Type();
      const events = callbacks();
      loader.load(context(url), configuration, events);
      expect(events.onError).toHaveBeenCalledOnce();
      loader.destroy();
    }
    expect(load).not.toHaveBeenCalled();
  });
  it('uses one selected-source grant for related resources on different hosts', async () => {
    const selectedGrant = true;
    const load = vi.fn(async () => ({ status: 200, headers: {}, data: [1] }));
    const Type = createNativeHlsLoader({
      allowHttp: () => selectedGrant,
      transport: { load, cancel: vi.fn(async () => {}) },
    });
    const loader = new Type();
    loader.load(context('http://different-segment.test/resource'), configuration, callbacks());
    await flush();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ allowHttp: true }));
    loader.destroy();
  });
  it('preserves known native TLS failure category while redacting unknown errors', async () => {
    for (const [failure, expected] of [
      ['tls-failure', 'tls-failure'],
      ['dns-failure', 'dns-failure'],
      [JSON.stringify({ category: 'timeout', phase: 'body' }), 'timeout'],
      ['private-url-with-secret', 'native-network-error'],
    ]) {
      const Type = createNativeHlsLoader({
        allowHttp: () => false,
        transport: {
          load: async () => {
            throw failure;
          },
          cancel: vi.fn(async () => {}),
        },
      });
      const loader = new Type();
      const events = callbacks();
      loader.load(context(), configuration, events);
      await flush();
      expect(events.onError).toHaveBeenCalledWith(
        { code: 0, text: expected },
        expect.any(Object),
        expect.objectContaining({ playbackTransportError: expect.any(Object) }),
        expect.any(Object),
      );
      loader.destroy();
    }
  });
});

it('retires hundreds of completed fragment wrappers without retaining session ownership', async () => {
  const owners = createResourceOwners();
  const transport = {
    load: vi.fn(async () => ({ status: 200, headers: {}, data: [1] })),
    cancel: vi.fn(async () => {}),
  };
  const session = createNativeHlsSession({ allowHttp: () => false, owners, transport });
  for (let index = 0; index < 300; index++) {
    const loader = new session.Loader();
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    const events = callbacks();
    loader.load(context(), configuration, events);
    expect(owners.snapshot().counts.nativeLoaders).toBe(1);
    await flush();
    expect(events.onSuccess).toHaveBeenCalledOnce();
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    expect(owners.snapshot().counts.loaderTimers).toBe(0);
  }
  session.close();
  await session.settled();
  expect(transport.cancel).not.toHaveBeenCalled();
  expect(owners.snapshot().highWater.nativeLoaders).toBe(1);
  expect(owners.snapshot().acquired.nativeLoaders).toBe(300);
  expect(owners.snapshot().released.nativeLoaders).toBe(300);
});
it('reacquires a reusable live-playlist wrapper and refuses retired idle reuse after close', async () => {
  const owners = createResourceOwners();
  const load = vi.fn(async () => ({ status: 200, headers: {}, data: [65] }));
  const session = createNativeHlsSession({
    allowHttp: () => false,
    owners,
    transport: { load, cancel: async () => {} },
  });
  const loader = new session.Loader();
  for (let index = 0; index < 200; index++) {
    const events = callbacks();
    loader.load(
      { ...context(), responseType: 'text', type: LoaderContextType.LEVEL },
      configuration,
      events,
    );
    await flush();
    expect(events.onSuccess).toHaveBeenCalledOnce();
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
  }
  session.close();
  // Retired wrappers are not retained/destroyed by the session registry. HLS still owns them.
  expect(loader.context?.url).toBe('https://source.test/opaque');
  loader.load(context(), configuration, callbacks());
  await flush();
  expect(load).toHaveBeenCalledTimes(200);
  expect(owners.snapshot().counts.nativeLoaders).toBe(0);
  await session.settled();
  loader.destroy();
  expect(owners.snapshot().released.nativeLoaders).toBe(200);
});
it.each(['success', 'http', 'policy', 'network'] as const)(
  'retires before %s callback reenters load and never releases the new owner',
  async (kind) => {
    const owners = createResourceOwners();
    let resolve!: (value: NativeMediaPayload) => void;
    let calls = 0;
    const load = vi.fn(() => {
      calls++;
      if (calls === 1 && kind === 'network') return Promise.reject(new Error('dns-failure'));
      if (calls === 1 && kind !== 'policy')
        return Promise.resolve({ status: kind === 'http' ? 503 : 200, headers: {}, data: [1] });
      return new Promise<NativeMediaPayload>((r) => {
        resolve = r;
      });
    });
    const session = createNativeHlsSession({
      allowHttp: () => false,
      owners,
      transport: { load, cancel: async () => {} },
    });
    const loader = new session.Loader();
    const next = callbacks();
    const reenter = () => {
      expect(owners.snapshot().counts.nativeLoaders).toBe(0);
      loader.load(context('https://source.test/next'), configuration, next);
      expect(owners.snapshot().counts.nativeLoaders).toBe(1);
    };
    const first = callbacks();
    if (kind === 'success') first.onSuccess = reenter;
    else first.onError = reenter;
    loader.load(
      context(kind === 'policy' ? 'http://refused.test/media' : 'https://source.test/first'),
      configuration,
      first,
    );
    await flush();
    expect(owners.snapshot().counts.nativeLoaders).toBe(1);
    resolve({ status: 200, headers: {}, data: [2] });
    await flush();
    expect(next.onSuccess).toHaveBeenCalledOnce();
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    session.close();
    await session.settled();
  },
);
it('does not overwrite a load acquired by a reentrant abort callback', async () => {
  const owners = createResourceOwners();
  const requests: NativeMediaRequest[] = [];
  const completions: Array<(value: NativeMediaPayload) => void> = [];
  const session = createNativeHlsSession({
    allowHttp: () => false,
    owners,
    transport: {
      load: (request) => {
        requests.push(request);
        return new Promise((r) => completions.push(r));
      },
      cancel: async () => {},
    },
  });
  const loader = new session.Loader();
  const first = callbacks(),
    third = callbacks();
  first.onAbort = () => {
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    loader.load(context('https://source.test/third'), configuration, third);
  };
  loader.load(context('https://source.test/first'), configuration, first);
  const second = callbacks();
  loader.load(context('https://source.test/second'), configuration, second);
  await flush();
  expect(requests.map((r) => r.url)).toEqual([
    'https://source.test/first',
    'https://source.test/third',
  ]);
  expect(owners.snapshot().counts.nativeLoaders).toBe(1);
  for (const done of completions) done({ status: 200, headers: {}, data: [1] });
  await flush();
  expect(first.onSuccess).not.toHaveBeenCalled();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(third.onSuccess).toHaveBeenCalledOnce();
  session.close();
  await session.settled();
});
it('timeout retires immediately but close joins both actual load and cancel settlement', async () => {
  vi.useFakeTimers();
  const owners = createResourceOwners();
  let complete!: (value: NativeMediaPayload) => void, finishCancel!: () => void;
  const session = createNativeHlsSession({
    allowHttp: () => false,
    owners,
    transport: {
      load: () =>
        new Promise((r) => {
          complete = r;
        }),
      cancel: () =>
        new Promise<void>((r) => {
          finishCancel = r;
        }),
    },
  });
  const loader = new session.Loader();
  const events = callbacks();
  events.onTimeout = vi.fn(() => expect(owners.snapshot().counts.nativeLoaders).toBe(0));
  loader.load(
    context(),
    { ...configuration, loadPolicy: { ...configuration.loadPolicy, maxLoadTimeMs: 10 } },
    events,
  );
  await flush();
  await vi.advanceTimersByTimeAsync(10);
  expect(events.onTimeout).toHaveBeenCalledOnce();
  expect(owners.snapshot().counts.nativeLoads).toBe(1);
  expect(owners.snapshot().counts.nativeCancels).toBe(1);
  session.close();
  let settled = false;
  const drain = session.settled().then(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);
  complete({ status: 200, headers: {}, data: [1] });
  await flush();
  expect(events.onSuccess).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  finishCancel();
  await drain;
  expect(owners.snapshot().counts.nativeLoads).toBe(0);
  expect(owners.snapshot().counts.nativeCancels).toBe(0);
  expect(owners.snapshot().counts.nativeLoaders).toBe(0);
});

it('does not deliver a second terminal callback when an application callback throws', async () => {
  const owners = createResourceOwners();
  const session = createNativeHlsSession({
    allowHttp: () => false,
    owners,
    transport: {
      load: async () => ({ status: 200, headers: {}, data: [1] }),
      cancel: async () => {},
    },
  });
  const loader = new session.Loader();
  const events = callbacks();
  events.onSuccess = vi.fn(() => {
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    throw new Error('Callback failure');
  });
  loader.load(context(), configuration, events);
  await flush();
  expect(events.onSuccess).toHaveBeenCalledOnce();
  expect(events.onError).not.toHaveBeenCalled();
  expect(owners.snapshot().counts.nativeLoaders).toBe(0);
  session.close();
  await session.settled();
});
describe('segment inspection', () => {
  it('shows each media segment to the inspector before HLS.js parses it, never playlists', async () => {
    const seen: number[][] = [];
    const session = createNativeHlsSession({
      allowHttp: () => false,
      inspectFragment: (bytes) => void seen.push([...bytes]),
      transport: {
        load: async () => ({ status: 200, headers: {}, data: [0x47, 1, 2] }) as NativeMediaPayload,
        cancel: vi.fn(async () => {}),
      },
    });
    const fragment = new session.Loader();
    const segment = callbacks();
    fragment.load({ ...context(), frag: {} } as unknown as LoaderContext, configuration, segment);
    const playlist = new session.Loader();
    const manifest = callbacks();
    playlist.load(
      { url: 'https://source.test/live.m3u8', responseType: 'text' } as LoaderContext,
      configuration,
      manifest,
    );
    await flush();
    expect(seen).toEqual([[0x47, 1, 2]]);
    expect(segment.onSuccess).toHaveBeenCalledOnce();
    expect(manifest.onSuccess).toHaveBeenCalledOnce();
    session.close();
    await session.settled();
  });
  it('a segment whose inspection ends the session is not delivered', async () => {
    const session = createNativeHlsSession({
      allowHttp: () => false,
      inspectFragment: () => session.close(),
      transport: {
        load: async () => ({ status: 200, headers: {}, data: [0x47] }) as NativeMediaPayload,
        cancel: vi.fn(async () => {}),
      },
    });
    const loader = new session.Loader();
    const events = callbacks();
    loader.load({ ...context(), frag: {} } as unknown as LoaderContext, configuration, events);
    await flush();
    expect(events.onSuccess).not.toHaveBeenCalled();
    await session.settled();
  });
});

describe('fetch_media_bytes frames', () => {
  const frame = (meta: unknown, body: Uint8Array) => {
    const json = new TextEncoder().encode(JSON.stringify(meta));
    const buffer = new ArrayBuffer(4 + json.length + body.length);
    new DataView(buffer).setUint32(0, json.length, true);
    new Uint8Array(buffer, 4).set(json);
    new Uint8Array(buffer, 4 + json.length).set(body);
    return buffer;
  };
  it('reads the metadata and views the body in place, without copying it', () => {
    const body = new Uint8Array(188 * 3).map((_, i) => (i === 0 ? 0x47 : i & 0xff));
    const buffer = frame(
      {
        status: 200,
        url: 'https://cdn.test/a.ts',
        headers: { 'content-type': 'video/mp2t' },
        timing: { version: 1, firstByteMs: 2, completeMs: 5 },
      },
      body,
    );
    const payload = decodeMediaFrame(buffer);
    expect(payload.status).toBe(200);
    expect(payload.url).toBe('https://cdn.test/a.ts');
    expect(payload.headers['content-type']).toBe('video/mp2t');
    expect(payload.timing?.completeMs).toBe(5);
    expect(payload.data).toBeInstanceOf(Uint8Array);
    expect((payload.data as Uint8Array).buffer).toBe(buffer);
    expect([...(payload.data as Uint8Array)]).toEqual([...body]);
  });
  // ABC TV, October 19, 2026: the player got the whole frame (length and
  // metadata in front of the body), so AES-128 keys and segments decrypted to
  // garbage and fMP4 could not parse. Plain TS still found its sync byte.
  it.each([
    ['an AES-128 key', LoaderContextType.KEY, new Uint8Array(16).map((_, i) => i + 1)],
    ['a segment', LoaderContextType.MEDIA_FRAGMENT, new Uint8Array(188).map((_, i) => i & 0xff)],
  ])('hands the player exactly the body of %s', async (_label, type, body) => {
    const session = createNativeHlsSession({
      allowHttp: () => false,
      transport: {
        load: async () =>
          decodeMediaFrame(frame({ status: 200, url: 'https://cdn.test/x', headers: {} }, body)),
        cancel: vi.fn(async () => {}),
      },
    });
    const loader = new session.Loader();
    const events = callbacks();
    loader.load({ ...context(), type } as LoaderContext, configuration, events);
    await flush();
    expect(events.onSuccess).toHaveBeenCalledOnce();
    const data = (events.onSuccess as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      .data as ArrayBuffer;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(data)]).toEqual([...body]);
    loader.destroy();
    session.close();
  });
  it('refuses truncated or malformed frames', () => {
    expect(() => decodeMediaFrame(new ArrayBuffer(2))).toThrow('media-frame-invalid');
    const short = new ArrayBuffer(8);
    new DataView(short).setUint32(0, 100, true);
    expect(() => decodeMediaFrame(short)).toThrow('media-frame-invalid');
    expect(() => decodeMediaFrame(frame({ headers: {} }, new Uint8Array(1)))).toThrow(
      'media-frame-invalid',
    );
  });
});
