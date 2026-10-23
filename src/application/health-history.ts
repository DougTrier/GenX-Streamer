import { emptyCatalog, parseCatalog, type CatalogRecord } from '../catalog';
import {
  fingerprintHealthTarget,
  healthFreshness,
  parseHealthPayload,
  type PersistedHealthRecord,
} from '../catalog/health-record';
export interface SavedHealthQuery {
  offset: number;
  pageSize: 50;
  query: string;
  revision?: string;
}
export interface SavedHealthRow {
  name: string;
  category: string;
  sourceName: string;
  checkedUrlOrdinal: number;
  verdict: PersistedHealthRecord['verdict'];
  evidence: PersistedHealthRecord['evidence'];
  observedAt: number;
  platform: string;
  observerProfile: string;
  freshness: ReturnType<typeof healthFreshness>;
  origin: 'local' | 'imported';
}
export interface SavedHealthPage {
  rows: SavedHealthRow[];
  total: number;
  revision: string;
}
export interface SavedHealthSnapshot {
  catalog: string | null;
  health: string | null;
  catalogRevision: string;
  healthRevision: string;
}
export interface SavedHealthContext {
  now: number;
  platform: string;
  observerProfile: string;
  decoderObserverProfile?: string;
}
export interface SavedHealthOnlySnapshot {
  health: string | null;
}
/** Scan publication needs health evidence only; canonical catalog admission belongs to its owner. */
export function decodeSavedHealthOnly(snapshot: SavedHealthOnlySnapshot): {
  health: PersistedHealthRecord[];
} {
  return { health: snapshot.health === null ? [] : parseHealthPayload(snapshot.health).records };
}
export function decodeSavedHealth(snapshot: SavedHealthSnapshot): {
  catalog: CatalogRecord;
  health: PersistedHealthRecord[];
} {
  return {
    catalog: snapshot.catalog === null ? emptyCatalog() : parseCatalog(snapshot.catalog),
    health: snapshot.health === null ? [] : parseHealthPayload(snapshot.health).records,
  };
}
/** Runs inside the owned worker; only a bounded page of safe metadata reaches the dialog. */
export async function evaluateHealthHistory(
  snapshot: SavedHealthSnapshot,
  query: SavedHealthQuery,
  context: SavedHealthContext,
): Promise<SavedHealthPage> {
  if (
    !Number.isInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 100000 ||
    query.pageSize !== 50 ||
    typeof query.query !== 'string' ||
    query.query.length > 256
  )
    throw new Error('Saved check query is invalid.');
  if (
    ![snapshot.catalogRevision, snapshot.healthRevision].every((value) =>
      /^(0|[1-9][0-9]{0,19})$/.test(value),
    )
  )
    throw new Error('Saved check revision is invalid.');
  const revision = `${snapshot.catalogRevision}:${snapshot.healthRevision}`;
  if (query.revision !== undefined && query.revision !== revision)
    throw new Error('Saved checks changed. Start from the first page.');
  const state = decodeSavedHealth(snapshot);
  const channels = new Map(state.catalog.channels.map((channel) => [channel.id, channel]));
  const sources = new Map(state.catalog.sources.map((source) => [source.id, source]));
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
  const tokens = normalize(query.query).trim().split(/\s+/).filter(Boolean);
  const matching = state.health
    .filter((record) => {
      const channel = channels.get(record.channelId);
      const source = sources.get(record.sourceId);
      if (
        !channel ||
        !source ||
        channel.sourceId !== source.id ||
        record.checkedUrlOrdinal >= channel.urls.length
      )
        throw new Error('Saved checks reference unavailable channel data.');
      const text = normalize(`${channel.name} ${channel.category} ${source.name}`);
      return tokens.every((token) => text.includes(token));
    })
    .sort(
      (left, right) =>
        right.observedAt - left.observedAt ||
        (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0) ||
        left.checkedUrlOrdinal - right.checkedUrlOrdinal ||
        (left.platform < right.platform ? -1 : left.platform > right.platform ? 1 : 0) ||
        (left.observerProfile < right.observerProfile
          ? -1
          : left.observerProfile > right.observerProfile
            ? 1
            : 0),
    );
  const rows: SavedHealthRow[] = [];
  for (const record of matching.slice(query.offset, query.offset + 50)) {
    const channel = channels.get(record.channelId)!;
    const source = sources.get(record.sourceId)!;
    if (
      (await fingerprintHealthTarget(source, channel, record.checkedUrlOrdinal)) !==
      record.targetFingerprint
    )
      throw new Error('Saved checks no longer match their channel URLs.');
    rows.push({
      name: channel.name,
      category: channel.category,
      sourceName: source.name,
      checkedUrlOrdinal: record.checkedUrlOrdinal,
      verdict: record.verdict,
      evidence: record.evidence,
      observedAt: record.observedAt,
      platform: record.platform,
      observerProfile: record.observerProfile,
      freshness: healthFreshness(record, {
        ...context,
        observerProfile:
          record.evidence.kind === 'decoded' && context.decoderObserverProfile !== undefined
            ? context.decoderObserverProfile
            : context.observerProfile,
      }),
      origin: record.origin,
    });
  }
  return { rows, total: matching.length, revision };
}
