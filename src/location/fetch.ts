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
import { boundedUtf8Text } from '../platform/bounded-text';

/** Existing native public-destination/redirect policy applies to these auxiliary requests. */
export async function fetchAuxiliaryText(
  url: string,
  signal: AbortSignal,
  limit = 32_768,
): Promise<string> {
  signal.throwIfAborted();
  if (!isTauri()) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error('Information unavailable.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
      text = '';
    try {
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) throw new Error('Information exceeds its size limit.');
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const requestId = `metadata-${crypto.randomUUID()}`;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= invoke('cancel_playlist', { requestId });
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const text = await invoke<string>('fetch_playlist', { url, allowHttp: false, requestId });
    signal.throwIfAborted();
    if (!boundedUtf8Text(text, limit)) throw new Error('Information exceeds its size limit.');
    return text;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
  }
}
