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

import { MAX_CHANNELS, MAX_PLAYLIST_BYTES } from './parser';
import { boundedUtf8Text } from '../platform/bounded-text';
import {
  isPlaylistExportFailureCode,
  type PlaylistExportInput,
  type PlaylistExportResult,
} from './playlist-export';
/** Worker postMessage takes the synchronous snapshot; no whole-catalog main-thread preparation. */
export function exportPlaylistInWorker(
  input: PlaylistExportInput,
  signal: AbortSignal,
): Promise<PlaylistExportResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./playlist-export-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      reject(new Error('playlist-export-worker-failed'));
      return;
    }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      action();
    };
    const abort = () =>
      finish(() => reject(new DOMException('Playlist export canceled.', 'AbortError')));
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(() => reject(new Error('playlist-export-worker-failed')));
    worker.onmessageerror = () =>
      finish(() => reject(new Error('playlist-export-worker-protocol')));
    worker.onmessage = (event: MessageEvent) =>
      finish(() => {
        const reply = event.data;
        if (reply?.ok !== true) {
          reject(
            new Error(
              isPlaylistExportFailureCode(reply?.code)
                ? reply.code
                : 'playlist-export-worker-protocol',
            ),
          );
          return;
        }
        const result = reply.result;
        if (
          !result ||
          result.schemaVersion !== 1 ||
          result.mimeType !== 'audio/x-mpegurl' ||
          result.filename !== 'genx-channels.m3u' ||
          !boundedUtf8Text(result.text, MAX_PLAYLIST_BYTES) ||
          !result.text.startsWith('#EXTM3U\n') ||
          !result.text.endsWith('\n') ||
          !Number.isSafeInteger(result.channelCount) ||
          result.channelCount < 0 ||
          result.channelCount > MAX_CHANNELS ||
          !Number.isSafeInteger(result.streamCount) ||
          result.streamCount < result.channelCount ||
          result.streamCount > MAX_CHANNELS ||
          !Number.isSafeInteger(result.byteLength) ||
          result.byteLength < 8 ||
          result.byteLength > MAX_PLAYLIST_BYTES
        ) {
          reject(new Error('playlist-export-worker-protocol'));
          return;
        }
        resolve(result);
      });
    try {
      worker.postMessage(input);
    } catch {
      finish(() => reject(new Error('playlist-export-worker-protocol')));
    }
    if (signal.aborted) abort();
  });
}
