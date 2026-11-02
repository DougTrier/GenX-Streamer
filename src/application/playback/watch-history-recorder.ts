/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import type { ChannelSelection, DecodedPlaybackObservation } from '../../playback/controller-model';
import { getWatchHistory, type WatchHistoryScope } from '../../playback/watch-history';

interface DecodedHistoryPlayer {
  readonly liveBufferGeneration: number;
  subscribeDecoded(listener: (observation: DecodedPlaybackObservation) => void): () => void;
  isDecodedCurrent(observation: DecodedPlaybackObservation): boolean;
}
interface History {
  load(): Promise<void>;
  record(scope: WatchHistoryScope, id: string): Promise<void>;
  settle(): Promise<void>;
}

/** A successful decoded session, once per selection; scans and failed tunes never enter history. */
export function createWatchHistoryRecorder(
  player: DecodedHistoryPlayer,
  history: History = getWatchHistory(),
  failed: () => void = () => {},
  admitted: (selection: Readonly<ChannelSelection>) => boolean = () => true,
) {
  let disposed = false;
  let marked: string | null = null;
  const pending = new Set<Promise<void>>();
  const unsubscribe = player.subscribeDecoded((observation) => {
    const selection = observation.selection;
    if (
      disposed ||
      !player.isDecodedCurrent(observation) ||
      selection.playMode === 'on-demand' ||
      !admitted(selection)
    )
      return;
    const paid = /^account-([a-f0-9]{32})-[a-f0-9]{64}$/.exec(selection.id);
    if (!paid && (selection.id.startsWith('account-') || selection.id.startsWith('archive-')))
      return;
    const scope: WatchHistoryScope = paid ? { kind: 'paid', accountId: paid[1] } : { kind: 'free' };
    const generation = player.liveBufferGeneration;
    const token = JSON.stringify([generation, scope, selection.id]);
    if (marked === token) return;
    marked = token;
    const current = () =>
      !disposed &&
      player.liveBufferGeneration === generation &&
      player.isDecodedCurrent(observation) &&
      admitted(selection);
    const work = (async () => {
      try {
        await history.load();
        if (!current()) {
          if (marked === token) marked = null;
          return;
        }
        await history.record(scope, selection.id);
      } catch {
        if (current()) failed();
      }
    })();
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  });
  return {
    async dispose() {
      disposed = true;
      unsubscribe();
      await Promise.allSettled([...pending]);
      await history.settle();
    },
  };
}
