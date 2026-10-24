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
  validateArchiveArtworkResponse,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveTitle,
} from '../platform/archive-catalog';
import { type ArchiveSearchHost } from './archive-search';

/** One title's artwork request, shared by every result node that shows it. */
export type ArtworkJob = {
  key: string;
  title: ArchiveTitle;
  request: ArchiveArtworkRequest;
  scope: string;
  epoch: number;
  nodes: Set<HTMLElement>;
  controller: AbortController;
  work?: Promise<void>;
};

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchArtworkEnvironment {
  readonly readArtwork:
    | ((
        request: ArchiveArtworkRequest,
        signal?: AbortSignal,
      ) => Promise<ArchiveArtworkResponse | null>)
    | undefined;
  readonly artworkNodes: WeakMap<
    HTMLElement,
    {
      title: ArchiveTitle;
      request: ArchiveArtworkRequest;
      scope: string;
      epoch: number;
      hero: boolean;
    }
  >;
  readonly enabled: boolean;
  readonly closed: boolean;
  artworkEpoch: number;
  readonly artworkVisible: Set<HTMLElement>;
  readonly artworkActive: Map<string, ArtworkJob>;
  readonly artworkQueue: Map<string, ArtworkJob>;
  readonly artworkCache: Map<string, ArchiveArtworkResponse | null>;
  readonly doc: Document;
  readonly artworkBindings: Map<string, Map<HTMLElement, ArchiveTitle>>;
  artworkBytes: number;
  readonly expanded: string | null;
  readonly host: ArchiveSearchHost;
  readonly revision: string | null;
  readonly isAbort: (error: unknown) => boolean;
  cleanupFailed: boolean;
  artworkJoin: Promise<void>;
  readonly continuationKey: () => string;
  artworkContext: string;
}

/**
 * Loading result artwork as it scrolls into view, within a budget. Part of
 * mountArchiveSearch.
 */
export function createArchiveSearchArtwork(env: ArchiveSearchArtworkEnvironment) {
  // Chosen once, before this part is created.
  const readArtwork = env.readArtwork;
  const artworkObserver = readArtwork
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const node = entry.target as HTMLElement;
          const view = env.artworkNodes.get(node);
          if (!view || !env.enabled || env.closed || view.epoch !== env.artworkEpoch) continue;
          if (!entry.isIntersecting && !view.hero) {
            env.artworkVisible.delete(node);
            releaseArtworkBinding(node, view.title);
            for (const job of [...env.artworkActive.values(), ...env.artworkQueue.values()]) {
              job.nodes.delete(node);
              if (!job.nodes.size) {
                job.controller.abort();
                if (env.artworkQueue.get(job.key) === job) env.artworkQueue.delete(job.key);
              }
            }
            continue;
          }
          env.artworkVisible.add(node);
          const key = JSON.stringify([
            view.scope,
            view.request.expectedRevision,
            view.request.titleRef,
          ]);
          if (env.artworkCache.has(key)) {
            const value = env.artworkCache.get(key) ?? null;
            env.artworkCache.delete(key);
            env.artworkCache.set(key, value);
            bindArtwork(node, view.title, value, key);
            continue;
          }
          const active = env.artworkActive.get(key);
          let job =
            active?.epoch === env.artworkEpoch && !active.controller.signal.aborted
              ? active
              : env.artworkQueue.get(key);
          if (!job) {
            if (env.artworkQueue.size >= 24) continue;
            job = { key, ...view, nodes: new Set(), controller: new AbortController() };
            env.artworkQueue.set(key, job);
          }
          for (const previous of job.nodes) if (!previous.isConnected) job.nodes.delete(previous);
          job.nodes.add(node);
        }
        pumpArtwork();
      })
    : null;
  function bindArtwork(
    node: HTMLElement,
    title: ArchiveTitle,
    value: ArchiveArtworkResponse | null,
    key: string,
  ): void {
    if (!value || !node.isConnected || !env.artworkVisible.has(node)) return;
    releaseArtworkBinding(node, title);
    const img = env.doc.createElement('img');
    img.alt = `Provider artwork for ${title.title}`;
    img.decoding = 'async';
    img.width = value.width;
    img.height = value.height;
    img.onerror = () => {
      if (node.contains(img)) {
        releaseArtworkBinding(node, title);
      }
    };
    img.src = value.dataUrl;
    node.replaceChildren(img);
    node.dataset.artwork = 'resolved';
    node.removeAttribute('aria-label');
    const bindings = env.artworkBindings.get(key) ?? new Map<HTMLElement, ArchiveTitle>();
    bindings.set(node, title);
    env.artworkBindings.set(key, bindings);
  }
  function releaseArtworkBinding(node: HTMLElement, title: ArchiveTitle): void {
    for (const [key, bindings] of env.artworkBindings) {
      bindings.delete(node);
      if (!bindings.size) env.artworkBindings.delete(key);
    }
    for (const img of node.querySelectorAll('img')) img.removeAttribute('src');
    node.replaceChildren(
      env.doc.createTextNode(Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase()),
    );
    node.dataset.artwork = 'fallback';
    if (node.matches('.gx-archive-detail-artwork'))
      node.setAttribute('aria-label', 'Artwork not available');
  }
  function reserveArtworkBudget(inFlight: number, incomingBytes = 0, incomingEntries = 0): void {
    while (
      env.artworkCache.size + inFlight + incomingEntries > 8 ||
      env.artworkBytes + inFlight * 524288 + incomingBytes > 4 * 1024 * 1024
    ) {
      const oldest = [...env.artworkCache.keys()].find(
        (key) =>
          ![...(env.artworkBindings.get(key) ?? [])].some(
            ([node, title]) =>
              node.isConnected &&
              node.matches('.gx-archive-detail-artwork') &&
              title.titleRef === env.expanded,
          ),
      );
      if (oldest === undefined) break;
      for (const [node, title] of [...(env.artworkBindings.get(oldest) ?? [])])
        releaseArtworkBinding(node, title);
      env.artworkBytes -= env.artworkCache.get(oldest)?.byteLength ?? 0;
      env.artworkCache.delete(oldest);
    }
  }
  function pumpArtwork(): void {
    if (!readArtwork || env.closed || !env.enabled) return;
    while (env.artworkActive.size < 2 && env.artworkQueue.size) {
      const job = env.artworkQueue.values().next().value!;
      env.artworkQueue.delete(job.key);
      if (job.epoch !== env.artworkEpoch || ![...job.nodes].some((node) => node.isConnected))
        continue;
      reserveArtworkBudget(env.artworkActive.size + 1);
      env.artworkActive.set(job.key, job);
      job.work = Promise.resolve().then(async () => {
        try {
          const raw = await readArtwork(job.request, job.controller.signal);
          if (
            env.closed ||
            !env.enabled ||
            job.controller.signal.aborted ||
            job.epoch !== env.artworkEpoch ||
            env.host.readyScope() !== job.scope ||
            env.revision !== job.request.expectedRevision
          )
            return;
          const value = raw === null ? null : validateArchiveArtworkResponse(raw, job.request);
          env.artworkBytes -= env.artworkCache.get(job.key)?.byteLength ?? 0;
          env.artworkCache.delete(job.key);
          reserveArtworkBudget(env.artworkActive.size - 1, value?.byteLength ?? 0, 1);
          env.artworkCache.set(job.key, value);
          env.artworkBytes += value?.byteLength ?? 0;
          for (const node of job.nodes)
            if (node.isConnected) bindArtwork(node, job.title, value, job.key);
        } catch (error) {
          if (job.controller.signal.aborted && !env.isAbort(error)) env.cleanupFailed = true;
          // Artwork failure leaves a truthful fallback and never changes playback/status.
        } finally {
          if (env.artworkActive.get(job.key) === job) env.artworkActive.delete(job.key);
          pumpArtwork();
        }
      });
    }
  }
  function cancelArtwork(): Promise<void> {
    env.artworkEpoch++;
    artworkObserver?.disconnect();
    env.artworkVisible.clear();
    for (const bindings of [...env.artworkBindings.values()])
      for (const [node, title] of [...bindings]) releaseArtworkBinding(node, title);
    env.artworkQueue.clear();
    for (const job of env.artworkActive.values()) job.controller.abort();
    env.artworkJoin = Promise.all([...env.artworkActive.values()].map((job) => job.work)).then(
      () => undefined,
    );
    return env.artworkJoin;
  }
  function syncArtworkContext(): Promise<void> {
    const next = JSON.stringify([env.continuationKey(), env.host.readyScope()]);
    if (next !== env.artworkContext) {
      env.artworkContext = next;
      return cancelArtwork();
    }
    return env.artworkJoin;
  }
  function observeArtwork(node: HTMLElement, title: ArchiveTitle): void {
    const scope = env.host.readyScope();
    if (!artworkObserver || !env.revision || scope === null || env.closed || !env.enabled) return;
    env.artworkNodes.set(node, {
      title,
      request: { schemaVersion: 1, titleRef: title.titleRef, expectedRevision: env.revision },
      scope,
      epoch: env.artworkEpoch,
      hero: node.matches('.gx-archive-detail-artwork'),
    });
    artworkObserver.observe(node);
  }
  return {
    artworkObserver,
    observeArtwork,
    releaseArtworkBinding,
    syncArtworkContext,
    cancelArtwork,
  };
}
