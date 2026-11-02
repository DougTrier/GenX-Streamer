// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { boundedUtf8Text } from '../platform/bounded-text';
import { normalizeLiveBufferPreference, type LiveBufferPreference } from './live-buffer';

export const STREAM_BUFFER_STORAGE_KEY = 'genx.stream-buffer-preferences.v1';
export const STREAM_BUFFER_ENTRY_LIMIT = 256;
export const STREAM_BUFFER_RECORD_BYTES = 64 * 1024;
const KEY = /^[a-f0-9]{64}$/u;
const AUTO: LiveBufferPreference = { mode: 'auto' };

export interface StreamBufferPreferencesAdapter {
  read(): Promise<string | null>;
  /** Resolve only after atomic publication; reject without exposing storage details. */
  write(text: string): Promise<void>;
}
const invalid = () => new Error('The stream buffer preference is invalid.');
const unavailable = () => new Error('Stream buffer preferences could not be saved or loaded.');
const full = () => new Error('Stream buffer preferences are full. Reset an existing stream first.');

async function digest(tuple: readonly string[]): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(tuple));
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw invalid();
  }
}

/** Same WHATWG URL serialization used by the catalog parser. Never remove
 * query/security parameters or fragments, or key on scan/list identifiers.
 * The endpoint exists transiently for hashing and is never retained by this store. */
export async function freeStreamBufferKey(endpointUrl: string): Promise<string> {
  try {
    if (!boundedUtf8Text(endpointUrl, 16_384)) throw invalid();
    const url = new URL(endpointUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !boundedUtf8Text(url.href, 16_384)
    )
      throw invalid();
    return await digest(['stream-buffer-v1', 'free', url.href]);
  } catch {
    throw invalid();
  }
}

/** Native acquisition derives this channel ID from account/provider identity,
 * refusing ambiguous rows. A new streamReference is issued on each install;
 * neither that capability nor catalog/account revisions are durable identity.
 * If a real rename changes native identity, never guess a preference transfer. */
export async function paidStreamBufferKey(
  accountId: string,
  stableChannelId: string,
  format: 'primary' | 'alternate',
): Promise<string> {
  if (
    typeof accountId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !['primary', 'alternate'].includes(format) ||
    typeof stableChannelId !== 'string' ||
    !stableChannelId.startsWith(`account-${accountId}-`) ||
    !/^[a-f0-9]{64}$/u.test(stableChannelId.slice(`account-${accountId}-`.length))
  )
    throw invalid();
  return digest(['stream-buffer-v1', 'paid', accountId, stableChannelId, format]);
}

/** Provider movie/episode identity, not its issued localhost playback URL. */
export async function paidVodStreamBufferKey(
  accountId: string,
  kind: 'movie' | 'episode',
  itemId: string,
  extension: string,
): Promise<string> {
  if (
    typeof accountId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !['movie', 'episode'].includes(kind) ||
    typeof itemId !== 'string' ||
    !/^[0-9]{1,32}$/u.test(itemId) ||
    typeof extension !== 'string' ||
    !/^(?:[a-z0-9]{2,5})?$/u.test(extension)
  )
    throw invalid();
  return digest(['stream-buffer-v1', 'paid-vod', accountId, kind, itemId, extension]);
}

/** Native fileRef is derived from provider item+filename, without revision or
 * playback capability. Saved and remote sources remain independent. */
export async function archiveStreamBufferKey(
  fileRef: string,
  source: 'remote' | 'saved',
): Promise<string> {
  if (typeof fileRef !== 'string' || !KEY.test(fileRef) || !['remote', 'saved'].includes(source))
    throw invalid();
  return digest(['stream-buffer-v1', 'archive', fileRef, source]);
}

function parse(text: string | null): Map<string, number> {
  if (text === null) return new Map();
  if (!boundedUtf8Text(text, STREAM_BUFFER_RECORD_BYTES)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    row.schemaVersion !== 1 ||
    !Array.isArray(row.entries) ||
    row.entries.length > STREAM_BUFFER_ENTRY_LIMIT
  )
    throw invalid();
  const entries = new Map<string, number>();
  for (const entry of row.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      typeof item.key !== 'string' ||
      !KEY.test(item.key) ||
      entries.has(item.key) ||
      !normalizeLiveBufferPreference({ mode: 'manual', targetSeconds: item.targetSeconds })
    )
      throw invalid();
    entries.set(item.key, item.targetSeconds as number);
  }
  return entries;
}

function serialize(entries: ReadonlyMap<string, number>): string {
  const text = JSON.stringify({
    schemaVersion: 1,
    entries: [...entries].map(([key, targetSeconds]) => ({ key, targetSeconds })),
  });
  if (!boundedUtf8Text(text, STREAM_BUFFER_RECORD_BYTES)) throw invalid();
  return text;
}

/** Device-local cache tuning, intentionally outside catalog/settings exports and
 * Full backup. Browser/WebView app-private storage survives ordinary restarts.
 * Only opaque digests plus manual seconds are written; Auto deletes ONE key.
 * One application instance owns this serialized store. */
export function createStreamBufferPreferences(adapter?: StreamBufferPreferencesAdapter) {
  const storage = adapter ?? {
    read: async () => localStorage.getItem(STREAM_BUFFER_STORAGE_KEY),
    write: async (text: string) => localStorage.setItem(STREAM_BUFFER_STORAGE_KEY, text),
  };
  let current = new Map<string, number>();
  let loaded = false;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => undefined).then(work);
    queue = result;
    return result;
  };
  const load = async () => {
    if (loaded) return;
    try {
      const next = parse(await storage.read());
      current = next;
      loaded = true;
    } catch {
      throw unavailable();
    }
  };
  const get = (key: string): LiveBufferPreference => {
    if (typeof key !== 'string' || !KEY.test(key)) throw invalid();
    const targetSeconds = current.get(key);
    return targetSeconds === undefined ? { ...AUTO } : { mode: 'manual', targetSeconds };
  };
  const set = (key: string, value: LiveBufferPreference): Promise<LiveBufferPreference> => {
    let preference: LiveBufferPreference | null;
    try {
      if (typeof key !== 'string' || !KEY.test(key)) throw invalid();
      preference = normalizeLiveBufferPreference(value);
      if (!preference) throw invalid();
    } catch {
      return Promise.reject(invalid());
    }
    return enqueue(async () => {
      await load();
      const next = new Map(current);
      if (preference.mode === 'auto') next.delete(key);
      else {
        if (!next.has(key) && next.size === STREAM_BUFFER_ENTRY_LIMIT) throw full();
        next.set(key, preference.targetSeconds);
      }
      if (current.size === next.size && current.get(key) === next.get(key)) return get(key);
      try {
        await storage.write(serialize(next));
      } catch {
        // An injected/native adapter might commit and lose its acknowledgement.
        // Keep the last acknowledged cache; re-read before another mutation.
        loaded = false;
        throw unavailable();
      }
      current = next;
      return get(key);
    });
  };
  return {
    get loaded(): boolean {
      return loaded;
    },
    load: () => enqueue(load),
    get,
    set,
    reset: (key: string) => set(key, { mode: 'auto' }),
  };
}

let shared: ReturnType<typeof createStreamBufferPreferences> | undefined;
/** Lazy: importing player code never touches browser storage. */
export function getStreamBufferPreferences() {
  return (shared ??= createStreamBufferPreferences());
}
