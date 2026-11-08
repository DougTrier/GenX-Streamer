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

import type { CatalogRecord, Channel } from '../catalog';
import { isPpvChannel } from '../catalog/ppv';
import { boundedUtf8Text } from '../platform/bounded-text';
import { shareableStream } from './share-link';

export const FAVORITES_FILE = 'genx-favorites.json';
export const MAX_FAVORITES_BYTES = 1024 * 1024;
const MAX_FAVORITES = 1000;

export interface SharedFavorite {
  name: string;
  category: string;
  endpoint: string;
  provider?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown, limit: number, empty = false): value is string =>
  boundedUtf8Text(value, limit, empty) && !/[\p{Cc}\p{Bidi_Control}]/u.test(value);

function favorite(value: unknown): SharedFavorite {
  if (
    !object(value) ||
    !label(value.name, 512) ||
    !label(value.category, 256, true) ||
    typeof value.endpoint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.endpoint) ||
    (value.provider !== undefined &&
      (typeof value.provider !== 'string' || !/^[a-f0-9]{64}$/u.test(value.provider))) ||
    isPpvChannel({ name: value.name, category: value.category })
  )
    throw new Error('The list contains an invalid or non-Free TV favorite.');
  return {
    name: value.name,
    category: value.category,
    endpoint: value.endpoint,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
  };
}

export function encodeFavorites(items: readonly SharedFavorite[]): string {
  if (items.length > MAX_FAVORITES) throw new Error('Choose a smaller set of favorites to share.');
  const text = JSON.stringify({
    format: 'genx-free-tv-favorites',
    version: 1,
    channels: items.map(favorite),
  });
  if (!boundedUtf8Text(text, MAX_FAVORITES_BYTES))
    throw new Error('Choose a smaller set of favorites to share.');
  return text;
}

export function decodeFavorites(text: unknown): SharedFavorite[] {
  if (!boundedUtf8Text(text, MAX_FAVORITES_BYTES))
    throw new Error('This favorites list is empty or exceeds 1 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid favorites JSON.');
  }
  if (
    !object(value) ||
    value.format !== 'genx-free-tv-favorites' ||
    value.version !== 1 ||
    !Array.isArray(value.channels) ||
    value.channels.length > MAX_FAVORITES
  )
    throw new Error('Choose a GenX favorites file with up to 1,000 channels.');
  const unique = new Map<string, SharedFavorite>();
  for (const entry of value.channels) {
    const item = favorite(entry);
    if (!unique.has(item.endpoint)) unique.set(item.endpoint, item);
  }
  return [...unique.values()];
}

const encoder = new TextEncoder();
async function fingerprint(kind: 'endpoint' | 'provider', value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`genx-favorites:${kind}:${value}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function collectFavorites(
  catalog: CatalogRecord,
  ids: readonly string[],
  removed: readonly string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const byId = new Map(catalog.channels.map((channel) => [channel.id, channel]));
  const hidden = new Set(removed);
  const candidates = new Map<string, { channel: Channel; stream: string }>();
  for (const id of ids) {
    const channel = byId.get(id);
    if (!channel || hidden.has(id) || isPpvChannel(channel)) continue;
    for (const stream of channel.urls) {
      try {
        const address = shareableStream(stream);
        if (!label(channel.name, 512) || !label(channel.category, 256, true)) break;
        if (!candidates.has(address)) candidates.set(address, { channel, stream: address });
        break;
      } catch {
        // Try the next saved address when this one is private or cannot be shared.
      }
    }
  }
  const items: SharedFavorite[] = [];
  const chosen = [...candidates.values()];
  for (let start = 0; start < chosen.length; start += 128) {
    signal?.throwIfAborted();
    items.push(
      ...(await Promise.all(
        chosen.slice(start, start + 128).map(async ({ channel, stream }) => {
          const key = providerKey(channel);
          return {
            name: channel.name,
            category: channel.category,
            endpoint: await fingerprint('endpoint', stream),
            ...(key ? { provider: await fingerprint('provider', key) } : {}),
          };
        }),
      )),
    );
  }
  signal?.throwIfAborted();
  return { items, skipped: ids.length - items.length };
}

function providerKey(channel: Pick<Channel, 'providerId' | 'name'>): string | undefined {
  const id = channel.providerId;
  return id && id !== 'direct'
    ? JSON.stringify([id, channel.name.normalize('NFKC').trim().toLowerCase()])
    : undefined;
}

export async function indexFavoriteMatches(
  catalog: CatalogRecord,
  items: readonly SharedFavorite[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const endpoints = new Map<string, string[]>();
  const providers = new Map<string, string[]>();
  const incomingEndpoints = new Set(items.map((item) => item.endpoint));
  const incomingProviders = new Set(items.map((item) => item.provider));
  const names = new Set(items.map((item) => item.name.normalize('NFKC').trim().toLowerCase()));
  const order = new Map<string, number>();
  let work: Promise<void>[] = [];
  const add = (index: Map<string, string[]>, key: string, id: string) => {
    const rows = index.get(key);
    if (rows) rows.push(id);
    else index.set(key, [id]);
  };
  for (const [ordinal, channel] of catalog.channels.entries()) {
    if (isPpvChannel(channel)) continue;
    work.push(
      (async () => {
        const endpointKeys = new Set<string>();
        for (const url of channel.urls) {
          let address: string;
          try {
            address = shareableStream(url);
          } catch {
            continue;
          }
          const endpoint = await fingerprint('endpoint', address);
          if (incomingEndpoints.has(endpoint)) endpointKeys.add(endpoint);
        }
        for (const endpoint of endpointKeys) {
          order.set(channel.id, ordinal);
          add(endpoints, endpoint, channel.id);
        }
        const key =
          names.has(channel.name.normalize('NFKC').trim().toLowerCase()) && providerKey(channel);
        if (key) {
          const provider = await fingerprint('provider', key);
          if (incomingProviders.has(provider)) add(providers, provider, channel.id);
        }
      })(),
    );
    if (work.length >= 128) {
      await Promise.all(work);
      signal.throwIfAborted();
      work = [];
    }
  }
  await Promise.all(work);
  signal.throwIfAborted();
  for (const rows of endpoints.values()) rows.sort((a, b) => order.get(a)! - order.get(b)!);
  return { endpoints, providers };
}

export function planFavorites(
  index: Awaited<ReturnType<typeof indexFavoriteMatches>>,
  ids: readonly string[],
  removed: readonly string[],
  items: readonly SharedFavorite[],
) {
  const starred = new Set(ids);
  const hidden = new Set(removed);
  const matched = new Set<string>();
  let unmatched = 0;
  let alreadySaved = 0;
  let previouslyRemoved = 0;
  for (const item of items) {
    const endpoints = index.endpoints.get(item.endpoint) ?? [];
    const providers = item.provider ? (index.providers.get(item.provider) ?? []) : [];
    const visible = endpoints.filter((id) => !hidden.has(id));
    const visibleProviders = providers.filter((id) => !hidden.has(id));
    const channel =
      visible.find((id) => starred.has(id)) ??
      visible[0] ??
      (visibleProviders.length === 1 ? visibleProviders[0] : undefined);
    if (!channel && [...endpoints, ...providers].some((id) => hidden.has(id))) previouslyRemoved++;
    else if (!channel) unmatched++;
    else if (starred.has(channel) || matched.has(channel)) alreadySaved++;
    else matched.add(channel);
  }
  return { matched: [...matched], unmatched, alreadySaved, previouslyRemoved };
}
