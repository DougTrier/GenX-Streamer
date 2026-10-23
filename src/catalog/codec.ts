import { MAX_CHANNELS, MAX_PLAYLIST_BYTES, type Channel, type Source } from './parser';
import { validateGeographyShape, validateGeographyProvenance } from './geography';
import { boundedUtf8Text as text } from '../platform/bounded-text';

export interface CatalogRecord {
  schemaVersion: 1;
  sources: Source[];
  channels: Channel[];
}
export const emptyCatalog = (): CatalogRecord => ({ schemaVersion: 1, sources: [], channels: [] });
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function validateSource(value: unknown): Source {
  if (
    !record(value) ||
    !text(value.id, 256) ||
    !text(value.name, 512) ||
    !text(value.location, 16_384) ||
    (value.kind !== 'url' && value.kind !== 'file')
  )
    throw new Error('Invalid playlist source.');
  if (value.allowHttp !== undefined && typeof value.allowHttp !== 'boolean')
    throw new Error('Invalid HTTP permission.');
  if (
    value.contentKind !== undefined &&
    !['catalog', 'hls', 'media'].includes(String(value.contentKind))
  )
    throw new Error('Invalid source content kind.');
  if (
    value.mediaMime !== undefined &&
    (!text(value.mediaMime, 128) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mediaMime))
  )
    throw new Error('Invalid media MIME type.');
  if (value.kind === 'url') validateUrl(value.location, value.allowHttp === true);
  return {
    id: value.id,
    name: value.name,
    location: value.location,
    kind: value.kind,
    ...(value.allowHttp !== undefined ? { allowHttp: value.allowHttp } : {}),
    ...(value.contentKind !== undefined
      ? { contentKind: value.contentKind as Source['contentKind'] }
      : {}),
    ...(value.mediaMime !== undefined ? { mediaMime: value.mediaMime } : {}),
  };
}
function validateUrl(value: string, allowHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid catalog URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Unsupported catalog URL protocol.');
  if (url.protocol === 'http:' && !allowHttp)
    throw new Error('HTTP requires explicit source permission.');
  if (url.username || url.password)
    throw new Error('Credentials embedded in catalog URLs are not supported.');
}

export function validateCatalog(input: unknown): CatalogRecord {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.sources) ||
    !Array.isArray(input.channels)
  )
    throw new Error('Invalid catalog schema.');
  if (input.sources.length > 100 || input.channels.length > MAX_CHANNELS)
    throw new Error('Catalog exceeds source or channel limits.');
  const sources = input.sources.map(validateSource);
  const bySource = new Map<string, Source>();
  for (const source of sources) {
    if (bySource.has(source.id)) throw new Error('Duplicate catalog source identity.');
    bySource.set(source.id, source);
  }
  const ids = new Set<string>();
  const channels = input.channels.map((value: unknown): Channel => {
    if (
      !record(value) ||
      !text(value.id, 16_384) ||
      !text(value.sourceId, 256) ||
      !text(value.name, 16_384) ||
      !text(value.category, 16_384, true) ||
      !Array.isArray(value.urls) ||
      !value.urls.length ||
      value.urls.length > 16
    )
      throw new Error('Invalid catalog channel.');
    if (value.providerId !== undefined && !text(value.providerId, 16_384))
      throw new Error('Invalid provider identity.');
    if (ids.has(value.id)) throw new Error('Duplicate catalog channel identity.');
    ids.add(value.id);
    const source = bySource.get(value.sourceId);
    if (!source) throw new Error('Channel references a missing catalog source.');
    const urls = value.urls.map((url: unknown): string => {
      if (!text(url, 16_384)) throw new Error('Invalid channel URL.');
      validateUrl(url, source.allowHttp === true);
      return url;
    });
    if (new Set(urls).size !== urls.length) throw new Error('Duplicate channel stream candidates.');
    const geography =
      value.geography === undefined ? undefined : validateGeographyShape(value.geography);
    const geographyProvenance =
      value.geographyProvenance === undefined
        ? undefined
        : validateGeographyProvenance(value.geographyProvenance, geography ?? {}, value.sourceId);
    return {
      id: value.id,
      sourceId: value.sourceId,
      name: value.name,
      category: value.category,
      urls,
      ...(value.providerId !== undefined ? { providerId: value.providerId } : {}),
      ...(geography !== undefined ? { geography } : {}),
      ...(geographyProvenance !== undefined ? { geographyProvenance } : {}),
    };
  });
  return { schemaVersion: 1, sources, channels };
}
/** Source definitions and channel data form one atomic record, separate from preferences. */
export function parseCatalog(serialized: string): CatalogRecord {
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLAYLIST_BYTES)
    throw new Error('Catalog exceeds the 20 MiB storage limit.');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Catalog is not valid JSON.');
  }
  return validateCatalog(value);
}
export function serializeCatalog(value: CatalogRecord): string {
  const serialized = JSON.stringify(validateCatalog(value));
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLAYLIST_BYTES)
    throw new Error('Catalog exceeds the 20 MiB storage limit.');
  return serialized;
}
