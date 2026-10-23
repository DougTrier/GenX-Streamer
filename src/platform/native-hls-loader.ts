import { invoke } from '@tauri-apps/api/core';
import { classifyTransportFailure } from '../playback/failure';
import {
  createOwnedWork,
  playbackResourceOwners,
  type ResourceOwners,
} from '../playback/resource-owners';
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js';
export interface NativeMediaPayload {
  status: number;
  headers: Record<string, string>;
  /** Raw bytes (fetch_media_bytes); a number array from older transports. */
  data: Uint8Array | number[];
  url?: string;
  timing?: { version: 1; firstByteMs: number; completeMs: number };
}
export interface NativeMediaRequest {
  url: string;
  allowHttp: boolean;
  requestId: string;
  range?: string;
}
export interface NativeMediaTransport {
  load(request: NativeMediaRequest): Promise<NativeMediaPayload>;
  cancel(requestId: string): Promise<void>;
}
export interface NativeLoaderOptions {
  allowHttp: (url: string) => boolean;
  /** Optional session capability boundary, checked for every manifest/key/media request. */
  requestAllowed?: (url: string) => boolean;
  transport?: NativeMediaTransport;
  owners?: ResourceOwners;
  /** Reads each media segment before the HLS library parses it. */
  inspectFragment?: (bytes: Uint8Array) => void;
}
/**
 * Reads fetch_media_bytes' binary message: a 4-byte little-endian length, that
 * much JSON metadata, then the body (viewed in place, not copied). The JSON
 * number array it replaces cost the TV's page thread about 10% of its time
 * while playing (Sansui, October 19, 2026).
 */
export function decodeMediaFrame(buffer: ArrayBuffer): NativeMediaPayload {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4)
    throw new Error('media-frame-invalid');
  const length = new DataView(buffer).getUint32(0, true);
  if (length < 2 || 4 + length > buffer.byteLength) throw new Error('media-frame-invalid');
  const meta: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  if (
    !meta ||
    typeof meta !== 'object' ||
    typeof (meta as { status?: unknown }).status !== 'number' ||
    typeof (meta as { headers?: unknown }).headers !== 'object'
  )
    throw new Error('media-frame-invalid');
  const { status, url, headers, timing } = meta as NativeMediaPayload;
  return {
    status,
    headers,
    data: new Uint8Array(buffer, 4 + length),
    ...(typeof url === 'string' ? { url } : {}),
    ...(timing ? { timing } : {}),
  };
}
const transport: NativeMediaTransport = {
  load: async (request) =>
    decodeMediaFrame(await invoke<ArrayBuffer>('fetch_media_bytes', { ...request })),
  cancel: (requestId) => invoke('cancel_playlist', { requestId }),
};
function stats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

/** Bounded native transport; no hidden retries, credentials, suffix checks, or response logs. */
export function createNativeHlsLoader(options: NativeLoaderOptions) {
  return createNativeHlsSession(options).Loader;
}
export function createNativeHlsSession(options: NativeLoaderOptions) {
  const network = options.transport ?? transport;
  const owners = options.owners ?? playbackResourceOwners;
  owners.cover('native-loader');
  const work = createOwnedWork(owners);
  const loaders = new Set<NativeHlsLoader>();
  let closing = false;
  class NativeHlsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = stats();
    private requestId: string | null = null;
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private releaseTimer: (() => void) | undefined;
    private releaseLoader: (() => void) | undefined;
    private callbacks: LoaderCallbacks<LoaderContext> | null = null;
    private headers = new Headers();
    private disposed = false;
    constructor(_config?: HlsConfig) {
      if (closing) throw new Error('Playback transport has closed.');
    }
    getResponseHeader = (name: string): string | null => this.headers.get(name);
    getCacheAge = (): number | null => {
      const age = this.headers.get('age');
      return age !== null && Number.isFinite(Number(age)) ? Number(age) : null;
    };
    private retire(): void {
      this.releaseLoader?.();
      this.releaseLoader = undefined;
      loaders.delete(this);
      this.callbacks = null;
    }
    private clearTimer(): void {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.releaseTimer?.();
      this.releaseTimer = undefined;
    }
    private cancel(): void {
      const request = this.requestId;
      this.requestId = null;
      this.clearTimer();
      this.retire();
      if (request)
        void work.run('nativeCancels', () => network.cancel(request)).catch(() => undefined);
    }
    abort(): void {
      if (!this.requestId) return;
      ++this.generation;
      this.stats.aborted = true;
      const callbacks = this.callbacks;
      const context = this.context;
      const stats = this.stats;
      this.cancel();
      if (context && !this.disposed) callbacks?.onAbort?.(stats, context, null);
    }
    destroy(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.abort();
      this.callbacks = null;
      this.context = null;
      this.retire();
    }
    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      providedCallbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      if (this.disposed || closing) return;
      const afterAbort = this.generation + (this.requestId ? 1 : 0);
      this.abort();
      // onAbort may reenter load or close this session. Do not overwrite its owner.
      if (this.disposed || closing || this.generation !== afterAbort) return;
      this.releaseLoader = owners.acquire('nativeLoaders');
      loaders.add(this);
      let callbackDelivered = false;
      const callbacks: LoaderCallbacks<LoaderContext> = {
        ...providedCallbacks,
        onSuccess: (...args) => {
          callbackDelivered = true;
          this.retire();
          providedCallbacks.onSuccess(...args);
        },
        onError: (...args) => {
          callbackDelivered = true;
          this.retire();
          providedCallbacks.onError(...args);
        },
        onTimeout: (...args) => {
          callbackDelivered = true;
          this.retire();
          providedCallbacks.onTimeout(...args);
        },
      };
      this.context = context;
      this.callbacks = callbacks;
      this.stats = stats();
      this.headers = new Headers();
      const generation = ++this.generation;
      let range: string | undefined;
      let allowHttp: boolean;
      try {
        const url = new URL(context.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('source-refused');
        allowHttp = options.allowHttp(context.url) === true;
        if (options.requestAllowed && options.requestAllowed(context.url) !== true)
          throw new Error('request-capability-refused');
        if (url.protocol === 'http:' && !allowHttp) throw new Error('http-refused');
        // HLS.js FragmentLoader uses 0/0 for fragments without a byte range.
        const noRange = context.rangeStart === 0 && context.rangeEnd === 0;
        if (!noRange && (context.rangeStart !== undefined || context.rangeEnd !== undefined)) {
          const start = context.rangeStart ?? 0;
          const end = context.rangeEnd;
          if (
            !Number.isSafeInteger(start) ||
            start < 0 ||
            (end !== undefined && (!Number.isSafeInteger(end) || end <= start))
          )
            throw new Error('range-refused');
          range = `bytes=${start}-${end === undefined ? '' : end - 1}`;
        }
      } catch {
        const details = Object.assign(new Response(null), {
          playbackTransportError: Object.freeze({
            category: 'source-policy-refused',
            phase: 'unknown',
          }),
        });
        callbacks.onError({ code: 0, text: 'source-policy-refused' }, context, details, this.stats);
        return;
      }
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      this.stats.loading.start = performance.now();
      const budget = config.loadPolicy?.maxLoadTimeMs ?? config.timeout;
      const releaseTimer = owners.acquire('loaderTimers');
      this.releaseTimer = releaseTimer;
      this.timer = setTimeout(
        () => {
          releaseTimer();
          if (this.releaseTimer === releaseTimer) {
            this.releaseTimer = undefined;
            this.timer = undefined;
          }
          if (generation !== this.generation || this.disposed) return;
          ++this.generation;
          this.stats.aborted = true;
          this.cancel();
          callbacks.onTimeout(this.stats, context, null);
        },
        Math.min(20_000, Number.isFinite(budget) && budget > 0 ? budget : 20_000),
      );
      void work
        .run('nativeLoads', () =>
          network.load({ url: context.url, allowHttp, requestId, ...(range ? { range } : {}) }),
        )
        .then((payload) => {
          if (generation !== this.generation || this.disposed || this.requestId !== requestId)
            return;
          this.requestId = null;
          this.clearTimer();
          this.headers = new Headers(payload.headers);
          const details = new Response(null, { status: payload.status, headers: this.headers });
          this.stats.loading.end = performance.now();
          const timing = payload.timing;
          const deliveredMs = this.stats.loading.end - this.stats.loading.start;
          // Native elapsed times share a monotonic origin. IPC overhead stays in
          // end-to-end load duration, never masquerading as body download TTFB.
          const validTiming =
            timing?.version === 1 &&
            Number.isFinite(timing.firstByteMs) &&
            Number.isFinite(timing.completeMs) &&
            timing.firstByteMs >= 0 &&
            timing.completeMs >= timing.firstByteMs &&
            timing.completeMs <= deliveredMs + 1;
          this.stats.loading.first = validTiming
            ? Math.min(this.stats.loading.end, this.stats.loading.start + timing!.firstByteMs)
            : this.stats.loading.start;
          if (payload.status < 200 || payload.status >= 300) {
            callbacks.onError(
              { code: payload.status, text: 'source-http-error' },
              context,
              details,
              this.stats,
            );
            return;
          }
          if (payload.data.length > 8 * 1024 * 1024) {
            callbacks.onError({ code: 0, text: 'media-too-large' }, context, details, this.stats);
            return;
          }
          // Content steering uses JSON contexts. Bound metadata separately from
          // media before decoding or parsing an untrusted response.
          if (context.responseType === 'json' && payload.data.length > 1024 * 1024) {
            callbacks.onError({ code: 0, text: 'json-too-large' }, context, details, this.stats);
            return;
          }
          const data =
            payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
          if ('frag' in context) options.inspectFragment?.(data);
          if (generation !== this.generation || this.disposed || closing) return;
          this.stats.loaded = this.stats.total = data.byteLength;
          this.stats.chunkCount = 1;
          const elapsed = this.stats.loading.end - this.stats.loading.start;
          this.stats.bwEstimate = elapsed > 0 ? (data.byteLength * 8000) / elapsed : 0;
          let body: string | object | ArrayBuffer;
          try {
            body =
              context.responseType === 'arraybuffer'
                ? // Exactly the body: a frame's view shares its buffer with the
                  // length and metadata in front. Handing over the whole buffer
                  // broke AES-128 keys and segments (ABC TV) and fMP4 streams,
                  // while plain TS still found its sync byte (October 19, 2026).
                  data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                  ? data.buffer
                  : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                : new TextDecoder('utf-8', { fatal: true }).decode(data);
            if (context.responseType === 'json') {
              const parsed: unknown = JSON.parse(body as string);
              if (!parsed || typeof parsed !== 'object') throw new Error('invalid-json');
              body = parsed;
            }
          } catch {
            callbacks.onError(
              { code: 0, text: context.responseType === 'json' ? 'invalid-json' : 'invalid-text' },
              context,
              details,
              this.stats,
            );
            return;
          }
          callbacks.onSuccess(
            { url: payload.url ?? context.url, data: body, code: payload.status },
            this.stats,
            context,
            details,
          );
        })
        .catch((error) => {
          if (generation !== this.generation || this.disposed || callbackDelivered) return;
          this.requestId = null;
          this.clearTimer();
          const failure = classifyTransportFailure(error);
          const categories: Record<string, string> = {
            tls: 'tls-failure',
            dns: 'dns-failure',
            network: 'network-failure',
            policy: 'url-policy-refused',
            timeout: 'timeout',
            unsupported: 'media-too-large',
          };
          const category = categories[failure.code] ?? 'native-network-error';
          const details = Object.assign(new Response(null), {
            playbackTransportError: { category, phase: failure.phase },
          });
          callbacks.onError({ code: 0, text: category }, context, details, this.stats);
        });
    }
  }
  return {
    Loader: NativeHlsLoader,
    pending: work.pending,
    close(): void {
      closing = true;
      const failures: Error[] = [];
      for (const loader of [...loaders]) {
        try {
          loader.destroy();
        } catch {
          failures.push(new Error('Playback loader cleanup failed.'));
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Playback loader cleanup did not finish.');
    },
    settled(timeoutMs = 5000): Promise<void> {
      return closing
        ? work.settled(timeoutMs)
        : Promise.reject(new Error('Playback transport is still active.'));
    },
  };
}
