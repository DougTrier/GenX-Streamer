// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
export interface SourcePerformance {
  decodedMs: number;
  stalls: number;
  stalledMs: number;
  failures: number;
  audioObserved: boolean;
  pixels: number;
  fps: number;
  updatedMs: number;
}

/** Session-local/device-local evidence; no background requests or source merging.
 * Only an owner's already-confirmed equivalent candidate set may be ranked. */
export function createSourceQuality(now: () => number = () => performance.now()) {
  const entries = new Map<string, SourcePerformance>();
  const owners = new Map<string, object>();
  const ttl = 15 * 60_000;
  const read = (key: string): SourcePerformance | undefined => {
    const row = entries.get(key);
    if (row && (now() < row.updatedMs || now() - row.updatedMs > ttl)) {
      entries.delete(key);
      owners.delete(key);
      return undefined;
    }
    return row;
  };
  const open = (key: string) => {
    const row = read(key) ?? {
      decodedMs: 0,
      stalls: 0,
      stalledMs: 0,
      failures: 0,
      audioObserved: false,
      pixels: 0,
      fps: 0,
      updatedMs: now(),
    };
    entries.delete(key);
    entries.set(key, row);
    const owner = {};
    owners.set(key, owner);
    while (entries.size > 256) {
      const oldest = entries.keys().next().value!;
      entries.delete(oldest);
      owners.delete(oldest);
    }
    let closed = false,
      played = false,
      failed = false;
    let stalledAt: number | null = null;
    let lastDecodedAt = now();
    const current = () => !closed && entries.get(key) === row && owners.get(key) === owner;
    const endStall = () => {
      if (stalledAt !== null) {
        row.stalledMs += Math.max(0, Math.min(60_000, now() - stalledAt));
        stalledAt = null;
      }
    };
    return {
      progress() {
        if (!current()) return;
        const starting = !played || stalledAt !== null;
        endStall();
        played = true;
        row.updatedMs = now();
        if (starting) lastDecodedAt = now();
      },
      decoded(elapsedMs: number, width: number, height: number, frames: number, audio = false) {
        if (
          !current() ||
          !played ||
          stalledAt !== null ||
          !Number.isFinite(elapsedMs) ||
          elapsedMs <= 0 ||
          elapsedMs > 5000 ||
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          width > 32768 ||
          !Number.isSafeInteger(height) ||
          height <= 0 ||
          height > 32768 ||
          !Number.isSafeInteger(frames) ||
          frames <= 0
        )
          return;
        const credit = Math.min(elapsedMs, Math.max(0, now() - lastDecodedAt));
        if (credit <= 0) return;
        lastDecodedAt = now();
        const fps = Math.min(120, (frames * 1000) / elapsedMs);
        const weight = Math.min(row.decodedMs, 60_000);
        row.pixels = (row.pixels * weight + width * height * credit) / (weight + credit);
        row.fps = (row.fps * weight + fps * credit) / (weight + credit);
        row.decodedMs += credit;
        row.audioObserved ||= audio;
        row.updatedMs = now();
      },
      buffering() {
        if (!current() || !played || stalledAt !== null) return;
        stalledAt = now();
        row.stalls++;
        row.updatedMs = now();
      },
      failure() {
        if (!current() || failed) return;
        endStall();
        failed = true;
        row.failures++;
        row.updatedMs = now();
      },
      stop() {
        if (current()) {
          endStall();
          owners.delete(key);
        }
        closed = true;
      },
    };
  };
  const tier = (r: SourcePerformance | undefined) =>
    !r ? 1 : r.failures > 0 || r.stalls >= 2 ? 0 : r.decodedMs >= 60_000 && r.stalls === 0 ? 2 : 1;
  return {
    open,
    forget(key: string) {
      entries.delete(key);
      owners.delete(key);
    },
    rank(keys: readonly string[]): string[] {
      if (keys.length > 16 || new Set(keys).size !== keys.length)
        throw Error('Invalid equivalent source set.');
      return [...keys].sort((a, b) => {
        const aa = read(a),
          bb = read(b);
        const health = tier(bb) - tier(aa);
        if (health) return health;
        // Unknown evidence never invents a quality advantage.
        if (!aa || !bb || tier(aa) !== 2) return 0;
        return (
          Number(bb.audioObserved) - Number(aa.audioObserved) ||
          bb.pixels - aa.pixels ||
          bb.fps - aa.fps
        );
      });
    },
    facts(key: string): Readonly<SourcePerformance> | null {
      const row = read(key);
      return row ? { ...row } : null;
    },
  };
}

/** Transient exact endpoint identity, never persisted or put in diagnostic exports. */
export const sourcePerformanceKey = (selection: {
  id: string;
  url: string;
  performanceKey?: string;
}): string => selection.performanceKey ?? JSON.stringify(['public', selection.url]);
