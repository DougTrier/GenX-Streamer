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

import {
  discoveryMetadata,
  type CompactDiscoveryMetadata,
  type DiscoveryMetadata,
} from './discovery-metadata';

/** Off-thread parse of published channel metadata; the worker is always terminated. */
export function buildDiscoveryMetadataInWorker(
  channels: string,
  blocklist: string | undefined,
  signal: AbortSignal,
): Promise<DiscoveryMetadata> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./discovery-metadata.worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (result?: DiscoveryMetadata, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(undefined, new DOMException('Discovery metadata canceled.', 'AbortError'));
    const timer = setTimeout(
      () => finish(undefined, new Error('Channel discovery metadata timed out.')),
      20_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ metadata?: CompactDiscoveryMetadata }>) => {
      try {
        if (!event.data.metadata) throw new Error('Channel discovery metadata is unavailable.');
        finish(discoveryMetadata(event.data.metadata));
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error('Metadata failed.'));
      }
    };
    worker.onerror = () => finish(undefined, new Error('Channel discovery metadata failed.'));
    try {
      worker.postMessage({ channels, blocklist });
    } catch {
      finish(undefined, new Error('Channel discovery metadata failed.'));
    }
  });
}
