export interface ProgramCountdown {
  kind: 'starts-in' | 'scheduled-now' | 'ended' | 'unknown';
  text: string;
}

/** Schedule time is an instant, independent of local zone and decoder state. */
export function programCountdown(
  startMs: number | null,
  stopMs: number | null,
  nowMs: number,
): ProgramCountdown {
  if (
    startMs === null ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(nowMs) ||
    Math.abs(startMs) > 8.64e15 ||
    Math.abs(nowMs) > 8.64e15 ||
    (stopMs !== null &&
      (!Number.isSafeInteger(stopMs) || stopMs <= startMs || Math.abs(stopMs) > 8.64e15))
  )
    return { kind: 'unknown', text: 'Schedule time unavailable.' };
  if (nowMs < startMs) {
    const seconds = Math.ceil((startMs - nowMs) / 1000);
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const remaining =
      seconds < 60
        ? `${seconds}s`
        : days
          ? `${days}d ${hours % 24}h ${minutes % 60}m`
          : hours
            ? `${hours}h ${minutes % 60}m`
            : `${minutes}m`;
    return { kind: 'starts-in', text: `Starts in ${remaining}` };
  }
  if (stopMs !== null && nowMs >= stopMs) return { kind: 'ended', text: 'Ended' };
  return {
    kind: 'scheduled-now',
    text: stopMs === null ? 'Scheduled start passed · End unknown' : 'Scheduled now',
  };
}
