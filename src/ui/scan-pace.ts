/**
 * Scan pace for the scan panel (owner request, October 21, 2026): checks per
 * minute over the last two minutes, and the time left at that pace. A new run
 * (another generation or total) starts over; until 30 seconds of progress are
 * seen the pace is not known yet.
 */
export interface ScanPace {
  perMinute: number | null;
  leftMs: number | null;
}
export function createScanPace(now: () => number = Date.now, windowMs = 120_000) {
  let run = '';
  let samples: { t: number; checked: number }[] = [];
  return {
    sample(runKey: string, checked: number, total: number): ScanPace {
      const t = now();
      if (runKey !== run) {
        run = runKey;
        samples = [];
      }
      const last = samples.at(-1);
      if (!last || checked !== last.checked) samples.push({ t, checked });
      while (samples.length > 1 && t - samples[1]!.t >= windowMs) samples.shift();
      const first = samples[0]!;
      const span = t - first.t;
      const done = checked - first.checked;
      if (span < 30_000 || done <= 0) return { perMinute: null, leftMs: null };
      const perMs = done / span;
      return {
        perMinute: Math.round(perMs * 60_000),
        leftMs: Math.max(0, (total - checked) / perMs),
      };
    },
  };
}
/** "about 2 h 30 min left", "about 12 min left", "under a minute left". */
export function timeLeftText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}
