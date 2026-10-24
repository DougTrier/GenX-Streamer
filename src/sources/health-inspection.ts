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

import { invoke, isTauri } from '@tauri-apps/api/core';
import { inspectSourceResponse, inferMediaMime, type SourceKind } from './index';
export type HealthCheckBudgetMs = 20000 | 45000 | 60000;
export interface HealthInspection {
  status: number;
  retryAfter?: string;
  kind?: SourceKind;
  mime?: string;
}
export interface NativeHealthInspection {
  inspect(input: {
    url: string;
    allowHttp: boolean;
    requestId: string;
    budgetMs: HealthCheckBudgetMs;
  }): Promise<unknown>;
  cancel(requestId: string): Promise<void>;
}
export interface HealthInspectorOptions {
  native?: NativeHealthInspection;
  fetch?: typeof fetch;
}
const MAX_TEXT = 20 * 1024 * 1024;
const SNIFF = 8192;
function healthKind(bytes: Uint8Array, mime: string | undefined): SourceKind {
  const prefix = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trimStart();
  // A split markup/BOM/whitespace prefix must not become media on MIME alone.
  const incompleteBom =
    bytes[0] === 0xef && (bytes.length === 1 || (bytes.length === 2 && bytes[1] === 0xbb));
  return inspectSourceResponse(
    bytes,
    incompleteBom || !prefix || prefix.startsWith('<') ? null : (mime ?? null),
  );
}
class HealthInputError extends Error {}
function urlAllowed(raw: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HealthInputError('Enter a complete source URL.');
  }
  if (
    raw.length > 16_384 ||
    url.username ||
    url.password ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !allowHttp)
  )
    throw new HealthInputError('Use HTTPS or explicitly allow HTTP, without embedded credentials.');
  url.hash = '';
  return url.href;
}
function boundedHeader(value: unknown): string | undefined {
  return typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength <= 128 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value
    : undefined;
}
function validateInspection(raw: unknown): HealthInspection {
  if (!raw || typeof raw !== 'object')
    throw new HealthInputError('The native health response is invalid.');
  const value = raw as Record<string, unknown>;
  if (
    !Number.isInteger(value.status) ||
    Number(value.status) < 100 ||
    Number(value.status) > 599 ||
    Object.keys(value).some((key) => !['status', 'retryAfter', 'kind', 'mime'].includes(key))
  )
    throw new HealthInputError('The native health response is invalid.');
  const status = Number(value.status),
    result: HealthInspection = { status };
  if (value.retryAfter !== undefined) {
    const header = boundedHeader(value.retryAfter);
    if (header === undefined) throw new HealthInputError('The native health response is invalid.');
    result.retryAfter = header;
  }
  if (value.kind !== undefined) {
    if (
      !['catalog', 'hls', 'media', 'unsupported'].includes(String(value.kind)) ||
      status < 200 ||
      status >= 300
    )
      throw new HealthInputError('The native health response is invalid.');
    result.kind = value.kind as SourceKind;
  }
  if (value.mime !== undefined) {
    const mime = boundedHeader(value.mime);
    if (mime === undefined || status < 200 || status >= 300)
      throw new HealthInputError('The native health response is invalid.');
    result.mime = mime;
  }
  return result;
}
async function browserInspect(
  fetcher: typeof fetch,
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
): Promise<HealthInspection> {
  let target = url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await fetcher(target, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw new DOMException('Health check canceled.', 'AbortError');
    }
    if (response.type === 'opaqueredirect') {
      await response.body?.cancel().catch(() => undefined);
      throw new HealthInputError(
        'This browser cannot inspect the redirect safely. Use the native app or final source URL.',
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirect === 5)
        throw new HealthInputError('The source redirect could not be inspected safely.');
      target = urlAllowed(new URL(location, target).href, allowHttp);
      continue;
    }
    urlAllowed(response.url || target, allowHttp);
    const result: HealthInspection = { status: response.status };
    const retry = boundedHeader(response.headers.get('retry-after'));
    if (retry !== undefined) result.retryAfter = retry;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return result;
    }
    const mime = boundedHeader(
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(),
    );
    if (mime !== undefined) result.mime = mime;
    if (!response.body) {
      result.kind = 'unsupported';
      return result;
    }
    const declared = response.headers.get('content-length');
    const reader = response.body.getReader(),
      sample = new Uint8Array(SNIFF),
      chunks: Uint8Array[] = [];
    let length = 0,
      sampled = 0;
    try {
      while (true) {
        if (signal.aborted) throw new DOMException('Health check canceled.', 'AbortError');
        const part = await reader.read();
        if (signal.aborted) throw new DOMException('Health check canceled.', 'AbortError');
        if (part.done) break;
        const amount = Math.min(part.value.byteLength, SNIFF - sampled);
        if (amount) {
          sample.set(part.value.subarray(0, amount), sampled);
          sampled += amount;
        }
        const prefix = sample.subarray(0, sampled),
          kind = healthKind(prefix, mime);
        if (kind === 'media') {
          result.kind = kind;
          result.mime = inferMediaMime(prefix) ?? mime;
          return result;
        }
        if (kind === 'unsupported' && sampled === SNIFF) {
          result.kind = 'unsupported';
          return result;
        }
        length += part.value.byteLength;
        if (
          length > MAX_TEXT ||
          ((kind === 'catalog' || kind === 'hls') &&
            declared !== null &&
            /^\d+$/u.test(declared) &&
            Number(declared) > MAX_TEXT)
        )
          throw new HealthInputError('Source playlist exceeds the 20 MiB health inspection limit.');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      result.kind = healthKind(bytes, mime);
      if (result.kind === 'hls' || result.kind === 'catalog') {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new HealthInputError('Source playlist uses unsupported text encoding.');
        }
      }
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  throw new HealthInputError('The source redirect limit was reached.');
}
/** One inspection, never a decoder claim. Timeout/cancel waits for actual input and native cancellation cleanup. */
export function createHealthInspector(
  options: HealthInspectorOptions = {},
): (
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
  budgetMs?: HealthCheckBudgetMs,
) => Promise<HealthInspection> {
  return async (raw, allowHttp, signal, budgetMs = 20000) => {
    if (![20000, 45000, 60000].includes(budgetMs))
      throw new HealthInputError('Choose a 20, 45 or 60 second health check budget.');
    const url = urlAllowed(raw, allowHttp),
      controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let timeout = false,
      started = false,
      cancelWork = Promise.resolve();
    const requestId = crypto.randomUUID();
    const cancelNative = () => {
      if (started && options.native)
        cancelWork = Promise.resolve()
          .then(() => options.native?.cancel(requestId))
          .then(() => undefined)
          .catch(() => undefined);
    };
    controller.signal.addEventListener('abort', cancelNative, { once: true });
    const timer = setTimeout(() => {
      timeout = true;
      abort();
    }, budgetMs);
    try {
      if (controller.signal.aborted) throw new DOMException('Health check canceled.', 'AbortError');
      let result: HealthInspection;
      if (options.native) {
        started = true;
        result = validateInspection(
          await options.native.inspect({ url, allowHttp, requestId, budgetMs }),
        );
      } else
        result = await browserInspect(options.fetch ?? fetch, url, allowHttp, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Health check canceled.', 'AbortError');
      return result;
    } catch (error) {
      if (timeout) throw 'timeout';
      if (signal.aborted) throw new DOMException('Health check canceled.', 'AbortError');
      if (error instanceof HealthInputError) throw error;
      if (
        typeof error === 'string' &&
        [
          'timeout',
          'dns-failure',
          'tls-failure',
          'connectivity-failure',
          'network-failure',
          'redirect-refused',
          'url-policy-refused',
          'playlist-too-large',
          'playlist-invalid-utf8',
        ].includes(error)
      )
        throw error;
      throw new HealthInputError(
        'The source health check failed. Check connectivity and access restrictions.',
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancelNative);
      await cancelWork;
    }
  };
}
export function inspectHealthSource(
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
  budgetMs: HealthCheckBudgetMs = 20000,
): Promise<HealthInspection> {
  return createHealthInspector(
    isTauri()
      ? {
          native: {
            inspect: (input) => invoke('inspect_health_source', input),
            cancel: (requestId) => invoke('cancel_playlist', { requestId }),
          },
        }
      : {},
  )(url, allowHttp, signal, budgetMs);
}
