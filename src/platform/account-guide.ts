import { invoke, isTauri } from '@tauri-apps/api/core';
import { validateAccountMetadata, type AccountMetadata } from './account-vault';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import { validateGuideCategories, type GuideCategory } from '../guide/categories';

/** The provider's guide as stored for one Paid TV account (native owns the address). */
export interface AccountGuideStatus {
  revision: number;
  fetchedMs: number;
  programs: number;
  channels: number;
  /** Listings for this account's channels left out as unusable (shown, never hidden). */
  skipped: number;
}
export interface AccountGuideChannel {
  id: string;
  name: string;
  category: string;
  epgId: string;
  providerId: string | null;
  /** Opaque native playback capability, as in the channel list. */
  streamReference: string;
  favorite: boolean;
}
export interface AccountGuideProgram {
  epgId: string;
  startMs: number;
  stopMs: number | null;
  ordinal: number;
  title: string;
  description: string | null;
  categories: GuideCategory[];
}

const invalid = () => new Error('Paid TV guide reply is invalid.');
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) throw invalid();
  return row;
};
const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
};
const text = (value: unknown, limit: number, empty = false) => {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.length))
    throw invalid();
  return value;
};

export function validateAccountGuideStatus(value: unknown): AccountGuideStatus | null {
  if (value === null) return null;
  const row = record(value, ['revision', 'fetchedMs', 'programs', 'channels', 'skipped']);
  const status = {
    revision: count(row.revision),
    fetchedMs: count(row.fetchedMs),
    programs: count(row.programs),
    channels: count(row.channels),
    skipped: count(row.skipped),
  };
  if (status.revision < 1) throw invalid();
  return status;
}
function validateChannel(value: unknown, accountId: string): AccountGuideChannel {
  const row = record(value, [
    'id',
    'name',
    'category',
    'epgId',
    'providerId',
    'streamReference',
    'favorite',
  ]);
  const id = text(row.id, 512);
  if (!id.startsWith(`account-${accountId}-`) || typeof row.favorite !== 'boolean') throw invalid();
  const streamReference = text(row.streamReference, 32);
  if (!/^[a-f0-9]{32}$/u.test(streamReference)) throw invalid();
  return {
    id,
    name: text(row.name, 16384),
    category: text(row.category, 16384, true),
    epgId: text(row.epgId, 16384),
    providerId: row.providerId === null ? null : text(row.providerId, 16384),
    streamReference,
    favorite: row.favorite,
  };
}
function validateProgram(value: unknown, epgId: string): AccountGuideProgram {
  const row = record(value, [
    'epgId',
    'startMs',
    'stopMs',
    'ordinal',
    'title',
    'description',
    'categories',
  ]);
  if (row.epgId !== epgId || !Number.isSafeInteger(row.startMs)) throw invalid();
  const stopMs = row.stopMs === null ? null : count(row.stopMs);
  if (stopMs !== null && stopMs <= (row.startMs as number)) throw invalid();
  return {
    epgId,
    startMs: row.startMs as number,
    stopMs,
    ordinal: count(row.ordinal),
    title: text(row.title, 16384),
    description: row.description === null ? null : text(row.description, 65536, true),
    categories: validateGuideCategories(row.categories),
  };
}

export function createAccountGuide(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('The Paid TV guide requires the installed application.'));
      return invoke(command, args);
    },
  };
  const read = <T>(
    command: string,
    account: AccountMetadata,
    extra: Record<string, unknown>,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
  ) =>
    invokeOwnedNative(
      native,
      command,
      { request: { schemaVersion: 1, accountId: validateAccountMetadata(account).id, ...extra } },
      { signal, validate },
    );
  return {
    /** Download the provider's guide now (only on the viewer's request). */
    refresh(account: AccountMetadata, signal?: AbortSignal): Promise<AccountGuideStatus> {
      const admitted = validateAccountMetadata(account);
      return invokeOwnedNative(
        native,
        'refresh_iptv_account_guide',
        {
          request: {
            schemaVersion: 1,
            accountId: admitted.id,
            expectedRevision: admitted.revision,
          },
        },
        {
          signal,
          durable: true,
          validate: (value) => {
            const status = validateAccountGuideStatus(value);
            if (!status) throw invalid();
            return status;
          },
        },
      );
    },
    status(account: AccountMetadata, signal?: AbortSignal) {
      return read(
        'read_iptv_account_guide_status',
        account,
        {},
        validateAccountGuideStatus,
        signal,
      );
    },
    channels(account: AccountMetadata, signal?: AbortSignal) {
      return read(
        'read_iptv_account_guide_channels',
        account,
        {},
        (value) => {
          if (!Array.isArray(value) || value.length > 50000) throw invalid();
          const rows = value.map((row) => validateChannel(row, account.id));
          if (new Set(rows.map((row) => row.id)).size !== rows.length) throw invalid();
          return rows;
        },
        signal,
      );
    },
    listed(
      account: AccountMetadata,
      fromMs: number,
      toMs: number,
      search: string,
      signal?: AbortSignal,
    ) {
      return read(
        'read_iptv_account_guide_listed',
        account,
        { fromMs, toMs, search },
        (value) => {
          const row = record(value, ['revision', 'epgIds']);
          if (!Array.isArray(row.epgIds) || row.epgIds.length > 50000) throw invalid();
          return {
            revision: count(row.revision),
            epgIds: row.epgIds.map((id) => text(id, 16384)),
          };
        },
        signal,
      );
    },
    programs(
      account: AccountMetadata,
      epgId: string,
      fromMs: number,
      toMs: number,
      after: { startMs: number; ordinal: number } | null,
      limit: number,
      signal?: AbortSignal,
    ) {
      return read(
        'read_iptv_account_guide_programs',
        account,
        {
          epgId,
          fromMs,
          toMs,
          limit,
          ...(after ? { afterStartMs: after.startMs, afterOrdinal: after.ordinal } : {}),
        },
        (value) => {
          const row = record(value, ['revision', 'programs']);
          if (!Array.isArray(row.programs) || row.programs.length > Math.min(100, limit))
            throw invalid();
          return {
            revision: count(row.revision),
            programs: row.programs.map((program) => validateProgram(program, epgId)),
          };
        },
        signal,
      );
    },
  };
}
export type AccountGuide = ReturnType<typeof createAccountGuide>;
