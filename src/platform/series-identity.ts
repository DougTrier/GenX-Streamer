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
import { boundedUtf8Text } from './bounded-text';

export interface SeriesShow {
  readonly name: string;
  readonly premieredYear?: number;
  readonly endedYear?: number;
  readonly network?: string;
}
export interface SeriesIdentity {
  readonly shows: readonly SeriesShow[];
  readonly person?: { readonly name: string; readonly shows: readonly SeriesShow[] };
  readonly attribution: string;
}
const ATTRIBUTION = 'Show information from TVmaze (CC BY-SA 4.0)';
const plain = (value: unknown, max: number): value is string =>
  boundedUtf8Text(value, max) && !!value.trim() && !/[\p{Cc}]/u.test(value);
const year = (value: unknown) =>
  value === undefined ||
  (Number.isInteger(value) && (value as number) >= 1900 && (value as number) <= 2100);
function show(value: unknown): SeriesShow {
  if (!value || typeof value !== 'object') throw new Error('Series suggestion is invalid.');
  const row = value as Record<string, unknown>;
  if (
    !plain(row.name, 256) ||
    !year(row.premieredYear) ||
    !year(row.endedYear) ||
    (row.network !== undefined && !plain(row.network, 128)) ||
    Object.keys(row).some((key) => !['name', 'premieredYear', 'endedYear', 'network'].includes(key))
  )
    throw new Error('Series suggestion is invalid.');
  return Object.freeze({ ...(row as unknown as SeriesShow) });
}
/** Whole-reply validation; display fields only. */
export function validateSeriesIdentity(value: unknown): SeriesIdentity {
  if (!value || typeof value !== 'object') throw new Error('Series suggestions are invalid.');
  const reply = value as Record<string, unknown>;
  if (!Array.isArray(reply.shows) || reply.shows.length > 5 || reply.attribution !== ATTRIBUTION)
    throw new Error('Series suggestions are invalid.');
  let person: SeriesIdentity['person'];
  if (reply.person !== undefined) {
    const raw = reply.person as Record<string, unknown>;
    if (!raw || !plain(raw.name, 256) || !Array.isArray(raw.shows) || raw.shows.length > 12)
      throw new Error('Series suggestions are invalid.');
    person = Object.freeze({ name: raw.name as string, shows: Object.freeze(raw.shows.map(show)) });
  }
  return Object.freeze({
    shows: Object.freeze(reply.shows.map(show)),
    ...(person ? { person } : {}),
    attribution: ATTRIBUTION,
  });
}

/** Explicit GenXtra Search only. Browser previews have no native lookup. */
export async function lookupSeriesIdentity(
  query: string,
  signal: AbortSignal,
): Promise<SeriesIdentity | null> {
  signal.throwIfAborted();
  if (!isTauri() || query.trim().length < 2) return null;
  const requestId = `series-${crypto.randomUUID()}`;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= invoke('cancel_playlist', { requestId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const reply = await invoke<unknown>('series_identity_lookup', { query, requestId });
    signal.throwIfAborted();
    return validateSeriesIdentity(reply);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
  }
}
