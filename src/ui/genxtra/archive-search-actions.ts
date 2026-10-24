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
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveFavoriteReceipt,
  type ArchiveFile,
  type ArchiveFileProgress,
  type ArchiveFileProgressPage,
  type ArchiveFilesPage,
  type ArchiveItemFilesReceipt,
  type ArchiveLanguageMode,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveRemovalReceipt,
  type ArchiveRemovalTarget,
  type ArchiveSelection,
  type ArchiveTitle,
} from '../../platform/archive-catalog';
import { archiveFavoriteEmptyState } from './archive-empty-state';
import { archivePlayerFailureGuidance } from '../../application/genxtra/archive-player';
import { type ArchiveSearchHost } from './archive-search';
import { type ArchiveContentType } from '../../platform/archive-catalog';
import { type ArchiveDecade } from '../../platform/archive-catalog';
import { type ArchiveDiscoverReceipt } from '../../platform/archive-catalog';
import { type ArchiveDiscoverStep } from '../../platform/archive-catalog';
import { type ArchiveFavoriteRequest } from '../../platform/archive-catalog';
import { type ArchiveFileProgressQuery } from '../../platform/archive-catalog';
import { type ArchiveFilesQuery } from '../../platform/archive-catalog';
import { type ArchiveItemFilesStep } from '../../platform/archive-catalog';
import { type ArchiveProgress } from '../../platform/archive-catalog';
import { type ArchiveProgressQuery } from '../../platform/archive-catalog';
import { type ArchiveRemovalRequest } from '../../platform/archive-catalog';
import { type PublicArchiveDiscoverReceipt } from '../../platform/archive-public-providers';
import { type PublicArchiveDiscoverRequest } from '../../platform/archive-public-providers';

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchActionsEnvironment {
  readonly host: ArchiveSearchHost;
  pendingPage: ArchiveFileProgressPage | null;
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
  readonly savedQuery: string;
  page: ArchivePage | null;
  readonly browseOptions: () => {
    languageMode: ArchiveLanguageMode;
    decade?: ArchiveDecade | null;
    favoritesOnly?: boolean;
    contentType?: ArchiveContentType | 'all';
  };
  revision: string | null;
  expanded: string | null;
  files: ArchiveFilesPage | null;
  readonly render: (preserveDetailDOM?: boolean) => void;
  readonly status: HTMLParagraphElement;
  readonly closed: boolean;
  readonly enabled: boolean;
  readonly syncArtworkContext: () => Promise<void>;
  generation: number;
  abort: AbortController | null;
  readonly clearFilters: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  tail: Promise<void>;
  cleanupFailed: boolean;
  readonly isAbort: (error: unknown) => boolean;
  readonly hideCancel: (scope: string | null) => void;
  failedTitlePage: ArchivePage | null;
  renderedOptions: string;
  readonly language: HTMLSelectElement;
  loadingTitles: boolean;
  readonly titleLimit: number;
  readonly list: HTMLDivElement;
  episodesOpen: boolean;
  readonly doc: Document;
  favoriteBusy: boolean;
  selecting: Promise<void> | null;
  readonly removalBusy: boolean;
  selectionAbort: AbortController | null;
  selectionIdentity: ArchiveSelection | null;
}

/**
 * Running searches and acting on results: pending files, saved titles,
 * favorites, and choosing a title or file. Part of mountArchiveSearch.
 */
export function createArchiveSearchActions(env: ArchiveSearchActionsEnvironment) {
  function loadPendingFiles(progress: ArchiveFileProgress): Promise<void> {
    if (
      !env.host.loadFiles ||
      env.pendingPage === null ||
      progress.complete ||
      progress.capacityReached
    )
      return Promise.resolve();

    const expectedRevision = env.pendingPage.revision;

    return run(async (signal, owner, scope) => {
      const receipt = await env.host.loadFiles!(progress, expectedRevision, signal);

      if (!env.current(owner, scope, signal)) return;

      const result = await env.catalog.query(
        {
          schemaVersion: 1,

          query: env.savedQuery,

          expectedRevision: receipt.revision,

          offset: env.page?.offset ?? 0,

          pageSize: 50,

          ...env.browseOptions(),
        },

        signal,
      );

      const suggestions = await env.host.pendingFiles?.(
        receipt.revision,
        0,
        env.savedQuery,
        signal,
        env.browseOptions().languageMode,
        env.browseOptions().contentType,
      );

      if (!env.current(owner, scope, signal)) return;

      env.revision = receipt.revision;

      env.page = result;

      env.pendingPage = suggestions ?? null;

      env.expanded = null;

      env.files = null;

      env.render();

      env.status.textContent = receipt.admitted
        ? `${receipt.admitted} files saved. Choose a title to see its available files.`
        : 'No suitable files in this checked page. More may remain; temporary failures do not prove removal.';
    }, 'Checking more files…');
  }
  function run(
    work: (signal: AbortSignal, owner: number, scope: string) => Promise<void>,

    message: string,
    failureGuidance = 'Archive request could not finish. Retry, or search online explicitly.',
  ): Promise<void> {
    if (env.closed || !env.enabled) return Promise.resolve();

    const scope = env.host.readyScope();
    const imagesSettled = env.syncArtworkContext();

    if (scope === null) {
      env.status.dataset.passive = 'false';
      env.status.textContent = 'Archive browsing is waiting for local storage.';

      return Promise.resolve();
    }

    const owner = ++env.generation;

    env.abort?.abort();

    const owned = new AbortController();

    env.abort = owned;

    env.status.textContent = message;
    env.status.dataset.passive = 'false';
    env.clearFilters.hidden = true;
    env.clearFilters.disabled = true;

    env.cancel.hidden = false;

    const operation = env.tail.then(async () => {
      if (!env.current(owner, scope, owned.signal)) return;

      try {
        await imagesSettled;
        if (!env.current(owner, scope, owned.signal)) return;
        if (env.cleanupFailed) throw new Error('Archive cleanup could not be confirmed.');
        await work(owned.signal, owner, scope);
      } catch (error) {
        if (owned.signal.aborted && !env.isAbort(error)) env.cleanupFailed = true;

        if (env.current(owner, scope, owned.signal) && !env.isAbort(error))
          env.status.textContent = failureGuidance;
      } finally {
        if (owner === env.generation) {
          env.hideCancel(scope);
          env.clearFilters.disabled = false;

          if (env.abort === owned) env.abort = null;
        }
      }
    });

    env.tail = operation.catch(() => {});

    return operation;
  }
  function queryAt(offset = 0, preserveDetails = false): Promise<void> {
    env.failedTitlePage = null;
    const retainedTitle = env.expanded,
      retainedFiles = env.files,
      retainedPage = env.page;

    return run(async (signal, owner, scope) => {
      const result = await env.catalog.query(
        {
          schemaVersion: 1,

          query: env.savedQuery,

          expectedRevision: offset === 0 ? null : env.revision,

          offset,

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

      env.revision = result.revision;

      env.page =
        preserveDetails &&
        retainedPage?.revision === result.revision &&
        retainedPage.totalCount === result.totalCount &&
        retainedPage.offset === result.offset &&
        retainedPage.items.length > result.items.length
          ? {
              ...retainedPage,
              items: [...result.items, ...retainedPage.items.slice(result.items.length)],
            }
          : result;

      env.renderedOptions = JSON.stringify(env.browseOptions() ?? {});

      const retained =
        preserveDetails &&
        retainedFiles?.revision === result.revision &&
        env.page.items.some((item) => item.titleRef === retainedTitle);

      env.expanded = retained ? retainedTitle : null;

      env.files = retained ? retainedFiles : null;

      env.render();

      env.status.textContent =
        !result.totalCount && env.pendingPage?.totalCount
          ? 'No playable matches yet. Check the saved suggestions below.'
          : result.totalCount
            ? `${result.totalCount} saved ${result.totalCount === 1 ? 'title' : 'titles'}. Select one for episodes or files.`
            : env.language.value === 'english'
              ? 'No videos listed as English. Try All languages, or Search online.'
              : env.language.value === 'unlisted'
                ? 'No videos with an unlisted language. Try All languages.'
                : env.savedQuery.trim()
                  ? 'No saved Archive matches. Use the magnifier to search online.'
                  : 'No curated Archive titles yet. Use the magnifier to search online.';
      const empty = archiveFavoriteEmptyState({
        ...env.browseOptions(),
        query: env.savedQuery,
        totalCount: result.totalCount,
        pendingCount: env.pendingPage?.totalCount,
      });
      if (empty) env.status.textContent = empty.message;
      env.status.dataset.passive = String(result.totalCount > 0);
    }, 'Filtering saved Archive titles…');
  }
  function appendSavedTitles(): Promise<void> {
    const before = env.page;
    if (
      !before?.more ||
      before === env.failedTitlePage ||
      env.loadingTitles ||
      env.abort !== null ||
      !env.enabled ||
      env.closed ||
      before.items.length >= env.titleLimit
    )
      return Promise.resolve();
    const offset = before.offset + before.items.length;
    const query = env.savedQuery;
    const options = env.browseOptions();
    env.loadingTitles = true;
    env.list.setAttribute('aria-busy', 'true');
    return run(
      async (signal, owner, scope) => {
        let result: ArchivePage;
        try {
          result = await env.catalog.query(
            {
              schemaVersion: 1,
              query,
              expectedRevision: before.revision,
              offset,
              pageSize: 50,
              ...options,
            },
            signal,
          );
        } catch (error) {
          if (env.current(owner, scope, signal)) env.failedTitlePage = before;
          throw error;
        }
        if (!env.current(owner, scope, signal) || env.page !== before) return;
        if (
          result.revision !== before.revision ||
          result.offset !== offset ||
          result.totalCount !== before.totalCount ||
          !result.items.length ||
          before.items.length + result.items.length > env.titleLimit ||
          new Set([...before.items, ...result.items].map((item) => item.titleRef)).size !==
            before.items.length + result.items.length
        ) {
          env.failedTitlePage = before;
          throw new Error('Saved Archive title continuation changed.');
        }
        env.page = { ...result, offset: before.offset, items: [...before.items, ...result.items] };
        env.render(true);
        env.status.textContent = 'Scroll to browse saved titles. Select one to see its videos.';
        env.status.dataset.passive = 'true';
      },
      'Loading more saved titles…',
      'More saved titles could not load. Change the search to retry.',
    ).finally(() => {
      env.loadingTitles = false;
      env.list.setAttribute('aria-busy', 'false');
    });
  }
  function filesAt(title: ArchiveTitle, offset: number): Promise<void> {
    if (env.revision === null) return Promise.resolve();

    const expectedRevision = env.revision;

    env.expanded = title.titleRef;
    env.episodesOpen = true;

    env.files = null;

    env.render();

    return run(async (signal, owner, scope) => {
      const result = await env.catalog.files(
        { schemaVersion: 1, titleRef: title.titleRef, expectedRevision, offset, pageSize: 50 },

        signal,
      );

      if (!env.current(owner, scope, signal)) return;

      const focused = env.doc.activeElement;
      const titleStillFocused =
        focused instanceof HTMLElement &&
        focused.matches('.gx-archive-title-button') &&
        focused.dataset.archiveRef === title.titleRef;
      env.files = result;

      env.render();

      if (titleStillFocused && env.current(owner, scope, signal)) {
        const choice = env.list.querySelector<HTMLButtonElement>(
          '.gx-archive-inline-videos:not([hidden]) :is(.gx-archive-file-button:not(:disabled),.gx-archive-file-details > summary)',
        );
        choice?.focus({ preventScroll: true });
        if (choice && env.doc.activeElement === choice)
          choice.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      env.status.textContent = 'Choose a video to play.';
      env.status.dataset.passive = 'true';
    }, 'Loading saved videos…');
  }
  function favorite(title: ArchiveTitle): Promise<void> {
    if (
      !env.host.onFavorite ||
      env.favoriteBusy ||
      env.revision === null ||
      !env.page?.items.some((item) => item.titleRef === title.titleRef)
    )
      return Promise.resolve();

    const expectedRevision = env.revision;
    const retainedTitle = env.expanded;
    const retainedFiles = env.files;
    const retainedCount = env.page.items.length;

    env.favoriteBusy = true;

    env.render();

    return run(async (signal, owner, scope) => {
      const receipt = await env.host.onFavorite!(title, expectedRevision, !title.favorite, signal);

      if (!env.current(owner, scope, signal)) return;

      env.revision = receipt.revision;

      let result = await env.catalog.query(
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

      // Refresh only the already loaded extent after favorite ordering changes.
      while (result.more && result.items.length < retainedCount) {
        const next = await env.catalog.query(
          {
            schemaVersion: 1,
            query: env.savedQuery,
            expectedRevision: receipt.revision,
            offset: result.items.length,
            pageSize: 50,
            ...env.browseOptions(),
          },
          signal,
        );
        if (!env.current(owner, scope, signal)) return;
        result = { ...next, offset: 0, items: [...result.items, ...next.items] };
      }
      const selected = result.items.find((item) => item.titleRef === retainedTitle);
      const refreshedFiles =
        selected && retainedFiles?.titleRef === selected.titleRef
          ? await env.catalog.files(
              {
                schemaVersion: 1,
                titleRef: selected.titleRef,
                expectedRevision: receipt.revision,
                offset: retainedFiles.offset,
                pageSize: 50,
              },
              signal,
            )
          : null;
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

      env.expanded = refreshedFiles?.titleRef ?? null;

      env.files = refreshedFiles;

      env.renderedOptions = JSON.stringify(env.browseOptions() ?? {});

      env.status.textContent = receipt.favorite
        ? 'Title saved to GenXtra favorites.'
        : 'Title removed from GenXtra favorites.';
    }, 'Saving GenXtra favorite…').finally(() => {
      env.favoriteBusy = false;

      if (!env.closed && env.enabled) env.render();
    });
  }
  function choose(title: ArchiveTitle, file: ArchiveFile): Promise<void> {
    if (
      env.selecting ||
      env.removalBusy ||
      env.closed ||
      !env.enabled ||
      !env.files ||
      env.files.revision !== env.revision ||
      env.files.titleRef !== title.titleRef ||
      file.availability === 'dead' ||
      file.providerFacts?.playbackCandidate === false
    )
      return env.selecting ?? Promise.resolve();

    const scope = env.host.readyScope();

    if (
      scope === null ||
      env.revision === null ||
      !env.files.files.some((entry) => entry.fileRef === file.fileRef)
    )
      return Promise.resolve();

    const owned = new AbortController();

    env.selectionAbort = owned;

    const expectedRevision = env.revision;
    const focusQuery = env.savedQuery;
    const focusOptions = JSON.stringify(env.browseOptions());
    const focusGeneration = env.generation;
    let returnFocus =
      env.doc.activeElement instanceof HTMLElement &&
      env.doc.activeElement.matches('.gx-archive-file-button') &&
      env.doc.activeElement.dataset.archiveRef === file.fileRef;
    const selectionInput = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('[inert]')) return;
      const modal = Array.from(env.doc.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
      if (modal && !modal.contains(target)) return;
      if (target.closest('.archive-resume-dialog[open]')) return;
      returnFocus = false;
    };
    const focusInputs = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const name of focusInputs) env.doc.addEventListener(name, selectionInput, true);

    env.selectionIdentity = {
      titleRef: title.titleRef,
      fileRef: file.fileRef,
      expectedRevision,
      title: title.title,
      fileTitle: file.title,
    };

    env.status.textContent = 'Opening selected Archive file…';
    env.status.dataset.passive = 'false';

    const work = Promise.resolve().then(async () => {
      try {
        if (env.closed || !env.enabled || owned.signal.aborted || env.host.readyScope() !== scope)
          return;
        await env.host.onSelect(
          {
            titleRef: title.titleRef,

            fileRef: file.fileRef,

            expectedRevision,

            title: title.title,

            fileTitle: file.title,
          },

          owned.signal,
        );

        if (
          !env.closed &&
          env.enabled &&
          !owned.signal.aborted &&
          env.host.readyScope() === scope
        ) {
          env.status.textContent = 'File selected. Keep browsing or search for another title.';
          env.status.dataset.passive = 'true';
        }
      } catch (error) {
        if (owned.signal.aborted && !env.isAbort(error)) env.cleanupFailed = true;

        if (
          !env.closed &&
          env.enabled &&
          !owned.signal.aborted &&
          env.host.readyScope() === scope
        ) {
          env.status.dataset.passive = 'false';
          env.status.textContent = env.isAbort(error)
            ? 'Playback canceled. Choose a video when ready.'
            : archivePlayerFailureGuidance(error);
        }
      } finally {
        for (const name of focusInputs) env.doc.removeEventListener(name, selectionInput, true);
        if (env.selecting === work) {
          env.selecting = null;

          env.selectionAbort = null;

          env.selectionIdentity = null;

          if (!env.closed && env.enabled) {
            env.render();
            if (
              returnFocus &&
              !env.doc.querySelector('dialog[open]') &&
              !owned.signal.aborted &&
              env.host.readyScope() === scope &&
              env.generation === focusGeneration &&
              env.revision === expectedRevision &&
              env.savedQuery === focusQuery &&
              JSON.stringify(env.browseOptions()) === focusOptions &&
              env.expanded === title.titleRef &&
              env.episodesOpen &&
              env.files?.titleRef === title.titleRef &&
              env.files.revision === expectedRevision
            ) {
              const target = Array.from(
                env.list.querySelectorAll<HTMLButtonElement>(
                  '.gx-archive-file-button:not(:disabled)',
                ),
              ).find((button) => button.dataset.archiveRef === file.fileRef);
              if (target && !target.closest('[hidden],[inert]') && target.getClientRects().length) {
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            }
          }
        }
      }
    });

    env.selecting = work;

    env.render();

    return work;
  }
  return {
    appendSavedTitles,
    queryAt,
    run,
    filesAt,
    favorite,
    choose,
    loadPendingFiles,
  };
}
