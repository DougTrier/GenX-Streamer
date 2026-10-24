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
  MAX_PLAYLIST_BYTES,
  reconcileChannels,
  type Channel,
  type ParsedPlaylist,
  type Source,
} from './parser';

export function parseInWorker(
  text: string,
  sourceId: string,
  signal: AbortSignal,
): Promise<ParsedPlaylist> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Import canceled.', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./parser-worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Import canceled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      cleanup();
      reject(new Error('Playlist worker failed.'));
    };
    worker.onmessage = (
      event: MessageEvent<{ ok: boolean; result: ParsedPlaylist; message: string }>,
    ) => {
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.postMessage({ text, sourceId });
  });
}

export async function downloadPlaylist(
  source: Source,
  signal: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<string> {
  if (source.kind !== 'url') throw new Error('Read local files through the native file picker.');
  const url = new URL(source.location);
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('Playlist sources must use HTTP or HTTPS.');
  if (url.protocol === 'http:' && source.allowHttp !== true)
    throw new Error('HTTP requires explicit source permission.');
  if (url.username || url.password)
    throw new Error('Credentials embedded in playlist URLs are not supported.');
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`Playlist download failed (${response.status}).`);
  if (!response.body) throw new Error('Playlist download has no content.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PLAYLIST_BYTES) throw new Error('Playlist exceeds the 20 MiB limit.');
      text += decoder.decode(chunk.value, { stream: true });
      progress?.(bytes);
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface CatalogAdapter {
  read(sourceId: string): Promise<Channel[]>;
  /** Must check signal immediately before atomic publication. Once published, resolve even if signal aborts. */
  commit(
    sourceId: string,
    channels: Channel[],
    signal: AbortSignal,
    stagedSource: Source,
  ): Promise<void>;
}
export interface RefreshResult {
  status: 'completed' | 'canceled';
  channels?: Channel[];
  warnings?: string[];
}
/** Called inside the atomic catalog mutation, against its current admitted source. */
export function mergeInspectedSource(current: Source | undefined, staged: Source): Source {
  if (
    current &&
    (current.id !== staged.id ||
      current.location !== staged.location ||
      current.kind !== staged.kind ||
      (current.allowHttp === true) !== (staged.allowHttp === true))
  )
    throw new Error('Import source changed. Try again.');
  return {
    ...(current ?? staged),
    contentKind: staged.contentKind,
    mediaMime: staged.mediaMime,
  };
}
export class CatalogRefreshService {
  private active = new Map<string, AbortController>();
  private settlements = new Set<Promise<void>>();
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private adapter: CatalogAdapter,
    private download = downloadPlaylist,
    private parse = parseInWorker,
  ) {}
  cancel(sourceId: string): void {
    this.active.get(sourceId)?.abort();
  }
  async refresh(
    source: Source,
    text?: string,
    progress?: (bytes: number) => void,
  ): Promise<RefreshResult> {
    if (this.disposed) throw new Error('Playlist refresh is closed.');
    // Inspection may update content hints, but only this private snapshot may
    // change before the adapter acknowledges atomic catalog publication.
    const stagedSource = structuredClone(source);
    this.cancel(source.id);
    const controller = new AbortController();
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.settlements.add(settled);
    this.active.set(source.id, controller);
    try {
      const input = text ?? (await this.download(stagedSource, controller.signal, progress));
      const parsed = await this.parse(input, source.id, controller.signal);
      const result = this.queue.then(async () => {
        controller.signal.throwIfAborted();
        const previous = await this.adapter.read(source.id);
        controller.signal.throwIfAborted();
        const channels = reconcileChannels(parsed.channels, previous);
        await this.adapter.commit(source.id, channels, controller.signal, stagedSource);
        return { status: 'completed' as const, channels, warnings: [...parsed.warnings] };
      });
      this.queue = result.catch(() => undefined);
      return await result;
    } catch (error) {
      if (controller.signal.aborted && error instanceof DOMException && error.name === 'AbortError')
        return { status: 'canceled' };
      throw error;
    } finally {
      if (this.active.get(source.id) === controller) this.active.delete(source.id);
      this.settlements.delete(settled);
      release();
    }
  }
  async cancelAll(): Promise<void> {
    const pending = [...this.settlements];
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(pending);
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.cancelAll();
  }
}
