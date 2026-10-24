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

const PREFIX = 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/';
export const MAX_PACK_SUGGESTIONS = 16;

export interface PackGuideSuggestion {
  readonly name: string;
  readonly location: string;
  /** Saved channels with an exact published tuple for this feed; not verified coverage. */
  readonly channels: number;
}

/** Validates the native reply; anything unexpected yields no suggestions. */
export function validatePackSuggestions(value: unknown): PackGuideSuggestion[] {
  if (!Array.isArray(value) || value.length > MAX_PACK_SUGGESTIONS) return [];
  const out: PackGuideSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') return [];
    const { name, location, channels } = row as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 512 ||
      typeof location !== 'string' ||
      !location.startsWith(PREFIX) ||
      !/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.xml\.gz$/.test(location.slice(PREFIX.length)) ||
      seen.has(location) ||
      !Number.isSafeInteger(channels) ||
      (channels as number) < 1
    )
      return [];
    seen.add(location);
    out.push(Object.freeze({ name, location, channels: channels as number }));
  }
  return out;
}

/** Optional discovery input: failures leave playlist/README guide discovery unchanged. */
export async function readPackSuggestions(
  read: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<PackGuideSuggestion[]> {
  signal.throwIfAborted();
  try {
    const value = await read();
    signal.throwIfAborted();
    return validatePackSuggestions(value);
  } catch {
    signal.throwIfAborted();
    return [];
  }
}
