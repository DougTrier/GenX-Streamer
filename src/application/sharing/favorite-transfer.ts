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

import type { DataTransferSetupEnvironment } from '../catalog/data-transfer-setup';
import type { mountGuide } from '../../ui/guide/guide';
import {
  collectFavorites,
  indexFavoriteMatches,
  planFavorites,
  type SharedFavorite,
} from '../../sharing/favorites';

export function createFavoriteTransfer(
  env: DataTransferSetupEnvironment & {
    readonly applicationClosing: boolean;
    readonly guide: ReturnType<typeof mountGuide>;
    catalogBrowseViewRevision: number;
  },
) {
  function ready() {
    if (env.applicationClosing || env.element('app').dataset.ready !== 'true')
      throw new Error('Wait for your saved channels to finish opening.');
  }

  let previewIndex:
    | {
        items: readonly SharedFavorite[];
        catalog: typeof env.catalog;
        index: Awaited<ReturnType<typeof indexFavoriteMatches>>;
        reviewedIds: ReadonlySet<string>;
      }
    | undefined;
  async function plan(items: readonly SharedFavorite[], signal: AbortSignal) {
    ready();
    const catalog = env.catalog;
    const index = await indexFavoriteMatches(catalog, items, signal);
    signal.throwIfAborted();
    const plan = planFavorites(index, env.settings.favorites, env.settings.removedChannels, items);
    const reviewedIds = new Set(plan.matched);
    previewIndex = { items, catalog, index, reviewedIds };
    signal.addEventListener(
      'abort',
      () => {
        if (previewIndex?.items === items) previewIndex = undefined;
      },
      { once: true },
    );
    return {
      ...plan,
      names: catalog.channels.filter(({ id }) => reviewedIds.has(id)).map(({ name }) => name),
    };
  }

  return {
    capture(signal: AbortSignal) {
      ready();
      return collectFavorites(
        env.catalog,
        env.settings.favorites,
        env.settings.removedChannels,
        signal,
      );
    },
    preview: plan,
    async apply(items: readonly SharedFavorite[], signal: AbortSignal) {
      ready();
      if (env.transferBusy || env.importRunning)
        throw new Error('Finish the current channel import first.');
      env.transferBusy = true;
      try {
        signal.throwIfAborted();
        return await env.withPausedGuideUpdates(async () => {
          const work = env.catalogWrites.then(async () => {
            ready();
            if (previewIndex?.items !== items || previewIndex.catalog !== env.catalog)
              throw new Error('Saved channels changed. Reopen the favorites list to review it.');
            const { index, reviewedIds } = previewIndex;
            previewIndex = undefined;
            let result: ReturnType<typeof planFavorites> = {
              matched: [],
              unmatched: 0,
              alreadySaved: 0,
              previouslyRemoved: 0,
            };
            env.settings = await env.preferences.update((draft) => {
              signal.throwIfAborted();
              ready();
              result = planFavorites(index, draft.favorites, draft.removedChannels, items);
              if (result.matched.some((id) => !reviewedIds.has(id)))
                throw new Error('Saved favorites changed. Reopen the list to review it.');
              draft.favorites.push(...result.matched);
            });
            if (result.matched.length) {
              env.catalogBrowseViewRevision++;
              if (!env.applicationClosing) {
                env.guide.catalogChanged(true);
                env.applySettings();
              }
            }
            return {
              added: result.matched.length,
              unmatched: result.unmatched,
              previouslyRemoved: result.previouslyRemoved,
            };
          });
          env.catalogWrites = work.catch(() => undefined);
          return work;
        });
      } finally {
        env.transferBusy = false;
      }
    },
  };
}

export type FavoriteTransfer = ReturnType<typeof createFavoriteTransfer>;
