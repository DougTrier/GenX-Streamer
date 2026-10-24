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

import { validatePreferences, type Preferences } from '../../preferences';
import { GUIDE_SOURCE_LIMIT } from '../../guide/limits';
import {
  canonicalProviderLocation,
  validateProviderRegistry,
  type ReviewedChannelProvider,
} from '../../discovery/provider-registry';
import type { ReviewedGuideProvider } from '../../guide/discovery';
import type {
  OnlineSourceCandidate,
  OnlineSourceScanResult,
} from '../../discovery/online-source-scan';
import { boundedUtf8Text } from '../../platform/bounded-text';
export interface DiscoveredSourceAudit {
  readonly kind: 'channel' | 'guide';
  readonly providerId: string;
  readonly location: string;
  readonly directoryIds: readonly number[];
  readonly provenances: readonly string[];
  readonly action: 'added' | 'existing';
}
const failure = () =>
  new Error('Discovered source configuration is invalid or exceeds its limits.');
const text = (value: unknown, max: number): boolean =>
  boundedUtf8Text(value, max) &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function candidate(value: OnlineSourceCandidate, kind: 'channel' | 'guide'): OnlineSourceCandidate {
  if (
    !value ||
    !text(value.label, 2048) ||
    !text(value.reason, 2048) ||
    value.allowHttp !== false ||
    value.rights !== 'unknown' ||
    (kind === 'channel' ? !['m3u', 'm3u8'].includes(value.format) : value.format !== 'xmltv') ||
    !Array.isArray(value.directoryIds) ||
    !value.directoryIds.length ||
    value.directoryIds.length > 20 ||
    new Set(value.directoryIds).size !== value.directoryIds.length ||
    value.directoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !Array.isArray(value.provenances) ||
    !value.provenances.length ||
    value.provenances.length > 20 ||
    new Set(value.provenances).size !== value.provenances.length
  )
    throw failure();
  if (
    canonicalProviderLocation(value.location) !== value.location ||
    canonicalProviderLocation(value.provenance) !== value.provenance ||
    !value.provenances.includes(value.provenance)
  )
    throw failure();
  for (const provenance of value.provenances) {
    if (!text(provenance, 2048) || canonicalProviderLocation(provenance) !== provenance)
      throw failure();
  }
  return value;
}
function name(option: OnlineSourceCandidate, kind: 'channel' | 'guide'): string {
  if (text(option.label, 512)) return option.label;
  const filename = option.label.split('/').at(-1)!;
  return text(filename, 512)
    ? filename
    : kind === 'channel'
      ? 'Discovered channel source'
      : 'Discovered program guide';
}
/** Pure preparation after explicit discovery intent; no persistence, acquisition or grant expansion. */
export function prepareDiscoveredSources<T extends Preferences>(
  preferences: T,
  result: OnlineSourceScanResult,
  idFactory: () => string,
  /**
   * Permanently unavailable links are neither added nor kept as channel suggestions,
   * except locations in `keep` (saved catalog sources, which hold channels).
   */
  options: { unavailable?: ReadonlySet<string>; keep?: ReadonlySet<string> } = {},
): { preferences: T; audit: readonly DiscoveredSourceAudit[]; pruned: readonly string[] } {
  validatePreferences(preferences);
  if (
    !result ||
    !Array.isArray(result.channels) ||
    !Array.isArray(result.guides) ||
    result.channels.length > 100 ||
    result.guides.length > GUIDE_SOURCE_LIMIT ||
    typeof idFactory !== 'function'
  )
    throw failure();
  // Only links recorded as permanently unavailable are pruned (placeholders are
  // recorded on their first failure, never guessed in advance).
  const dead = (location: string) =>
    !!options.unavailable?.has(location) && !options.keep?.has(location);
  const pruned: string[] = [];
  const channelProviders = (preferences.reviewedChannelProviders ?? [])
    .filter((p) => (dead(p.location) ? (pruned.push(p.location), false) : true))
    .map((p) => ({ ...p }));
  const guideProviders = (preferences.reviewedGuideProviders ?? []).map((p) => ({ ...p }));
  const selected = {
    channel: result.channels.map((c) => candidate(c, 'channel')).filter((c) => !dead(c.location)),
    guide: result.guides.map((c) => candidate(c, 'guide')),
  };
  const ids = new Set([...channelProviders, ...guideProviders].map((p) => p.id));
  const audit = new Map<string, DiscoveredSourceAudit>();
  for (const kind of ['channel', 'guide'] as const) {
    const providers: (ReviewedChannelProvider | ReviewedGuideProvider)[] =
      kind === 'channel' ? channelProviders : guideProviders;
    const byLocation = new Map(providers.map((p) => [p.location, p]));
    if (
      new Set([...byLocation.keys(), ...selected[kind].map((c) => c.location)]).size >
      (kind === 'guide' ? GUIDE_SOURCE_LIMIT : 100)
    )
      throw failure();
    for (const option of selected[kind]) {
      let provider = byLocation.get(option.location);
      const auditKey = JSON.stringify([kind, option.location]);
      let action: DiscoveredSourceAudit['action'] = 'existing';
      if (!provider) {
        const id = idFactory();
        if (!text(id, 256) || ids.has(id) || /https?:\/\//iu.test(id)) throw failure();
        ids.add(id);
        const base = {
          id,
          name: name(option, kind),
          location: option.location,
          provenance: option.provenance,
        };
        provider =
          kind === 'channel'
            ? // Included sources allow plain HTTP channels (owner decision, Oct 17 2026).
              { ...base, allowHttp: true }
            : {
                ...base,
                limitations:
                  'Discovered published guide candidate. Freshness, channel matching, schedule coverage and rights have not been verified.',
              };
        providers.push(provider);
        byLocation.set(option.location, provider);
        action = 'added';
      }
      const prior = audit.get(auditKey);
      audit.set(
        auditKey,
        Object.freeze({
          kind,
          providerId: provider.id,
          location: provider.location,
          action: prior?.action ?? action,
          directoryIds: Object.freeze([
            ...new Set([...(prior?.directoryIds ?? []), ...option.directoryIds]),
          ]),
          provenances: Object.freeze([
            ...new Set([...(prior?.provenances ?? []), ...option.provenances]),
          ]),
        }),
      );
    }
  }
  validateProviderRegistry({
    schemaVersion: 1,
    reviewedChannelProviders: channelProviders,
    reviewedGuideProviders: guideProviders,
  });
  return {
    preferences: {
      ...preferences,
      reviewedChannelProviders: channelProviders,
      reviewedGuideProviders: guideProviders,
    },
    audit: Object.freeze([...audit.values()]),
    pruned: Object.freeze(pruned),
  };
}
