// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { invoke } from '@tauri-apps/api/core';
import {
  validateAccountChannel,
  type AccountChannel,
  type AccountCatalogFence,
} from './account-catalog';
export const accountSourceKey = (
  channel: Pick<AccountChannel, 'streamReference'>,
  fence: AccountCatalogFence,
  alternate = false,
): string =>
  JSON.stringify([
    'paid',
    fence.accountId,
    fence.accountRevision,
    fence.mediaRevision,
    channel.streamReference,
    alternate,
  ]);
export async function readEquivalentPaidChannels(
  channel: AccountChannel,
  fence: AccountCatalogFence,
): Promise<AccountChannel[]> {
  const result = await invoke<{
    accountId: string;
    accountRevision: string;
    mediaRevision: string;
    channelId: string;
    validUntilMs: number | null;
    candidates: unknown[];
  }>('equivalent_paid_channels', { query: { ...fence, channelId: channel.id } });
  if (
    !result ||
    result.accountId !== fence.accountId ||
    result.accountRevision !== fence.accountRevision ||
    result.mediaRevision !== fence.mediaRevision ||
    result.channelId !== channel.id ||
    !Array.isArray(result.candidates) ||
    !result.candidates.length ||
    result.candidates.length > 16
  )
    throw Error('Equivalent account feeds are unavailable.');
  if (
    !Number.isSafeInteger(result.validUntilMs) ||
    result.validUntilMs! <= Date.now() + 10_000 ||
    result.validUntilMs! > Date.now() + 12 * 60 * 60_000
  )
    return [channel];
  const candidates = result.candidates.map((c) => validateAccountChannel(c, fence.accountId));
  if (
    candidates[0].id !== channel.id ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length
  )
    throw Error('Equivalent account feeds are invalid.');
  return candidates;
}
