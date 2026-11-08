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
import { validateAccountMetadata, type AccountMetadata } from './account-vault';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import { validateGuideCategories, type GuideCategory } from '../guide/categories';
import { validateSportsScope, type SportsScope } from '../search/sports';
import { captureGuideHistory, type GuideHistoryScope } from '../guide/history-scope';
import { validReplayDay, type ReplayDates } from '../search/replay-dates';

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
  originalCategory?: string;
  epgId: string;
  providerId: string | null;
  /** Opaque native playback capability, as in the channel list. */
  streamReference: string;
  favorite: boolean;
  /** Positive PPV evidence from original/effective provider metadata. */
  ppv?: boolean;
  /** Canonical country from the provider's original group; absent legacy values are Unknown. */
  country?: string | null;
}
export interface AccountGuideProgram {
  epgId: string;
  startMs: number;
  stopMs: number | null;
  ordinal: number;
  title: string;
  description: string | null;
  categories: GuideCategory[];
  replay?: ReplayDates;
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
const guideChannelId = (value: unknown, accountId: string): string => {
  const id = text(value, 512);
  const prefix = `account-${accountId}-`;
  if (!id.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(id.slice(prefix.length))) throw invalid();
  return id;
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
    'originalCategory',
    'epgId',
    'providerId',
    'streamReference',
    'favorite',
    'ppv',
    'country',
  ]);
  const id = text(row.id, 512);
  if (!id.startsWith(`account-${accountId}-`) || typeof row.favorite !== 'boolean') throw invalid();
  if (row.ppv !== undefined && typeof row.ppv !== 'boolean') throw invalid();
  const streamReference = text(row.streamReference, 32);
  if (!/^[a-f0-9]{32}$/u.test(streamReference)) throw invalid();
  if (
    row.country !== undefined &&
    row.country !== null &&
    (typeof row.country !== 'string' || !/^[A-Z]{2}$/.test(row.country))
  )
    throw invalid();
  return {
    id,
    name: text(row.name, 16384),
    category: text(row.category, 16384, true),
    ...(row.originalCategory === undefined
      ? {}
      : { originalCategory: text(row.originalCategory, 16384, true) }),
    epgId: text(row.epgId, 16384),
    providerId: row.providerId === null ? null : text(row.providerId, 16384),
    streamReference,
    favorite: row.favorite,
    ...(row.ppv === undefined ? {} : { ppv: row.ppv as boolean }),
    ...(row.country === undefined ? {} : { country: row.country as string | null }),
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
    'replay',
  ]);
  if (row.epgId !== epgId || !Number.isSafeInteger(row.startMs)) throw invalid();
  const stopMs = row.stopMs === null ? null : count(row.stopMs);
  if (stopMs !== null && stopMs <= (row.startMs as number)) throw invalid();
  const replay =
    row.replay === undefined
      ? undefined
      : record(row.replay, ['originalAirDate', 'previousAirDate']);
  const replayDay = (value: unknown) => {
    if (value === null) return null;
    if (!validReplayDay(value) || Date.parse(value) > (row.startMs as number)) throw invalid();
    return value;
  };
  return {
    epgId,
    startMs: row.startMs as number,
    stopMs,
    ordinal: count(row.ordinal),
    title: text(row.title, 16384),
    description: row.description === null ? null : text(row.description, 65536, true),
    categories: validateGuideCategories(row.categories),
    ...(replay
      ? {
          replay: {
            originalAirDate: replayDay(replay.originalAirDate),
            previousAirDate: replayDay(replay.previousAirDate),
          },
        }
      : {}),
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
    /** Explicit downloads or enabled, due renewal of an already cached guide. */
    refresh(
      account: AccountMetadata,
      signal?: AbortSignal,
      options?: { automatic?: boolean },
    ): Promise<AccountGuideStatus> {
      const admitted = validateAccountMetadata(account);
      return invokeOwnedNative(
        native,
        'refresh_iptv_account_guide',
        {
          request: {
            schemaVersion: 1,
            accountId: admitted.id,
            expectedRevision: admitted.revision,
            ...(options?.automatic === true ? { automatic: true } : {}),
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
      ppv = false,
      sports?: SportsScope,
      history?: GuideHistoryScope,
    ) {
      const sportScope = sports === undefined ? undefined : validateSportsScope(sports, search);
      const watched = history === undefined ? undefined : captureGuideHistory(history);
      if (watched && ppv) throw invalid();
      if (watched) watched.ids.forEach((id) => guideChannelId(id, account.id));
      return read(
        'read_iptv_account_guide_listed',
        account,
        {
          fromMs,
          toMs,
          search,
          ...(ppv ? { ppv: true } : {}),
          ...(sportScope ? { sports: sportScope } : {}),
          ...(watched ? { historyIds: [...watched.ids], hideAdult: watched.hideAdult } : {}),
        },
        (value) => {
          const row = record(value, [
            'revision',
            'epgIds',
            'channelIds',
            'ppvChannelIds',
            'firstStartsMs',
          ]);
          if (!Array.isArray(row.epgIds) || row.epgIds.length > 50000) throw invalid();
          if ((ppv || sportScope || watched) && row.channelIds === undefined) throw invalid();
          let channelIds: string[] | undefined;
          if (row.channelIds !== undefined) {
            if (!Array.isArray(row.channelIds) || row.channelIds.length > 100000) throw invalid();
            channelIds = row.channelIds.map((value) => guideChannelId(value, account.id));
            if (new Set(channelIds).size !== channelIds.length) throw invalid();
            if (watched && channelIds.some((id) => !watched.ids.includes(id))) throw invalid();
          }
          let ppvChannelIds: string[] | undefined;
          if (row.ppvChannelIds !== undefined) {
            if (
              !Array.isArray(row.ppvChannelIds) ||
              row.ppvChannelIds.length > 100000 ||
              !channelIds
            )
              throw invalid();
            const admitted = new Set(channelIds);
            ppvChannelIds = row.ppvChannelIds.map((value) => guideChannelId(value, account.id));
            if (
              new Set(ppvChannelIds).size !== ppvChannelIds.length ||
              ppvChannelIds.some((id) => !admitted.has(id))
            )
              throw invalid();
          }
          if ((sportScope?.includePpv || watched) && ppvChannelIds === undefined) throw invalid();
          const rawStarts = row.firstStartsMs;
          const start = sportScope?.windowStartMs ?? fromMs;
          const end = sportScope?.windowEndMs ?? toMs;
          if (
            rawStarts !== undefined &&
            (!Array.isArray(rawStarts) ||
              rawStarts.length !== channelIds?.length ||
              rawStarts.some(
                (value) =>
                  !Number.isSafeInteger(value) || value < start - 43_200_000 || value >= end,
              ))
          )
            throw invalid();
          return {
            revision: count(row.revision),
            epgIds: row.epgIds.map((id) => text(id, 16384)),
            ...(channelIds === undefined ? {} : { channelIds }),
            ...(ppvChannelIds === undefined ? {} : { ppvChannelIds }),
            ...(rawStarts === undefined ? {} : { firstStartsMs: rawStarts as number[] }),
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
      ppv = false,
      channelId?: string,
      sports?: SportsScope,
      search = '',
      history?: GuideHistoryScope,
    ) {
      const sportScope = sports === undefined ? undefined : validateSportsScope(sports, search);
      const watched = history === undefined ? undefined : captureGuideHistory(history);
      if (watched && ppv) throw invalid();
      if (watched) watched.ids.forEach((id) => guideChannelId(id, account.id));
      if ((ppv || sportScope || watched) && channelId === undefined) throw invalid();
      const admittedChannel =
        channelId === undefined ? undefined : guideChannelId(channelId, account.id);
      if (watched && !watched.ids.includes(admittedChannel!)) throw invalid();
      return read(
        'read_iptv_account_guide_programs',
        account,
        {
          epgId,
          fromMs,
          toMs,
          limit,
          ...(ppv ? { ppv: true } : {}),
          ...(sportScope ? { sports: sportScope, search } : {}),
          ...(watched ? { historyIds: [...watched.ids], hideAdult: watched.hideAdult } : {}),
          ...(admittedChannel === undefined ? {} : { channelId: admittedChannel }),
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
