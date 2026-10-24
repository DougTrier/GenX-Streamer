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
import { SOURCE_INDEX_MAX_BYTES } from '../discovery/source-index';

const invalidRequest = () => new Error('Source directory request is invalid.');
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const controls = /\p{Cc}/u;
function component(raw: string, limit: number, slash = false): boolean {
  try {
    const value = decodeURIComponent(raw);
    return (
      !!value &&
      byteLength(value) <= limit &&
      value !== '.' &&
      value !== '..' &&
      !/[\p{Cc}\p{White_Space}\\?#]/u.test(value) &&
      (slash
        ? value.split('/').every((part) => !!part && part !== '.' && part !== '..')
        : !value.includes('/'))
    );
  } catch {
    return false;
  }
}
function integer(value: string, max: number): boolean {
  return /^[1-9][0-9]*$/u.test(value) && Number(value) <= max;
}
/** Mirrors native source_directory admission before either transport starts. */
function validateEndpoint(raw: string): void {
  if (
    byteLength(raw) > 16_384 ||
    !raw.startsWith('https://api.github.com/') ||
    /[\p{Cc}\p{White_Space}\\]/u.test(raw) ||
    raw.includes('#')
  )
    throw invalidRequest();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRequest();
  }
  const rawPath = raw.slice('https://api.github.com'.length).split('?')[0]!;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== rawPath ||
    rawPath.endsWith('/')
  )
    throw invalidRequest();
  const path = rawPath.split('/').slice(1);
  let mode: 'repo' | 'search' | 'ref' | 'tree';
  if (path.length === 2 && path[0] === 'repositories') {
    if (!integer(path[1]!, Number.MAX_SAFE_INTEGER)) throw invalidRequest();
    mode = 'repo';
  } else if (path.length === 2 && path[0] === 'search' && path[1] === 'repositories')
    mode = 'search';
  else {
    if (
      path.length < 3 ||
      path[0] !== 'repos' ||
      !component(path[1]!, 100) ||
      !/^[A-Za-z0-9_-]+$/u.test(path[1]!) ||
      !component(path[2]!, 100)
    )
      throw invalidRequest();
    if (path.length === 3) mode = 'repo';
    else if (path.length === 4 && path[3] === 'readme') mode = 'ref';
    else if (
      path.length === 6 &&
      path[3] === 'git' &&
      path[4] === 'trees' &&
      component(path[5]!, 256, true)
    )
      mode = 'tree';
    else if (
      path.length >= 5 &&
      path[3] === 'contents' &&
      path.slice(4).every((part) => component(part, 256))
    )
      mode = 'ref';
    else throw invalidRequest();
  }
  if (raw.includes('?')) {
    const query = raw.slice(raw.indexOf('?') + 1);
    try {
      if (!query) throw invalidRequest();
      decodeURIComponent(query);
    } catch {
      throw invalidRequest();
    }
  }
  const keys = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (keys.has(key) || controls.test(value)) throw invalidRequest();
    keys.add(key);
    const valid =
      mode === 'search'
        ? key === 'q'
          ? !!value.trim() && byteLength(value) <= 512
          : key === 'sort'
            ? ['stars', 'forks', 'help-wanted-issues', 'updated'].includes(value)
            : key === 'order'
              ? ['asc', 'desc'].includes(value)
              : key === 'per_page'
                ? integer(value, 100)
                : key === 'page' && integer(value, 1000)
        : mode === 'tree'
          ? key === 'recursive' && value === '1'
          : mode === 'ref' && key === 'ref' && !!value && byteLength(value) <= 256;
    if (!valid) throw invalidRequest();
  }
  if (mode === 'search' && !keys.has('q')) throw invalidRequest();
}

/**
 * Classifies a directory rejection. Returns undefined when it is not a rate limit,
 * null when limited without a published reset, or the reset instant in ms.
 */
export function directoryRateLimitReset(error: unknown): number | null | undefined {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (raw.length > 1024 || !raw.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const failure = value as { code?: unknown; rateLimitReset?: unknown };
  if (failure.code !== 'http-rate-limited') return undefined;
  const reset = failure.rateLimitReset;
  if (typeof reset !== 'string' || !/^\d{1,12}$/u.test(reset)) return null;
  const ms = Number(reset) * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Public directory metadata, never stream bytes, authentication or imports. */
export async function readDirectoryJson(
  raw: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  signal.throwIfAborted();
  if (maxBytes !== SOURCE_INDEX_MAX_BYTES) throw invalidRequest();
  validateEndpoint(raw);
  if (isTauri()) {
    const requestId = crypto.randomUUID();
    const cancellation: { work: Promise<{ ok: true } | { ok: false; error: unknown }> | null } = {
      work: null,
    };
    const cancel = () => {
      // Attach both handlers immediately; the query remains owned until it and
      // cancellation settle, including an early rejected cancellation transport.
      cancellation.work ??= Promise.resolve()
        .then(() => invoke('cancel_playlist', { requestId }))
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const result = await invoke<{ httpStatus: number; json: unknown }>(
        'inspect_source_directory',
        { url: raw, requestId },
      );
      signal.throwIfAborted();
      if (!result || result.httpStatus !== 200 || !Object.hasOwn(result, 'json'))
        throw new Error('Source directory response is invalid.');
      return result.json;
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancellation.work?.then((outcome) => {
        if (!outcome.ok) throw outcome.error;
      });
    }
  }
  const controller = new AbortController(),
    cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 20_000);
  try {
    signal.throwIfAborted();
    const response = await fetch(raw, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      const reset = response.headers.get('x-ratelimit-reset');
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      )
        throw new Error(
          JSON.stringify({
            code: 'http-rate-limited',
            ...(reset && /^\d{1,12}$/u.test(reset) ? { rateLimitReset: reset } : {}),
          }),
        );
      throw new Error('Source directory could not respond.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Source directory response is empty.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0,
      text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) throw new Error('Source directory exceeds its size limit.');
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      signal.throwIfAborted();
      const result: unknown = JSON.parse(text);
      if (result === null || typeof result !== 'object')
        throw new Error('Source directory response is invalid.');
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
