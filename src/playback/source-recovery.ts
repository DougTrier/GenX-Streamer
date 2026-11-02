// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { PlaybackSnapshot } from './controller-model';
import { sourcePerformanceKey } from './source-quality';
/** Two genuine mid-play stalls in a minute may try another admitted feed.
 * No timers, probes, or changes while a stream plays smoothly. */
export function createSourceRecoveryWindow(now: () => number = () => performance.now()) {
  let identity = '',
    lastState = '',
    played = false;
  let stalls: number[] = [];
  return (snapshot: PlaybackSnapshot, eligible: boolean): boolean => {
    const key = snapshot.selection ? sourcePerformanceKey(snapshot.selection) : '';
    if (key !== identity || ['idle', 'paused', 'connecting', 'disposed'].includes(snapshot.state)) {
      identity = key;
      played = false;
      stalls = [];
    }
    const changed = lastState !== snapshot.state;
    lastState = snapshot.state;
    if (!eligible) {
      played = false;
      stalls = [];
      return false;
    }
    if (snapshot.state === 'playing') played = true;
    if (
      !eligible ||
      !played ||
      !changed ||
      snapshot.state !== 'buffering' ||
      snapshot.selection?.playMode === 'on-demand'
    )
      return false;
    const at = now();
    stalls = stalls.filter((t) => at >= t && at - t <= 60_000).slice(-19);
    stalls.push(at);
    return stalls.length >= 2;
  };
}
