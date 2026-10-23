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
