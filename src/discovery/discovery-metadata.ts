import { boundedUtf8Text } from '../platform/bounded-text';

/** Published channel metadata used only to match and order discovery candidates. */
export interface DiscoveryChannelInfo {
  /** Official name followed by published alternate names. */
  readonly names: readonly string[];
  /** Closed, replaced, blocklisted or adult channels are checked last, never removed. */
  readonly demoted: boolean;
}
export interface DiscoveryMetadata {
  lookup(providerId: string | undefined): DiscoveryChannelInfo | undefined;
  /** Channel IDs any of whose published names contain every query word; null if over `limit`. */
  matchIds(query: string, limit: number): string[] | null;
  /** Closed, replaced, blocklisted or adult channel IDs. */
  demotedIds(): string[];
  readonly size: number;
}
const fold = (text: string) => text.normalize('NFKC').toLowerCase();
/** Structured-clone form returned by the worker. */
export interface CompactDiscoveryMetadata {
  readonly ids: readonly string[];
  readonly names: readonly (readonly string[])[];
  readonly demoted: readonly boolean[];
}
export const MAX_DISCOVERY_CHANNELS = 100_000;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_NAMES = 32;
const refuse = (): never => {
  throw new Error('Channel discovery metadata is invalid or exceeds its limits.');
};
const plain = (value: unknown, max: number): value is string =>
  boundedUtf8Text(value, max) &&
  !!value.trim() &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function rows(raw: string): Record<string, unknown>[] {
  if (!boundedUtf8Text(raw, MAX_DOCUMENT_BYTES)) refuse();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    refuse();
  }
  if (!Array.isArray(value) || value.length > MAX_DISCOVERY_CHANNELS || !value.every(object))
    refuse();
  return value as Record<string, unknown>[];
}

/** iptv-org stream IDs carry an optional `@feed` suffix; channel metadata is per channel. */
export function providerChannelId(providerId: string): string {
  const at = providerId.indexOf('@');
  return at < 0 ? providerId : providerId.slice(0, at);
}

/** Whole-document admission: one malformed record refuses the complete snapshot. */
export function compactDiscoveryMetadata(
  channelsRaw: string,
  blocklistRaw?: string,
): CompactDiscoveryMetadata {
  const blocked = new Set<string>();
  if (blocklistRaw !== undefined)
    for (const row of rows(blocklistRaw)) {
      if (!plain(row.channel, 256)) refuse();
      blocked.add(row.channel as string);
    }
  const ids: string[] = [],
    names: string[][] = [],
    demoted: boolean[] = [];
  const seen = new Set<string>();
  for (const row of rows(channelsRaw)) {
    if (!plain(row.id, 256) || !plain(row.name, 512) || seen.has(row.id as string)) refuse();
    seen.add(row.id as string);
    const alternates = row.alt_names ?? [];
    if (!Array.isArray(alternates) || alternates.length > MAX_NAMES) refuse();
    const list = [row.name as string];
    for (const alternate of alternates as unknown[]) {
      if (!plain(alternate, 512)) refuse();
      if (!list.includes(alternate as string)) list.push(alternate as string);
    }
    for (const key of ['closed', 'replaced_by'] as const)
      if (row[key] !== undefined && row[key] !== null && !plain(row[key], 256)) refuse();
    if (row.is_nsfw !== undefined && typeof row.is_nsfw !== 'boolean') refuse();
    ids.push(row.id as string);
    names.push(list.slice(0, MAX_NAMES));
    demoted.push(
      !!row.closed || !!row.replaced_by || row.is_nsfw === true || blocked.has(row.id as string),
    );
  }
  return { ids, names, demoted };
}

export function discoveryMetadata(compact: CompactDiscoveryMetadata): DiscoveryMetadata {
  if (
    !compact ||
    !Array.isArray(compact.ids) ||
    !Array.isArray(compact.names) ||
    !Array.isArray(compact.demoted) ||
    compact.ids.length > MAX_DISCOVERY_CHANNELS ||
    compact.names.length !== compact.ids.length ||
    compact.demoted.length !== compact.ids.length
  )
    refuse();
  const index = new Map<string, DiscoveryChannelInfo>();
  compact.ids.forEach((id, i) => {
    const list = compact.names[i];
    if (
      !plain(id, 256) ||
      index.has(id) ||
      !Array.isArray(list) ||
      !list.length ||
      list.length > MAX_NAMES ||
      !list.every((name) => plain(name, 512)) ||
      typeof compact.demoted[i] !== 'boolean'
    )
      refuse();
    index.set(id, Object.freeze({ names: Object.freeze([...list]), demoted: compact.demoted[i] }));
  });
  return Object.freeze({
    size: index.size,
    lookup: (providerId: string | undefined) =>
      providerId ? index.get(providerChannelId(providerId.trim())) : undefined,
    matchIds(query: string, limit: number): string[] | null {
      const tokens = fold(query).split(/\s+/u).filter(Boolean);
      if (!tokens.length) return [];
      const ids: string[] = [];
      for (const [id, info] of index) {
        if (!info.names.some((name) => tokens.every((token) => fold(name).includes(token))))
          continue;
        if (ids.length >= limit) return null;
        ids.push(id);
      }
      return ids;
    },
    demotedIds: () => [...index].filter(([, info]) => info.demoted).map(([id]) => id),
  });
}
