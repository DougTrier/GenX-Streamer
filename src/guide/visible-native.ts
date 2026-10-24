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
import { boundedUtf8Text } from '../platform/bounded-text';
import {
  SelectedGuideUnavailableError,
  validateSelectedGuideSummary,
  type SelectedGuideSummary,
} from './native';

export interface VisibleGuideChannel {
  catalogSourceId: string;
  appChannelId: string;
}
export interface VisibleGuideQuery {
  requestId: string;
  atMs: number;
  channels: readonly VisibleGuideChannel[];
}
export interface VisibleGuideSummary {
  requestId: string;
  atMs: number;
  catalogRevision: string;
  databaseRevision: number;
  rows: SelectedGuideSummary[];
}
const invalid = () =>
  new Error('Visible program guide response was invalid. Retry or review Guide.');
export function validGuideRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function validVisibleChannels(channels: readonly VisibleGuideChannel[]): boolean {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 64) return false;
  const keys = new Set<string>();
  for (const channel of channels) {
    if (
      !channel ||
      !boundedUtf8Text(channel.catalogSourceId, 256) ||
      !boundedUtf8Text(channel.appChannelId, 16384)
    )
      return false;
    for (const id of [channel.catalogSourceId, channel.appChannelId])
      if (
        [...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
        return false;
    const key = JSON.stringify([channel.catalogSourceId, channel.appChannelId]);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
function validateQuery(query: VisibleGuideQuery): void {
  if (
    !validVisibleChannels(query.channels) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(query.requestId) ||
    !Number.isSafeInteger(query.atMs) ||
    query.atMs < -62135596800000 ||
    query.atMs > 253402300799999
  )
    throw invalid();
}
export function validateVisibleGuideSummary(
  value: unknown,
  query: VisibleGuideQuery,
): VisibleGuideSummary {
  validateQuery(query);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !['requestId', 'atMs', 'catalogRevision', 'databaseRevision', 'rows'].includes(key),
    ) ||
    v.requestId !== query.requestId ||
    v.atMs !== query.atMs ||
    !validGuideRevision(v.catalogRevision) ||
    !Number.isSafeInteger(v.databaseRevision) ||
    (v.databaseRevision as number) < 0 ||
    !Array.isArray(v.rows) ||
    v.rows.length !== query.channels.length
  )
    throw invalid();
  if (!boundedUtf8Text(JSON.stringify(v), 512 * 1024)) throw invalid();
  const rows = v.rows.map((row, index) => {
    const summary = validateSelectedGuideSummary(row, {
      ...query.channels[index],
      requestId: query.requestId,
      atMs: query.atMs,
    });
    if (
      summary.catalogRevision !== v.catalogRevision ||
      summary.databaseRevision !== v.databaseRevision
    )
      throw invalid();
    return summary;
  });
  return {
    requestId: query.requestId,
    atMs: query.atMs,
    catalogRevision: v.catalogRevision,
    databaseRevision: v.databaseRevision as number,
    rows,
  };
}
export function createVisibleGuideAdapter(transport: {
  isNative(): boolean;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}) {
  return async (query: VisibleGuideQuery, signal: AbortSignal): Promise<VisibleGuideSummary> => {
    signal.throwIfAborted();
    validateQuery(query);
    if (!transport.isNative()) throw new SelectedGuideUnavailableError();
    let cancellation: Promise<unknown> | null = null;
    const cancel = () => {
      cancellation ??= Promise.resolve().then(() =>
        transport.invoke('cancel_playlist', { requestId: query.requestId }),
      );
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let value: unknown,
      failed = false;
    try {
      value = await transport.invoke('guide_visible_summaries', { ...query });
    } catch {
      failed = true;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (cancellation) {
      try {
        await cancellation;
      } catch {
        throw new Error('Program guide cancellation could not finish. Retry closing.');
      }
    }
    if (signal.aborted) throw new DOMException('Program guide canceled.', 'AbortError');
    if (failed) throw new Error('Visible program guide could not refresh. Retry or review Guide.');
    return validateVisibleGuideSummary(value, query);
  };
}
export const readVisibleGuide = createVisibleGuideAdapter({
  isNative: isTauri,
  invoke: (command, args) => invoke(command, args),
});
