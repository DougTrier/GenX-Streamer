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

import { invoke, isTauri } from '@tauri-apps/api/core';

/** A local TV station's website (opened in the in-app page view). */
export interface LocalTvStation {
  name: string;
  callSign?: string | null;
  website: string;
  place: string;
  distanceKm: number;
}
/** A local radio stream (played in the GenX player). */
export interface LocalRadioStation {
  id: string;
  name: string;
  stream: string;
  codec: string;
  bitrate: number;
  homepage?: string | null;
  area: string;
}
export interface LocalStreams {
  schemaVersion: 1;
  areaCode: string;
  places: { name: string; state?: string | null }[];
  tv: LocalTvStation[];
  radio: LocalRadioStation[];
  /** One half of the lookup failed; the other half's results are still here. */
  tvUnavailable?: boolean;
  radioUnavailable?: boolean;
}

/** A three-digit area code (not starting 0 or 1) or a five-digit ZIP code. */
export const validLocalArea = (value: string) => /^(?:[2-9]\d{2}|\d{5})$/.test(value);

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const web = (value: unknown): value is string => {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
};
const invalid = () => new Error('Local streams could not be read. Retry the scan.');

export function validateLocalStreams(raw: unknown): LocalStreams {
  const value = raw as LocalStreams;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !validLocalArea(value.areaCode) ||
    !Array.isArray(value.places) ||
    !Array.isArray(value.tv) ||
    !Array.isArray(value.radio) ||
    value.tv.length > 60 ||
    value.radio.length > 120 ||
    value.places.length > 4 ||
    ![undefined, true, false].includes(value.tvUnavailable) ||
    ![undefined, true, false].includes(value.radioUnavailable)
  )
    throw invalid();
  for (const place of value.places) if (!text(place?.name, 120)) throw invalid();
  for (const tv of value.tv)
    if (
      !text(tv?.name, 120) ||
      !web(tv.website) ||
      !tv.website.startsWith('https://') ||
      !text(tv.place, 120) ||
      !Number.isSafeInteger(tv.distanceKm) ||
      tv.distanceKm < 0
    )
      throw invalid();
  for (const radio of value.radio)
    if (
      !text(radio?.id, 64) ||
      !text(radio.name, 120) ||
      !web(radio.stream) ||
      typeof radio.codec !== 'string' ||
      !Number.isSafeInteger(radio.bitrate)
    )
      throw invalid();
  return value;
}

/** Wikidata and Radio Browser through the native app; about ten seconds. */
export async function scanLocalStreams(area: string): Promise<LocalStreams> {
  if (!validLocalArea(area)) throw new Error('Enter a 3-digit area code or a 5-digit ZIP code.');
  if (!isTauri()) throw new Error('Local streams need the GenX app.');
  try {
    return validateLocalStreams(await invoke('local_streams_scan', { areaCode: area }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Local streams could not')) throw error;
    const code = String(error);
    throw new Error(
      code === 'local-streams-area-code-unknown'
        ? 'No places were found for that area code or ZIP code.'
        : 'The local scan could not finish. Check the connection and retry.',
      { cause: error },
    );
  }
}

/** The viewing area in window pixels, for the native page view. */
export type PageRect = [left: number, top: number, width: number, height: number];
export function pageRect(element: HTMLElement): PageRect {
  const box = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return [
    Math.max(0, Math.round(box.left * scale)),
    Math.max(0, Math.round(box.top * scale)),
    Math.max(1, Math.round(box.width * scale)),
    Math.max(1, Math.round(box.height * scale)),
  ];
}

/** A station's own website inside the viewing area (Android TV for now). */
export const pageView = {
  open: (url: string, rect: PageRect) =>
    invoke('web_page', { action: 'open', url, rect }).then(() => true),
  place: (rect: PageRect) => invoke('web_page', { action: 'place', url: null, rect }),
  enter: () => invoke('web_page', { action: 'enter', url: null, rect: null }),
  /** The page's own history. */
  history: (step: 'back' | 'forward') =>
    invoke('web_page', { action: step, url: null, rect: null }),
  /** The open page's address and title. */
  status: () =>
    invoke<{ open?: boolean; url?: string; title?: string }>('web_page', {
      action: 'status',
      url: null,
      rect: null,
    }),
  /** GenX's Pause and Mute, sent to the page's videos in every frame. */
  remote: (command: 'play' | 'mute') =>
    invoke('web_page', { action: command, url: null, rect: null }),
  /** Only the page's video (GenX fullscreen), or the whole page again. */
  videoOnly: (value: boolean) =>
    invoke('web_page', { action: value ? 'video' : 'page', url: null, rect: null }),
  /** The page is drawn above GenX, so it steps aside for GenX dialogs. */
  shown: (value: boolean) =>
    invoke('web_page', { action: value ? 'show' : 'hide', url: null, rect: null }),
  close: () => invoke('web_page', { action: 'close', url: null, rect: null }),
};

/** Saved stations (from any area's scan) and saved areas (searches rerun when chosen). */
export interface LocalFavoriteStation {
  area: string;
  tv?: LocalTvStation | null;
  radio?: LocalRadioStation | null;
}
/** A website saved from the page view. */
export interface LocalSite {
  url: string;
  title: string;
}
export interface LocalFavorites {
  schemaVersion: 1;
  stations: LocalFavoriteStation[];
  areas: { area: string; label: string }[];
  sites: LocalSite[];
}
export const emptyLocalFavorites = (): LocalFavorites => ({
  schemaVersion: 1,
  stations: [],
  areas: [],
  sites: [],
});
export function validateLocalFavorites(raw: unknown): LocalFavorites {
  const value = raw as LocalFavorites;
  const bad = () => new Error('Your Local favorites could not be read.');
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.stations) ||
    !Array.isArray(value.areas) ||
    value.stations.length > 200 ||
    value.areas.length > 50
  )
    throw bad();
  for (const station of value.stations) {
    if (!validLocalArea(station?.area) || !!station.tv === !!station.radio) throw bad();
    if (station.tv && (!text(station.tv.name, 120) || !web(station.tv.website))) throw bad();
    if (station.radio && (!text(station.radio.id, 64) || !web(station.radio.stream))) throw bad();
  }
  for (const saved of value.areas)
    if (!validLocalArea(saved?.area) || !text(saved.label, 160)) throw bad();
  // Files saved before websites existed have none.
  const sites = value.sites ?? [];
  if (!Array.isArray(sites) || sites.length > 100) throw bad();
  for (const site of sites)
    if (!web(site?.url) || !site.url.startsWith('https://') || !text(site.title, 160)) throw bad();
  return { ...value, sites };
}
/** The owner's saved Local stations and areas (native file; none outside the app). */
export async function readLocalFavorites(): Promise<LocalFavorites> {
  if (!isTauri()) throw new Error('Local favorites need the GenX app.');
  return validateLocalFavorites(await invoke('local_favorites_read'));
}
export async function saveLocalFavorites(favorites: LocalFavorites): Promise<LocalFavorites> {
  if (!isTauri()) throw new Error('Local favorites need the GenX app.');
  try {
    return validateLocalFavorites(await invoke('local_favorites_save', { favorites }));
  } catch (error) {
    throw new Error('Your Local favorites could not be saved. Try again.', { cause: error });
  }
}

/**
 * What someone typed or said in the address box: an address opens directly
 * (https only), anything else is a web search.
 */
export function webAddress(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const typed = /^https?:\/\//i.test(value) ? value.replace(/^http:/i, 'https:') : null;
  const bare =
    !typed && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(value) ? `https://${value}` : null;
  const candidate = typed ?? bare;
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password)
        return url.href;
    } catch {
      /* Not an address: search for it instead. */
    }
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}
