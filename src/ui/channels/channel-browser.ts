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

import { formatCompactViewingTime } from '../../guide/time';
import { locationSearchText } from '../../search/location-labels';
import { CatalogWindow, type CatalogWindowAnchor, type CatalogWindowHost } from './catalog-window';
import { hasOfficialGeographyLabels } from './geography-controls';
import {
  channelGuideText,
  type ChannelGuideHost,
  type ChannelGuideRow,
  type VisibleGuideChannel,
} from '../guide/channel-guide';
import type { NowPlayingRow } from '../../application/accounts/paid-now-playing';
import { declaredCategoryAliases, categoryAliasMatches } from '../../search/category-aliases';
import { isPpvChannel, hasPpvMarker } from '../../catalog/ppv';
import {
  captureSportsScope,
  matchesSportsFacet,
  matchesSportsSearch,
  planSportsSearch,
  programmeSportsFacts,
  programmeSportsTexts,
  sportsMatchupTitle,
  sportsFacts,
  type SportsFacet,
  type SportsFacts,
  type SportsProgram,
  type SportsScope,
} from '../../search/sports';
import type { LiveTabBrowseState } from '../../application/catalog/live-tab-browse-state';
import { mountSportsFilters } from './sports-filters';
import type { WatchHistoryScope, createWatchHistory } from '../../playback/watch-history';
import {
  compareGeographicChannels,
  matchesGeography,
  type ChannelGeography,
  type GeographyFilter,
  type GeographyRegistry,
} from '../../catalog/geography';
export interface BrowserChannel {
  id: string;
  name: string;
  category: string;
  originalCategory?: string;
  ppv?: boolean;
  cachedPrograms?: readonly SportsProgram[];
  sourceId?: string;
  providerId?: string;
  geography?: ChannelGeography;
}
export type ChannelFilter =
  'all' | 'favorites' | 'news' | 'sports' | 'movies' | 'ppv' | 'unresponsive' | 'watched';
export type CatalogEmptyReason = 'no-sources' | 'empty-sources' | 'removed-channels';
const ROW_HEIGHT = 72;
export interface IndexedBrowserHost extends Omit<CatalogWindowHost, 'changed'> {
  identity(): string;
  /** Root/library/account authority, independent of mutable catalog/view revisions. */
  scopeIdentity?(): string;
  ready?(): boolean;
}
export interface ChannelBrowserOptions {
  sportsControls?: HTMLElement;
  logos?: {
    get(channel: BrowserChannel): string | null;
    visible(channels: readonly BrowserChannel[]): void;
    rejected(channel: BrowserChannel): void;
  };
  /** Includes the four-pixel row gap; at least 48 preserves a 44px control. */
  baseRowHeight?: number | (() => number);
  onFavorite?: (id: string) => void;
  onManage?: (id: string) => void;
  history?: {
    store: Pick<
      ReturnType<typeof createWatchHistory>,
      'load' | 'ids' | 'subscribe' | 'remove' | 'clear'
    >;
    scope(): WatchHistoryScope | null;
    controls?: HTMLElement;
    failed?(): void;
  };
}
interface SearchMetadata {
  channel: BrowserChannel;
  name: string;
  category: string;
  ppv: boolean;
  originalCategory?: string;
  declaredPpv?: boolean;
  sportsFacts: SportsFacts;
  sportsTexts: readonly string[];
  normalizedSportsTexts: readonly string[];
  queryMatch?: { query: string; normal: boolean; semantic: boolean };
  providerId?: string;
  normalizedCategory: string;
  locationText: string;
  providerSearchKey: string;
  searchText: string;
  categoryAliases: readonly string[];
  sortName: string;
}
interface DisplayMetadata {
  name: string;
  category: string;
  originalCategory?: string;
  declaredPpv?: boolean;
  ppv: boolean;
  facts: SportsFacts;
  matchup: string | null;
  program?: {
    title: string;
    description: string | null | undefined;
    categories: string;
    value: string;
  };
}
interface BrowseAnchor {
  window: CatalogWindowAnchor;
  scope: string;
  offset: number;
  scrollTop: number;
  focus: { element: HTMLElement; action: string | undefined } | null;
  intent: number;
}
// Channel browsing keeps contiguous substring matching. NFKC/case folding is
// locale-independent, like the shared search contract; it does not tokenize input.
const searchKey = (value: string): string => value.normalize('NFKC').toLowerCase();
// These reviewed iptv-org identities are search metadata, not proof of network/event coverage.
const networkSearchLabel = (providerId?: string): string => {
  const match = providerId?.match(/^(Fox|NBC|CBS|ABC)\.us(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,255})?$/);
  return match ? match[1].toLowerCase() : '';
};

export class ChannelBrowser {
  private all: BrowserChannel[] = [];
  private visible: BrowserChannel[] = [];
  private searchMetadata: SearchMetadata[] = [];
  // Old catalogs remain collectible: only the current index owns strong references.
  private metadataCache = new WeakMap<BrowserChannel, SearchMetadata>();
  private displayMetadataCache = new WeakMap<BrowserChannel, DisplayMetadata>();
  private sportsPlan = planSportsSearch('');
  private sportsPlanQuery = '';
  private favorites = new Set<string>();
  /** Saved channels that failed quiet checks on two different days. */
  private notResponding: ReadonlySet<string> = new Set<string>();
  private slow: ReadonlySet<string> = new Set<string>();
  private selected: string | null = null;
  private emptyReason: CatalogEmptyReason = 'no-sources';
  private filter: ChannelFilter = 'all';
  private sportsFacet: SportsFacet = {};
  private sportsWindowKey = '';
  private sportsWindow: SportsScope | undefined;
  private sportsControls: ReturnType<typeof mountSportsFilters> | undefined;
  private sportsPpvRows = new Set<string>();
  private programmeMembershipEpoch = 0;
  /** One viewing choice for every library: hide channels labeled adult. */
  private hideAdult = true;
  private query = '';
  private geographyFilter: GeographyFilter = {};
  private geographySort: 'source' | 'geography' | 'name' | null = null;
  private geographyRegistry: GeographyRegistry | null = null;
  private frame = 0;
  private focusedIndex = 0;
  private rowHeight = ROW_HEIGHT;
  private baseRowHeight = ROW_HEIGHT;
  private guideRows: readonly ChannelGuideRow[] = [];
  /** Paid TV rows' current programmes from the stored provider guide. */
  private nowPlaying = new Map<string, NowPlayingRow>();
  private guideForeground = true;
  private reportedGuideScope = '';
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private contentObserver: ResizeObserver;
  private measuredWidth = 0;
  private indexed: CatalogWindow | null = null;
  private focusIntent = 0;
  private browseScope = '';
  private displayAnchor: BrowseAnchor | null = null;
  private restoredFocus: {
    id: string;
    action: string | undefined;
    element: HTMLElement;
    intent: number;
  } | null = null;
  private countElement: Element | null;
  private emptyElement: HTMLElement | null;
  private resizedFocus: { id: string; intent: number; sidebarTop: number | null } | null = null;
  private historyReady = false;
  private historyFailed = false;
  private presentedHistoryScope: string | undefined;
  private historyJobs = new Set<Promise<void>>();
  private historyUnsubscribe?: () => void;
  private clearHistoryButton?: HTMLButtonElement;
  constructor(
    private list: HTMLElement,
    private onSelect: (id: string) => void,
    private guideHost?: ChannelGuideHost,
    private indexedHost?: IndexedBrowserHost,
    private options: ChannelBrowserOptions = {},
  ) {
    this.countElement = list.ownerDocument.querySelector('#channel-count');
    this.emptyElement = list.ownerDocument.querySelector('#list-empty');
    this.rowHeight = this.baseRowHeight = this.resolveBaseRowHeight();
    this.list.style.setProperty('--channel-row-height', `${this.rowHeight}px`);
    if (indexedHost)
      this.indexed = new CatalogWindow({
        ...indexedHost,
        captureAnchor: () => this.captureAnchor(),
        restoreAnchor: (anchor, index, id) => this.restoreAnchor(anchor, index, id),
        changed: () => {
          if (this.disposed || !this.useIndexed()) return;
          if (this.indexed?.failed) this.displayAnchor = null;
          this.updateCount();
          this.schedule();
        },
      });
    list.addEventListener('scroll', this.schedule);
    list.addEventListener('click', this.click);
    list.addEventListener('keydown', this.keydown);
    list.addEventListener('focusin', this.focusin);
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.list.getBoundingClientRect().width;
      if (this.measuredWidth > 0 && width !== this.measuredWidth)
        this.resizeRows(this.baseRowHeight);
      this.measuredWidth = width;
      this.schedule();
    });
    this.resizeObserver.observe(list);
    this.contentObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      // Every rendered title participates, not just the first overscan row.
      // Keep the largest pitch at this width so overscan cannot oscillate it.
      let height = this.rowHeight;
      for (const copy of this.list.querySelectorAll<HTMLElement>('.channel-copy')) {
        const button = copy.closest<HTMLElement>('.channel');
        if (!button) continue;
        const style = getComputedStyle(button);
        height = Math.max(
          height,
          Math.ceil(
            copy.getBoundingClientRect().height +
              parseFloat(style.paddingTop) +
              parseFloat(style.paddingBottom) +
              6,
          ),
        );
      }
      if (!Number.isFinite(height) || height === this.rowHeight) return;
      this.resizeRows(height);
      this.schedule();
    });
    if (options.sportsControls)
      this.sportsControls = mountSportsFilters(options.sportsControls, (facet) =>
        this.setSportsFacet(facet),
      );
    if (options.history) {
      this.historyUnsubscribe = options.history.store.subscribe(() => {
        if (!this.disposed && this.filter === 'watched') this.apply();
      });
      if (options.history.controls) {
        const button = list.ownerDocument.createElement('button');
        button.type = 'button';
        button.id = 'clear-watch-history';
        button.className = 'row-filter';
        button.textContent = 'Clear History';
        button.hidden = true;
        button.addEventListener('click', this.clearHistoryClick);
        options.history.controls.append(button);
        this.clearHistoryButton = button;
      }
      this.trackHistory(
        options.history.store.load().then(() => {
          if (this.disposed) return;
          this.historyReady = true;
          this.apply();
        }),
      );
    }
  }
  private historyIds(): string[] {
    const history = this.options.history;
    const scope = history?.scope();
    return this.historyReady && history && scope ? history.store.ids(scope) : [];
  }
  /** A fresh exact active-tab/account snapshot; never the visible or overscan page. */
  getWatchedIds(): string[] {
    return [...this.historyIds()];
  }
  private trackHistory(work: Promise<void>, scopeKey?: string): Promise<void> {
    const observed = work
      .catch(() => {
        if (
          this.disposed ||
          (scopeKey !== undefined && scopeKey !== JSON.stringify(this.options.history?.scope()))
        )
          return;
        this.historyFailed = true;
        try {
          this.options.history?.failed?.();
        } catch {
          /* Observers do not own persistence. */
        }
      })
      .finally(() => {
        this.historyJobs.delete(observed);
        if (!this.disposed) this.updateCount();
      });
    this.historyJobs.add(observed);
    return observed;
  }
  private clearHistoryClick = (): void => {
    void this.clearHistory();
  };
  clearHistory(): Promise<void> {
    const history = this.options.history,
      scope = history?.scope();
    if (
      this.disposed ||
      this.filter !== 'watched' ||
      !this.historyReady ||
      !history ||
      !scope ||
      JSON.stringify(scope) !== this.presentedHistoryScope
    )
      return Promise.resolve();
    this.historyFailed = false;
    if (this.clearHistoryButton === this.list.ownerDocument.activeElement)
      this.list.focus({ preventScroll: true });
    const work = this.trackHistory(history.store.clear(scope), JSON.stringify(scope));
    this.updateCount();
    return work;
  }
  private removeHistory(id: string): void {
    const history = this.options.history,
      scope = history?.scope();
    if (
      this.disposed ||
      this.filter !== 'watched' ||
      !history ||
      !scope ||
      JSON.stringify(scope) !== this.presentedHistoryScope ||
      !this.historyIds().includes(id)
    )
      return;
    this.historyFailed = false;
    this.trackHistory(history.store.remove(scope, id), JSON.stringify(scope));
    this.updateCount();
  }
  private resizeRows(height: number): void {
    // The replacement page will re-observe its text. Until then the old rows
    // and scroll range must use the same geometry as the captured anchor.
    if (this.displayAnchor && this.useIndexed()) return;
    const position = this.list.scrollTop / this.rowHeight;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && this.list.contains(active)
        ? this.indexOf(active.dataset.channel ?? active.dataset.channelId)
        : -1;
    if (height > this.rowHeight && focused >= 0 && active instanceof HTMLElement) {
      const id = active.dataset.channel ?? active.dataset.channelId;
      const box = active.getBoundingClientRect();
      const viewport = this.list.getBoundingClientRect();
      const sidebar = this.list.closest<HTMLElement>('.browser');
      const outer = sidebar?.getBoundingClientRect();
      const top = Math.max(0, viewport.top, outer ? outer.top + sidebar!.clientTop : viewport.top);
      const bottom = Math.min(
        window.innerHeight,
        viewport.bottom,
        outer ? outer.top + sidebar!.clientTop + sidebar!.clientHeight : viewport.bottom,
      );
      if (id && box.bottom > top && box.top < bottom)
        this.resizedFocus = {
          id,
          intent: this.focusIntent,
          sidebarTop: sidebar?.scrollTop ?? null,
        };
    }
    this.rowHeight = height;
    this.list.style.setProperty('--channel-row-height', `${height}px`);
    // Extend the scroll range before assigning the new offset; otherwise the
    // browser clamps an expanded last-row offset against the old spacer.
    const spacer = this.list.querySelector<HTMLElement>('#channel-spacer');
    if (spacer) spacer.style.height = `${this.length * height}px`;
    let top = position * height;
    if (focused >= 0) {
      if (focused * height < top || height > this.list.clientHeight) top = focused * height;
      else if ((focused + 1) * height > top + this.list.clientHeight)
        top = (focused + 1) * height - this.list.clientHeight;
    }
    this.list.scrollTop = Math.max(0, top);
  }
  private revealInSidebar(target: HTMLElement | null | undefined): void {
    if (!target || this.disposed || !this.list.contains(target)) return;
    const sidebar = this.list.closest<HTMLElement>('.browser');
    if (
      !sidebar ||
      !/auto|scroll/.test(getComputedStyle(sidebar).overflowY) ||
      sidebar.scrollHeight <= sidebar.clientHeight
    )
      return;
    const bounds = sidebar.getBoundingClientRect();
    const top = bounds.top + sidebar.clientTop + 2;
    const bottom = bounds.top + sidebar.clientTop + sidebar.clientHeight - 2;
    let row = (target.closest<HTMLElement>('.channel-row') ?? target).getBoundingClientRect();
    if (row.height > bottom - top)
      row = target.dataset.channelAction
        ? target.getBoundingClientRect()
        : (target.querySelector<HTMLElement>('.channel-copy') ?? target).getBoundingClientRect();
    const delta =
      row.height > bottom - top || row.top < top
        ? row.top - top
        : row.bottom > bottom
          ? row.bottom - bottom
          : 0;
    if (delta) sidebar.scrollTop += delta;
  }
  private pageOversizedRow(key: string, target: HTMLElement): boolean {
    if ((key !== 'ArrowUp' && key !== 'ArrowDown') || target.dataset.channelAction) return false;
    const sidebar = this.list.closest<HTMLElement>('.browser');
    if (!sidebar || !/auto|scroll/.test(getComputedStyle(sidebar).overflowY)) return false;
    const bounds = sidebar.getBoundingClientRect();
    const top = bounds.top + sidebar.clientTop + 2;
    const bottom = bounds.top + sidebar.clientTop + sidebar.clientHeight - 2;
    const row = (
      target.querySelector<HTMLElement>('.channel-copy') ?? target
    ).getBoundingClientRect();
    if (row.height <= bottom - top) return false;
    const remaining = key === 'ArrowDown' ? row.bottom - bottom : top - row.top;
    if (remaining <= 1) return false;
    const previous = sidebar.scrollTop;
    sidebar.scrollTop += (key === 'ArrowDown' ? 1 : -1) * Math.min((bottom - top) * 0.8, remaining);
    return Math.abs(sidebar.scrollTop - previous) > 0.5;
  }
  private resolveBaseRowHeight(): number {
    const height =
      typeof this.options.baseRowHeight === 'function'
        ? this.options.baseRowHeight()
        : (this.options.baseRowHeight ?? ROW_HEIGHT);
    if (!Number.isSafeInteger(height) || height < 48 || height > 512)
      throw new Error('Channel row height is invalid.');
    return height;
  }
  private displayMetadata(channel: BrowserChannel): DisplayMetadata {
    const cached = this.displayMetadataCache.get(channel);
    if (
      cached &&
      cached.name === channel.name &&
      cached.category === channel.category &&
      cached.originalCategory === channel.originalCategory &&
      cached.declaredPpv === channel.ppv
    )
      return cached;
    const searchable = this.metadataCache.get(channel);
    const valid =
      searchable?.name === channel.name &&
      searchable.category === channel.category &&
      searchable.originalCategory === channel.originalCategory &&
      searchable.declaredPpv === channel.ppv;
    const facts = valid
      ? searchable.sportsFacts
      : sportsFacts([channel.name, channel.category, channel.originalCategory ?? '']);
    const value: DisplayMetadata = {
      name: channel.name,
      category: channel.category,
      originalCategory: channel.originalCategory,
      declaredPpv: channel.ppv,
      ppv: valid ? searchable.ppv : isPpvChannel(channel),
      facts,
      matchup: sportsMatchupTitle(channel.name, facts),
    };
    this.displayMetadataCache.set(channel, value);
    return value;
  }
  private useIndexed(): boolean {
    return (
      !!this.indexed &&
      this.indexedHost?.ready?.() !== false &&
      (!this.geographyRegistry || hasOfficialGeographyLabels(this.geographyRegistry))
    );
  }
  private get length(): number {
    return this.useIndexed()
      ? this.indexed!.countKnown
        ? this.indexed!.total
        : 0
      : this.visible.length;
  }
  private at(index: number): BrowserChannel | undefined {
    return this.useIndexed() ? this.indexed!.row(index) : this.visible[index];
  }
  private indexOf(id: string | null | undefined): number {
    return this.useIndexed()
      ? this.indexed!.indexOf(id ?? null)
      : this.visible.findIndex((row) => row.id === id);
  }
  private captureAnchor(): CatalogWindowAnchor | null {
    if (this.displayAnchor) return this.displayAnchor.window;
    if (!this.length) return null;
    const active = document.activeElement;
    const owned = active instanceof HTMLElement && this.list.contains(active) ? active : null;
    const focused = owned ? this.indexOf(owned.dataset.channel ?? owned.dataset.channelId) : -1;
    const top = this.list.scrollTop;
    const focusedVisible =
      focused >= 0 &&
      (focused + 1) * this.rowHeight > top &&
      focused * this.rowHeight < top + this.list.clientHeight;
    const index = focusedVisible
      ? focused
      : Math.min(this.length - 1, Math.floor(top / this.rowHeight));
    const row = this.at(index);
    if (!row) return null;
    const anchor: CatalogWindowAnchor = {
      id: row.id,
      index,
      alternatives: [this.at(index + 1)?.id, this.at(index - 1)?.id].filter(
        (id): id is string => !!id,
      ),
    };
    this.displayAnchor = {
      window: anchor,
      scope: this.browseScope,
      offset: index * this.rowHeight - top,
      scrollTop: top,
      focus:
        focusedVisible && owned ? { element: owned, action: owned.dataset.channelAction } : null,
      intent: this.focusIntent,
    };
    return anchor;
  }
  private restoreAnchor(anchor: CatalogWindowAnchor, index: number, id: string): void {
    const saved = this.displayAnchor;
    if (!saved || saved.window !== anchor || saved.scope !== this.browseScope || this.disposed)
      return;
    if (saved.scope !== this.scopeKey()) {
      this.displayAnchor = null;
      this.apply();
      return;
    }
    this.displayAnchor = null;
    const delta = this.list.scrollTop - saved.scrollTop;
    const spacer = this.list.querySelector<HTMLElement>('#channel-spacer');
    if (spacer) spacer.style.height = `${this.length * this.rowHeight}px`;
    this.list.scrollTop = Math.max(0, index * this.rowHeight - saved.offset + delta);
    this.focusedIndex = index;
    // A background result owns only the focus it captured. In particular it
    // cannot take focus back from search, settings, or another library.
    if (
      id &&
      saved.focus &&
      saved.intent === this.focusIntent &&
      (document.activeElement === saved.focus.element || document.activeElement === this.list)
    )
      this.restoredFocus = {
        id,
        action: saved.focus.action,
        element: saved.focus.element,
        intent: saved.intent,
      };
  }
  private schedule = (): void => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };
  private click = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-channel-action]',
    );
    if (action?.dataset.channelId) {
      if (action.dataset.channelAction === 'favorite')
        this.options.onFavorite?.(action.dataset.channelId);
      else if (action.dataset.channelAction === 'history-remove')
        this.removeHistory(action.dataset.channelId);
      else this.options.onManage?.(action.dataset.channelId);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-channel]');
    if (button?.dataset.channel) this.onSelect(button.dataset.channel);
  };
  private focusin = (event: FocusEvent): void => {
    const target = event.target as HTMLElement;
    if (this.displayAnchor?.focus && target !== this.displayAnchor.focus.element)
      this.focusIntent++;
    const id =
      target.dataset.channelId ?? target.closest<HTMLElement>('[data-channel]')?.dataset.channel;
    const index = this.indexOf(id);
    if (index >= 0) this.focusedIndex = index;
  };
  private keydown = (event: KeyboardEvent): void => {
    const targetControl = event.target as HTMLElement;
    const rowControls = targetControl
      .closest('.channel-row')
      ?.querySelectorAll<HTMLButtonElement>('button');
    if (rowControls && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const controls = [...rowControls];
      const next =
        controls.indexOf(targetControl as HTMLButtonElement) +
        (event.key === 'ArrowRight' ? 1 : -1);
      if (controls[next]) {
        event.preventDefault();
        controls[next].focus({ preventScroll: true });
        this.revealInSidebar(controls[next]);
        return;
      }
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key) || !this.length)
      return;
    const target = event.target as HTMLElement;
    const currentId =
      target.closest<HTMLElement>('.channel-row')?.querySelector<HTMLElement>('[data-channel]')
        ?.dataset.channel ?? target.closest<HTMLButtonElement>('[data-channel]')?.dataset.channel;
    if (event.key === 'Enter' && currentId) return; // Native button activation owns select.
    const current = currentId ? this.indexOf(currentId) : -1;
    // Read an oversized card's remaining lines before leaving its row.
    if (current >= 0 && this.pageOversizedRow(event.key, target)) {
      event.preventDefault();
      return;
    }
    // Up and Down keep the column: the star stays on stars, the menu on menus.
    const column = rowControls ? [...rowControls].indexOf(targetControl as HTMLButtonElement) : 0;
    const focusRow = (id: string | undefined) => {
      const main = [...this.list.querySelectorAll<HTMLButtonElement>('[data-channel]')].find(
        (button) => button.dataset.channel === id,
      );
      const controls = main?.closest('.channel-row')?.querySelectorAll<HTMLButtonElement>('button');
      const control = controls?.[Math.max(0, column)] ?? main;
      control?.focus({ preventScroll: true });
      this.revealInSidebar(control);
    };
    // At a list boundary the shared remote navigator owns the route to other controls.
    if (
      (event.key === 'ArrowUp' && current === 0) ||
      (event.key === 'ArrowDown' && current === this.length - 1)
    )
      return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? this.length - 1
          : Math.min(this.length - 1, Math.max(0, current + (event.key === 'ArrowUp' ? -1 : 1)));
    if (event.key === 'Enter') {
      const row = this.at(Math.max(0, current));
      if (row) this.onSelect(row.id);
      return;
    }
    if (this.rowHeight > this.list.clientHeight || next * this.rowHeight < this.list.scrollTop)
      this.list.scrollTop = next * this.rowHeight;
    else if ((next + 1) * this.rowHeight > this.list.scrollTop + this.list.clientHeight)
      this.list.scrollTop = (next + 1) * this.rowHeight - this.list.clientHeight;
    this.focusedIndex = next;
    const intent = ++this.focusIntent;
    if (this.useIndexed() && !this.at(next)) {
      this.indexed!.ensure(next);
      void this.indexed!.settled().then(() => {
        if (
          this.disposed ||
          intent !== this.focusIntent ||
          !this.list.contains(document.activeElement)
        )
          return;
        this.render();
        const row = this.at(next);
        if (row) focusRow(row.id);
      });
    }
    this.render();
    focusRow(this.at(next)?.id);
  };
  update(
    channels: BrowserChannel[],
    favorites: string[],
    selected: string | null,
    emptyReason?: CatalogEmptyReason,
  ): void {
    this.all = channels;
    if (emptyReason !== undefined) this.emptyReason = emptyReason;
    if (this.indexedHost?.ready?.() === false) {
      // A suspended native catalog will render again when its owner admits browsing.
      // Do not index the entire retained library on the UI thread while waiting.
      this.favorites = new Set(favorites);
      this.selected = selected;
      return;
    }
    if (this.useIndexed()) {
      this.favorites = new Set(favorites);
      this.selected = selected;
      this.apply();
      return;
    }
    this.searchMetadata = channels.map((channel) => {
      const previous = this.metadataCache.get(channel);
      const locationText = locationSearchText(channel.geography, this.geographyRegistry);
      if (
        previous &&
        previous.name === channel.name &&
        previous.category === channel.category &&
        previous.originalCategory === channel.originalCategory &&
        previous.declaredPpv === channel.ppv &&
        previous.providerId === channel.providerId &&
        previous.locationText === locationText
      )
        return previous;
      const normalizedCategory = searchKey(channel.category);
      const sportsTexts = [channel.name, channel.category, channel.originalCategory ?? ''];
      const normalizedSportsTexts = [
        ...sportsTexts.map(searchKey),
        searchKey(locationText),
        networkSearchLabel(channel.providerId),
      ];
      const metadata = {
        channel,
        name: channel.name,
        category: channel.category,
        ppv: isPpvChannel(channel),
        originalCategory: channel.originalCategory,
        declaredPpv: channel.ppv,
        sportsFacts: sportsFacts(sportsTexts),
        sportsTexts,
        normalizedSportsTexts,
        providerId: channel.providerId,
        normalizedCategory,
        locationText,
        providerSearchKey: channel.providerId === undefined ? '' : searchKey(channel.providerId),
        searchText: `${searchKey(channel.name)} ${normalizedCategory} ${searchKey(channel.originalCategory ?? '')} ${networkSearchLabel(channel.providerId)} ${locationText}`,
        categoryAliases: declaredCategoryAliases(channel.category),
        sortName: channel.name.normalize('NFC').toLowerCase(),
      };
      this.metadataCache.set(channel, metadata);
      return metadata;
    });
    this.favorites = new Set(favorites);
    this.selected = selected;
    this.apply();
  }
  search(query: string): void {
    this.query = searchKey(query.trim());
    this.apply();
  }
  setHideAdult(hide: boolean): void {
    if (this.hideAdult === hide) return;
    this.hideAdult = hide;
    this.apply();
  }
  setFilter(filter: ChannelFilter): void {
    this.filter = filter;
    this.sportsControls?.setActive(filter === 'sports');
    this.apply();
  }
  setSportsFacet(facet: SportsFacet): void {
    captureSportsScope('', facet);
    this.sportsFacet = { ...facet };
    this.sportsControls?.setFacet(facet);
    this.apply();
  }
  getBrowseState(): LiveTabBrowseState {
    return {
      filter: this.filter,
      query: this.query,
      sportsFacet: { ...this.sportsFacet },
      geography: this.getGeographyFilter(),
      sort: this.geographySort ?? 'source',
    };
  }
  /** Apply one tab's UI choices together; a restored tab receives a fresh saved-schedule window. */
  restoreBrowseState(state: LiveTabBrowseState): void {
    captureSportsScope('', state.sportsFacet);
    this.filter = state.filter;
    this.query = searchKey(state.query.trim());
    this.sportsFacet = { ...state.sportsFacet };
    this.geographyFilter = {
      ...state.geography,
      ...(state.geography.countries ? { countries: [...state.geography.countries] } : {}),
    };
    this.geographySort = state.sort;
    this.sportsWindowKey = '';
    this.sportsControls?.setFacet(this.sportsFacet);
    this.sportsControls?.setActive(this.filter === 'sports');
    this.apply();
  }
  getSportsScope(): SportsScope | undefined {
    const facet = this.filter === 'sports' ? this.sportsFacet : {};
    const key = JSON.stringify([this.query, facet]);
    if (key !== this.sportsWindowKey) {
      this.sportsWindowKey = key;
      this.sportsWindow = captureSportsScope(this.query, facet);
    }
    return this.sportsWindow ? { ...this.sportsWindow } : undefined;
  }
  /** A committed cached schedule update can change this query's admitted channels. */
  refreshProgrammeMembership(): void {
    if (this.disposed || !this.getSportsScope()) return;
    this.programmeMembershipEpoch++;
    this.apply();
  }
  private savedProgrammes(channel: BrowserChannel, scope: SportsScope): readonly SportsProgram[] {
    const guide = this.guideRows.find(
      (row) => row.appChannelId === channel.id && row.catalogSourceId === channel.sourceId,
    )?.summary;
    const current = this.nowPlaying.get(JSON.stringify([channel.sourceId, channel.id]));
    return [
      ...(channel.cachedPrograms ?? []),
      ...(guide?.current ? [guide.current] : []),
      ...(guide?.next ? [guide.next] : []),
      ...(current ? [current] : []),
    ].filter((program) =>
      program.stopMs === null
        ? program.startMs >= scope.windowStartMs && program.startMs < scope.windowEndMs
        : program.startMs < scope.windowEndMs && program.stopMs > scope.windowStartMs,
    );
  }
  /** Marks rows Not responding; the Not responding list itself is re-read. */
  setNotResponding(ids: ReadonlySet<string>): void {
    const same =
      ids.size === this.notResponding.size && [...ids].every((id) => this.notResponding.has(id));
    if (same) return;
    this.notResponding = new Set(ids);
    if (this.filter === 'unresponsive') this.apply();
    else this.render();
  }
  /** Marks rows Slow: saved from the Slow list, or slow to start playing. */
  setSlow(ids: ReadonlySet<string>): void {
    if (ids.size === this.slow.size && [...ids].every((id) => this.slow.has(id))) return;
    this.slow = new Set(ids);
    // The indexed list is reordered natively; this one sorts here.
    if (this.useIndexed()) this.render();
    else this.apply();
  }
  setGeography(
    filter: GeographyFilter,
    sort: 'source' | 'geography' | 'name',
    registry: GeographyRegistry,
  ): void {
    this.geographyFilter = Object.fromEntries(
      Object.entries(filter).filter(([, value]) => value !== undefined),
    );
    this.geographySort = sort;
    this.geographyRegistry = registry;
    this.update(this.all, [...this.favorites], this.selected);
  }
  /** The viewing scope is shared with Guide without exposing mutable browser state. */
  getGeographyFilter(): GeographyFilter {
    return {
      ...this.geographyFilter,
      ...(this.geographyFilter.countries ? { countries: [...this.geographyFilter.countries] } : {}),
    };
  }
  private scopeKey(): string {
    return JSON.stringify([
      this.useIndexed(),
      this.indexedHost?.scopeIdentity?.() ?? this.indexedHost?.identity() ?? 'local',
      this.query,
      this.filter,
      this.getSportsScope(),
      this.hideAdult,
      this.geographySort ?? 'source',
      this.geographyFilter.country ?? null,
      this.geographyFilter.region ?? null,
      this.geographyFilter.state ?? null,
      [...(this.geographyFilter.countries ?? [])].sort(),
      this.options.history?.scope() ?? null,
    ]);
  }
  private apply(): void {
    const indexed = this.useIndexed();
    const sports = this.getSportsScope();
    this.presentedHistoryScope = JSON.stringify(this.options.history?.scope());
    const historyIds = this.filter === 'watched' ? this.historyIds() : undefined;
    this.sportsControls?.presentScope(sports);
    const scope = this.scopeKey();
    const preserve = scope === this.browseScope;
    if (!preserve) {
      this.focusIntent++;
      this.displayAnchor = null;
      this.restoredFocus = null;
      this.list.scrollTop = 0;
    }
    const anchor = !indexed && preserve ? this.captureAnchor() : null;
    this.browseScope = scope;
    if (indexed) {
      this.visible = [];
      this.searchMetadata = [];
      this.metadataCache = new WeakMap();
      this.indexed!.reset(
        {
          query: this.query,
          filter: this.filter,
          geography: this.geographyFilter,
          sort: this.geographySort ?? 'source',
          hideAdult: this.hideAdult,
          ...(sports ? { sports } : {}),
          ...(historyIds === undefined ? {} : { historyIds }),
        },
        JSON.stringify([
          this.indexedHost!.scopeIdentity?.(),
          this.indexedHost!.identity(),
          this.programmeMembershipEpoch,
        ]),
        preserve,
      );
      this.updateCount();
      this.render();
      return;
    }
    const visible: BrowserChannel[] = [];
    this.sportsPpvRows.clear();
    if (this.sportsPlanQuery !== this.query) {
      this.sportsPlanQuery = this.query;
      this.sportsPlan = planSportsSearch(this.query);
    }
    const plan = this.sportsPlan;
    const facet = this.filter === 'sports' ? this.sportsFacet : {};
    const specificFacet = !!(facet.sport || facet.league);
    const semanticSports = specificFacet || plan.semantic.length > 0;
    const hasGeography = Object.values(this.geographyFilter).some((value) => value !== undefined);
    for (const metadata of this.searchMetadata) {
      const channel = metadata.channel;
      const accepts = (
        texts: readonly string[],
        facts: SportsFacts,
        ppv: boolean,
        literal = false,
        cached?: { normal: boolean; semantic: boolean },
      ) => {
        if (!matchesSportsFacet(facts, facet)) return false;
        if (this.filter !== 'ppv' && this.filter !== 'watched' && ppv) {
          if (sports?.includePpv !== true) return false;
          if (
            !specificFacet &&
            !(cached?.semantic ?? matchesSportsSearch(plan, texts, facts, true))
          )
            return false;
        }
        if (plan.specific)
          return cached?.semantic ?? matchesSportsSearch(plan, texts, facts, false, facet);
        return cached?.normal ?? (literal || matchesSportsSearch(plan, texts, facts, false, facet));
      };
      const texts = [
        ...metadata.sportsTexts,
        metadata.locationText,
        networkSearchLabel(channel.providerId),
      ];
      if (metadata.queryMatch?.query !== this.query) {
        const literal =
          !this.query ||
          metadata.normalizedSportsTexts.some((text) => text.includes(this.query)) ||
          metadata.providerSearchKey === this.query ||
          categoryAliasMatches(metadata.categoryAliases, this.query);
        metadata.queryMatch = {
          query: this.query,
          normal: literal || matchesSportsSearch(plan, texts, metadata.sportsFacts),
          semantic:
            plan.semantic.length > 0 &&
            matchesSportsSearch(plan, texts, metadata.sportsFacts, true),
        };
      }
      const direct = accepts(texts, metadata.sportsFacts, metadata.ppv, false, metadata.queryMatch);
      const programmes = sports ? this.savedProgrammes(channel, sports) : [];
      const matched = programmes.filter((program) => {
        const ppv =
          metadata.ppv ||
          hasPpvMarker(program.title) ||
          (program.categories ?? []).some((entry) => hasPpvMarker(entry.text));
        if (this.filter === 'ppv' && !ppv) return false;
        return accepts(
          programmeSportsTexts(program, texts, metadata.sportsFacts),
          programmeSportsFacts(program, metadata.sportsFacts),
          ppv,
        );
      });
      const programme = matched[0];
      const rowPpv =
        metadata.ppv ||
        (!direct &&
          matched.length > 0 &&
          matched.every(
            (entry) =>
              hasPpvMarker(entry.title) ||
              (entry.categories ?? []).some((category) => hasPpvMarker(category.text)),
          ));
      const inFilter =
        this.filter === 'ppv'
          ? rowPpv
          : this.filter === 'watched'
            ? historyIds!.includes(channel.id)
            : this.filter === 'all'
              ? true
              : this.filter === 'favorites'
                ? this.favorites.has(channel.id)
                : this.filter === 'unresponsive'
                  ? this.notResponding.has(channel.id)
                  : this.filter === 'sports' && semanticSports
                    ? true
                    : metadata.normalizedCategory.includes(this.filter) ||
                      (this.filter === 'sports' && metadata.sportsFacts.sports.size > 0);
      if (
        inFilter &&
        (direct || !!programme) &&
        !(
          this.hideAdult &&
          (metadata.normalizedCategory.includes('xxx') ||
            metadata.normalizedCategory.includes('adult') ||
            /xxx|adult/u.test(searchKey(metadata.originalCategory ?? '')))
        ) &&
        (!hasGeography || matchesGeography(channel, this.geographyFilter))
      ) {
        if (rowPpv) this.sportsPpvRows.add(channel.id);
        visible.push(channel);
      }
    }
    this.visible = visible;
    if (this.geographySort && this.geographySort !== 'source')
      this.visible.sort((a, b) => {
        if (this.geographySort === 'geography' && this.geographyRegistry)
          return compareGeographicChannels(a, b, this.geographyRegistry);
        const cmp = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
        return (
          cmp(this.metadataCache.get(a)!.sortName, this.metadataCache.get(b)!.sortName) ||
          cmp(a.name, b.name) ||
          cmp(a.sourceId ?? '', b.sourceId ?? '') ||
          cmp(a.id, b.id)
        );
      });
    // Preserve the chosen order within each group: favorites first, and within
    // favorites and the rest, Slow channels after fast ones (as the native list).
    const ordered: BrowserChannel[] = [];
    for (const favorite of [true, false])
      for (const slow of [false, true])
        for (const channel of this.visible)
          if (this.favorites.has(channel.id) === favorite && this.slow.has(channel.id) === slow)
            ordered.push(channel);
    this.visible = historyIds
      ? this.visible.sort((a, b) => historyIds.indexOf(a.id) - historyIds.indexOf(b.id))
      : ordered;
    if (anchor) {
      let index = [anchor.id, ...anchor.alternatives]
        .map((id) => this.indexOf(id))
        .find((i) => i >= 0);
      index ??= Math.max(0, Math.min(anchor.index, this.length - 1));
      this.restoreAnchor(anchor, index, this.at(index)?.id ?? '');
    }
    this.updateCount();
    this.render();
  }
  private updateCount(): void {
    // A detached/replaced owner must not change another browser's shared chrome.
    if (
      !this.list.isConnected ||
      (this.list.id && this.list.ownerDocument.getElementById(this.list.id) !== this.list)
    )
      return;
    const indexed = this.useIndexed() ? this.indexed : null;
    if (this.clearHistoryButton) {
      this.clearHistoryButton.hidden = this.disposed || this.filter !== 'watched';
      this.clearHistoryButton.disabled =
        !this.historyReady || !this.historyIds().length || this.historyJobs.size > 0;
    }
    const state = this.disposed ? 'closed' : (indexed?.state ?? 'ready');
    const unavailable = state === 'error' || state === 'closed';
    const historyLoading =
      this.filter === 'watched' &&
      !!this.options.history &&
      !this.historyReady &&
      !this.historyFailed;
    const unresolved = historyLoading || (!!indexed && !indexed.countKnown && !unavailable);
    this.list.dataset.catalogState = state;
    // Only a settled empty view can release the card reserve. Pending native
    // reads retain their old rows/anchor and must not collapse their viewport.
    this.list.dataset.catalogEmpty = String(
      !unavailable && !unresolved && !this.displayAnchor && this.length === 0,
    );
    this.list.setAttribute(
      'aria-busy',
      String(
        !this.disposed &&
          (!!indexed?.pending || (this.filter === 'watched' && this.historyJobs.size > 0)),
      ),
    );
    const count = this.countElement;
    const notImported = unavailable && this.indexed?.failedBecause === 'account-not-imported';
    const countText = notImported
      ? 'No channels yet'
      : unavailable
        ? 'Channels unavailable'
        : unresolved
          ? historyLoading
            ? 'Loading History…'
            : 'Loading channels…'
          : `${this.length.toLocaleString()} ${this.length === 1 ? 'channel' : 'channels'}`;
    if (count && count.textContent !== countText) count.textContent = countText;
    const empty = this.emptyElement;
    if (!empty) return;
    empty.hidden =
      state === 'closed' ||
      (!unavailable && !!this.displayAnchor && (indexed?.total ?? 0) > 0) ||
      (!unavailable &&
        !unresolved &&
        this.length !== 0 &&
        !(this.filter === 'watched' && this.historyFailed));
    empty.setAttribute('role', 'status');
    empty.setAttribute('aria-live', 'polite');
    const emptyText =
      this.filter === 'watched' && this.historyFailed
        ? 'History could not be loaded or saved. Try again after reopening the app.'
        : this.filter === 'watched' && this.options.history && !this.historyReady
          ? 'Loading History…'
          : unresolved
            ? 'Loading channels…'
            : notImported
              ? 'This account has no channels yet. Open Settings → Sources and choose Refresh channels.'
              : unavailable
                ? 'Channels could not be loaded. Try another filter or refresh.'
                : this.filter === 'watched'
                  ? 'No watched channels here. Play a channel, or change the search or location filter.'
                  : this.query
                    ? 'No matching channels or saved guide listings. Programme matches need a connected guide.'
                    : this.all.length
                      ? 'No channels here. Try another filter or search.'
                      : {
                          'no-sources': 'Select the search icon to find channels.',
                          'empty-sources':
                            'Your saved sources contain no channels. Update or replace a source in Settings.',
                          'removed-channels':
                            'All saved channels are removed. Restore removed channels in Settings.',
                        }[this.emptyReason];
    if (empty.textContent !== emptyText) empty.textContent = emptyText;
  }
  setGuideRows(rows: readonly ChannelGuideRow[]): void {
    if (this.disposed || !this.guideHost) return;
    if (rows.length > 64 && !rows.every((row) => row.status === 'capacity' && row.summary === null))
      throw new Error('Guide viewport limit exceeded.');
    if (
      rows.some(
        (row) =>
          row.summary &&
          (row.summary.appChannelId !== row.appChannelId ||
            row.summary.catalogSourceId !== row.catalogSourceId),
      )
    )
      throw new Error('Guide row identity did not match.');
    this.guideRows = rows.map((row) => ({ ...row }));
    if (!this.useIndexed() && this.getSportsScope()) {
      this.apply();
      return;
    }
    this.schedule();
  }
  /** Current programmes for Paid TV rows on screen (replaces the previous set). */
  setNowPlaying(rows: readonly NowPlayingRow[]): void {
    if (this.disposed) return;
    if (rows.length > 64) throw new Error('Guide viewport limit exceeded.');
    const next = new Map<string, NowPlayingRow>();
    for (const row of rows) {
      if (
        typeof row.title !== 'string' ||
        !row.title.trim() ||
        row.title.length > 1024 ||
        !Number.isSafeInteger(row.startMs) ||
        !Number.isSafeInteger(row.stopMs) ||
        row.stopMs <= row.startMs
      )
        throw new Error('Now playing row is invalid.');
      next.set(JSON.stringify([row.catalogSourceId, row.appChannelId]), {
        ...row,
        ...(row.categories
          ? { categories: row.categories.map((category) => ({ ...category })) }
          : {}),
      });
    }
    this.nowPlaying = next;
    if (!this.useIndexed() && this.getSportsScope()) {
      this.apply();
      return;
    }
    this.schedule();
  }
  setGuideForeground(foreground: boolean): void {
    if (this.disposed) return;
    this.guideForeground = foreground;
    if (!foreground) {
      this.reportGuideRows([]);
      this.options.logos?.visible([]);
    } else this.schedule();
  }
  private reportGuideRows(rows: VisibleGuideChannel[]): void {
    if (!this.guideHost) return;
    const key = JSON.stringify([
      rows,
      this.filter,
      this.query,
      this.getSportsScope(),
      this.programmeMembershipEpoch,
    ]);
    if (key === this.reportedGuideScope) return;
    this.reportedGuideScope = key;
    this.guideHost.onVisibleGuideRows(rows);
  }
  private render(): void {
    // A same-owner refresh keeps its old display until the native anchor read
    // has located the new page. Dropping the spacer here would clamp scrollTop
    // to zero and detach the remote's focused button before the result arrives.
    if (this.displayAnchor && this.useIndexed() && !this.indexed!.failed) return;
    const base = this.resolveBaseRowHeight();
    if (base !== this.baseRowHeight) {
      this.baseRowHeight = base;
      this.resizeRows(base);
    }
    const spacer = this.list.querySelector('#channel-spacer') as HTMLElement;
    const rows = this.list.querySelector('#channel-rows') as HTMLElement;
    spacer.style.height = `${this.length * this.rowHeight}px`;
    const start = Math.max(0, Math.floor(this.list.scrollTop / this.rowHeight) - 3);
    const end = Math.min(
      this.length,
      start + Math.ceil(this.list.clientHeight / this.rowHeight) + 7,
    );
    rows.style.transform = `translateY(${start * this.rowHeight}px)`;
    const active = document.activeElement;
    const ownedFocus = active instanceof HTMLElement && this.list.contains(active) ? active : null;
    const restored =
      this.restoredFocus &&
      this.restoredFocus.intent === this.focusIntent &&
      (active === this.restoredFocus.element || active === this.list)
        ? this.restoredFocus
        : null;
    const focusedAction = restored?.action ?? ownedFocus?.dataset.channelAction;
    const focused = restored?.id ?? ownedFocus?.dataset.channel ?? ownedFocus?.dataset.channelId;
    this.restoredFocus = null;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const channel = this.at(i);
      if (!channel) {
        this.indexed?.ensure(i);
        const pending = document.createElement('div');
        pending.className = 'channel';
        // This stands in for the entire row, including its four-pixel gap.
        pending.style.height = `${this.rowHeight}px`;
        pending.textContent = 'Loading channels…';
        pending.setAttribute('aria-hidden', 'true');
        fragment.append(pending);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'channel media-result-main';
      button.style.height = `${this.rowHeight - 4}px`;
      button.title = `${channel.name} · ${channel.category || 'Live channel'}`;
      button.setAttribute('aria-label', button.title);
      button.dataset.channel = channel.id;
      button.setAttribute('aria-current', String(channel.id === this.selected));
      const position = document.createElement('span');
      position.className = 'channel-number';
      position.textContent = String(i + 1).padStart(3, '0');
      position.setAttribute('aria-hidden', 'true');
      position.hidden = true;
      const monogram = document.createElement('span');
      monogram.className = 'monogram media-result-artwork';
      monogram.dataset.artwork = 'fallback';
      const badgeCategory = (channel.category || '').toLowerCase();
      monogram.dataset.category =
        ['news', 'sports', 'movies', 'kids', 'nature', 'food', 'history'].find((category) =>
          badgeCategory.includes(category),
        ) ?? 'other';
      monogram.textContent =
        Array.from(
          (channel.name.match(/[\p{L}\p{N}]+/gu) ?? [])
            .slice(0, 2)
            .map((word) => Array.from(word)[0])
            .join('')
            .toUpperCase(),
        )
          .slice(0, 2)
          .join('') || 'TV';
      monogram.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'channel-copy media-result-copy';
      const name = document.createElement('strong');
      name.className = 'media-result-title';
      name.textContent = channel.name;
      const meta = document.createElement('small');
      meta.className = 'media-result-subtitle';
      meta.textContent = channel.category || 'Live channel';
      const provider = document.createElement('small');
      provider.className = 'channel-provider-label';
      provider.hidden = true;
      copy.append(name, provider, meta);
      // What is on now: the Free TV guide's summary, or the Paid TV provider guide.
      let playing: SportsProgram | null = null;
      let playingPrefix = '';
      const display = this.displayMetadata(channel);
      const showPlaying = (logoShown: boolean) => {
        const channelMatchup = display.matchup;
        if (!playing) {
          if (channelMatchup !== null || /(?:\s(?:vs?\.?|versus|at)\s|@)/iu.test(channel.name)) {
            name.classList.add('channel-event-title');
            name.textContent = channelMatchup ?? channel.name;
            if (channelMatchup !== null && channelMatchup !== channel.name) {
              provider.hidden = false;
              provider.textContent = channel.name;
              button.setAttribute('aria-label', `${button.title} · ${channelMatchup}`);
            }
          }
          return;
        }
        const categories = JSON.stringify(playing.categories ?? []);
        if (
          !display.program ||
          display.program.title !== playing.title ||
          display.program.description !== playing.description ||
          display.program.categories !== categories
        ) {
          display.program = {
            title: playing.title,
            description: playing.description,
            categories,
            value:
              sportsMatchupTitle(playing.title, programmeSportsFacts(playing, display.facts)) ??
              playing.title,
          };
        }
        const title = display.program.value;
        if (title !== playing.title)
          button.setAttribute('aria-label', `${button.title} · ${title}`);
        copy.dataset.nowPlaying = logoShown ? 'title' : 'subtitle';
        if (logoShown) {
          // The logo names the channel; the row's text shows what is on.
          name.textContent = playingPrefix + title;
          name.classList.add('channel-event-title');
          meta.classList.remove('channel-event-title');
          provider.hidden = false;
          provider.textContent = channel.name;
          meta.textContent =
            playing.stopMs !== null && playing.stopMs > playing.startMs
              ? `${formatCompactViewingTime(playing.startMs)} – ${formatCompactViewingTime(playing.stopMs)}`
              : `From ${formatCompactViewingTime(playing.startMs)}`;
        } else {
          name.textContent = channel.name;
          name.classList.remove('channel-event-title');
          provider.hidden = true;
          meta.textContent = playingPrefix + title;
          meta.classList.add('channel-event-title');
        }
      };
      const notResponding = this.notResponding.has(channel.id);
      const slow = !notResponding && this.slow.has(channel.id);
      const markNotResponding = () => {
        if (
          (display.ppv || this.sportsPpvRows.has(channel.id)) &&
          !meta.querySelector('.ppv-badge')
        ) {
          const mark = document.createElement('span');
          mark.className = 'ppv-badge';
          mark.textContent = 'PPV';
          meta.prepend(mark, ' · ');
        }
        if (slow && !meta.querySelector('.channel-slow-mark')) {
          const mark = document.createElement('span');
          mark.className = 'channel-slow-mark';
          mark.textContent = 'Slow';
          meta.prepend(mark, ' · ');
        }
        if (!notResponding || meta.querySelector('.channel-dead-mark')) return;
        const mark = document.createElement('span');
        mark.className = 'channel-dead-mark';
        mark.textContent = 'Not responding';
        meta.prepend(mark, ' · ');
      };
      const logo = this.options.logos?.get(channel);
      if (logo) {
        const fallback = monogram.textContent;
        const image = document.createElement('img');
        image.className = 'channel-logo-image';
        image.alt = '';
        image.decoding = 'async';
        image.src = logo;
        image.addEventListener(
          'error',
          () => {
            this.options.logos?.rejected(channel);
            monogram.dataset.artwork = 'fallback';
            monogram.textContent = fallback;
            showPlaying(false);
            markNotResponding();
          },
          { once: true },
        );
        monogram.dataset.artwork = 'logo';
        monogram.replaceChildren(image);
      }
      const programMeta = document.createElement('span');
      programMeta.className = 'channel-program-meta';
      const schedule = document.createElement('span');
      schedule.className = 'channel-guide-details';
      schedule.hidden = true;
      schedule.append(position, programMeta);
      if (this.guideHost) {
        const admitted = this.guideRows.find(
          (row) => row.appChannelId === channel.id && row.catalogSourceId === channel.sourceId,
        );
        const guide = channelGuideText(
          channel.sourceId
            ? admitted
            : {
                catalogSourceId: '',
                appChannelId: channel.id,
                status: 'unavailable',
                summary: null,
              },
          (milliseconds) => formatCompactViewingTime(milliseconds),
        );
        const current = document.createElement('small');
        current.className = 'channel-guide-current';
        current.textContent = guide.current;
        current.hidden = true;
        const next = document.createElement('small');
        next.className = 'channel-guide-next';
        next.textContent = guide.next;
        next.hidden = true;
        schedule.append(current, next);
        const summary = admitted?.status === 'ready' ? admitted.summary : null;
        const program =
          summary?.mappingStatus === 'mapped' &&
          summary.currentStatus === 'current' &&
          summary.cacheStatus !== 'unavailable'
            ? summary.current
            : null;
        if (program) {
          playing = program;
          playingPrefix = summary!.cacheStatus === 'stale' ? 'Cached · ' : '';
        }
        if (program && program.stopMs !== null && program.stopMs > program.startMs) {
          const time = document.createElement('small');
          time.className = 'channel-program-time';
          time.textContent = `${formatCompactViewingTime(program.startMs)} – ${formatCompactViewingTime(program.stopMs)}`;
          const progress = document.createElement('progress');
          progress.className = 'channel-program-progress';
          progress.max = 1;
          progress.value = Math.max(
            0,
            Math.min(1, (summary!.atMs - program.startMs) / (program.stopMs - program.startMs)),
          );
          progress.setAttribute('aria-label', 'Current program progress');
          programMeta.append(time, progress);
        }
        button.title += ` · ${guide.current}${guide.next ? ' · ' + guide.next : ''}`;
        button.setAttribute('aria-label', button.title);
      }
      if (!playing && channel.sourceId) {
        const paid = this.nowPlaying.get(JSON.stringify([channel.sourceId, channel.id]));
        if (paid) {
          playing = paid;
          const range = `${formatCompactViewingTime(paid.startMs)} – ${formatCompactViewingTime(paid.stopMs)}`;
          button.title += ` · Now: ${paid.title} (${range})`;
          button.setAttribute('aria-label', button.title);
        }
      }
      showPlaying(monogram.dataset.artwork === 'logo');
      markNotResponding();
      const star = document.createElement('span');
      star.className = 'channel-star';
      star.textContent = this.favorites.has(channel.id)
        ? '★'
        : channel.id === this.selected
          ? '●'
          : '';
      button.append(monogram, copy, schedule);
      if (!this.options.onFavorite) button.append(star);
      const row = document.createElement('div');
      row.className = 'channel-row media-result-row';
      row.dataset.selected = String(channel.id === this.selected);
      if (notResponding) {
        row.dataset.notResponding = 'true';
        button.title += ' · Not responding';
        button.setAttribute('aria-label', button.title);
      } else if (slow) {
        row.dataset.slow = 'true';
        button.title += ' · Slow to start';
        button.setAttribute('aria-label', button.title);
      }
      row.style.height = `${this.rowHeight}px`;
      row.append(button);
      if (this.options.onFavorite || this.options.onManage) {
        for (const action of ['manage', 'favorite'] as const) {
          if (!(action === 'favorite' ? this.options.onFavorite : this.options.onManage)) continue;
          const control = document.createElement('button');
          control.type = 'button';
          control.className = `channel-action channel-${action}${action === 'favorite' ? ' media-result-favorite' : ''}`;
          control.dataset.channelAction = action;
          control.dataset.channelId = channel.id;
          control.textContent =
            action === 'favorite' ? (this.favorites.has(channel.id) ? '★' : '☆') : '⌄';
          control.setAttribute(
            'aria-label',
            action === 'favorite' ? `Favorite ${channel.name}` : `Manage ${channel.name}`,
          );
          if (action === 'favorite')
            control.setAttribute('aria-pressed', String(this.favorites.has(channel.id)));
          row.append(control);
        }
      }
      if (this.filter === 'watched' && this.options.history) {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'channel-action channel-history-remove';
        control.dataset.channelAction = 'history-remove';
        control.dataset.channelId = channel.id;
        control.textContent = '×';
        control.setAttribute('aria-label', `Remove ${channel.name} from History`);
        row.append(control);
      }
      fragment.append(row);
    }
    this.contentObserver.disconnect();
    rows.replaceChildren(fragment);
    // ensure() above can admit a missing visible page after the count is known.
    this.updateCount();
    if (this.options.logos) {
      const visible: BrowserChannel[] = [];
      const bounds = this.list.getBoundingClientRect();
      if (
        this.guideForeground &&
        this.list.getClientRects().length &&
        bounds.width > 0 &&
        bounds.height > 0
      )
        for (let index = start; index < end; index++) {
          const channel = this.at(index),
            row = rows.children[index - start] as HTMLElement;
          const box = row.getBoundingClientRect();
          if (
            channel &&
            box.bottom > Math.max(0, bounds.top) &&
            box.top < Math.min(innerHeight, bounds.bottom)
          )
            visible.push(channel);
        }
      this.options.logos.visible(visible);
    }
    if (this.guideHost) {
      const bounds = this.list.getBoundingClientRect();
      const scope: VisibleGuideChannel[] = [];
      if (
        this.guideForeground &&
        this.list.getClientRects().length &&
        bounds.height > 0 &&
        bounds.width > 0
      ) {
        for (let index = start; index < end; index++) {
          const channel = this.at(index);
          if (!channel) continue;
          const button = rows.children[index - start] as HTMLElement;
          const box = button.getBoundingClientRect();
          if (
            channel.sourceId &&
            box.bottom > Math.max(0, bounds.top) &&
            box.top < Math.min(innerHeight, bounds.bottom) &&
            box.right > Math.max(0, bounds.left) &&
            box.left < Math.min(innerWidth, bounds.right)
          )
            scope.push({ catalogSourceId: channel.sourceId, appChannelId: channel.id });
        }
      }
      this.reportGuideRows(scope);
    }
    for (const copy of rows.querySelectorAll('.channel-copy')) this.contentObserver.observe(copy);
    if (focused) {
      const buttons = [...rows.querySelectorAll<HTMLButtonElement>('button')];
      const same = buttons.find((button) =>
        focusedAction
          ? button.dataset.channelId === focused && button.dataset.channelAction === focusedAction
          : button.dataset.channel === focused,
      );
      const nearestRow =
        rows.children[Math.max(0, Math.min(rows.children.length - 1, this.focusedIndex - start))];
      const nearest = nearestRow?.querySelector<HTMLButtonElement>(
        focusedAction ? `button[data-channel-action="${focusedAction}"]` : '[data-channel]',
      );
      const target = same ?? nearest ?? this.list;
      target.focus({ preventScroll: true });
      if (
        this.resizedFocus?.id === focused &&
        this.resizedFocus.intent === this.focusIntent &&
        (this.resizedFocus.sidebarTop === null ||
          this.list.closest<HTMLElement>('.browser')?.scrollTop === this.resizedFocus.sidebarTop)
      )
        this.revealInSidebar(target);
    }
    this.resizedFocus = null;
  }
  selectAdjacent(direction: -1 | 1): boolean {
    if (!this.disposed && this.useIndexed()) {
      this.indexed!.adjacent(
        () => this.selected,
        direction,
        (row, index) => {
          if (this.disposed) return;
          this.selected = row.id;
          this.list.scrollTop = index * this.rowHeight;
          this.onSelect(row.id);
        },
      );
      return this.length > 0;
    }
    if (this.disposed || !this.visible.length) return false;
    const selected = this.visible.findIndex((channel) => channel.id === this.selected);
    const index =
      selected < 0
        ? direction === 1
          ? 0
          : this.visible.length - 1
        : (selected + direction + this.visible.length) % this.visible.length;
    if (this.visible[index].id === this.selected) return false;
    this.list.scrollTop = index * this.rowHeight;
    this.onSelect(this.visible[index].id);
    return true;
  }
  dispose(): Promise<void> {
    if (this.disposed)
      return Promise.all([this.indexed?.dispose(), ...this.historyJobs]).then(() => undefined);
    this.reportGuideRows([]);
    this.options.logos?.visible([]);
    this.disposed = true;
    this.historyUnsubscribe?.();
    this.clearHistoryButton?.removeEventListener('click', this.clearHistoryClick);
    this.clearHistoryButton?.remove();
    this.resizedFocus = null;
    this.list.style.removeProperty('--channel-row-height');
    this.sportsControls?.dispose();
    this.updateCount();
    this.guideRows = [];
    cancelAnimationFrame(this.frame);
    this.list.removeEventListener('scroll', this.schedule);
    this.list.removeEventListener('click', this.click);
    this.list.removeEventListener('keydown', this.keydown);
    this.list.removeEventListener('focusin', this.focusin);
    this.resizeObserver.disconnect();
    this.contentObserver.disconnect();
    this.all = [];
    this.visible = [];
    this.searchMetadata = [];
    this.metadataCache = new WeakMap();
    this.favorites.clear();
    this.selected = null;
    this.displayAnchor = null;
    this.restoredFocus = null;
    return Promise.all([this.indexed?.dispose(), ...this.historyJobs]).then(() => undefined);
  }
  refreshArtwork(): void {
    if (!this.disposed) this.schedule();
  }
}
