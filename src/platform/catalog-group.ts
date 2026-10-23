import { invoke, isTauri } from '@tauri-apps/api/core';
import { invokeOwnedNative } from './owned-native-command';
export type CatalogGroupAction = { kind: 'remove' } | { kind: 'favorite'; value: boolean } | { kind: 'category'; value: string | null };
export interface CatalogGroupReceipt { schemaVersion: 1; committed: true; catalogRevision: string; viewRevision: string; affectedCount: number; }
const revision = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
/** Most further channels one removal may take with it (native BATCH_LIMIT). */
export const CATALOG_GROUP_BATCH_LIMIT = 5000;
/** `moreChannelIds` (removal only) leave in the same native write, each with its group. */
export async function mutateCatalogGroup(channelId: string, action: CatalogGroupAction,
  expected: { catalogRevision: string; viewRevision: string }, signal?: AbortSignal,
  moreChannelIds: readonly string[] = []): Promise<CatalogGroupReceipt> {
  if (!isTauri()) throw new Error('Group editing requires the installed application.');
  if (!channelId || channelId.length > 16384 || !revision(expected.catalogRevision) || !revision(expected.viewRevision)) throw new Error('Channel group identity is invalid.');
  if (moreChannelIds.length > CATALOG_GROUP_BATCH_LIMIT || moreChannelIds.some((id) => !id || id.length > 16384) || (moreChannelIds.length > 0 && action.kind !== 'remove')) throw new Error('Channel group identity is invalid.');
  const requestId = crypto.randomUUID();
  return invokeOwnedNative({ invoke, idFactory: () => requestId }, 'mutate_catalog_group', {
    request: { schemaVersion: 1, requestId, channelId, expectedCatalogRevision: expected.catalogRevision, expectedViewRevision: expected.viewRevision, action, ...(moreChannelIds.length ? { moreChannelIds: [...moreChannelIds] } : {}) },
  }, { signal, durable: true, validate(value): CatalogGroupReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Group write acknowledgment is invalid.');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'affectedCount,catalogRevision,committed,schemaVersion,viewRevision' || v.schemaVersion !== 1 || v.committed !== true || !revision(v.catalogRevision) || !revision(v.viewRevision) || !Number.isSafeInteger(v.affectedCount) || Number(v.affectedCount) < 1 || Number(v.affectedCount) > 100000) throw new Error('Group write acknowledgment is invalid.');
    return v as unknown as CatalogGroupReceipt;
  } });
}
