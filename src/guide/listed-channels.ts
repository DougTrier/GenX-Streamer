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

export interface ListedGuideChannel {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  xmltvChannelId: string;
  sourceRevision: number;
  /** Live exact-group filter facts: favorite=1, news=2, sports=4. */
  filterMask: number;
}
export interface ListedGuideChannels {
  catalogRevision: string;
  databaseRevision: number;
  viewRevision: string;
  groupingPolicy: typeof GUIDE_GROUPING_POLICY;
  channels: ListedGuideChannel[];
}
export const GUIDE_GROUPING_POLICY = 'exact-ordered-endpoints-policy-v2' as const;
const revision = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const MAX_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const id = (v: unknown, max = 16384): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  boundedUtf8Text(v, max) &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c));
const invalid = () => new Error('The listed program guide channel inventory is invalid.');
const compare = (a: string, b: string): number => {
  const aa = utf8.encode(a),
    bb = utf8.encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++)
    if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
};

/** Entire snapshot is returned only after every page joins and validates. */
export async function readListedGuideChannels(
  start: number,
  end: number,
  signal: AbortSignal,
  search?: string,
): Promise<ListedGuideChannels> {
  signal.throwIfAborted();
  if (
    search !== undefined &&
    (typeof search !== 'string' ||
      new TextEncoder().encode(search).length > 256 ||
      /\p{Cc}/u.test(search))
  )
    throw invalid();
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < -62135647200000 ||
    end <= start ||
    end - start > 7 * 86400000 ||
    end > 253402351200000
  )
    throw invalid();
  if (!isTauri()) throw new Error('The native program guide is unavailable.');
  const channels: ListedGuideChannel[] = [];
  let cursor: string | null = null;
  let catalogRevision: string | undefined;
  let databaseRevision: number | undefined;
  let rootGeneration: number | undefined;
  let viewRevision: string | undefined;
  let bytes = 0;
  const cursors = new Set<string>();
  const sourceRevisions = new Map<string, number>();
  let previous: ListedGuideChannel | undefined;
  // Native pages can shrink by bytes; each nonterminal page must still advance one identity.
  for (let pageNumber = 0; pageNumber <= 100000; pageNumber++) {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    let cancellation: Promise<unknown> | null = null;
    let cancellationFailed = false;
    const cancel = () => {
      cancellation ??= invoke('cancel_playlist', { requestId }).catch(() => {
        cancellationFailed = true;
      });
    };
    signal.addEventListener('abort', cancel, { once: true });
    let raw: unknown;
    let producerFailed = false;
    let producerError: unknown;
    try {
      signal.throwIfAborted();
      raw = await invoke('guide_listed_channels', {
        query: { startMs: start, endMs: end, cursor, ...(search ? { search } : {}) },
        requestId,
      });
    } catch (error) {
      producerFailed = true;
      producerError = error;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (cancellation) await cancellation;
    }
    if (cancellationFailed)
      throw new Error('The program guide cancellation acknowledgement failed.');
    if (producerFailed) {
      // Rust command failures cross IPC as strings. Only recognized lifecycle
      // refusals become an abort, and only after this owner's signal, original
      // command and matching cancellation acknowledgement have all settled.
      // Other failures must remain visible to the timeline's cleanup owner.
      if (
        signal.aborted &&
        typeof producerError === 'string' &&
        ['canceled', 'guide-cancelled', 'application-closing'].includes(producerError)
      )
        throw new DOMException('Program guide inventory canceled.', 'AbortError');
      throw producerError;
    }
    signal.throwIfAborted();
    if (!raw || typeof raw !== 'object') throw invalid();
    const page = raw as Record<string, unknown>;
    if (
      Object.keys(page).some(
        (key) =>
          ![
            'startMs',
            'endMs',
            'rootGeneration',
            'catalogRevision',
            'databaseRevision',
            'viewRevision',
            'groupingPolicy',
            'channels',
            'nextCursor',
          ].includes(key),
      ) ||
      page.startMs !== start ||
      page.endMs !== end ||
      !integer(page.rootGeneration) ||
      !revision(page.catalogRevision) ||
      !revision(page.viewRevision) ||
      page.groupingPolicy !== GUIDE_GROUPING_POLICY ||
      !integer(page.databaseRevision) ||
      !Array.isArray(page.channels) ||
      // Native pages hold up to 1,024 channels (guide/listed_channels.rs PAGE).
      page.channels.length > 1024 ||
      !(page.nextCursor === null || id(page.nextCursor, 128 * 1024))
    )
      throw invalid();
    if (utf8.encode(JSON.stringify(page)).byteLength > 512 * 1024) throw invalid();
    if (catalogRevision === undefined) {
      catalogRevision = page.catalogRevision;
      databaseRevision = page.databaseRevision;
      rootGeneration = page.rootGeneration;
      viewRevision = page.viewRevision;
    } else if (
      catalogRevision !== page.catalogRevision ||
      databaseRevision !== page.databaseRevision ||
      rootGeneration !== page.rootGeneration ||
      viewRevision !== page.viewRevision
    )
      throw invalid();
    for (const value of page.channels) {
      if (!value || typeof value !== 'object') throw invalid();
      const v = value as Record<string, unknown>;
      if (
        Object.keys(v).some(
          (key) =>
            ![
              'catalogSourceId',
              'appChannelId',
              'guideSourceId',
              'xmltvChannelId',
              'sourceRevision',
              'filterMask',
            ].includes(key),
        ) ||
        !id(v.catalogSourceId) ||
        !id(v.appChannelId) ||
        !id(v.guideSourceId, 256) ||
        !id(v.xmltvChannelId) ||
        !integer(v.sourceRevision) ||
        v.sourceRevision < 1 ||
        !integer(v.filterMask) ||
        v.filterMask > 7
      )
        throw invalid();
      const item = v as unknown as ListedGuideChannel;
      if (
        previous &&
        (compare(previous.catalogSourceId, item.catalogSourceId) > 0 ||
          (previous.catalogSourceId === item.catalogSourceId &&
            compare(previous.appChannelId, item.appChannelId) >= 0))
      )
        throw invalid();
      const priorRevision = sourceRevisions.get(item.guideSourceId);
      if (priorRevision !== undefined && priorRevision !== item.sourceRevision) throw invalid();
      if (priorRevision === undefined) bytes += utf8.encode(item.guideSourceId).byteLength + 96;
      sourceRevisions.set(item.guideSourceId, item.sourceRevision);
      bytes += utf8.encode(JSON.stringify(item)).byteLength + 256;
      if (channels.length >= 100000 || bytes > MAX_BYTES)
        throw new Error('The listed program guide channel inventory exceeds its safe capacity.');
      channels.push({
        catalogSourceId: item.catalogSourceId,
        appChannelId: item.appChannelId,
        guideSourceId: item.guideSourceId,
        xmltvChannelId: item.xmltvChannelId,
        sourceRevision: item.sourceRevision,
        filterMask: item.filterMask,
      });
      previous = channels[channels.length - 1];
    }
    if (page.nextCursor === null)
      return {
        catalogRevision,
        databaseRevision: databaseRevision!,
        viewRevision: viewRevision!,
        groupingPolicy: GUIDE_GROUPING_POLICY,
        channels,
      };
    if (page.channels.length === 0 || cursors.has(page.nextCursor as string)) throw invalid();
    cursor = page.nextCursor as string;
    bytes += utf8.encode(cursor).byteLength + 96;
    if (bytes > MAX_BYTES)
      throw new Error('The listed program guide channel inventory exceeds its safe capacity.');
    cursors.add(cursor);
  }
  throw invalid();
}
