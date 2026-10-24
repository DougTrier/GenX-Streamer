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

import { validateCatalog, type CatalogRecord } from '../catalog/codec';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface GuideAliasPair {
  readonly catalogSourceId: string;
  readonly appChannelId: string;
  readonly providerId: string;
  readonly xmltvChannelId: string;
}
export interface GuideCommitAliases {
  readonly schemaVersion: 1;
  readonly guideLocation: string;
  readonly provenanceLocation: string;
  readonly provenanceSha256: string;
  readonly pairs: readonly GuideAliasPair[];
}
export const MAX_GUIDE_ALIAS_PAIRS = 1024;
export const MAX_GUIDE_ALIAS_BYTES = 512 * 1024;
export const REVIEWED_GUIDE_ALIAS_LOCATION =
  'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz';
const authority = Object.freeze({
  guideLocation: REVIEWED_GUIDE_ALIAS_LOCATION,
  provenanceLocation:
    'https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml',
  provenanceSha256: 'dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e',
});
const targets: ReadonlyMap<string, string> = new Map([
  ['PGATour.us@SD', '5de94dacb394a300099fa22a'],
  ['CBSSportsGolazoNetwork.us@SD', '63a0e33a45264d000850ed7e'],
  ['WorldPokerTour.us@US', '5616f9c0ada51f8004c4b091'],
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const failure = () =>
  new Error('Reviewed program guide aliases are invalid or exceed their limit.');
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key))
  );
}
function identity(value: unknown, limit: number): value is string {
  return (
    boundedUtf8Text(value, limit) &&
    ![...value].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
    )
  );
}
/** Only installed, reviewed ID tuples grant aliases; caller-provided provenance alone grants none.
 * Native publication repeats URL, canonical channel, feed target and revision admission.
 */
export function validateReviewedGuideAliases(input: unknown): GuideCommitAliases {
  if (
    !object(input) ||
    !exactFields(input, [
      'schemaVersion',
      'guideLocation',
      'provenanceLocation',
      'provenanceSha256',
      'pairs',
    ]) ||
    input.schemaVersion !== 1 ||
    input.guideLocation !== authority.guideLocation ||
    input.provenanceLocation !== authority.provenanceLocation ||
    input.provenanceSha256 !== authority.provenanceSha256 ||
    !Array.isArray(input.pairs) ||
    input.pairs.length > MAX_GUIDE_ALIAS_PAIRS
  )
    throw failure();
  const seen = new Set<string>();
  const pairs = input.pairs.map((pair: unknown): GuideAliasPair => {
    if (
      !object(pair) ||
      !exactFields(pair, ['catalogSourceId', 'appChannelId', 'providerId', 'xmltvChannelId']) ||
      !identity(pair.catalogSourceId, 256) ||
      !identity(pair.appChannelId, 16_384) ||
      !identity(pair.providerId, 16_384) ||
      !identity(pair.xmltvChannelId, 16_384) ||
      targets.get(pair.providerId) !== pair.xmltvChannelId
    )
      throw failure();
    const key = JSON.stringify([pair.catalogSourceId, pair.appChannelId]);
    if (seen.has(key)) throw failure();
    seen.add(key);
    return Object.freeze({
      catalogSourceId: pair.catalogSourceId,
      appChannelId: pair.appChannelId,
      providerId: pair.providerId,
      xmltvChannelId: pair.xmltvChannelId,
    });
  });
  const result: GuideCommitAliases = Object.freeze({
    schemaVersion: 1,
    ...authority,
    pairs: Object.freeze(pairs),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_GUIDE_ALIAS_BYTES)
    throw failure();
  return result;
}
/** Build only from an admitted canonical snapshot, never channel names or a partial review page. */
export function buildReviewedGuideAliases(
  guideLocation: string,
  catalog: CatalogRecord,
  removedIds: readonly string[],
): GuideCommitAliases | undefined {
  if (guideLocation !== authority.guideLocation) return undefined;
  const admitted = validateCatalog(catalog);
  if (
    !Array.isArray(removedIds) ||
    removedIds.length > 100_000 ||
    removedIds.some((id) => !identity(id, 16_384))
  )
    throw failure();
  const removed = new Set(removedIds);
  const pairs: GuideAliasPair[] = [];
  for (const channel of admitted.channels) {
    if (removed.has(channel.id) || channel.providerId === undefined) continue;
    const xmltvChannelId = targets.get(channel.providerId);
    if (xmltvChannelId === undefined) continue;
    if (pairs.length >= MAX_GUIDE_ALIAS_PAIRS) throw failure();
    pairs.push({
      catalogSourceId: channel.sourceId,
      appChannelId: channel.id,
      providerId: channel.providerId,
      xmltvChannelId,
    });
  }
  return validateReviewedGuideAliases({ schemaVersion: 1, ...authority, pairs });
}
