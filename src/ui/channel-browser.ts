import { formatCompactViewingTime } from '../guide/time';
import { locationSearchText } from '../search/location-labels';
import { CatalogWindow, type CatalogWindowHost } from './catalog-window';
import { hasOfficialGeographyLabels } from './geography-controls';
import {
  channelGuideText,
  type ChannelGuideHost,
  type ChannelGuideRow,
  type VisibleGuideChannel,
} from './channel-guide';
import type { NowPlayingRow } from '../application/paid-now-playing';
import { declaredCategoryAliases, categoryAliasMatches } from '../search/category-aliases';
import {
  compareGeographicChannels,
  matchesGeography,
  type ChannelGeography,
  type GeographyFilter,
  type GeographyRegistry,
} from '../catalog/geography';
export interface BrowserChannel {
  id: string;
  name: string;
  category: string;
  sourceId?: string;
  providerId?: string;
  geography?: ChannelGeography;
}
export type ChannelFilter = 'all' | 'favorites' | 'news' | 'sports' | 'movies' | 'unresponsive';
export type CatalogEmptyReason = 'no-sources' | 'empty-sources' | 'removed-channels';
const ROW_HEIGHT = 72;
export interface IndexedBrowserHost extends Omit<CatalogWindowHost, 'changed'> {
  identity(): string;
  ready?(): boolean;
}
export interface ChannelBrowserOptions {
  logos?: {
    get(channel: BrowserChannel): string | null;
    visible(channels: readonly BrowserChannel[]): void;
    rejected(channel: BrowserChannel): void;
  };
  /** Includes the four-pixel row gap; at least 48 preserves a 44px control. */
  baseRowHeight?: number | (() => number);
  onFavorite?: (id: string) => void;
  onManage?: (id: string) => void;
}
interface SearchMetadata {
  channel: BrowserChannel;
  name: string;
  category: string;
  providerId?: string;
  normalizedCategory: string;
  locationText: string;
  providerSearchKey: string;
  searchText: string;
  categoryAliases: readonly string[];
  sortName: string;
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
  private favorites = new Set<string>();
  /** Saved channels that failed quiet checks on two different days. */
  private notResponding: ReadonlySet<string> = new Set<string>();
  private slow: ReadonlySet<string> = new Set<string>();
  private selected: string | null = null;
  private emptyReason: CatalogEmptyReason = 'no-sources';
  private filter: ChannelFilter = 'all';
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
  private indexed: CatalogWindow | null = null;
  private focusIntent = 0;
  private countElement: Element | null;
  private emptyElement: HTMLElement | null;
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
    if (indexedHost)
      this.indexed = new CatalogWindow({
        ...indexedHost,
        changed: () => {
          if (this.disposed || !this.useIndexed()) return;
          this.updateCount();
          this.schedule();
        },
      });
    list.addEventListener('scroll', this.schedule);
    list.addEventListener('click', this.click);
    list.addEventListener('keydown', this.keydown);
    list.addEventListener('focusin', this.focusin);
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.resizeObserver.observe(list);
    this.contentObserver = new ResizeObserver((entries) => {
      if (this.disposed) return;
      const copy = entries[0]?.target;
      const button = copy?.closest<HTMLElement>('.channel');
      if (!copy || !button || !this.list.contains(copy)) return;
      const style = getComputedStyle(button);
      const height = Math.max(
        this.baseRowHeight,
        Math.ceil(
          copy.getBoundingClientRect().height +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom) +
            6,
        ),
      );
      if (!Number.isFinite(height) || height === this.rowHeight) return;
      this.resizeRows(height);
      this.schedule();
    });
  }
  private resizeRows(height: number): void {
    const position = this.list.scrollTop / this.rowHeight;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && this.list.contains(active)
        ? this.indexOf(active.dataset.channel ?? active.dataset.channelId)
        : -1;
    this.rowHeight = height;
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
  private resolveBaseRowHeight(): number {
    const height =
      typeof this.options.baseRowHeight === 'function'
        ? this.options.baseRowHeight()
        : (this.options.baseRowHeight ?? ROW_HEIGHT);
    if (!Number.isSafeInteger(height) || height < 48 || height > 512)
      throw new Error('Channel row height is invalid.');
    return height;
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
      else this.options.onManage?.(action.dataset.channelId);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-channel]');
    if (button?.dataset.channel) this.onSelect(button.dataset.channel);
  };
  private focusin = (event: FocusEvent): void => {
    const target = event.target as HTMLElement;
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
    // Up and Down keep the column: the star stays on stars, the menu on menus.
    const column = rowControls ? [...rowControls].indexOf(targetControl as HTMLButtonElement) : 0;
    const focusRow = (id: string | undefined) => {
      const main = [...this.list.querySelectorAll<HTMLButtonElement>('[data-channel]')].find(
        (button) => button.dataset.channel === id,
      );
      const controls = main?.closest('.channel-row')?.querySelectorAll<HTMLButtonElement>('button');
      (controls?.[Math.max(0, column)] ?? main)?.focus({ preventScroll: true });
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
    if (next * this.rowHeight < this.list.scrollTop) this.list.scrollTop = next * this.rowHeight;
    if ((next + 1) * this.rowHeight > this.list.scrollTop + this.list.clientHeight)
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
        previous.providerId === channel.providerId &&
        previous.locationText === locationText
      )
        return previous;
      const normalizedCategory = searchKey(channel.category);
      const metadata = {
        channel,
        name: channel.name,
        category: channel.category,
        providerId: channel.providerId,
        normalizedCategory,
        locationText,
        providerSearchKey: channel.providerId === undefined ? '' : searchKey(channel.providerId),
        searchText: `${searchKey(channel.name)} ${normalizedCategory} ${networkSearchLabel(channel.providerId)} ${locationText}`,
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
    this.list.scrollTop = 0;
    this.apply();
  }
  setHideAdult(hide: boolean): void {
    if (this.hideAdult === hide) return;
    this.hideAdult = hide;
    this.apply();
  }
  setFilter(filter: ChannelFilter): void {
    this.filter = filter;
    this.list.scrollTop = 0;
    this.apply();
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
    this.list.scrollTop = 0;
    this.update(this.all, [...this.favorites], this.selected);
  }
  private apply(): void {
    this.focusIntent++;
    if (this.useIndexed()) {
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
        },
        this.indexedHost!.identity(),
      );
      this.updateCount();
      this.render();
      return;
    }
    const visible: BrowserChannel[] = [];
    const hasGeography = Object.values(this.geographyFilter).some((value) => value !== undefined);
    for (const metadata of this.searchMetadata) {
      const channel = metadata.channel;
      const inFilter =
        this.filter === 'all' ||
        (this.filter === 'favorites'
          ? this.favorites.has(channel.id)
          : this.filter === 'unresponsive'
            ? this.notResponding.has(channel.id)
            : metadata.normalizedCategory.includes(this.filter));
      if (
        inFilter &&
        !(
          this.hideAdult &&
          (metadata.normalizedCategory.includes('xxx') ||
            metadata.normalizedCategory.includes('adult'))
        ) &&
        (!hasGeography || matchesGeography(channel, this.geographyFilter)) &&
        (!this.query ||
          metadata.searchText.includes(this.query) ||
          metadata.providerSearchKey === this.query ||
          categoryAliasMatches(metadata.categoryAliases, this.query))
      )
        visible.push(channel);
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
    this.visible = ordered;
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
    const state = this.disposed ? 'closed' : (indexed?.state ?? 'ready');
    const unavailable = state === 'error' || state === 'closed';
    const unresolved = !!indexed && !indexed.countKnown && !unavailable;
    this.list.dataset.catalogState = state;
    this.list.setAttribute('aria-busy', String(!this.disposed && !!indexed?.pending));
    const count = this.countElement;
    const notImported = unavailable && this.indexed?.failedBecause === 'account-not-imported';
    const countText = notImported
      ? 'No channels yet'
      : unavailable
        ? 'Channels unavailable'
        : unresolved
          ? 'Loading channels…'
          : `${this.length.toLocaleString()} ${this.length === 1 ? 'channel' : 'channels'}`;
    if (count && count.textContent !== countText) count.textContent = countText;
    const empty = this.emptyElement;
    if (!empty) return;
    empty.hidden = state === 'closed' || (!unavailable && !unresolved && this.length !== 0);
    empty.setAttribute('role', 'status');
    empty.setAttribute('aria-live', 'polite');
    const emptyText = unresolved
      ? 'Loading channels…'
      : notImported
        ? 'This account has no channels yet. Open Settings → Sources and choose Refresh channels.'
        : unavailable
          ? 'Channels could not be loaded. Try another filter or refresh.'
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
      next.set(JSON.stringify([row.catalogSourceId, row.appChannelId]), { ...row });
    }
    this.nowPlaying = next;
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
    const key = JSON.stringify(rows);
    if (key === this.reportedGuideScope) return;
    this.reportedGuideScope = key;
    this.guideHost.onVisibleGuideRows(rows);
  }
  private render(): void {
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
    const focusedAction =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.channelAction
        : undefined;
    const focused =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset.channel ?? document.activeElement.dataset.channelId)
        : undefined;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const channel = this.at(i);
      if (!channel) {
        this.indexed?.ensure(i);
        const pending = document.createElement('div');
        pending.className = 'channel';
        pending.style.height = `${this.rowHeight - 4}px`;
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
      copy.append(name, meta);
      // What is on now: the Free TV guide's summary, or the Paid TV provider guide.
      let playing: { title: string; startMs: number; stopMs: number | null } | null = null;
      let playingPrefix = '';
      const showPlaying = (logoShown: boolean) => {
        if (!playing) return;
        copy.dataset.nowPlaying = logoShown ? 'title' : 'subtitle';
        if (logoShown) {
          // The logo names the channel; the row's text shows what is on.
          name.textContent = playingPrefix + playing.title;
          meta.textContent =
            playing.stopMs !== null && playing.stopMs > playing.startMs
              ? `${formatCompactViewingTime(playing.startMs)} – ${formatCompactViewingTime(playing.stopMs)}`
              : `From ${formatCompactViewingTime(playing.startMs)}`;
        } else {
          name.textContent = channel.name;
          meta.textContent = playingPrefix + playing.title;
        }
      };
      const notResponding = this.notResponding.has(channel.id);
      const slow = !notResponding && this.slow.has(channel.id);
      const markNotResponding = () => {
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
    const firstCopy = rows.querySelector('.channel-copy');
    if (firstCopy) this.contentObserver.observe(firstCopy);
    if (focused) {
      const buttons = [...rows.querySelectorAll<HTMLButtonElement>('button')];
      const same = buttons.find((button) =>
        focusedAction
          ? button.dataset.channelId === focused && button.dataset.channelAction === focusedAction
          : button.dataset.channel === focused,
      );
      const nearest = buttons[Math.max(0, Math.min(buttons.length - 1, this.focusedIndex - start))];
      (same ?? nearest ?? this.list).focus({ preventScroll: true });
    }
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
    if (this.disposed) return this.indexed?.dispose() ?? Promise.resolve();
    this.reportGuideRows([]);
    this.options.logos?.visible([]);
    this.disposed = true;
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
    return this.indexed?.dispose() ?? Promise.resolve();
  }
  refreshArtwork(): void {
    if (!this.disposed) this.schedule();
  }
}
