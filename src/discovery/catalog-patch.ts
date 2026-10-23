import { validateCatalog, validateSource, type CatalogRecord, type Source } from '../catalog';
import { MAX_CHANNELS, MAX_PLAYLIST_BYTES, type Channel } from '../catalog/parser';
import { boundedUtf8Text } from '../platform/bounded-text';
import { normalizeSourceMime } from '../sources';

export interface CatalogPatch {
  schemaVersion: 1;
  baseSourceCount: number;
  baseChannelCount: number;
  finalSourceCount: number;
  finalChannelCount: number;
  sources: Source[];
  channels: Channel[];
}
const fields = [
  'schemaVersion',
  'baseSourceCount',
  'baseChannelCount',
  'finalSourceCount',
  'finalChannelCount',
  'sources',
  'channels',
];
const invalid = () => new Error('The compact scan catalog patch is invalid.');
const identity = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const normalizedSource = (source: Source): Source =>
  validateSource({
    ...source,
    ...(source.mediaMime === undefined
      ? {}
      : { mediaMime: normalizeSourceMime(source.mediaMime) ?? source.mediaMime }),
  });

/** Worker-only derivation. Map publication preserves every old ordinal and appends new IDs. */
export function deriveCatalogPatch(base: CatalogRecord, next: CatalogRecord): CatalogPatch {
  const before = validateCatalog(base);
  if (
    next.sources.length < before.sources.length ||
    next.channels.length < before.channels.length ||
    before.sources.some((source, index) => next.sources[index]?.id !== source.id) ||
    before.channels.some(
      (channel, index) =>
        next.channels[index]?.id !== channel.id ||
        next.channels[index]?.sourceId !== channel.sourceId,
    )
  )
    throw invalid();
  return {
    schemaVersion: 1,
    baseSourceCount: before.sources.length,
    baseChannelCount: before.channels.length,
    finalSourceCount: next.sources.length,
    finalChannelCount: next.channels.length,
    sources: next.sources.filter(
      (source, index) => identity(source) !== identity(before.sources[index]),
    ),
    channels: next.channels.filter(
      (channel, index) => identity(channel) !== identity(before.channels[index]),
    ),
  };
}

/** Apply against the captured validated base only; caller fences pointer/revision and waits durable ACK.
 * No removal/reordering, no full base serialization/clone, and unchanged records retain identity.
 */
export function applyCatalogPatch(
  base: CatalogRecord,
  raw: CatalogPatch,
  authorizedSources: readonly Source[],
): CatalogRecord {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(raw, field)) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.sources) ||
    !Array.isArray(raw.channels) ||
    raw.sources.length > 100 ||
    raw.channels.length > MAX_CHANNELS ||
    authorizedSources.length > 100 ||
    ![raw.baseSourceCount, raw.baseChannelCount, raw.finalSourceCount, raw.finalChannelCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    raw.baseSourceCount !== base.sources.length ||
    raw.baseChannelCount !== base.channels.length ||
    raw.finalSourceCount > 100 ||
    raw.finalChannelCount > MAX_CHANNELS ||
    raw.finalSourceCount < raw.baseSourceCount ||
    raw.finalChannelCount < raw.baseChannelCount ||
    !boundedUtf8Text(JSON.stringify(raw), MAX_PLAYLIST_BYTES)
  )
    throw invalid();
  const allowed = new Map(authorizedSources.map((source) => [source.id, normalizedSource(source)]));
  if (allowed.size !== authorizedSources.length) throw invalid();
  const sources = new Map(base.sources.map((source) => [source.id, source]));
  if (sources.size !== base.sources.length) throw invalid();
  const seenSources = new Set<string>();
  for (const value of raw.sources) {
    const source = validateSource(value);
    if (
      seenSources.has(source.id) ||
      identity(value) !== identity(source) ||
      identity(source) !== identity(allowed.get(source.id))
    )
      throw invalid();
    seenSources.add(source.id);
    sources.set(source.id, source);
  }
  const finalSources = [...sources.values()];
  const updates = validateCatalog({
    schemaVersion: 1,
    sources: finalSources,
    channels: raw.channels,
  });
  if (
    updates.channels.some((channel, index) => identity(channel) !== identity(raw.channels[index]))
  )
    throw invalid();
  const channels = new Map(base.channels.map((channel) => [channel.id, channel]));
  if (channels.size !== base.channels.length) throw invalid();
  for (const channel of updates.channels) {
    const old = channels.get(channel.id);
    if (
      !allowed.has(channel.sourceId) ||
      identity(sources.get(channel.sourceId)) !== identity(allowed.get(channel.sourceId)) ||
      (old && old.sourceId !== channel.sourceId)
    )
      throw invalid();
    channels.set(channel.id, channel);
  }
  if (sources.size !== raw.finalSourceCount || channels.size !== raw.finalChannelCount)
    throw invalid();
  return { schemaVersion: 1, sources: finalSources, channels: [...channels.values()] };
}
