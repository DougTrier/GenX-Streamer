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
  type AccountVodCategory,
  type AccountVodItem,
  type AccountVodSection,
  type createAccountVod,
} from '../platform/account-vod';
import { type Account, type AccountVodHost } from './account-vod';

/** Titles shown in a category row before its "See all" card. */
const ROW_TITLES = 40;

/** Category rows loading at once (one provider request each). */
const ROW_LOADS = 2;

/** What this part reads from, and writes back to, mountAccountVod. */
export interface AccountVodRowsEnvironment {
  readonly key: () => string;
  readonly rowsBox: HTMLDivElement;
  readonly card: (
    label: string,
    detail: string,
    poster: string | undefined | null,
    action: () => void,
  ) => HTMLButtonElement;
  readonly meta: (item: AccountVodItem) => string;
  readonly section: AccountVodSection;
  readonly playMovie: (item: AccountVodItem) => void;
  readonly openSeries: (item: AccountVodItem) => Promise<void>;
  readonly lastTitle: Map<string, string>;
  readonly lastPlace: Map<string, { mode: 'rows' | 'grid'; category: string; item: string }>;
  readonly markCategory: (id: string) => void;
  readonly featured: AccountVodItem | null;
  readonly feature: (item: AccountVodItem | null) => void;
  readonly make: <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props?: Partial<HTMLElementTagNameMap[K]>,
  ) => HTMLElementTagNameMap[K];
  readonly categories: HTMLDivElement;
  readonly host: AccountVodHost;
  readonly loadCategory: (id: string, name: string) => Promise<void>;
  readonly rowState: Map<string, 'loading' | 'ready' | 'failed'>;
  readonly rowWaiters: Map<string, (() => void)[]>;
  readonly rowQueue: string[];
  rowLoads: number;
  readonly rowItems: Map<string, AccountVodItem[]>;
  rowOwner: AbortController;
  readonly account: Account | null;
  readonly client: Pick<ReturnType<typeof createAccountVod>, 'list' | 'episodes' | 'details'>;
  rowObserver: IntersectionObserver | null;
  readonly mode: 'rows' | 'grid' | 'episodes';
  readonly setMode: (next: 'rows' | 'grid' | 'episodes') => void;
  readonly showGallery: (value: boolean) => void;
  readonly results: HTMLDivElement;
  readonly sectionButtons: HTMLButtonElement[];
  readonly channels: HTMLButtonElement;
}

/**
 * The on-demand screen's category rows: filling them as they scroll into
 * view, one load at a time, and moving between them with the remote. Part of
 * mountAccountVod.
 */
export function createAccountVodRows(env: AccountVodRowsEnvironment) {
  const rowKey = (id: string) => `${env.key()}:${id}`;
  const rowNode = (id: string) =>
    env.rowsBox.querySelector<HTMLElement>(`.vod-row[data-category="${CSS.escape(id)}"]`);
  const rowButtons = (row: Element | null) =>
    row ? [...row.querySelectorAll<HTMLElement>('.vod-strip > button')] : [];
  function titleCard(item: AccountVodItem, category: string, inRow: boolean): HTMLElement {
    const node = env.card(item.name, env.meta(item), item.poster, () =>
      env.section === 'movies' ? env.playMovie(item) : void env.openSeries(item),
    );
    node.dataset.vodItem = item.id;
    node.addEventListener('focus', () => {
      env.lastTitle.set(env.key(), item.id);
      env.lastPlace.set(env.key(), { mode: inRow ? 'rows' : 'grid', category, item: item.id });
      if (inRow) env.markCategory(category);
      if (env.featured !== item) env.feature(item);
    });
    return node;
  }
  function fillRow(id: string, list: AccountVodItem[]): void {
    const row = rowNode(id);
    if (!row) return;
    const strip = row.querySelector<HTMLElement>('.vod-strip')!;
    const total = row.querySelector<HTMLElement>('small')!;
    total.textContent = list.length
      ? `${list.length.toLocaleString()} ${env.section === 'movies' ? 'movies' : 'series'}`
      : '';
    if (!list.length) {
      strip.replaceChildren(
        env.make('p', { className: 'vod-row-note', textContent: 'No titles here.' }),
      );
      row.dataset.empty = 'true';
      return;
    }
    delete row.dataset.empty;
    const nodes = list.slice(0, ROW_TITLES).map((item) => titleCard(item, id, true));
    if (list.length > ROW_TITLES) {
      const all = env.make('button', {
        type: 'button',
        className: 'vod-see-all',
        textContent: `See all (${list.length.toLocaleString()})`,
      });
      all.addEventListener('click', () => {
        const name = env.categories.querySelector<HTMLElement>(
          `[data-category="${CSS.escape(id)}"]`,
        )?.textContent;
        env.host.run(env.loadCategory(id, name ?? ''));
      });
      nodes.push(all);
    }
    strip.replaceChildren(...nodes);
  }
  /** Rows load as they come near; at most ROW_LOADS provider requests at once. */
  function requestRow(id: string): Promise<void> {
    const state = env.rowState.get(rowKey(id));
    if (state === 'ready') return Promise.resolve();
    const waiting = new Promise<void>((resolve) => {
      env.rowWaiters.set(id, [...(env.rowWaiters.get(id) ?? []), resolve]);
    });
    if (state !== 'loading') {
      env.rowState.set(rowKey(id), 'loading');
      env.rowQueue.push(id);
      pumpRows();
    }
    return waiting;
  }
  function settleRow(id: string): void {
    for (const resolve of env.rowWaiters.get(id) ?? []) resolve();
    env.rowWaiters.delete(id);
  }
  function pumpRows(): void {
    while (env.rowLoads < ROW_LOADS && env.rowQueue.length) {
      const id = env.rowQueue.shift()!;
      const cached = env.rowItems.get(rowKey(id));
      if (cached) {
        env.rowState.set(rowKey(id), 'ready');
        fillRow(id, cached);
        settleRow(id);
        continue;
      }
      env.rowLoads++;
      const signal = env.rowOwner.signal;
      const current = env.account!;
      const wanted = env.key();
      void env.client
        .list(current, env.section, id, signal)
        .then((listing) => {
          if (signal.aborted || wanted !== env.key()) return;
          if (env.rowItems.size > 60) env.rowItems.delete(env.rowItems.keys().next().value!);
          env.rowItems.set(rowKey(id), listing.items);
          env.rowState.set(rowKey(id), 'ready');
          fillRow(id, listing.items);
          if (!env.featured && env.rowsBox.querySelector('.vod-title')) {
            const first = listing.items[0];
            if (first) env.feature(first);
          }
        })
        .catch(() => {
          if (signal.aborted) return;
          env.rowState.set(rowKey(id), 'failed');
          const strip = rowNode(id)?.querySelector('.vod-strip');
          strip?.replaceChildren(
            env.make('p', { className: 'vod-row-note', textContent: 'This row could not load.' }),
          );
        })
        .finally(() => {
          env.rowLoads--;
          settleRow(id);
          if (!signal.aborted) pumpRows();
        });
    }
  }
  function buildRows(list: AccountVodCategory[]): void {
    env.rowOwner.abort();
    env.rowOwner = new AbortController();
    env.rowQueue.length = 0;
    env.rowLoads = 0;
    for (const [id] of env.rowWaiters) settleRow(id);
    // New row elements: every row fills again (from the cache when loaded before).
    env.rowState.clear();
    env.rowObserver?.disconnect();
    env.rowObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            void requestRow((entry.target as HTMLElement).dataset.category!);
      },
      { root: env.rowsBox, rootMargin: '400px 0px' },
    );
    env.rowsBox.replaceChildren(
      ...list.map((category) => {
        const row = env.make('section', { className: 'vod-row' });
        row.dataset.category = category.id;
        const title = env.make('div', { className: 'vod-row-head' });
        title.append(env.make('h5', { textContent: category.name }), env.make('small'));
        const strip = env.make('div', { className: 'vod-strip' });
        strip.setAttribute('role', 'list');
        strip.setAttribute('aria-label', category.name);
        strip.append(env.make('p', { className: 'vod-row-note', textContent: 'Loading…' }));
        row.append(title, strip);
        env.rowObserver!.observe(row);
        return row;
      }),
    );
    env.rowsBox.scrollTop = 0;
  }
  /** Rail category: go to its row and its first title. */
  async function jumpToRow(id: string): Promise<void> {
    if (env.mode !== 'rows') env.setMode('rows');
    env.showGallery(true);
    env.markCategory(id);
    rowNode(id)?.scrollIntoView({ block: 'start' });
    await requestRow(id);
    focusCard(rowButtons(rowNode(id))[0]);
  }
  function lastRowCard(): HTMLElement | undefined {
    const place = env.lastPlace.get(env.key());
    const row = place?.mode === 'rows' ? rowNode(place.category) : null;
    const buttons = rowButtons(row);
    return (
      buttons.find((node) => node.dataset.vodItem === place?.item) ??
      buttons[0] ??
      env.rowsBox.querySelector<HTMLElement>('.vod-strip > button') ??
      undefined
    );
  }
  const cards = () => [...env.results.querySelectorAll<HTMLElement>('.vod-title')];
  /** Posters per row, as laid out (the remote moves by this). */
  function columns(list = cards()): number {
    const top = list[0]?.offsetTop;
    let count = 0;
    for (const card of list) {
      if (card.offsetTop !== top) break;
      count++;
    }
    return Math.max(1, count);
  }
  function focusCard(card: HTMLElement | undefined): boolean {
    if (!card) return false;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  function railTarget(): HTMLElement {
    return (
      env.categories.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      env.categories.querySelector<HTMLElement>('button') ??
      env.sectionButtons.find((node) => node.getAttribute('aria-pressed') === 'true') ??
      env.channels
    );
  }
  function lastCard(): HTMLElement | undefined {
    if (env.mode === 'rows') return lastRowCard();
    const id = env.lastTitle.get(env.key());
    const list = cards();
    return list.find((card) => card.dataset.vodItem === id) ?? list[0];
  }
  return {
    titleCard,
    focusCard,
    cards,
    lastRowCard,
    rowButtons,
    rowNode,
    jumpToRow,
    buildRows,
    requestRow,
    columns,
    railTarget,
    lastCard,
  };
}
