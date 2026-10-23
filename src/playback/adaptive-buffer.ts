/**
 * Live rebuffering that adapts to the stream. After a stall, playback waits
 * until `target` seconds are buffered ahead instead of resuming on the first
 * frame (which stalls again a moment later: the stop-start "jitter"). Each
 * stall raises the target, and it stays there once the stream plays smoothly:
 * it never steps back down, which could bring the stalls back (owner decision,
 * October 18, 2026). The viewer's buffer choice is the starting point.
 */
export type LiveBufferProfile = 'fast' | 'balanced' | 'smooth';

/** Never more than this behind live; bounds memory on small TVs as well. */
export const ADAPTIVE_MAX_SECONDS = 20;
const FLOOR: Record<LiveBufferProfile, number> = { fast: 1, balanced: 3, smooth: 6 };
const RAISE = 1.6;
/** A hold ends by itself well inside the player's 20-second buffering deadline. */
const HOLD_LIMIT_MS = 12_000;

/** A level this channel already reached (a reconnect keeps it; never lower). */
export function createAdaptiveBuffer(profile: LiveBufferProfile, learned = 0) {
  const floor = FLOOR[profile] ?? FLOOR.balanced;
  let target = Math.min(ADAPTIVE_MAX_SECONDS, Math.max(floor, learned));
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    get target(): number {
      return target;
    },
    holdLimitMs: HOLD_LIMIT_MS,
    /** A stall: ask for more video from now on. */
    stalled(): number {
      target = round(Math.min(ADAPTIVE_MAX_SECONDS, Math.max(target * RAISE, target + 2)));
      return target;
    },
    ready(aheadSeconds: number): boolean {
      return aheadSeconds >= target;
    },
  };
}

const LEARNED_LIMIT = 64;
const learned = new Map<string, number>();
/** The level each live channel reached in this run of GenX (bounded). */
export const learnedLiveBuffer = {
  get(channel: string): number {
    return learned.get(channel) ?? 0;
  },
  set(channel: string, seconds: number): void {
    learned.delete(channel);
    learned.set(channel, seconds);
    while (learned.size > LEARNED_LIMIT) learned.delete(learned.keys().next().value as string);
  },
};
