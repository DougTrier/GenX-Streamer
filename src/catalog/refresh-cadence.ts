export const REFRESH_CADENCES = [
  'off',
  'hourly',
  'every6hours',
  'daily',
  'weekly',
  'every2weeks',
  'monthly',
] as const;
export type RefreshCadence = (typeof REFRESH_CADENCES)[number];
export const REFRESH_TIMER_MAX_MS = 86_400_000;
const FIXED: Partial<Record<RefreshCadence, number>> = {
  hourly: 3_600_000,
  every6hours: 21_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  every2weeks: 1_209_600_000,
};
export function validateRefreshCadence(value: unknown): RefreshCadence {
  if (typeof value !== 'string' || !(REFRESH_CADENCES as readonly string[]).includes(value))
    throw new Error('Invalid refresh cadence.');
  return value as RefreshCadence;
}
export function migrateRefreshCadence(value: unknown, legacy: unknown): RefreshCadence {
  if (legacy !== undefined && typeof legacy !== 'boolean')
    throw new Error('Invalid automatic refresh preference.');
  return value === undefined ? (legacy === true ? 'daily' : 'off') : validateRefreshCadence(value);
}
/** Calendar arithmetic is UTC, based on the last actual persisted attempt. */
export function nextRefreshAt(last: number, cadence: RefreshCadence): number {
  validateRefreshCadence(cadence);
  if (!Number.isSafeInteger(last) || last < 0 || last > 8_640_000_000_000_000)
    throw new Error('Invalid refresh attempt.');
  if (cadence === 'off') return Number.POSITIVE_INFINITY;
  if (last === 0) return 0;
  if (cadence !== 'monthly') return last + FIXED[cadence]!;
  const date = new Date(last);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  if (!Number.isFinite(date.getTime())) return Number.POSITIVE_INFINITY;
  const end = new Date(date.getTime());
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.POSITIVE_INFINITY;
}
export function refreshDueIn(last: number, cadence: RefreshCadence, now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid refresh clock.');
  return Math.max(0, nextRefreshAt(last, cadence) - now);
}
