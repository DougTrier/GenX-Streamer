import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** Movies and series a paid provider offers on demand (Xtream catalog). */
export type AccountVodSection = 'movies' | 'series';
export interface AccountVodCategory {
  id: string;
  name: string;
}
export interface AccountVodItem {
  id: string;
  name: string;
  year?: string;
  rating?: string;
  /** HTTPS artwork that carries no part of the sign-in. */
  poster?: string;
  /** Movies only; a series opens its episode list instead. */
  extension?: string;
}
export interface AccountVodListing {
  categories: AccountVodCategory[];
  items: AccountVodItem[];
  skipped: number;
}
export interface AccountVodEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  /** Absent when the provider gives no usable container (XC-021). */
  extension?: string;
  durationSeconds?: number;
}
/** One title's description from the provider (the browsing banner). */
export interface AccountVodDetails {
  plot?: string;
  genre?: string;
  director?: string;
  cast?: string;
  year?: string;
  durationSeconds?: number;
  /** HTTPS artwork that carries no part of the sign-in. */
  backdrop?: string;
}
export interface AccountVodAccount {
  id: string;
  revision: string;
}

const invalid = () => new Error('The provider’s on-demand list could not be read.');
const EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'm4v',
  'mov',
  'webm',
  'avi',
  'ts',
  'm3u8',
  'flv',
  'mpg',
  'mpeg',
]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return value as Record<string, unknown>;
}
function only(row: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const text = (value: unknown, limit = 300): value is string =>
  boundedUtf8Text(value, limit) && value.trim().length > 0;
const optionalText = (value: unknown): boolean => value === undefined || text(value, 40);
function poster(value: unknown): boolean {
  if (value === undefined) return true;
  if (!boundedUtf8Text(value, 1024)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.href === value;
  } catch {
    return false;
  }
}
function account(value: AccountVodAccount): AccountVodAccount {
  if (
    !/^[a-f0-9]{32}$/u.test(value?.id ?? '') ||
    !/^[1-9][0-9]{0,18}$/u.test(value?.revision ?? '')
  )
    throw invalid();
  return { id: value.id, revision: value.revision };
}
function envelope(value: unknown, owner: AccountVodAccount): Record<string, unknown> {
  const row = record(value);
  if (row.schemaVersion !== 1 || row.accountId !== owner.id || row.revision !== owner.revision)
    throw invalid();
  return row;
}

export function validateAccountVodListing(
  value: unknown,
  owner: AccountVodAccount,
): AccountVodListing {
  const row = envelope(value, owner);
  only(row, ['schemaVersion', 'accountId', 'revision', 'categories', 'items', 'skipped']);
  if (
    !Array.isArray(row.categories) ||
    !Array.isArray(row.items) ||
    row.categories.length > 5000 ||
    row.items.length > 20000 ||
    !Number.isSafeInteger(row.skipped) ||
    (row.skipped as number) < 0
  )
    throw invalid();
  const categories = row.categories.map((value) => {
    const category = record(value);
    only(category, ['id', 'name']);
    if (!id(category.id) || !text(category.name)) throw invalid();
    return { id: category.id, name: category.name };
  });
  const items = row.items.map((value) => {
    const item = record(value);
    only(item, ['id', 'name'], ['year', 'rating', 'poster', 'extension']);
    if (
      !id(item.id) ||
      !text(item.name) ||
      !optionalText(item.year) ||
      !optionalText(item.rating) ||
      !poster(item.poster) ||
      (item.extension !== undefined && !EXTENSIONS.has(item.extension as string))
    )
      throw invalid();
    return { ...item } as unknown as AccountVodItem;
  });
  return { categories, items, skipped: row.skipped as number };
}
export function validateAccountVodEpisodes(
  value: unknown,
  owner: AccountVodAccount,
): AccountVodEpisode[] {
  const row = envelope(value, owner);
  only(row, ['schemaVersion', 'accountId', 'revision', 'episodes', 'skipped']);
  if (
    !Array.isArray(row.episodes) ||
    row.episodes.length > 5000 ||
    !Number.isSafeInteger(row.skipped) ||
    (row.skipped as number) < 0
  )
    throw invalid();
  return row.episodes.map((value) => {
    const episode = record(value);
    only(episode, ['id', 'season', 'episode', 'title'], ['extension', 'durationSeconds']);
    const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    if (
      !id(episode.id) ||
      !count(episode.season) ||
      !count(episode.episode) ||
      !text(episode.title) ||
      (episode.extension !== undefined && !EXTENSIONS.has(episode.extension as string)) ||
      (episode.durationSeconds !== undefined && !count(episode.durationSeconds))
    )
      throw invalid();
    return { ...episode } as unknown as AccountVodEpisode;
  });
}

export function validateAccountVodDetails(
  value: unknown,
  owner: AccountVodAccount,
  itemId: string,
): AccountVodDetails {
  const row = envelope(value, owner);
  only(row, ['schemaVersion', 'accountId', 'revision', 'itemId', 'details']);
  if (row.itemId !== itemId) throw invalid();
  const details = record(row.details);
  only(details, [], ['plot', 'genre', 'director', 'cast', 'year', 'durationSeconds', 'backdrop']);
  const optional = (value: unknown, limit: number) => value === undefined || text(value, limit);
  if (
    !optional(details.plot, 4096) ||
    !optional(details.genre, 1024) ||
    !optional(details.director, 1024) ||
    !optional(details.cast, 1024) ||
    !(
      details.year === undefined ||
      (typeof details.year === 'string' && /^\d{4}$/u.test(details.year))
    ) ||
    !(
      details.durationSeconds === undefined ||
      (Number.isSafeInteger(details.durationSeconds) &&
        (details.durationSeconds as number) > 0 &&
        (details.durationSeconds as number) <= 86400)
    ) ||
    !poster(details.backdrop)
  )
    throw invalid();
  return { ...details } as AccountVodDetails;
}

export function createAccountVod(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('On-demand titles require the installed application.'));
      return invoke(command, args);
    },
  };
  const failure = (): never => {
    throw new Error('The provider’s on-demand list could not load. Retry or reload the account.');
  };
  return {
    list(
      target: AccountVodAccount,
      section: AccountVodSection,
      categoryId: string | null,
      signal?: AbortSignal,
    ): Promise<AccountVodListing> {
      const owner = account(target);
      if (section !== 'movies' && section !== 'series') throw invalid();
      if (categoryId !== null && !id(categoryId)) throw invalid();
      return invokeOwnedNative(
        native,
        'account_vod_list',
        {
          request: {
            schemaVersion: 1,
            accountId: owner.id,
            expectedRevision: owner.revision,
            section,
            categoryId,
          },
        },
        { signal, validate: (value) => validateAccountVodListing(value, owner), failure },
      );
    },
    /** The provider's description of one title, for the banner. */
    details(
      target: AccountVodAccount,
      section: AccountVodSection,
      itemId: string,
      signal?: AbortSignal,
    ): Promise<AccountVodDetails> {
      const owner = account(target);
      if ((section !== 'movies' && section !== 'series') || !id(itemId)) throw invalid();
      return invokeOwnedNative(
        native,
        'account_vod_details',
        {
          request: {
            schemaVersion: 1,
            accountId: owner.id,
            expectedRevision: owner.revision,
            section,
            itemId,
          },
        },
        { signal, validate: (value) => validateAccountVodDetails(value, owner, itemId), failure },
      );
    },
    episodes(
      target: AccountVodAccount,
      seriesId: string,
      signal?: AbortSignal,
    ): Promise<AccountVodEpisode[]> {
      const owner = account(target);
      if (!id(seriesId)) throw invalid();
      return invokeOwnedNative(
        native,
        'account_series_info',
        {
          request: {
            schemaVersion: 1,
            accountId: owner.id,
            expectedRevision: owner.revision,
            seriesId,
          },
        },
        { signal, validate: (value) => validateAccountVodEpisodes(value, owner), failure },
      );
    },
  };
}
