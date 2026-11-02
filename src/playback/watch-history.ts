// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { boundedUtf8Text } from '../platform/bounded-text';

export type WatchHistoryScope = { kind: 'free' } | { kind: 'paid'; accountId: string };
export interface WatchedChannel {
  id: string;
  watchedAtMs: number;
}
export interface WatchHistoryAdapter {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
export const WATCH_HISTORY_LIMIT = 256;
export const WATCH_HISTORY_STORAGE_KEY = 'genx.watch-history.v1';
const MAX_SCOPES = 32;
const MAX_BYTES = 2 * 1024 * 1024;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const invalid = () => new Error('Watch history is invalid.');
const unavailable = () => new Error('Watch history could not be saved or loaded.');

export function validateHistoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > WATCH_HISTORY_LIMIT) throw invalid();
  const ids: string[] = [];
  for (const id of value) {
    if (
      !boundedUtf8Text(id, 16_384) ||
      /\p{Cc}|:\/\/|^(?:data|file):/iu.test(id) ||
      ids.includes(id)
    )
      throw invalid();
    ids.push(id);
  }
  return ids;
}
function scopeKey(scope: WatchHistoryScope): string {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw invalid();
  if (scope.kind === 'free' && Object.keys(scope).length === 1) return 'free';
  if (
    scope.kind === 'paid' &&
    Object.keys(scope).length === 2 &&
    typeof scope.accountId === 'string' &&
    ACCOUNT.test(scope.accountId)
  )
    return `paid:${scope.accountId}`;
  throw invalid();
}
function scopedId(key: string, id: string): boolean {
  if (key === 'free') return !/^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id);
  const account = key.slice(5);
  return id.startsWith(`account-${account}-`) && /^[a-f0-9]{64}$/u.test(id.slice(41));
}
function parse(text: string | null): Map<string, WatchedChannel[]> {
  if (text === null) return new Map();
  if (!boundedUtf8Text(text, MAX_BYTES)) throw invalid();
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    row.schemaVersion !== 1 ||
    !Array.isArray(row.scopes) ||
    row.scopes.length > MAX_SCOPES
  )
    throw invalid();
  const result = new Map<string, WatchedChannel[]>();
  for (const raw of row.scopes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
    const section = raw as Record<string, unknown>;
    if (
      Object.keys(section).length !== 2 ||
      typeof section.scope !== 'string' ||
      !Array.isArray(section.entries) ||
      result.has(section.scope)
    )
      throw invalid();
    const key = section.scope;
    if (key !== 'free' && !/^paid:[a-f0-9]{32}$/u.test(key)) throw invalid();
    const ids = validateHistoryIds(
      section.entries.map((entry: unknown) =>
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>).id : undefined,
      ),
    );
    const entries = section.entries.map((entry: unknown, i: number) => {
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).length !== 2 ||
        !Number.isSafeInteger(item.watchedAtMs) ||
        Number(item.watchedAtMs) < 0 ||
        !scopedId(key, ids[i]!)
      )
        throw invalid();
      return { id: ids[i]!, watchedAtMs: item.watchedAtMs as number };
    });
    result.set(key, entries);
  }
  return result;
}
function serialize(scopes: ReadonlyMap<string, readonly WatchedChannel[]>): string {
  const text = JSON.stringify({
    schemaVersion: 1,
    scopes: [...scopes].map(([scope, entries]) => ({ scope, entries })),
  });
  if (!boundedUtf8Text(text, MAX_BYTES)) throw invalid();
  return text;
}

/** Device-local IDs and timestamps only. Record only after current decoded-frame
 * ownership is confirmed by the caller. This is never a playback entitlement. */
export function createWatchHistory(adapter?: WatchHistoryAdapter, now: () => number = Date.now) {
  const storage = adapter ?? {
    read: async () => localStorage.getItem(WATCH_HISTORY_STORAGE_KEY),
    write: async (text: string) => localStorage.setItem(WATCH_HISTORY_STORAGE_KEY, text),
  };
  let current = new Map<string, WatchedChannel[]>();
  let loaded = false;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => undefined).then(work);
    queue = result;
    return result;
  };
  const load = async () => {
    if (loaded) return;
    try {
      current = parse(await storage.read());
      loaded = true;
    } catch {
      throw unavailable();
    }
  };
  const get = (scope: WatchHistoryScope): WatchedChannel[] =>
    (current.get(scopeKey(scope)) ?? []).map((entry) => ({ ...entry }));
  const mutate = (
    scope: WatchHistoryScope,
    update: (entries: WatchedChannel[]) => WatchedChannel[],
  ) => {
    let key: string;
    try {
      key = scopeKey(scope);
    } catch {
      return Promise.reject(invalid());
    }
    return enqueue(async () => {
      await load();
      const entries = update((current.get(key) ?? []).map((entry) => ({ ...entry })));
      const next = new Map(current);
      if (entries.length) {
        if (!next.has(key) && next.size >= MAX_SCOPES) throw unavailable();
        next.set(key, entries);
      } else next.delete(key);
      if (JSON.stringify(current.get(key) ?? []) === JSON.stringify(entries)) return;
      try {
        await storage.write(serialize(next));
      } catch {
        loaded = false;
        throw unavailable();
      }
      current = next;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* Observers cannot undo acknowledged history. */
        }
      }
    });
  };
  return {
    get loaded() {
      return loaded;
    },
    load: () => enqueue(load),
    get,
    ids: (scope: WatchHistoryScope) => get(scope).map((entry) => entry.id),
    record(scope: WatchHistoryScope, id: string): Promise<void> {
      try {
        validateHistoryIds([id]);
        if (!scopedId(scopeKey(scope), id)) throw invalid();
      } catch {
        return Promise.reject(invalid());
      }
      return mutate(scope, (entries) => {
        const watchedAtMs = now();
        if (!Number.isSafeInteger(watchedAtMs) || watchedAtMs < 0) throw invalid();
        return [{ id, watchedAtMs }, ...entries.filter((entry) => entry.id !== id)].slice(
          0,
          WATCH_HISTORY_LIMIT,
        );
      });
    },
    remove(scope: WatchHistoryScope, id: string): Promise<void> {
      try {
        validateHistoryIds([id]);
        if (!scopedId(scopeKey(scope), id)) throw invalid();
      } catch {
        return Promise.reject(invalid());
      }
      return mutate(scope, (entries) => entries.filter((entry) => entry.id !== id));
    },
    clear: (scope: WatchHistoryScope) => mutate(scope, () => []),
    // Mutation/load callers retain their own failure. Closing only joins the
    // already observed optional persistence work; it does not assert a save.
    settle: () =>
      queue.then(
        () => undefined,
        () => undefined,
      ),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
let shared: ReturnType<typeof createWatchHistory> | undefined;
export function getWatchHistory() {
  return (shared ??= createWatchHistory());
}
