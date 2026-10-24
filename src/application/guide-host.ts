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

import { createMappedGuideNativeHost } from './mapped-guide-native';
import { mapGuideAndHydrate } from './mapped-guide-schedule';
import { invoke } from '@tauri-apps/api/core';
import {
  nativeGuide,
  previewNativeGuide,
  readSelectedGuide,
  readChannelGuideCoverage,
  type ProposedGuidePreview,
} from '../guide/native';
import { formatGuideTime } from '../guide/time';
import type { GuideHost, GuideCatalogChannel } from '../ui/guide';
import type { GuideCommitAliases } from '../guide/reviewed-aliases';
import { readListedGuideChannels } from '../guide/listed-channels';

export interface OwnedGuideHost extends GuideHost {
  settleProposedPreviews(): Promise<void>;
  previewProposedSource(
    location: string,
    name: string,
    signal: AbortSignal,
  ): Promise<ProposedGuidePreview>;
  publishCachedPreview(
    ticket: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
  commitMatchedPreview(
    ticket: string,
    expectedGuideRevision: number,
    expectedCatalogRevision: string,
    signal: AbortSignal,
    aliases?: GuideCommitAliases,
  ): Promise<{ committed: boolean; matched: number; unmatched: number }>;
}

function pickGuideFile(signal: AbortSignal): Promise<File | null> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    const finish = (file: File | null, canceled = false) => {
      input.remove();
      signal.removeEventListener('abort', abort);
      if (canceled) reject(new DOMException('Guide file selection canceled.', 'AbortError'));
      else resolve(file);
    };
    const abort = () => finish(null, true);
    signal.addEventListener('abort', abort, { once: true });
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), {
      once: true,
    });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
/** UI owns intent; native SQLite owns source revisions, mappings and schedule publication. */
export function createGuideHost(options: {
  enableTimeline?: boolean;
  channels(): readonly GuideCatalogChannel[];
  selectedChannel(): GuideCatalogChannel | null;
  catalogRevision?(): string | null;
  watch(channel: GuideCatalogChannel, signal: AbortSignal): Promise<void>;
  onChanged?(): void;
  discover?: GuideHost['discover'];
}): OwnedGuideHost {
  const mappedHydration = createMappedGuideNativeHost(() => options.onChanged?.());
  const tickets = new Map<string, number>();
  const mutations = new Set<string>();
  const pendingProposedDiscards = new Set<string>();
  const admitMutation = (ticket: string) => {
    if (mutations.has(ticket)) throw new Error('This program guide preview is still being saved.');
    mutations.add(ticket);
  };
  const picked = new Map<string, File>();
  const settleProposedDiscards = async () => {
    for (const ticket of pendingProposedDiscards) {
      admitMutation(ticket);
      try {
        await nativeGuide.discard(ticket);
        tickets.delete(ticket);
        pendingProposedDiscards.delete(ticket);
      } finally {
        mutations.delete(ticket);
      }
    }
  };
  const read = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const value = await work();
    signal.throwIfAborted();
    return value;
  };
  return {
    ...options,
    listedChannels: readListedGuideChannels,
    summary: readSelectedGuide,
    channelCoverage: readChannelGuideCoverage,
    cancelSummary: (requestId) => invoke('cancel_playlist', { requestId }),
    now: () => Date.now(),
    formatTime: (milliseconds) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const value = formatGuideTime(milliseconds, { timeZone });
      return `${value.date} ${value.time} ${value.zone}`;
    },
    sources: (signal) => read(signal, nativeGuide.sources),
    coverage: async (sourceId, signal) => {
      const result = await read(signal, () => nativeGuide.coverage(sourceId));
      const sources = await read(signal, nativeGuide.sources);
      const source = sources.find((entry) => entry.id === sourceId);
      return {
        publishedRevision: result.publishedRevision,
        updatedMs: result.sourceRevision === source?.revision ? source.updatedMs : null,
        startMs: result.firstStartMs,
        endMs: result.lastStopMs,
      };
    },
    mappings: (signal) => read(signal, nativeGuide.mappings),
    query: (query, signal) => read(signal, () => nativeGuide.programs(query)),
    guideChannels: (query, signal) =>
      read(signal, () => nativeGuide.channels(query.guideSourceId, query.search, query.afterId)),
    settleProposedPreviews: settleProposedDiscards,
    previewProposedSource: async (location, name, signal) => {
      signal.throwIfAborted();
      await settleProposedDiscards();
      signal.throwIfAborted();
      // Adopt before DTO validation: a rejected reply may still own a native ticket.
      // Only a validated, current reply enters the publication map.
      const adopted = new Set<string>();
      try {
        const result = await nativeGuide.previewProposedSource(location, name, signal, (ticket) => {
          adopted.add(ticket);
        });
        signal.throwIfAborted();
        tickets.set(result.ticket, result.sourceRevision);
        adopted.delete(result.ticket);
        return result;
      } catch (error) {
        for (const ticket of adopted) pendingProposedDiscards.add(ticket);
        await settleProposedDiscards();
        throw error;
      }
    },
    preview: async (input, signal) => {
      signal.throwIfAborted();
      const sources = await read(signal, nativeGuide.sources);
      let file: File | undefined;
      let source;
      if ('sourceId' in input) {
        source = sources.find((entry) => entry.id === input.sourceId);
        if (!source) throw new Error('This guide source was removed.');
        if (source.kind === 'file') {
          const selection = await pickGuideFile(signal);
          if (!selection) throw new DOMException('Guide file selection canceled.', 'AbortError');
          file = selection;
        }
      } else {
        if (input.kind === 'file') {
          file = picked.get(input.location);
          picked.delete(input.location);
          if (!file) throw new Error('Choose the guide file again.');
        }
        const existing =
          input.kind === 'url'
            ? sources.find((entry) => entry.kind === 'url' && entry.location === input.location)
            : undefined;
        // The button explicitly saves configuration before the schedule preview.
        source = await nativeGuide.saveSource(
          {
            id: existing?.id ?? crypto.randomUUID(),
            name: input.name,
            location: file?.name ?? input.location,
            kind: input.kind,
            allowHttp: input.allowHttp,
            revision: existing?.revision ?? 0,
            updatedMs: null,
          },
          existing?.revision ?? 0,
        );
        options.onChanged?.();
        signal.throwIfAborted();
      }
      const result = await previewNativeGuide(source.id, signal, file);
      tickets.set(result.ticket, result.sourceRevision);
      return result;
    },
    publishCachedPreview: async (ticket, expectedRevision, signal) => {
      signal.throwIfAborted();
      const revision = tickets.get(ticket);
      if (revision === undefined || revision !== expectedRevision)
        throw new Error('The guide preview changed. Preview it again.');
      admitMutation(ticket);
      try {
        const published = await nativeGuide.commit(ticket, revision, false);
        if (!Number.isSafeInteger(published) || published <= revision)
          throw new Error('The program guide cache receipt is invalid.');
        tickets.delete(ticket);
        options.onChanged?.();
      } finally {
        mutations.delete(ticket);
      }
    },
    commitPreview: async (ticket, signal) => {
      signal.throwIfAborted();
      const revision = tickets.get(ticket);
      if (revision === undefined) throw new Error('The guide preview expired. Preview it again.');
      admitMutation(ticket);
      try {
        const result = await nativeGuide.commitAndMatch(ticket, revision);
        if (
          !result ||
          !Number.isSafeInteger(result.sourceRevision) ||
          result.sourceRevision <= revision ||
          ![result.matched, result.unmatched, result.preservedMappings].every(
            (count) => Number.isSafeInteger(count) && count >= 0,
          )
        )
          throw new Error('The program guide save receipt is invalid.');
        tickets.delete(ticket);
        options.onChanged?.();
        return {
          committed: true,
          matched: result.matched,
          unmatched: result.unmatched,
        };
      } finally {
        mutations.delete(ticket);
      }
    },
    commitMatchedPreview: async (
      ticket,
      expectedGuideRevision,
      expectedCatalogRevision,
      signal,
      aliases,
    ) => {
      signal.throwIfAborted();
      const revision = tickets.get(ticket);
      if (revision === undefined) throw new Error('The guide preview expired. Preview it again.');
      if (revision !== expectedGuideRevision)
        throw new Error('The guide preview revision changed. Preview it again.');
      admitMutation(ticket);
      try {
        const result = await nativeGuide.commitIfMatched(
          ticket,
          revision,
          expectedCatalogRevision,
          aliases,
        );
        if (
          !result ||
          typeof result.committed !== 'boolean' ||
          ![result.matched, result.unmatched].every(
            (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100_000,
          ) ||
          (!result.committed && result.matched !== 0)
        )
          throw new Error('The automatic program guide receipt is invalid.');
        // Both outcomes consume the native ticket; a durable receipt wins a late abort.
        tickets.delete(ticket);
        if (result.committed) options.onChanged?.();
        return {
          committed: result.committed,
          matched: result.matched,
          unmatched: result.unmatched,
        };
      } finally {
        mutations.delete(ticket);
      }
    },
    discardPreview: async (ticket) => {
      admitMutation(ticket);
      try {
        await nativeGuide.discard(ticket);
        tickets.delete(ticket);
        pendingProposedDiscards.delete(ticket);
      } finally {
        mutations.delete(ticket);
      }
    },
    removeSource: async (sourceId, signal) => {
      const sources = await read(signal, nativeGuide.sources);
      const source = sources.find((entry) => entry.id === sourceId);
      if (!source) return;
      signal.throwIfAborted();
      await nativeGuide.removeSource(source.id, source.revision);
      options.onChanged?.();
    },
    mapAndHydrate: (mapping, signal, saved) =>
      mapGuideAndHydrate(mappedHydration, mapping, signal, saved),
    settleMappingHydration: () => mappedHydration.settle(),
    setMapping: async (mapping, signal) => {
      signal.throwIfAborted();
      await nativeGuide.saveMapping(mapping);
      options.onChanged?.();
    },
    pickFile: async (signal) => {
      const file = await pickGuideFile(signal);
      if (!file) return null;
      if (file.size > 20 * 1024 * 1024) throw new Error('Guide input exceeds the 20 MiB limit.');
      const location = crypto.randomUUID();
      picked.clear();
      picked.set(location, file);
      return { name: file.name, location };
    },
  };
}
