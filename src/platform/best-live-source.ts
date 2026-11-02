// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { invoke } from '@tauri-apps/api/core';
import type { Channel } from '../catalog';
import type { ChannelSelection } from '../playback/controller-model';

interface Reply {
  channelId: string;
  catalogRevision: string;
  validUntilMs: number | null;
  candidates: string[];
}
export function createBestLiveSource(options: {
  channels(): readonly Channel[];
  revision(): string;
  rank(candidates: readonly ChannelSelection[]): ChannelSelection[];
  now?(): number;
  query?(channelId: string, catalogRevision: string): Promise<Reply>;
  unavailable?(): void;
  observed?(facts: { candidateCount: number; sourceChanged: boolean; available: boolean }): void;
}) {
  const query =
    options.query ??
    ((channelId, catalogRevision) =>
      invoke<Reply>('equivalent_live_channels', { query: { channelId, catalogRevision } }));
  return async (selection: ChannelSelection): Promise<ChannelSelection> => {
    if (
      selection.playMode === 'on-demand' ||
      !options.channels().some((c) => c.id === selection.id)
    )
      return selection;
    const revision = options.revision();
    let reply: Reply;
    try {
      reply = await query(selection.id, revision);
      if (
        !reply ||
        reply.channelId !== selection.id ||
        reply.catalogRevision !== revision ||
        !Array.isArray(reply.candidates) ||
        reply.candidates.length < 1 ||
        reply.candidates.length > 16 ||
        reply.candidates[0] !== selection.id ||
        new Set(reply.candidates).size !== reply.candidates.length ||
        reply.candidates.some((id) => typeof id !== 'string' || !id || id.length > 16384)
      )
        throw Error('Invalid equivalent feed set.');
    } catch {
      options.unavailable?.();
      options.observed?.({ candidateCount: 0, sourceChanged: false, available: false });
      return selection;
    }
    if (options.revision() !== revision) return selection;
    const now = (options.now ?? Date.now)();
    if (
      !Number.isSafeInteger(reply.validUntilMs) ||
      reply.validUntilMs! <= now + 10_000 ||
      reply.validUntilMs! > now + 12 * 60 * 60_000
    ) {
      options.observed?.({ candidateCount: 0, sourceChanged: false, available: false });
      return selection;
    }
    const candidates: ChannelSelection[] = [];
    const wanted = new Set(reply.candidates);
    const available = new Map(
      options
        .channels()
        .filter((c) => wanted.has(c.id))
        .map((c) => [c.id, c]),
    );
    const endpointsSeen = new Set<string>();
    for (const id of reply.candidates) {
      const row = available.get(id);
      if (!row?.urls.length) continue;
      // Each source's own endpoints are ranked before comparing equivalent rows.
      const ordered =
        row.id === selection.id
          ? [selection.url, ...row.urls.filter((url) => url !== selection.url)]
          : row.urls;
      const endpoints = ordered
        .filter((url) => row.urls.includes(url) && !endpointsSeen.has(url))
        .slice(0, 16)
        .map((url) => ({
          id: row.id,
          name: row.name,
          url,
          ...(selection.buffer ? { buffer: selection.buffer } : {}),
        }));
      const best = options.rank(endpoints)[0];
      if (best) {
        candidates.push(best);
        for (const url of row.urls) endpointsSeen.add(url);
      }
    }
    const selected = candidates.length ? (options.rank(candidates)[0] ?? selection) : selection;
    options.observed?.({
      candidateCount: candidates.length,
      sourceChanged: selected.id !== selection.id || selected.url !== selection.url,
      available: true,
    });
    return selected;
  };
}
