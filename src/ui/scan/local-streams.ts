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

import { APP_SITES } from '../channels/app-sites';
import '../local-streams.css';
import globeUrl from '../../../assets/genx-nav-local.svg';
import radioUrl from '../../../assets/genx-radio.svg';
import {
  emptyLocalFavorites,
  pageRect,
  pageView,
  readLocalFavorites,
  saveLocalFavorites,
  scanLocalStreams,
  validLocalArea,
  validateLocalStreams,
  webAddress,
  type LocalFavorites,
  type LocalFavoriteStation,
  type LocalRadioStation,
  type LocalStreams,
  type LocalTvStation,
  type PageRect,
} from '../../platform/local-streams';

export interface LocalStreamsHost {
  /** Show the Live page with its viewing area (switching library if needed). */
  showLive(): Promise<void>;
  /** Play a radio stream in the GenX player. */
  playRadio(station: { id: string; name: string; url: string }): Promise<unknown>;
  /** Stop the GenX player before a station page takes the viewing area. */
  stopPlayback(): Promise<unknown>;
  run(work: Promise<void>): void;
  /** Lends GenX's voice search to an input (null gives it back to channel search). */
  voice?(target: { container: HTMLElement; input: HTMLInputElement } | null): void;
}

const STORE = 'genx-local-streams-v1';
/** A station's identity across scans: its website (TV) or directory id (radio). */
const keyOf = (s: { tv?: LocalTvStation | null; radio?: LocalRadioStation | null }) =>
  s.tv ? `tv:${s.tv.website}` : `radio:${s.radio?.id ?? ''}`;

/**
 * Local: TV station websites and radio streams near an area code or ZIP.
 * The globe tab replaces the channel list with the scan and its results; the
 * chosen station shows in the viewing area (radio in the GenX player, a TV
 * station's own website in the in-app page view) and goes fullscreen with it.
 */
export function mountLocalStreams(
  host: LocalStreamsHost,
  elements: {
    /** The top navigation row; the globe goes after `after`. */
    after: HTMLElement;
    /** Library buttons whose use leaves Local. */
    leave: readonly HTMLElement[];
    list: HTMLElement;
    stage: HTMLElement;
  },
) {
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<HTMLElementTagNameMap[K]> = {},
  ): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

  const button = make('button', {
    id: 'local-button',
    type: 'button',
    title: 'Local TV and radio',
  });
  button.setAttribute('aria-label', 'Local TV and radio');
  button.setAttribute('aria-pressed', 'false');
  button.append(make('img', { className: 'nav-icon local-globe', src: globeUrl, alt: '' }));
  elements.after.after(button);

  // Left: the area and the results.
  const panel = make('section', { id: 'local-streams', className: 'local-streams', hidden: true });
  panel.setAttribute('aria-label', 'Local TV and radio');
  const form = make('form', { className: 'local-form' });
  const area = make('input', {
    id: 'local-area',
    type: 'text',
    inputMode: 'numeric',
    maxLength: 5,
    placeholder: 'Area code or ZIP',
    autocomplete: 'off',
  });
  area.setAttribute('aria-label', 'Area code or ZIP code');
  const scan = make('button', { type: 'submit', className: 'local-scan', textContent: 'Scan' });
  const saveArea = make('button', { type: 'button', className: 'local-save-area', hidden: true });
  form.append(area, scan, saveArea);
  // Results | APK sites | Favorites | Websites: favorites never bury a scan's
  // results, and the app sites have their own tab (Android only).
  const tabs = make('div', { className: 'local-tabs' });
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Local lists');
  const resultsTab = make('button', { type: 'button', textContent: 'Results' });
  const appsTab = make('button', { type: 'button', textContent: 'APK sites' });
  const favoritesTab = make('button', { type: 'button', textContent: '★ Favorites' });
  const websitesTab = make('button', { type: 'button', textContent: 'Websites' });
  resultsTab.dataset.tab = 'results';
  appsTab.dataset.tab = 'apps';
  favoritesTab.dataset.tab = 'favorites';
  websitesTab.dataset.tab = 'websites';
  // One row (owner request): Results | ★ Favorites ▾ | Websites. On Android
  // the middle button opens a short list (Favorites, APK sites); OK opens it,
  // Up/Down choose, OK picks, Back closes. Windows has no APK sites, so the
  // middle button is Favorites itself.
  const listTab = make('button', { type: 'button', className: 'local-list-tab' });
  const listMenu = make('div', { className: 'local-list-menu', hidden: true });
  listMenu.setAttribute('role', 'menu');
  listMenu.setAttribute('aria-label', 'Lists');
  // Windows does not install Android apps (W16), so the tab is Android's.
  const android = /Android/i.test(navigator.userAgent);
  appsTab.hidden = !android;
  if (android) {
    for (const item of [favoritesTab, appsTab]) item.setAttribute('role', 'menuitemradio');
    listTab.setAttribute('aria-haspopup', 'menu');
    listTab.setAttribute('aria-expanded', 'false');
    listMenu.append(favoritesTab, appsTab);
    tabs.append(resultsTab, listTab, websitesTab, listMenu);
  } else tabs.append(resultsTab, favoritesTab, websitesTab);
  // Websites: an address or a search, typed or said (GenX's voice search).
  const webForm = make('form', { className: 'local-web-form', hidden: true });
  const web = make('input', {
    id: 'local-web',
    type: 'text',
    inputMode: 'url',
    placeholder: 'Website or search',
    autocomplete: 'off',
  });
  web.setAttribute('aria-label', 'Website address or search');
  const webVoice = make('div', { className: 'local-web-voice' });
  const go = make('button', { type: 'submit', className: 'local-go', textContent: 'Go' });
  webForm.append(web, webVoice, go);
  // Saved areas (Favorites tab): one press reruns that area's scan.
  const areas = make('div', { className: 'local-areas', hidden: true });
  areas.setAttribute('aria-label', 'Saved areas');
  const status = make('p', { className: 'local-status' });
  status.setAttribute('role', 'status');
  const results = make('div', { className: 'local-results' });
  results.setAttribute('role', 'list');
  panel.append(form, webForm, tabs, areas, status, results);
  elements.list.after(panel);

  // Right: a note in the viewing area until something is chosen.
  const note = make('p', { className: 'local-stage-note', hidden: true });
  // While a station page shows, OK on the viewing area hands the remote back to
  // the page (Back or Left at its edge returns here); Down still reaches the
  // player controls, Full screen included.
  const into = make('button', { type: 'button', className: 'local-stage-enter', hidden: true });
  into.setAttribute('aria-label', 'Use the station page');
  // PC: an address strip above the page (GenX can't see the mouse inside a
  // website, so it stays visible). Android draws the same controls itself.
  const strip = make('div', { className: 'local-page-strip', hidden: true });
  const stripBack = make('button', { type: 'button', textContent: '◀', title: 'Back' });
  const stripForward = make('button', { type: 'button', textContent: '▶', title: 'Forward' });
  const stripAddress = make('button', { type: 'button', className: 'local-page-address' });
  const stripSave = make('button', { type: 'button', className: 'local-page-save' });
  stripBack.setAttribute('aria-label', 'Back');
  stripForward.setAttribute('aria-label', 'Forward');
  stripAddress.title = 'Type or say another address';
  strip.append(stripBack, stripForward, stripAddress, stripSave);
  elements.stage.append(note, into, strip);

  let active = false;
  let found: LocalStreams | null = null;
  let owner: AbortController | null = null;
  let pageOpen = false;
  let current = '';
  let favorites: LocalFavorites | null = null;
  type Tab = 'results' | 'apps' | 'favorites' | 'websites';
  let tab: Tab = 'results';
  /** The open page's address and title, as last reported. */
  let pageAddress = { url: '', title: '' };
  /** Every station on screen (favorites and the current scan), by identity. */
  const stations = new Map<string, LocalFavoriteStation>();

  const say = (text: string, failed = false) => {
    status.textContent = text;
    status.toggleAttribute('data-error', failed);
  };
  const showNote = (text: string, radio?: LocalRadioStation) => {
    note.toggleAttribute('data-radio', !!radio);
    note.replaceChildren();
    if (radio)
      note.append(
        make('img', { className: 'local-radio-art', src: radioUrl, alt: '' }),
        make('span', { className: 'local-radio-eq' }),
        make('small', { textContent: 'Local radio · now playing' }),
        make('strong', { textContent: radio.name }),
        make('span', { textContent: radio.area }),
      );
    else note.textContent = text;
    note.hidden = !text && !radio;
  };
  const enterPage = () => {
    if (pageOpen) void pageView.enter().catch(() => undefined);
  };
  into.addEventListener('click', enterPage);
  let statusBefore = '';
  into.addEventListener('focus', () => {
    statusBefore = status.textContent ?? '';
    say('OK: back into the page · Down: player controls');
  });
  into.addEventListener('blur', () => say(statusBefore));
  function closePage(): Promise<void> {
    if (!pageOpen) return Promise.resolve();
    pageOpen = false;
    full = false;
    pageAddress = { url: '', title: '' };
    strip.hidden = true;
    document.getElementById('app')?.classList.remove('local-page-open');
    into.hidden = true;
    current = '';
    return pageView.close().then(
      () => undefined,
      () => undefined,
    );
  }
  function heading(text: string) {
    const node = make('h4', { className: 'local-heading', textContent: text });
    node.setAttribute('role', 'presentation');
    return node;
  }
  const isFavorite = (key: string) => !!favorites?.stations.some((s) => keyOf(s) === key);
  function row(station: LocalFavoriteStation) {
    const key = keyOf(station);
    stations.set(key, station);
    const tv = station.tv;
    const radio = station.radio;
    const label = tv ? tv.callSign || tv.name : (radio?.name ?? '');
    const detail = tv
      ? `${tv.place} · ${tv.distanceKm} km · ${siteName(tv)}`
      : [radio?.area, radio?.codec, radio?.bitrate ? `${radio.bitrate} kbps` : '']
          .filter(Boolean)
          .join(' · ');
    const node = make('div', { className: 'local-row' });
    node.setAttribute('role', 'listitem');
    const pick = make('button', { type: 'button', className: 'local-item' });
    pick.dataset.kind = tv ? 'tv' : 'radio';
    pick.dataset.key = key;
    if (current === tv?.website || playing === key) pick.setAttribute('aria-pressed', 'true');
    pick.append(make('strong', { textContent: label }), make('small', { textContent: detail }));
    node.append(pick);
    if (favorites) {
      const saved = isFavorite(key);
      const star = make('button', {
        type: 'button',
        className: 'local-star',
        textContent: saved ? '★' : '☆',
      });
      star.dataset.key = key;
      star.setAttribute('aria-pressed', String(saved));
      star.setAttribute(
        'aria-label',
        `${saved ? 'Remove' : 'Add'} ${label} ${saved ? 'from' : 'to'} favorites`,
      );
      node.append(star);
    }
    return node;
  }
  let playing = '';
  function render(): void {
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = results.contains(focused) ? focused?.dataset.key : undefined;
    const focusStar = !!focused?.classList.contains('local-star');
    results.replaceChildren();
    stations.clear();
    const saved = favorites?.stations ?? [];
    tabs.hidden = !favorites;
    resultsTab.setAttribute('aria-pressed', String(tab === 'results'));
    appsTab.setAttribute('aria-pressed', String(tab === 'apps'));
    favoritesTab.setAttribute('aria-pressed', String(tab === 'favorites'));
    websitesTab.setAttribute('aria-pressed', String(tab === 'websites'));
    favoritesTab.textContent = `★ Favorites · ${saved.length}`;
    if (android) {
      favoritesTab.setAttribute('aria-checked', String(tab === 'favorites'));
      appsTab.setAttribute('aria-checked', String(tab === 'apps'));
    }
    listTab.textContent = `${tab === 'apps' ? 'APK sites' : `★ Favorites · ${saved.length}`} ▾`;
    listTab.setAttribute('aria-pressed', String(tab === 'apps' || tab === 'favorites'));
    websitesTab.textContent = `Websites · ${favorites?.sites.length ?? 0}`;
    form.hidden = tab === 'websites' || tab === 'apps';
    webForm.hidden = tab !== 'websites';
    renderStrip();
    // Favorite stations stay playable from either tab.
    for (const s of saved) stations.set(keyOf(s), s);
    renderAreas();
    if (tab === 'apps') {
      // Android app sites: one press, no long addresses (W16 downloads their APKs).
      results.append(heading(`Android app sites · ${APP_SITES.length}`));
      for (const site of APP_SITES) {
        const node = make('div', { className: 'local-row' });
        node.setAttribute('role', 'listitem');
        const pick = make('button', { type: 'button', className: 'local-item' });
        pick.dataset.kind = 'site';
        pick.dataset.key = `app-site:${site.url}`;
        pick.dataset.url = site.url;
        if (current === site.url) pick.setAttribute('aria-pressed', 'true');
        pick.append(
          make('strong', { textContent: site.title }),
          make('small', { textContent: site.note }),
        );
        node.append(pick);
        results.append(node);
      }
      say("Choose a site. An app's APK link there downloads and opens in Android's installer.");
    } else if (tab === 'websites') {
      const sites = [...(favorites?.sites ?? [])].reverse();
      if (sites.length) results.append(heading(`Saved websites · ${sites.length}`));
      for (const site of sites) {
        const node = make('div', { className: 'local-row' });
        node.setAttribute('role', 'listitem');
        const pick = make('button', { type: 'button', className: 'local-item' });
        pick.dataset.kind = 'site';
        pick.dataset.key = `site:${site.url}`;
        pick.dataset.url = site.url;
        if (current === site.url) pick.setAttribute('aria-pressed', 'true');
        pick.append(
          make('strong', { textContent: site.title }),
          make('small', { textContent: hostOf(site.url) }),
        );
        const star = make('button', { type: 'button', className: 'local-star', textContent: '★' });
        star.dataset.key = `site:${site.url}`;
        star.setAttribute('aria-pressed', 'true');
        star.setAttribute('aria-label', `Remove ${site.title} from saved websites`);
        node.append(pick, star);
        results.append(node);
      }
      say(
        sites.length
          ? 'Say or type an address or a search, or choose a saved website.'
          : 'Say or type an address or a search. Save a page you like with ★ while it is open.',
      );
    } else if (tab === 'favorites') {
      const tvs = saved.filter((s) => s.tv).reverse();
      const radios = saved.filter((s) => s.radio).reverse();
      if (tvs.length) results.append(heading(`TV · ${tvs.length}`));
      tvs.forEach((s) => results.append(row(s)));
      if (radios.length) results.append(heading(`Radio · ${radios.length}`));
      radios.forEach((s) => results.append(row(s)));
      const areaCount = favorites?.areas.length ?? 0;
      say(
        saved.length || areaCount
          ? `${saved.length} favorite station${saved.length === 1 ? '' : 's'} · ${areaCount} saved area${areaCount === 1 ? '' : 's'}`
          : 'Press ☆ next to a station, or Save area after a scan, to keep it here.',
      );
    } else if (found) {
      const scanned = found;
      const where = scanned.places.map((p) => p.name).join(', ');
      results.append(heading(`Local TV · ${scanned.tv.length}`));
      scanned.tv.forEach((tv) => results.append(row({ area: scanned.areaCode, tv })));
      results.append(heading(`Local radio · ${scanned.radio.length}`));
      scanned.radio.forEach((radio) => results.append(row({ area: scanned.areaCode, radio })));
      const missing = [
        scanned.tvUnavailable ? 'TV stations' : '',
        scanned.radioUnavailable ? 'radio' : '',
      ].filter(Boolean);
      say(
        `${scanned.tv.length + scanned.radio.length} found near ${where}.` +
          (missing.length
            ? ` The ${missing.join(' and ')} lookup didn't answer; Scan again later.`
            : ''),
        missing.length > 0,
      );
    }
    if (focusKey) {
      const selector = `${focusStar ? '.local-star' : '.local-item'}[data-key="${CSS.escape(focusKey)}"]`;
      results.querySelector<HTMLElement>(selector)?.focus();
    }
  }
  function renderAreas(): void {
    const list = favorites?.areas ?? [];
    areas.replaceChildren(
      ...list.map((saved) => {
        const chip = make('button', {
          type: 'button',
          className: 'local-area-chip',
          textContent: `${saved.area} · ${saved.label}`,
        });
        chip.dataset.area = saved.area;
        return chip;
      }),
    );
    areas.hidden = list.length === 0 || tab !== 'favorites';
    const scanned = found?.areaCode;
    saveArea.hidden = !favorites || !scanned;
    const kept = !!scanned && list.some((a) => a.area === scanned);
    saveArea.textContent = kept ? '★ Area saved' : '☆ Save area';
    saveArea.setAttribute('aria-pressed', String(kept));
  }
  // Favorites change one at a time, in order; a failed save restores the list.
  let saving: Promise<void> = Promise.resolve();
  function changeFavorites(change: (draft: LocalFavorites) => void): void {
    if (!favorites) return;
    const before = favorites;
    const draft: LocalFavorites = structuredClone(before);
    change(draft);
    favorites = draft;
    render();
    saving = saving.then(() =>
      saveLocalFavorites(draft).then(
        (stored) => {
          if (favorites === draft) favorites = stored;
        },
        (error: unknown) => {
          if (favorites === draft) favorites = before;
          render();
          say(
            error instanceof Error ? error.message : 'Your Local favorites could not be saved.',
            true,
          );
        },
      ),
    );
    host.run(saving);
  }
  saveArea.addEventListener('click', () => {
    const scanned = found;
    if (!scanned) return;
    changeFavorites((draft) => {
      const index = draft.areas.findIndex((a) => a.area === scanned.areaCode);
      if (index >= 0) draft.areas.splice(index, 1);
      else
        draft.areas.push({
          area: scanned.areaCode,
          label:
            scanned.places
              .map((p) => p.name)
              .join(', ')
              .slice(0, 160) || scanned.areaCode,
        });
    });
  });
  areas.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('.local-area-chip');
    if (!chip?.dataset.area) return;
    area.value = chip.dataset.area;
    showTab('results');
    host.run(runScan());
  });
  function showTab(next: Tab): void {
    tab = next;
    // The voice search follows the address box while Websites shows.
    host.voice?.(next === 'websites' && active ? { container: webVoice, input: web } : null);
    render();
  }
  const menuItems = () => [favoritesTab, appsTab].filter((item) => !item.hidden);
  function setMenu(open: boolean, refocus = true): void {
    if ((listMenu.hidden !== false) === !open) return;
    listMenu.hidden = !open;
    listTab.setAttribute('aria-expanded', String(open));
    // GenX's Back closes the open list first (handleBack in main.ts).
    if (open) listMenu.dataset.popupOpen = 'true';
    else delete listMenu.dataset.popupOpen;
    if (open)
      (
        menuItems().find((item) => item.getAttribute('aria-checked') === 'true') ?? menuItems()[0]
      )?.focus();
    else if (refocus) listTab.focus();
  }
  listMenu.addEventListener('popup-close', () => setMenu(false));
  listMenu.addEventListener('keydown', (event) => {
    const items = menuItems();
    const at = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') setMenu(false);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = items[at + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    } else if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // The list keeps the remote until a choice or Back.
    event.preventDefault();
    event.stopPropagation();
  });
  // Focus moving elsewhere (a finger, a mouse) closes the list.
  listMenu.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !listMenu.contains(next) && next !== listTab) setMenu(false, false);
  });
  tabs.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.local-list-tab')) {
      setMenu(listMenu.hidden !== false);
      return;
    }
    const choice = target.closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (
      choice === 'results' ||
      (choice === 'apps' && android) ||
      choice === 'favorites' ||
      choice === 'websites'
    ) {
      showTab(choice);
      setMenu(false, listMenu.contains(target));
    }
  });
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  };
  function goWeb(): void {
    const url = webAddress(web.value);
    if (!url) return;
    host.run(openPage(url, hostOf(url)));
  }
  webForm.addEventListener('submit', (event) => {
    event.preventDefault();
    goWeb();
  });
  // A finished voice search opens at once.
  web.addEventListener('speech-search-final', goWeb);
  /** Opens the Websites tab with the address box ready (typing or the mic). */
  function askAddress(): void {
    if (!active) return;
    showTab('websites');
    web.value = pageAddress.url;
    web.focus();
    web.select();
  }
  /** Saves the open page as a website, or removes it when it is already saved. */
  async function togglePageSaved(reported?: { url: string; title: string }): Promise<void> {
    const status = reported ?? (await pageView.status().catch(() => null));
    const url = status?.url ?? '';
    if (!url.startsWith('https://') || !favorites) return;
    const title = (status?.title || hostOf(url)).slice(0, 160);
    changeFavorites((draft) => {
      const index = draft.sites.findIndex((s) => s.url === url);
      if (index >= 0) draft.sites.splice(index, 1);
      else draft.sites.push({ url, title });
    });
    pageAddress = { url, title };
    renderStrip();
  }
  function renderStrip(): void {
    strip.hidden = !(pageOpen && desktop && !full);
    const saved = !!favorites?.sites.some((s) => s.url === pageAddress.url);
    stripAddress.textContent = pageAddress.title
      ? `${pageAddress.title} · ${hostOf(pageAddress.url)}`
      : hostOf(pageAddress.url || current);
    stripSave.textContent = saved ? '★ Saved' : '☆ Save';
    stripSave.setAttribute('aria-pressed', String(saved));
  }
  stripBack.addEventListener('click', () => void pageView.history('back').catch(() => undefined));
  stripForward.addEventListener(
    'click',
    () => void pageView.history('forward').catch(() => undefined),
  );
  stripAddress.addEventListener('click', askAddress);
  stripSave.addEventListener('click', () => host.run(togglePageSaved()));
  // Android's on-screen bar asks GenX to save the page or to take an address.
  addEventListener('genx-page-save', (event) => {
    const detail = (event as CustomEvent<{ url?: unknown; title?: unknown }>).detail;
    if (typeof detail?.url === 'string')
      host.run(
        togglePageSaved({
          url: detail.url,
          title: typeof detail.title === 'string' ? detail.title : '',
        }),
      );
  });
  addEventListener('genx-page-address', askAddress);
  // Android: the remote left the page. Back keeps the remote on the page's
  // area, so one OK goes back in; Left at the page's edge goes to the list.
  addEventListener('genx-page-left', (event) => {
    if (!pageOpen || into.hidden) return;
    const reason = (event as CustomEvent<{ reason?: unknown }>).detail?.reason;
    if (reason === 'address') return;
    const row =
      reason === 'edge'
        ? (results.querySelector<HTMLElement>('.local-item[aria-pressed="true"]') ??
          results.querySelector<HTMLElement>('.local-item'))
        : null;
    const target = row ?? into;
    // Returning window focus to GenX lands on its first control (the header's
    // Free TV, measured on the Google TV Streamer) or on the body, before and
    // sometimes after this event: replace only those, for about half a
    // second, never a viewer's own move.
    const landed = document.activeElement;
    target.focus();
    let tries = 6;
    const settle = () => {
      const now = document.activeElement;
      if (now !== target && (!now || now === document.body || now === landed)) target.focus();
      else if (now !== target) return;
      if (--tries > 0) setTimeout(settle, 100);
    };
    setTimeout(settle, 100);
  });
  // Android: the page's renderer died and the page view closed itself (W10).
  addEventListener('genx-page-closed', () => {
    if (!pageOpen) return;
    void closePage();
    showNote('That page stopped working and was closed. Choose another.');
  });
  // PC: keep the strip's address current as the page navigates.
  setInterval(() => {
    if (!pageOpen || !desktop || document.hidden) return;
    void pageView
      .status()
      .then((s) => {
        if (s?.url && (s.url !== pageAddress.url || (s.title ?? '') !== pageAddress.title)) {
          pageAddress = { url: s.url, title: s.title ?? '' };
          renderStrip();
        }
      })
      .catch(() => undefined);
  }, 2500);
  // The remote moves along the form row (area, Scan, Save area) and down to
  // the tabs; spatial guessing skipped Scan from the wide area field.
  const formRow = () => [area, scan, saveArea].filter((c) => !c.hidden);
  form.addEventListener('keydown', (event) => {
    const controls = formRow();
    const at = controls.indexOf(event.target as HTMLInputElement & HTMLButtonElement);
    if (at < 0) return;
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowRight' && (at > 0 || area.selectionStart === area.value.length))
      next = controls[at + 1];
    else if (event.key === 'ArrowLeft' && at > 0) next = controls[at - 1];
    else if (event.key === 'ArrowDown')
      next = tabs.hidden
        ? (results.querySelector<HTMLElement>('.local-item') ?? undefined)
        : tab === 'results'
          ? resultsTab
          : android
            ? listTab
            : favoritesTab;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    next.focus();
  });
  const siteName = (tv: LocalTvStation) => {
    try {
      return new URL(tv.website).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  function remember(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify({ area: area.value, found }));
    } catch {
      /* A device convenience only. */
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as {
      area?: unknown;
      found?: unknown;
    } | null;
    if (saved && typeof saved.area === 'string' && validLocalArea(saved.area)) {
      area.value = saved.area;
      found = saved.found ? validateLocalStreams(saved.found) : null;
      render();
    }
  } catch {
    found = null;
  }
  // Favorites live in the app's own file, read when Local first opens; a file
  // that can't be read is reported (and kept by the next save), never treated
  // as empty.
  let favoritesRequested = false;
  const loadFavorites = () => {
    if (favoritesRequested) return;
    favoritesRequested = true;
    host.run(
      readLocalFavorites().then(
        (stored) => {
          favorites = stored;
          render();
        },
        (error: unknown) => {
          if (String((error as Error)?.cause ?? error).includes('file-invalid')) {
            favorites = emptyLocalFavorites();
            render();
            say(
              'Your Local favorites file could not be read; saving a favorite keeps a copy of it.',
              true,
            );
          }
        },
      ),
    );
  };

  async function runScan(): Promise<void> {
    const value = area.value.trim();
    if (!validLocalArea(value)) {
      say('Enter a 3-digit area code or a 5-digit ZIP code.', true);
      return;
    }
    owner?.abort();
    const owned = new AbortController();
    owner = owned;
    scan.disabled = true;
    say('Finding local TV and radio… this can take up to half a minute.');
    try {
      const next = await scanLocalStreams(value);
      if (owned.signal.aborted) return;
      found = next;
      tab = 'results';
      render();
      remember();
      if (!pageOpen) showNote('Choose a station on the left.');
      results.querySelector<HTMLButtonElement>('.local-item')?.focus();
    } catch (error) {
      if (!owned.signal.aborted)
        say(error instanceof Error ? error.message : 'The local scan could not finish.', true);
    } finally {
      if (owner === owned) owner = null;
      scan.disabled = false;
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    host.run(runScan());
  });

  /** A station's site or any website in the viewing area. */
  async function openPage(url: string, label: string): Promise<void> {
    // Pages belong to Local: one opened behind another library could never be
    // closed by leaving Local (a late voice result, a script), so none opens.
    if (!active) return;
    // Choosing the open page again returns the remote to it.
    // A page the native side no longer has (closed or lost however it went)
    // opens again instead.
    if (pageOpen && current === url) {
      const status = await pageView.status().catch(() => null);
      if (status?.open !== false) {
        await pageView.enter().catch(() => undefined);
        return;
      }
      pageOpen = false;
    }
    playing = '';
    await host.stopPlayback();
    showNote(`Opening ${label}…`);
    try {
      await pageView.open(url, pageRect(elements.stage));
      pageOpen = true;
      current = url;
      pageAddress = { url, title: '' };
      syncDock();
      follow();
      into.hidden = false;
      showNote('');
      render();
    } catch (error) {
      showNote(
        String(error) === 'web-page-unavailable'
          ? 'Websites open inside GenX on Android TV and Windows.'
          : 'This page could not open. Try another.',
      );
    }
  }
  async function choose(node: HTMLElement): Promise<void> {
    const key = node.dataset.key ?? '';
    if (node.dataset.kind === 'site' && node.dataset.url) {
      await openPage(node.dataset.url, node.querySelector('strong')?.textContent ?? '');
      return;
    }
    const station = stations.get(key);
    if (!station) return;
    for (const other of results.querySelectorAll('.local-item'))
      other.setAttribute('aria-pressed', String(other.getAttribute('data-key') === key));
    const radio = station.radio;
    if (radio) {
      playing = key;
      await closePage();
      // Radio has no picture: a station card replaces the player's blank frame.
      showNote('', radio);
      await host.playRadio({ id: `local-radio:${radio.id}`, name: radio.name, url: radio.stream });
      return;
    }
    const tv = station.tv;
    if (!tv) return;
    await openPage(tv.website, tv.callSign || tv.name);
  }
  // Right from the open station's star hands the remote to its page.
  results.addEventListener('keydown', (event) => {
    const star = (event.target as HTMLElement).closest<HTMLElement>('.local-star');
    if (event.key !== 'ArrowRight' || !pageOpen) return;
    const key =
      star?.dataset.key ??
      (event.target as HTMLElement).closest<HTMLElement>('.local-item')?.dataset.key;
    if (key !== `tv:${current}`) return;
    // Without stars (favorites unavailable) Right on the station itself enters.
    if (!star && favorites) return;
    event.preventDefault();
    event.stopPropagation();
    enterPage();
  });
  results.addEventListener('click', (event) => {
    const star = (event.target as HTMLElement).closest<HTMLElement>('.local-star');
    if (star?.dataset.key?.startsWith('site:')) {
      const url = star.dataset.key.slice(5);
      changeFavorites((draft) => {
        draft.sites = draft.sites.filter((s) => s.url !== url);
      });
      renderStrip();
      return;
    }
    if (star?.dataset.key) {
      const key = star.dataset.key;
      const station = stations.get(key);
      if (!station) return;
      changeFavorites((draft) => {
        const index = draft.stations.findIndex((s) => keyOf(s) === key);
        if (index >= 0) draft.stations.splice(index, 1);
        else draft.stations.push(structuredClone(station));
      });
      return;
    }
    const node = (event.target as HTMLElement).closest<HTMLElement>('.local-item');
    if (node) host.run(choose(node));
  });

  // The page view follows the viewing area. Fullscreen shows only the page's
  // video and gives the remote to the page (Play/Pause, pointer).
  let full = false;
  // On a desktop the page is a window layer over GenX's own controls, so in
  // Full screen GenX's dock stays visible below it (Exit full screen, Pause,
  // Mute) and the keyboard stays with GenX; Android draws its own bar.
  const desktop = !/Android/i.test(navigator.userAgent);
  const app = document.getElementById('app');
  const dock = () => elements.stage.closest('.view')?.querySelector<HTMLElement>('.dock') ?? null;
  const placement = (): PageRect => {
    const rect = pageRect(elements.stage);
    const scale = window.devicePixelRatio || 1;
    // The PC address strip sits above the page.
    const top = !full && desktop && !strip.hidden ? Math.round(strip.offsetHeight * scale) : 0;
    const placed: PageRect = [rect[0], rect[1] + top, rect[2], Math.max(1, rect[3] - top)];
    const bar = full && desktop ? dock() : null;
    if (!bar) return placed;
    const bottom = Math.round(bar.getBoundingClientRect().top * scale);
    return [placed[0], placed[1], placed[2], Math.max(1, Math.min(placed[3], bottom - placed[1]))];
  };
  const follow = () => {
    app?.classList.toggle('local-page-open', pageOpen && desktop);
    if (!pageOpen) return;
    const now = !!document.querySelector('#app.viewing-fullscreen') || !!document.fullscreenElement;
    const changed = now !== full;
    full = now;
    renderStrip();
    void pageView.place(placement()).catch(() => undefined);
    if (!changed) return;
    void pageView
      .videoOnly(now)
      .then(() => (now && !desktop ? pageView.enter() : undefined))
      .catch(() => undefined);
  };
  // The page is a native layer above GenX: it hides while any GenX dialog is open.
  let covered = false;
  new MutationObserver(() => {
    const now = !!document.querySelector('dialog[open]');
    if (now === covered) return;
    covered = now;
    if (pageOpen) void pageView.shown(!now).catch(() => undefined);
  }).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  const sizes = new ResizeObserver(follow);
  sizes.observe(elements.stage);
  const bar = dock();
  if (bar) sizes.observe(bar);
  window.addEventListener('resize', follow);

  function open(value: boolean): void {
    active = value;
    panel.hidden = !value;
    elements.list.hidden = value;
    button.setAttribute('aria-pressed', String(value));
    if (value) {
      loadFavorites();
      for (const other of elements.leave) other.setAttribute('aria-pressed', 'false');
      showNote(found ? 'Choose a station on the left.' : 'Enter an area code or ZIP, then Scan.');
      if (tab === 'websites') host.voice?.({ container: webVoice, input: web });
    } else {
      owner?.abort();
      showNote('');
      host.voice?.(null);
      void closePage();
    }
  }
  button.addEventListener('click', () => {
    if (active) return;
    host.run(
      host.showLive().then(() => {
        open(true);
        (found ? results.querySelector<HTMLButtonElement>('.local-item') : area)?.focus();
      }),
    );
  });
  // Any other library leaves Local first.
  for (const other of elements.leave)
    other.addEventListener('click', () => active && open(false), { capture: true });

  // While a station page is open GenX's own Pause and Mute drive the page's
  // video, so the same buttons work on every site.
  const dockButton = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  const syncDock = () => {
    const pause = dockButton('pause-button');
    if (pause && pageOpen) pause.disabled = false;
  };
  document.addEventListener(
    'click',
    (event) => {
      if (!pageOpen) return;
      const id = (event.target as HTMLElement | null)?.closest('button')?.id;
      if (id !== 'pause-button' && id !== 'mute-button') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pageView.remote(id === 'pause-button' ? 'play' : 'mute').catch(() => undefined);
    },
    true,
  );

  return {
    get active() {
      return active;
    },
    /** A station page holds the viewing area (GenX's Pause and Mute drive it). */
    get pageOpen() {
      return pageOpen;
    },
    /** Plain-HTTP radio is allowed only for streams in the current results or favorites. */
    allowsHttp(url: string): boolean {
      return (
        url.startsWith('http://') && [...stations.values()].some((s) => s.radio?.stream === url)
      );
    },
    /** A chosen radio stream as a playable channel; the catalog never holds these. */
    channel(id: string) {
      const radio = stations.get(`radio:${id.replace(/^local-radio:/, '')}`)?.radio;
      return radio ? { id, name: radio.name, urls: [radio.stream] } : undefined;
    },
    close: () => open(false),
  };
}
