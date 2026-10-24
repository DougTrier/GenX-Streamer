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

import { boundedUtf8Text } from '../platform/bounded-text';
import { GUIDE_SOURCE_LIMIT } from '../guide/limits';
import { canonicalProviderLocation } from './provider-registry';
import { defaultPreferences, validatePreferences } from '../preferences';
import {
  validateSourceRepository,
  type SourceRepository,
  type SourceOption,
  type PublishedSourceOption,
} from './source-index';
import type { PreferredRegion } from '../location/region';
import { directoryRateLimitReset } from '../platform/source-directory';
export interface OnlineSourceIndex {
  repository(id: number, signal: AbortSignal): Promise<SourceRepository>;
  publishedLinks(
    repository: SourceRepository,
    path: string,
    signal: AbortSignal,
  ): Promise<readonly PublishedSourceOption[]>;
  openRepository(
    repository: SourceRepository,
    signal: AbortSignal,
  ): Promise<readonly SourceOption[]>;
}
export type OnlineSourceCandidate = (SourceOption | PublishedSourceOption) & {
  readonly directoryIds: readonly number[];
  readonly provenances: readonly string[];
  readonly allowHttp: false;
};
export interface OnlineSourceScanResult {
  readonly query: string;
  readonly region?: PreferredRegion;
  readonly startedAtMs: number;
  readonly channels: readonly OnlineSourceCandidate[];
  readonly guides: readonly OnlineSourceCandidate[];
  readonly documentOutcomes?: readonly {
    directoryId: number;
    path: 'epglist.txt';
    status: 'found' | 'none' | 'failed' | 'over-budget';
    guideCount: number;
  }[];
  readonly outcomes: readonly {
    directoryId: number;
    status: 'found' | 'none' | 'failed';
    channelCount: number;
    guideCount: number;
    /** GitHub refused for quota; retryAtMs is its published reset, when known. */
    reason?: 'rate-limited';
    retryAtMs?: number;
  }[];
  /** Present when any directory was refused for quota rather than unavailable. */
  readonly rateLimited?: { readonly retryAtMs: number | null };
}
export const ONLINE_SOURCE_DIRECTORY_LIMIT = 20;
export const ONLINE_SOURCE_OPTION_LIMIT = 100;
export interface OnlineSourceProgress {
  checkedDirectories: number;
  totalDirectories: number;
  channelSources: number;
  guideSources: number;
  elapsedMilliseconds: number;
}
const refused = () => new Error('Online source discovery scope is invalid or exceeds its bounds.');
const aborted = () => new DOMException('Online source discovery canceled.', 'AbortError');
class OptionBudgetError extends Error {}
function validateOption(option: SourceOption | PublishedSourceOption) {
  if (!option || !['m3u', 'm3u8', 'xmltv'].includes(option.format) || option.rights !== 'unknown')
    throw refused();
  for (const field of [option.label, option.reason])
    if (!boundedUtf8Text(field, 2048) || /[\r\n]/u.test(field)) throw refused();
  // Index results are inert HTTPS source suggestions; HTTP never becomes an automatic grant.
  if (
    canonicalProviderLocation(option.location) !== option.location ||
    canonicalProviderLocation(option.provenance) !== option.provenance
  )
    throw refused();
  return { ...option };
}
/** Explicit search resolves directory metadata only. Playlist inspection, probes and publication remain separate owners. */
export function createOnlineSourceScan(
  index: OnlineSourceIndex,
  knownDirectoryIds: readonly number[],
  now: () => number = Date.now,
  onProgress?: (progress: Readonly<OnlineSourceProgress>) => void,
) {
  if (
    !Array.isArray(knownDirectoryIds) ||
    knownDirectoryIds.length > ONLINE_SOURCE_DIRECTORY_LIMIT ||
    new Set(knownDirectoryIds).size !== knownDirectoryIds.length ||
    knownDirectoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw refused();
  const ids = [...knownDirectoryIds];
  let disposed = false;
  let active: { controller: AbortController; work: Promise<OnlineSourceScanResult> } | null = null;
  function start(
    input: { query: string; region?: PreferredRegion },
    signal: AbortSignal,
  ): Promise<OnlineSourceScanResult> {
    if (disposed) return Promise.reject(new Error('Online source discovery is closed.'));
    if (active) return Promise.reject(new Error('Online source discovery is already running.'));
    if (
      !boundedUtf8Text(input.query, 256, true) ||
      [...input.query].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return Promise.reject(refused());
    signal.throwIfAborted();
    const query = input.query,
      region = validatePreferences({
        ...defaultPreferences(),
        preferredRegion: input.region,
      }).preferredRegion,
      startedAtMs = now();
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || startedAtMs > 8.64e15)
      return Promise.reject(refused());
    const controller = new AbortController(),
      cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const admitted = () => {
      if (controller.signal.aborted || disposed) throw aborted();
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const work = Promise.resolve()
      .then(async () => {
        const channels = new Map<string, OnlineSourceCandidate>(),
          guides = new Map<string, OnlineSourceCandidate>();
        const outcomes: OnlineSourceScanResult['outcomes'][number][] = [];
        const documentOutcomes: NonNullable<OnlineSourceScanResult['documentOutcomes']>[number][] =
          [];
        const notify = () => {
          if (controller.signal.aborted || disposed || !onProgress) return;
          try {
            onProgress(
              Object.freeze({
                checkedDirectories: outcomes.length,
                totalDirectories: ids.length,
                channelSources: channels.size,
                guideSources: guides.size,
                elapsedMilliseconds: Math.max(0, now() - startedAtMs),
              }),
            );
          } catch {
            /* Observers cannot change source admission or collection. */
          }
        };
        notify();
        if (onProgress) heartbeat = setInterval(notify, 1000);
        const admitOptions = (
          options: readonly (SourceOption | PublishedSourceOption)[],
          directoryId: number,
        ) => {
          if (options.length > ONLINE_SOURCE_OPTION_LIMIT + GUIDE_SOURCE_LIMIT)
            throw new OptionBudgetError();
          const validated = options.map(validateOption);
          const newChannels = new Set(
              validated.filter((o) => o.format !== 'xmltv').map((o) => o.location),
            ),
            newGuides = new Set(
              validated.filter((o) => o.format === 'xmltv').map((o) => o.location),
            );
          if (
            new Set([...channels.keys(), ...newChannels]).size > ONLINE_SOURCE_OPTION_LIMIT ||
            new Set([...guides.keys(), ...newGuides]).size > GUIDE_SOURCE_LIMIT
          )
            throw new OptionBudgetError();
          for (const option of validated) {
            const target = option.format === 'xmltv' ? guides : channels,
              previous = target.get(option.location);
            target.set(
              option.location,
              Object.freeze({
                ...option,
                ...(previous ?? {}),
                directoryIds: Object.freeze([
                  ...new Set([...(previous?.directoryIds ?? []), directoryId]),
                ]),
                provenances: Object.freeze([
                  ...new Set([...(previous?.provenances ?? []), option.provenance]),
                ]),
                allowHttp: false as const,
              }),
            );
          }
          return { channelCount: newChannels.size, guideCount: newGuides.size };
        };
        for (const directoryId of ids) {
          admitted();
          try {
            const repository = validateSourceRepository(
              await index.repository(directoryId, controller.signal),
            );
            admitted();
            if (repository.id !== directoryId) throw refused();
            let options: readonly (SourceOption | PublishedSourceOption)[] = [];
            for (const path of ['README.md', 'readme.md']) {
              try {
                options = await index.publishedLinks(repository, path, controller.signal);
                admitted();
                if (options.length) break;
              } catch {
                admitted();
              }
            }
            if (!options.length) {
              options = await index.openRepository(repository, controller.signal);
              admitted();
            }
            const counts = admitOptions(options, directoryId);
            // A playlist-bearing README must not hide a separately published
            // guide index. Each document has independent whole admission.
            try {
              const guideOptions = await index.publishedLinks(
                repository,
                'epglist.txt',
                controller.signal,
              );
              admitted();
              if (guideOptions.some((option) => option.format !== 'xmltv')) throw refused();
              const guideCounts = admitOptions(guideOptions, directoryId);
              counts.guideCount = new Set([
                ...options
                  .filter((option) => option.format === 'xmltv')
                  .map((option) => option.location),
                ...guideOptions.map((option) => option.location),
              ]).size;
              documentOutcomes.push(
                Object.freeze({
                  directoryId,
                  path: 'epglist.txt',
                  status: guideOptions.length ? 'found' : 'none',
                  guideCount: guideCounts.guideCount,
                }),
              );
            } catch (error) {
              admitted();
              documentOutcomes.push(
                Object.freeze({
                  directoryId,
                  path: 'epglist.txt',
                  status: error instanceof OptionBudgetError ? 'over-budget' : 'failed',
                  guideCount: 0,
                }),
              );
            }
            outcomes.push(
              Object.freeze({
                directoryId,
                status: counts.channelCount || counts.guideCount ? 'found' : 'none',
                ...counts,
              }),
            );
          } catch (error) {
            admitted();
            const reset = directoryRateLimitReset(error);
            outcomes.push(
              Object.freeze({
                directoryId,
                status: 'failed',
                channelCount: 0,
                guideCount: 0,
                ...(reset === undefined
                  ? {}
                  : {
                      reason: 'rate-limited' as const,
                      ...(reset === null ? {} : { retryAtMs: reset }),
                    }),
              }),
            );
          } finally {
            notify();
          }
        }
        admitted();
        const limited = outcomes.filter((outcome) => outcome.reason === 'rate-limited');
        const resets = limited.flatMap((outcome) =>
          outcome.retryAtMs === undefined ? [] : [outcome.retryAtMs],
        );
        return Object.freeze({
          ...(limited.length
            ? {
                rateLimited: Object.freeze({
                  retryAtMs: resets.length === limited.length ? Math.max(...resets) : null,
                }),
              }
            : {}),
          query,
          ...(region ? { region: Object.freeze({ ...region }) } : {}),
          startedAtMs,
          channels: Object.freeze([...channels.values()]),
          guides: Object.freeze([...guides.values()]),
          outcomes: Object.freeze(outcomes),
          documentOutcomes: Object.freeze(documentOutcomes),
        });
      })
      .finally(() => {
        clearInterval(heartbeat);
        signal.removeEventListener('abort', cancel);
        active = null;
      });
    active = { controller, work };
    return work;
  }
  return {
    start,
    async cancel() {
      const job = active;
      if (job) {
        job.controller.abort();
        await Promise.allSettled([job.work]);
      }
    },
    async dispose() {
      disposed = true;
      const job = active;
      if (job) {
        job.controller.abort();
        await Promise.allSettled([job.work]);
      }
    },
  };
}
