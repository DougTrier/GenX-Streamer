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
  archiveRevision,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveDiscoveryView,
  type ArchiveFavoriteReceipt,
  type ArchiveFileProgressPage,
  type ArchiveFilesPage,
  type ArchiveItemFilesReceipt,
  type ArchiveLanguageMode,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveRemovalReceipt,
  type ArchiveRemovalTarget,
  type ArchiveTitle,
} from '../platform/archive-catalog';
import { type ArchiveSearchHost } from './archive-search';
import { type ArchiveContentType } from '../platform/archive-catalog';
import { type ArchiveDecade } from '../platform/archive-catalog';
import { type ArchiveDiscoverReceipt } from '../platform/archive-catalog';
import { type ArchiveDiscoverStep } from '../platform/archive-catalog';
import { type ArchiveFavoriteRequest } from '../platform/archive-catalog';
import { type ArchiveFileProgressQuery } from '../platform/archive-catalog';
import { type ArchiveFilesQuery } from '../platform/archive-catalog';
import { type ArchiveItemFilesStep } from '../platform/archive-catalog';
import { type ArchiveProgress } from '../platform/archive-catalog';
import { type ArchiveProgressQuery } from '../platform/archive-catalog';
import { type ArchiveRemovalRequest } from '../platform/archive-catalog';
import { type PublicArchiveDiscoverReceipt } from '../platform/archive-public-providers';
import { type PublicArchiveDiscoverRequest } from '../platform/archive-public-providers';
import { type ArtworkJob } from './archive-search-artwork';

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchApiEnvironment {
  readonly dismissFilters: (restoreFocus?: boolean) => boolean;
  readonly dismissEpisodes: () => boolean;
  savedQuery: string;
  revision: string | null;
  readonly host: ArchiveSearchHost;
  renderedOptions: string;
  readonly browseOptions: () => {
    languageMode: ArchiveLanguageMode;
    decade?: ArchiveDecade | null;
    favoritesOnly?: boolean;
    contentType?: ArchiveContentType | 'all';
  };
  page: ArchivePage | null;
  pendingPage: ArchiveFileProgressPage | null;
  expanded: string | null;
  files: ArchiveFilesPage | null;
  readonly render: (preserveDetailDOM?: boolean) => void;
  readonly queryAt: (offset?: number, preserveDetails?: boolean) => Promise<void>;
  activeOnlineSearch: { intent: number; scope: string; query: string } | null;
  onlineSearchIntent: number;
  enabled: boolean;
  closed: boolean;
  readonly abort: AbortController | null;
  readonly resultSummary: HTMLParagraphElement;
  readonly status: HTMLParagraphElement;
  readonly series: {
    element: HTMLDivElement;
    clear: () => void;
    show(query: string): Promise<void>;
    dispose: () => void;
  } | null;
  readonly continuationKey: () => string;
  continuationContext: string | null;
  readonly run: (
    work: (signal: AbortSignal, owner: number, scope: string) => Promise<void>,
    message: string,
    failureGuidance?: string,
  ) => Promise<void>;
  readonly current: (owner: number, scope: string, signal: AbortSignal) => boolean;
  readonly catalog: Pick<
    {
      publicDiscoverStep(
        request: PublicArchiveDiscoverRequest,
        signal?: AbortSignal,
      ): Promise<PublicArchiveDiscoverReceipt>;
      remove(
        target: ArchiveRemovalTarget,
        request: ArchiveRemovalRequest,
        signal?: AbortSignal,
      ): Promise<ArchiveRemovalReceipt>;
      itemFilesProgress(
        request: ArchiveFileProgressQuery,
        signal?: AbortSignal,
      ): Promise<ArchiveFileProgressPage>;
      itemFilesStep(
        request: ArchiveItemFilesStep,
        signal?: AbortSignal,
      ): Promise<ArchiveItemFilesReceipt>;
      setFavorite(
        request: ArchiveFavoriteRequest,
        signal?: AbortSignal,
      ): Promise<ArchiveFavoriteReceipt>;
      progress(request: ArchiveProgressQuery, signal?: AbortSignal): Promise<ArchiveProgress>;
      query(request: ArchiveQuery, signal?: AbortSignal): Promise<ArchivePage>;
      files(request: ArchiveFilesQuery, signal?: AbortSignal): Promise<ArchiveFilesPage>;
      artwork(
        request: ArchiveArtworkRequest,
        signal?: AbortSignal,
      ): Promise<ArchiveArtworkResponse | null>;
      discoverStep(
        request: ArchiveDiscoverStep,
        signal?: AbortSignal,
      ): Promise<ArchiveDiscoverReceipt>;
    },
    'query' | 'files'
  >;
  readonly root: HTMLElement;
  confirmation: string | null;
  readonly cancelWork: (preserveSelection?: boolean) => Promise<void>;
  readonly downloadsView: {
    root: HTMLElement;
    fileControls(
      fileRef: string,
      expectedCatalogRevision: string,
      eligible?: boolean,
    ): HTMLDivElement;
    suspend(preserveSelection?: boolean): Promise<void>;
    dispose(): Promise<void>;
  } | null;
  readonly syncDetailsHost: () => void;
  readonly artworkActive: Map<string, ArtworkJob>;
  readonly artworkCache: Map<string, ArchiveArtworkResponse | null>;
  artworkBytes: number;
  readonly artworkQueue: Map<string, ArtworkJob>;
  readonly artworkBindings: Map<string, Map<HTMLElement, ArchiveTitle>>;
  readonly artworkVisible: Set<HTMLElement>;
  disposePromise: Promise<void> | null;
  readonly controls: Array<{
    node: EventTarget;
    type: string;
    listener: EventListener;
    capture: boolean;
  }>;
  readonly artworkObserver: IntersectionObserver | null;
  readonly detailPane: HTMLElement;
  readonly management: HTMLDetailsElement;
}

/**
 * What GenXtra search offers the rest of the application: searching,
 * refreshing, focusing and disposing. Part of mountArchiveSearch.
 */
export function createArchiveSearchApi(env: ArchiveSearchApiEnvironment) {
  const api = {
    dismissFilters: env.dismissFilters,
    dismissEpisodes: env.dismissEpisodes,
    get queryText() {
      return env.savedQuery;
    },

    get catalogRevision() {
      return env.revision;
    },

    query(query = env.host.input.value): Promise<void> {
      const changed =
        query !== env.savedQuery ||
        env.renderedOptions !== JSON.stringify(env.browseOptions() ?? {});
      env.savedQuery = query;
      if (changed) {
        env.page = null;

        env.pendingPage = null;

        env.expanded = null;

        env.files = null;

        env.render();
      }

      return env.queryAt();
    },

    searchProgress(query: string, checked: number): void {
      if (
        !env.activeOnlineSearch ||
        env.activeOnlineSearch.intent !== env.onlineSearchIntent ||
        env.activeOnlineSearch.scope !== env.host.readyScope() ||
        env.activeOnlineSearch.query !== query ||
        query !== env.savedQuery ||
        !env.enabled ||
        env.closed ||
        env.abort?.signal.aborted ||
        !Number.isSafeInteger(checked) ||
        checked < 0
      )
        return;
      env.resultSummary.textContent = `Searching… ${checked} checked`;
    },
    async searchOnline(_intent?: 'search' | 'continue'): Promise<void> {
      const requested = ++env.onlineSearchIntent;
      const query = env.host.input.value;
      const rootScope = env.host.readyScope();
      const capturedOptions = JSON.stringify(env.browseOptions());
      // Search first exposes local results. Typing/resume use query() only and never discover.
      await api.query(query);
      if (
        requested !== env.onlineSearchIntent ||
        env.closed ||
        !env.enabled ||
        rootScope === null ||
        rootScope !== env.host.readyScope() ||
        env.savedQuery !== query ||
        env.host.input.value !== query ||
        JSON.stringify(env.browseOptions()) !== capturedOptions
      )
        return;

      if (!env.host.discover) {
        env.status.dataset.passive = 'false';
        if (env.enabled) env.status.textContent = 'Online Archive search is unavailable.';

        return Promise.resolve();
      }

      if (query.trim()) void env.series?.show(query.trim());
      else env.series?.clear();
      const options = env.browseOptions();
      const view: ArchiveDiscoveryView = {
        schemaVersion: 1,
        languageMode: options.languageMode,
        favoritesOnly: options.favoritesOnly ?? false,
        curatedOnly: false,
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      };

      const key = JSON.stringify([env.continuationKey(), rootScope]);
      const intent = env.continuationContext === key ? 'continue' : 'search';
      env.continuationContext = key;
      env.activeOnlineSearch = { intent: requested, scope: rootScope, query };
      env.resultSummary.textContent = 'Searching…';
      return env
        .run(async (signal, owner, scope) => {
          const receipt = await env.host.discover!(env.savedQuery, signal, intent, view);

          if (!archiveRevision(receipt.revision))
            throw new Error('Archive discovery receipt is invalid.');

          if (!env.current(owner, scope, signal)) return;

          env.revision = receipt.revision;

          const result = await env.catalog.query(
            {
              schemaVersion: 1,

              query: env.savedQuery,

              expectedRevision: env.revision,

              offset: 0,

              pageSize: 50,

              ...env.browseOptions(),
            },

            signal,
          );

          if (!env.current(owner, scope, signal)) return;

          const suggestions = await env.host.pendingFiles?.(
            result.revision,
            0,
            env.savedQuery,
            signal,
            env.browseOptions().languageMode,
            env.browseOptions().contentType,
          );

          if (!env.current(owner, scope, signal)) return;

          env.pendingPage = suggestions ?? null;

          env.page = result;

          env.renderedOptions = JSON.stringify(env.browseOptions() ?? {});

          env.expanded = null;

          env.files = null;

          env.render();

          if (Number.isSafeInteger(receipt.examined) && receipt.examined! >= 0)
            env.resultSummary.textContent += ` · ${receipt.examined} checked`;
          env.status.textContent =
            receipt.outcome === 'waiting'
              ? 'Search paused. Try Search later.'
              : receipt.outcome === 'capacity'
                ? 'Try a different search for more videos.'
                : receipt.outcome === 'canceled'
                  ? 'Search canceled. Search again when ready.'
                  : result.totalCount
                    ? 'Choose a title to see its videos.'
                    : env.pendingPage?.totalCount
                      ? 'More items remain to check.'
                      : receipt.outcome === 'partial'
                        ? 'No matching saved videos yet. Search again to continue.'
                        : 'No matching saved videos. Try another search.';
          env.status.dataset.passive = String(
            result.totalCount > 0 &&
              !['waiting', 'capacity', 'canceled'].includes(receipt.outcome ?? ''),
          );
        }, 'Searching…')
        .finally(() => {
          if (env.activeOnlineSearch?.intent === requested) env.activeOnlineSearch = null;
        });
    },

    resume(query = env.savedQuery): Promise<void> {
      if (env.closed) return Promise.resolve();
      const preserve =
        query === env.savedQuery &&
        env.page !== null &&
        env.renderedOptions === JSON.stringify(env.browseOptions() ?? {});
      env.savedQuery = query;
      if (!preserve) {
        env.page = null;
        env.pendingPage = null;
        env.expanded = null;
        env.files = null;
      }
      env.enabled = true;
      env.root.hidden = false;
      env.render();

      return env.queryAt(preserve ? env.page!.offset : 0, preserve);
    },

    async suspend(options?: { preserveSelection?: boolean }): Promise<void> {
      env.dismissFilters(false);
      env.enabled = false;

      env.root.hidden = true;

      env.confirmation = null;

      env.render();

      await env.cancelWork(options?.preserveSelection === true);
      await env.downloadsView?.suspend(options?.preserveSelection === true);
    },

    cancel: env.cancelWork,

    syncDetails: env.syncDetailsHost,

    /** Bounded resource evidence only: opaque identities and counters, never encoded data or URLs. */
    artworkSnapshot() {
      const reserved = [...env.artworkActive.keys()].filter(
        (key) => !env.artworkCache.has(key),
      ).length;
      return Object.freeze({
        cacheEntries: env.artworkCache.size,
        compressedBytes: env.artworkBytes,
        active: env.artworkActive.size,
        queued: env.artworkQueue.size,
        reservedImages: reserved,
        retainedImageBound: env.artworkCache.size + reserved,
        retainedCompressedByteBound: env.artworkBytes + reserved * 524288,
        bindings: [...env.artworkBindings.values()].reduce((sum, nodes) => sum + nodes.size, 0),
        offscreenRowBindings: [...env.artworkBindings.values()]
          .flatMap((nodes) => [...nodes.keys()])
          .filter(
            (node) => !env.artworkVisible.has(node) && !node.matches('.gx-archive-detail-artwork'),
          ).length,
        cacheKeys: [...env.artworkCache].map(([key, value]) => {
          const [, revision, titleRef] = JSON.parse(key) as [string, string, string];
          return Object.freeze({ titleRef, revision, artworkRef: value?.artworkRef ?? null });
        }),
      });
    },

    dispose(): Promise<void> {
      if (env.disposePromise) return env.disposePromise;
      env.dismissFilters(false);

      env.closed = true;

      env.enabled = false;

      env.root.hidden = true;
      env.series?.dispose();

      env.disposePromise = (async () => {
        await env.cancelWork();
        await env.downloadsView?.dispose();

        for (const owner of env.controls)
          owner.node.removeEventListener(owner.type, owner.listener, owner.capture);

        env.controls.length = 0;

        env.root.remove();
        env.artworkObserver?.disconnect();
        env.artworkCache.clear();
        env.artworkBindings.clear();
        env.artworkVisible.clear();
        env.artworkBytes = 0;
        env.detailPane.remove();
        if (env.host.detailsContainer) env.host.detailsContainer.hidden = true;

        env.management.remove();
      })().catch((error: unknown) => {
        env.disposePromise = null;

        throw error;
      });

      return env.disposePromise;
    },
  };
  return {
    api,
  };
}
