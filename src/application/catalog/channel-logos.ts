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

import { createChannelLogoAdapter, type ChannelLogoImage } from '../../platform/channel-logos';
interface Channel {
  id: string;
  providerId?: string;
}
export interface ChannelLogosHost {
  readyScope(): { key: string; revision: string } | null;
  changed(): void;
  native?: ReturnType<typeof createChannelLogoAdapter>;
  now?(): number;
}
/** One retained native batch; scroll cancellation joins its original work. */
export function createChannelLogos(host: ChannelLogosHost) {
  const native = host.native ?? createChannelLogoAdapter();
  const images = new Map<string, ChannelLogoImage>();
  const misses = new Map<string, number>();
  let desired: Channel[] = [],
    key = '',
    scopeKey = '',
    generation = 0,
    handled = -1;
  let owner: AbortController | null = null,
    work: Promise<void> | null = null;
  let closed = false;
  const now = host.now ?? Date.now;
  const clear = () => {
    images.clear();
    misses.clear();
  };
  function trim() {
    const visible = new Set(desired.map((c) => c.id));
    let bytes = [...images.values()].reduce((n, i) => n + i.byteLength, 0);
    for (const [id, image] of images) {
      if (images.size <= 32 && bytes <= 8 * 1024 * 1024) break;
      if (!visible.has(id)) {
        images.delete(id);
        bytes -= image.byteLength;
      }
    }
    while (misses.size > 128) misses.delete(misses.keys().next().value!);
  }
  function pump() {
    if (work || closed || desired.length === 0) return;
    const task = Promise.resolve()
      .then(async () => {
        const scope = host.readyScope(),
          intent = generation;
        handled = intent;
        if (!scope || desired.length === 0) return;
        const ids = desired
          .filter((c) => !images.has(c.id) && (misses.get(c.id) ?? 0) <= now())
          .map((c) => c.id);
        if (!ids.length) return;
        const abort = new AbortController();
        owner = abort;
        try {
          const reply = await native.read(ids, scope.revision, abort.signal);
          if (
            abort.signal.aborted ||
            closed ||
            intent !== generation ||
            host.readyScope()?.key !== scope.key
          )
            return;
          for (const id of reply.attemptedChannelIds) misses.set(id, now() + 300000);
          for (const image of reply.images) {
            images.delete(image.channelId);
            images.set(image.channelId, image);
            misses.delete(image.channelId);
          }
          trim();
          host.changed();
        } catch {
          if (!abort.signal.aborted && !closed && intent === generation)
            for (const id of ids) misses.set(id, now() + 60000);
        } finally {
          if (owner === abort) owner = null;
        }
      })
      .finally(() => {
        if (work === task) work = null;
        if (!closed && handled !== generation) pump();
      });
    work = task;
  }
  return {
    get(channel: Channel): string | null {
      if (closed || host.readyScope()?.key !== scopeKey) return null;
      return images.get(channel.id)?.dataUrl ?? null;
    },
    visible(channels: readonly Channel[]) {
      if (closed) return;
      const scope = host.readyScope();
      const next = channels.slice(0, 32).map((c) => ({ id: c.id, providerId: c.providerId }));
      const nextKey = JSON.stringify([scope?.key, next]);
      if (key === nextKey) return;
      if (scope?.key !== scopeKey) {
        clear();
        scopeKey = scope?.key ?? '';
      }
      key = nextKey;
      desired = next;
      generation++;
      owner?.abort();
      trim();
      pump();
    },
    rejected(channel: Channel) {
      images.delete(channel.id);
      misses.set(channel.id, now() + 300000);
    },
    async suspend() {
      generation++;
      key = '';
      desired = [];
      owner?.abort();
      await work;
    },
    async dispose() {
      closed = true;
      owner?.abort();
      await work;
      clear();
      desired = [];
    },
    snapshot() {
      return {
        images: images.size,
        bytes: [...images.values()].reduce((n, i) => n + i.byteLength, 0),
        inFlight: work !== null,
        visible: desired.length,
      };
    },
  };
}
