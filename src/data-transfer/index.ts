import {
  MAX_CHANNELS,
  MAX_PLAYLIST_BYTES,
  reconcileChannels,
  validateCatalog,
  validateSource,
  serializeCatalog,
  type CatalogRecord,
  type ChannelCandidate,
  type Source,
} from '../catalog';
import {
  defaultPreferences,
  validatePreferences,
  exportPreferences,
  type Preferences,
} from '../preferences';
import {
  validateHealthRecords,
  serializeHealthPayload,
  type PersistedHealthRecord,
} from '../catalog/health-record';
import { boundedJsonUtf8Bytes, JsonByteLimitError } from './json-byte-admission';

export interface BackupRecord {
  format: 'genx-tv-backup';
  schemaVersion: 1;
  catalog: CatalogRecord;
  preferences: Preferences;
  health?: PersistedHealthRecord[];
}
export interface TransferPreview {
  sources: number;
  channels: number;
  favorites: number;
  removedChannels: number;
  missingFavoriteIdentities: number;
  missingRemovedIdentities: number;
  httpSourceGrants: number;
}
export interface PreparedTransfer {
  record: BackupRecord;
  catalogText: string;
  preferencesText: string;
  backupText: string;
  preview: TransferPreview;
  healthText?: string;
}
export type PreparedCommitTransfer = Pick<
  PreparedTransfer,
  'record' | 'catalogText' | 'preferencesText' | 'healthText'
>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
/** A backup contains three independently bounded records plus its small versioned wrapper. */
export const MAX_BACKUP_BYTES = 3 * MAX_PLAYLIST_BYTES + 4096;
function boundedJson(text: string, limit = MAX_PLAYLIST_BYTES): unknown {
  if (bytes(text) > limit)
    throw new Error(
      limit === MAX_BACKUP_BYTES
        ? 'Backup exceeds the 60 MiB + 4 KiB limit.'
        : 'Import exceeds the 20 MiB limit.',
    );
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Import is not valid JSON.');
  }
}
function sourcesMatch(a: Source[], b: Source[]): boolean {
  const key = (source: Source) =>
    JSON.stringify([
      source.id,
      source.name,
      source.location,
      source.kind,
      source.allowHttp === true,
      source.contentKind ?? null,
      source.mediaMime ?? null,
    ]);
  const left = new Map(a.map((source) => [source.id, key(source)]));
  return left.size === b.length && b.every((source) => left.get(source.id) === key(source));
}
export function validateBackup(input: unknown): BackupRecord {
  return validateRecord(input, (catalog) => {
    serializeCatalog(catalog);
  });
}
/** Native batch admission preserves normalized record checks without discarded catalog text. */
export function validateCommitRecord(input: unknown, signal?: AbortSignal): BackupRecord {
  signal?.throwIfAborted();
  return validateRecord(input, (catalog) => {
    try {
      boundedJsonUtf8Bytes(catalog, MAX_PLAYLIST_BYTES, signal);
    } catch (error) {
      if (error instanceof JsonByteLimitError)
        throw new Error('Catalog exceeds the 20 MiB storage limit.', { cause: error });
      throw error;
    }
  });
}
function validateRecord(
  input: unknown,
  admitCatalog: (catalog: CatalogRecord) => void,
): BackupRecord {
  if (!object(input) || input.format !== 'genx-tv-backup' || input.schemaVersion !== 1)
    throw new Error('Unsupported backup format or schema.');
  if (
    Object.keys(input).some(
      (key) => !['format', 'schemaVersion', 'catalog', 'preferences', 'health'].includes(key),
    )
  )
    throw new Error('Backup contains unsupported root fields.');
  const catalog = validateCatalog(input.catalog);
  const preferences = validatePreferences(input.preferences);
  if (!sourcesMatch(catalog.sources, preferences.sources))
    throw new Error(
      'Backup source records disagree. Export a consistent catalog and preferences snapshot.',
    );
  const health = input.health === undefined ? undefined : validateHealthRecords(input.health);
  // A larger interchange container never relaxes the individual storage admission bounds.
  admitCatalog(catalog);
  if (bytes(exportPreferences(preferences)) > MAX_PLAYLIST_BYTES)
    throw new Error('Preferences record exceeds the 20 MiB limit.');
  if (health !== undefined) serializeHealthPayload(health);
  if (health) {
    const channels = new Map(catalog.channels.map((channel) => [channel.id, channel]));
    for (const record of health) {
      const channel = channels.get(record.channelId);
      if (
        !channel ||
        channel.sourceId !== record.sourceId ||
        record.checkedUrlOrdinal >= channel.urls.length
      )
        throw new Error('Backup health references a missing channel or stream.');
    }
  }
  return {
    format: 'genx-tv-backup',
    schemaVersion: 1,
    catalog,
    preferences,
    ...(health === undefined ? {} : { health }),
  };
}
export function serializeBackup(input: BackupRecord): string {
  const serialized = JSON.stringify(validateBackup(input));
  if (bytes(serialized) > MAX_BACKUP_BYTES)
    throw new Error('Backup exceeds the 60 MiB + 4 KiB limit.');
  return serialized;
}
export function parseBackup(text: string): BackupRecord {
  return validateBackup(boundedJson(text, MAX_BACKUP_BYTES));
}
export function createBackup(
  catalog: CatalogRecord,
  preferences: Preferences,
  health?: PersistedHealthRecord[],
): BackupRecord {
  return validateBackup({
    format: 'genx-tv-backup',
    schemaVersion: 1,
    catalog,
    preferences,
    ...(health === undefined ? {} : { health }),
  });
}
export function prepareBackupImport(text: string): PreparedTransfer {
  const backup = parseBackup(text);
  return prepareTransfer({
    ...backup,
    ...(backup.health === undefined
      ? {}
      : { health: backup.health.map((record) => ({ ...record, origin: 'imported' as const })) }),
  });
}
export function prepareTransfer(input: BackupRecord): PreparedTransfer {
  const record = validateBackup(input);
  const backupText = serializeBackup(record);
  const identities = new Set(record.catalog.channels.map((channel) => channel.id));
  const preferencesText = exportPreferences(record.preferences);
  if (bytes(preferencesText) > MAX_PLAYLIST_BYTES)
    throw new Error('Preferences record exceeds the 20 MiB limit.');
  return {
    record,
    backupText,
    catalogText: serializeCatalog(record.catalog),
    preferencesText,
    ...(record.health === undefined ? {} : { healthText: serializeHealthPayload(record.health) }),
    preview: {
      sources: record.catalog.sources.length,
      channels: record.catalog.channels.length,
      favorites: record.preferences.favorites.length,
      removedChannels: record.preferences.removedChannels.length,
      missingFavoriteIdentities: record.preferences.favorites.filter((id) => !identities.has(id))
        .length,
      missingRemovedIdentities: record.preferences.removedChannels.filter(
        (id) => !identities.has(id),
      ).length,
      httpSourceGrants: record.catalog.sources.filter((source) => source.allowHttp === true).length,
    },
  };
}

/** Same record admission as export preparation, without export-only output allocation. */
export function prepareCommitTransfer(input: BackupRecord): PreparedCommitTransfer {
  const record = validateBackup(input);
  const preferencesText = exportPreferences(record.preferences);
  if (bytes(preferencesText) > MAX_PLAYLIST_BYTES)
    throw new Error('Preferences record exceeds the 20 MiB limit.');
  return {
    record,
    catalogText: serializeCatalog(record.catalog),
    preferencesText,
    ...(record.health === undefined ? {} : { healthText: serializeHealthPayload(record.health) }),
  };
}

export type LegacySourceField = 'custom_sources' | 'user_m3u_lists';
export interface LegacySourceBinding {
  field: LegacySourceField;
  index: number;
  source: Source;
}
export interface LegacyMigrationOptions {
  /** Explicit user metadata for the old master_db snapshot; never inferred from hardcoded seeds. */
  source: Source;
  base?: BackupRecord;
  sourceBindings?: LegacySourceBinding[];
}
export interface LegacyPreview {
  importedChannels: number;
  exactDuplicatesRemoved: number;
  matchedFavorites: number;
  matchedRemovedChannels: number;
  ambiguousFavorites: number;
  ambiguousRemovedChannels: number;
  unmatchedFavorites: number;
  unmatchedRemovedChannels: number;
  unresolvedPreferenceIdentities: number;
  offeredSourceEntries: number;
  selectedSourceEntries: number;
  unselectedSourceEntries: number;
  unsupportedRootFields: number;
  unsupportedRootItems: number;
  unsupportedChannelFields: number;
  unsupportedSourceFields: number;
}
export interface PreparedLegacyTransfer extends PreparedTransfer {
  legacyPreview: LegacyPreview;
}
function list(input: unknown, field: string, limit = MAX_CHANNELS): unknown[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > limit)
    throw new Error(`Legacy ${field} is invalid or exceeds its limit.`);
  return input;
}
function text(input: unknown, field: string, empty = false): string {
  if (typeof input !== 'string' || (!empty && !input.trim()) || input.length > 16384)
    throw new Error(`Legacy ${field} is invalid.`);
  return input;
}
async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function sourceLocation(value: unknown): string {
  if (typeof value === 'string') return text(value, 'source');
  if (object(value)) return text(value.url, 'source');
  throw new Error('Legacy source entry is invalid.');
}
function itemCount(value: unknown): number {
  return Array.isArray(value)
    ? value.length
    : object(value)
      ? Object.keys(value).length
      : value === undefined
        ? 0
        : 1;
}

/** User-selected JSON only. Pure data preparation: no filesystem/network/persistence side effects. */
export async function migrateLegacyJson(
  serialized: string,
  options: LegacyMigrationOptions,
): Promise<PreparedLegacyTransfer> {
  const input = boundedJson(serialized);
  if (
    !object(input) ||
    !Array.isArray(input.master_db) ||
    (input.schemaVersion !== undefined && input.schemaVersion !== 1)
  )
    throw new Error('Unsupported legacy JSON schema. A master_db array is required.');
  const source = validateSource(options.source);
  const base = options.base
    ? validateBackup(options.base)
    : createBackup({ schemaVersion: 1, sources: [], channels: [] }, defaultPreferences());
  const entries = list(input.master_db, 'master_db');
  const favorites = list(input.favorites, 'favorites').map((value) =>
    text(value, 'favorite reference'),
  );
  const removed = list(input.blacklist, 'blacklist').map((value) =>
    text(value, 'blacklist reference'),
  );
  const legacySources: Record<LegacySourceField, unknown[]> = {
    custom_sources: list(input.custom_sources, 'custom_sources', 100),
    user_m3u_lists: list(input.user_m3u_lists, 'user_m3u_lists', 100),
  };
  // Validate offered entries even when not selected; never turn malformed metadata into a partial import.
  let unsupportedSourceFields = 0;
  for (const offered of Object.values(legacySources))
    for (const entry of offered) {
      sourceLocation(entry);
      if (object(entry))
        unsupportedSourceFields += Object.keys(entry).filter(
          (key) => !['url', 'name'].includes(key),
        ).length;
    }
  const sourceMap = new Map(base.catalog.sources.map((value) => [value.id, value]));
  sourceMap.set(source.id, source);
  const bindings = options.sourceBindings ?? [];
  if (bindings.length > 100) throw new Error('Migration exceeds the source binding limit.');
  const selected = new Set<string>();
  for (const binding of bindings) {
    if (
      !['custom_sources', 'user_m3u_lists'].includes(binding.field) ||
      !Number.isInteger(binding.index) ||
      binding.index < 0
    )
      throw new Error('Invalid legacy source binding.');
    const offered = legacySources[binding.field][binding.index];
    const key = `${binding.field}:${binding.index}`;
    if (offered === undefined || selected.has(key))
      throw new Error('Invalid or duplicate legacy source binding.');
    const supplied = validateSource(binding.source);
    if (supplied.kind !== 'url' || supplied.location !== sourceLocation(offered))
      throw new Error('Chosen source metadata does not match the selected legacy source entry.');
    if (sourceMap.has(supplied.id))
      throw new Error('Legacy source binding reuses an existing source identity.');
    sourceMap.set(supplied.id, supplied);
    selected.add(key);
  }
  const knownChannelKeys = new Set(['name', 'url', 'group', 'lang', 'providerId', 'tvg-id']);
  let unsupportedChannelFields = 0;
  const unique = new Map<string, ChannelCandidate>();
  for (const entry of entries) {
    if (!object(entry)) throw new Error('Legacy channel entry is invalid.');
    if (
      entry.providerId !== undefined &&
      entry['tvg-id'] !== undefined &&
      entry.providerId !== entry['tvg-id']
    )
      throw new Error('Legacy channel has conflicting provider identities.');
    const provider = entry.providerId ?? entry['tvg-id'];
    const candidate: ChannelCandidate = {
      sourceId: source.id,
      name: text(entry.name, 'channel name'),
      category:
        entry.group === undefined
          ? entry.lang === undefined
            ? ''
            : text(entry.lang, 'channel category', true)
          : text(entry.group, 'channel category', true),
      urls: [text(entry.url, 'channel URL')],
      ...(provider === undefined ? {} : { providerId: text(provider, 'provider identity') }),
    };
    unsupportedChannelFields += Object.keys(entry).filter(
      (key) => !knownChannelKeys.has(key),
    ).length;
    // Exact record duplicates alone collapse. Distinct metadata/provider/stream records remain separate.
    let signature: string;
    try {
      signature = JSON.stringify(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    } catch {
      throw new Error('Legacy channel metadata is too deeply nested.');
    }
    unique.set(signature, candidate);
  }
  const ordered = [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, candidate]) => candidate);
  const batch = await digest(JSON.stringify(ordered));
  let counter = 0;
  const reserved = new Set(base.catalog.channels.map((channel) => channel.id));
  const channels = reconcileChannels(
    ordered,
    base.catalog.channels.filter((channel) => channel.sourceId === source.id),
    () => {
      let id: string;
      do {
        id = `legacy:${encodeURIComponent(source.id)}:${batch}:${counter++}`;
      } while (reserved.has(id));
      reserved.add(id);
      return id;
    },
  );
  const catalog = validateCatalog({
    schemaVersion: 1,
    sources: [...sourceMap.values()],
    channels: [
      ...base.catalog.channels.filter((channel) => channel.sourceId !== source.id),
      ...channels,
    ],
  });
  const byUrl = new Map<string, string[]>();
  for (const channel of channels)
    for (const url of channel.urls) {
      const matches = byUrl.get(url) ?? [];
      matches.push(channel.id);
      byUrl.set(url, matches);
    }
  const preferences = validatePreferences({ ...base.preferences, sources: catalog.sources });
  const stats = {
    matchedFavorites: 0,
    matchedRemovedChannels: 0,
    ambiguousFavorites: 0,
    ambiguousRemovedChannels: 0,
    unmatchedFavorites: 0,
    unmatchedRemovedChannels: 0,
    unresolvedPreferenceIdentities: 0,
  };
  const references = [...new Set([...favorites, ...removed])];
  const referenceIds = new Map<string, string>();
  // Bounded digest batches avoid creating 100,000 pending crypto operations at once.
  for (let start = 0; start < references.length; start += 32)
    await Promise.all(
      references
        .slice(start, start + 32)
        .map(async (reference) =>
          referenceIds.set(
            reference,
            `legacy-ref:${encodeURIComponent(source.id)}:${await digest(reference)}`,
          ),
        ),
    );
  for (const [references, target, kind] of [
    [favorites, preferences.favorites, 'Favorites'],
    [removed, preferences.removedChannels, 'RemovedChannels'],
  ] as const) {
    const identities = new Set(target);
    for (const reference of new Set(references)) {
      const unresolved = referenceIds.get(reference)!;
      const matches = byUrl.get(reference) ?? [];
      if (matches.length === 1) {
        identities.delete(unresolved);
        identities.add(matches[0]!);
        stats[`matched${kind}`]++;
      } else {
        identities.add(unresolved);
        stats.unresolvedPreferenceIdentities++;
        if (matches.length > 1) stats[`ambiguous${kind}`]++;
        else stats[`unmatched${kind}`]++;
      }
    }
    target.splice(0, target.length, ...identities);
  }
  const knownRoot = new Set([
    'master_db',
    'favorites',
    'blacklist',
    'custom_sources',
    'user_m3u_lists',
    'schemaVersion',
  ]);
  const unsupported = Object.entries(input).filter(([key]) => !knownRoot.has(key));
  const prepared = prepareTransfer(createBackup(catalog, preferences));
  return {
    ...prepared,
    legacyPreview: {
      importedChannels: channels.length,
      exactDuplicatesRemoved: entries.length - channels.length,
      ...stats,
      offeredSourceEntries:
        legacySources.custom_sources.length + legacySources.user_m3u_lists.length,
      selectedSourceEntries: selected.size,
      unselectedSourceEntries:
        legacySources.custom_sources.length + legacySources.user_m3u_lists.length - selected.size,
      unsupportedRootFields: unsupported.length,
      unsupportedRootItems: unsupported.reduce((sum, [, value]) => sum + itemCount(value), 0),
      unsupportedChannelFields,
      unsupportedSourceFields,
    },
  };
}
