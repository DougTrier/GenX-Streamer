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
  type ArchiveFileProgressPage,
  type ArchiveFilesPage,
  type ArchiveItemFilesReceipt,
  type ArchiveLanguageMode,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveRemovalReceipt,
  type ArchiveRemovalTarget,
  type ArchiveSelection,
} from '../platform/archive-catalog';
import { type createArchiveSearchRender } from './archive-search-render';
import { type createArchiveSearchActions } from './archive-search-actions';
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

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchRemovalEnvironment {
  readonly doc: Document;
  confirmation: string | null;
  readonly button: (label: string, action: () => void, identity?: string) => HTMLButtonElement;
  readonly render: ReturnType<typeof createArchiveSearchRender>['render'];
  readonly list: HTMLDivElement;
  removalBusy: boolean;
  readonly management: HTMLDetailsElement;
  readonly detailPane: HTMLElement;
  revision: string | null;
  readonly enabled: boolean;
  readonly host: ArchiveSearchHost;
  readonly run: ReturnType<typeof createArchiveSearchActions>['run'];
  readonly selectionIdentity: ArchiveSelection | null;
  readonly selectionAbort: AbortController | null;
  readonly selecting: Promise<void> | null;
  readonly current: (owner: number, scope: string, signal: AbortSignal) => boolean;
  readonly managementStatus: HTMLParagraphElement;
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
  readonly status: HTMLParagraphElement;
  readonly closed: boolean;
}

/**
 * Removing downloaded titles and files, with confirmation. Part of
 * mountArchiveSearch.
 */
export function createArchiveSearchRemoval(env: ArchiveSearchRemovalEnvironment) {
  function removeMatches(target: ArchiveRemovalTarget, selected: ArchiveSelection): boolean {
    return (
      target.kind === 'library' ||
      (target.titleRef === selected.titleRef &&
        (target.kind === 'title' || target.fileRef === selected.fileRef))
    );
  }
  function removalControls(
    target: ArchiveRemovalTarget,
    label: string,
    identity: string,
  ): HTMLElement {
    const group = env.doc.createElement('div');

    group.className = 'gx-archive-remove-confirmation';

    if (env.confirmation === identity) {
      const prompt = env.doc.createElement('p');

      prompt.textContent =
        target.kind === 'library' ? 'Clear your GenXtra library?' : `Remove ${label} from GenXtra?`;

      const yes = env.button(
        target.kind === 'library' ? 'Clear GenXtra' : 'Remove',
        () => {
          void remove(target);
        },
        `${identity}-confirm`,
      );

      const no = env.button(
        'Keep',
        () => {
          env.confirmation = null;
          env.render();
          if (target.kind === 'file')
            env.list
              .querySelector<HTMLElement>(`[data-archive-ref="${target.fileRef}-details"]`)
              ?.focus();
        },
        `${identity}-keep`,
      );

      yes.disabled = no.disabled = env.removalBusy;

      group.append(prompt, yes, no);
    } else {
      const ask = env.button(
        target.kind === 'library' ? 'Clear GenXtra library' : 'Remove from GenXtra',
        () => {
          env.confirmation = identity;
          env.render();

          const parent =
            target.kind === 'library'
              ? env.management
              : target.kind === 'file'
                ? env.list
                : env.detailPane;

          parent
            .querySelector<HTMLButtonElement>(`[data-archive-ref="${identity}-confirm"]`)
            ?.focus();
        },
        identity,
      );

      ask.disabled = env.removalBusy || env.revision === null || !env.enabled;

      group.append(ask);
    }

    return group;
  }
  async function remove(target: ArchiveRemovalTarget): Promise<void> {
    if (!env.host.onRemove || env.removalBusy || env.revision === null) return;

    const expectedRevision = env.revision;

    env.removalBusy = true;

    env.render();

    try {
      await env.run(async (signal, owner, scope) => {
        if (env.selectionIdentity && removeMatches(target, env.selectionIdentity)) {
          env.selectionAbort?.abort();

          await env.selecting;
        }

        if (!env.current(owner, scope, signal)) return;

        const receipt = await env.host.onRemove!(target, expectedRevision, signal);

        // Durable receipt is authoritative even when the caller aborted at COMMIT.

        env.revision = receipt.revision;

        env.confirmation = null;

        const message = receipt.cleanupPending
          ? 'Removed. Playback cleanup needs retry.'
          : target.kind === 'library'
            ? 'GenXtra library cleared.'
            : 'Removed from GenXtra.';

        env.managementStatus.textContent = message;

        if (!env.current(owner, scope, signal)) return;

        const result = await env.catalog.query(
          {
            schemaVersion: 1,
            query: env.savedQuery,
            expectedRevision: receipt.revision,

            offset: 0,
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

        env.page = result;
        env.pendingPage = suggestions ?? null;
        env.expanded = null;
        env.files = null;

        env.status.textContent = message;
      }, 'Removing from GenXtra…');
    } finally {
      env.removalBusy = false;

      if (!env.closed) env.render();
    }
  }
  return {
    removalControls,
  };
}
