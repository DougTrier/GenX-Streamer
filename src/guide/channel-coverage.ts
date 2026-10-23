/** Native per-channel interval coverage: structure and UTC duration, never programme accuracy. */
export interface ChannelCoverageRequest {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly xmltvChannelId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly expectedSourceRevision: number;
  readonly expectedPublishedRevision: number;
}
export interface ChannelCoverageGap {
  readonly startMs: number;
  readonly endMs: number;
}
export interface ChannelCoverageReply {
  readonly schemaVersion: 1;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: 'assessed' | 'not-assessed';
  readonly reason: null | 'source-missing' | 'source-stale' | 'channel-missing' | 'work-limit';
  readonly sourceRevision: number | null;
  readonly publishedRevision: number | null;
  readonly coveredMs: number | null;
  readonly gapCount: number | null;
  readonly unknownEndCount: number | null;
  readonly gaps: readonly ChannelCoverageGap[];
  readonly gapsComplete: boolean;
}
const WEEK = 7 * 24 * 60 * 60 * 1000;
const invalid = (): never => {
  throw new Error('Program guide interval coverage is invalid.');
};
function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const names = Reflect.ownKeys(raw);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    return invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor)) return invalid();
  }
  return raw as Record<string, unknown>;
}
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const instant = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= -62135647200000 &&
  (value as number) <= 253402351200000;
const id = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !/\p{Cc}/u.test(value) &&
  new TextEncoder().encode(value).length <= max;
export function validateChannelCoverageRequest(raw: unknown): ChannelCoverageRequest {
  const v = record(raw, [
    'schemaVersion',
    'sourceId',
    'xmltvChannelId',
    'startMs',
    'endMs',
    'expectedSourceRevision',
    'expectedPublishedRevision',
  ]);
  if (
    v.schemaVersion !== 1 ||
    !id(v.sourceId, 256) ||
    !id(v.xmltvChannelId, 16384) ||
    !instant(v.startMs) ||
    !instant(v.endMs) ||
    v.endMs <= v.startMs ||
    v.endMs - v.startMs > WEEK ||
    !integer(v.expectedSourceRevision) ||
    !integer(v.expectedPublishedRevision)
  )
    return invalid();
  return Object.freeze({
    schemaVersion: 1,
    sourceId: v.sourceId,
    xmltvChannelId: v.xmltvChannelId,
    startMs: v.startMs,
    endMs: v.endMs,
    expectedSourceRevision: v.expectedSourceRevision,
    expectedPublishedRevision: v.expectedPublishedRevision,
  });
}
export function validateChannelCoverageReply(
  raw: unknown,
  request: ChannelCoverageRequest,
): ChannelCoverageReply {
  const q = validateChannelCoverageRequest(request);
  const v = record(raw, [
    'schemaVersion',
    'startMs',
    'endMs',
    'status',
    'reason',
    'sourceRevision',
    'publishedRevision',
    'coveredMs',
    'gapCount',
    'unknownEndCount',
    'gaps',
    'gapsComplete',
  ]);
  if (
    v.schemaVersion !== 1 ||
    v.startMs !== q.startMs ||
    v.endMs !== q.endMs ||
    (v.status !== 'assessed' && v.status !== 'not-assessed') ||
    !(v.sourceRevision === null || integer(v.sourceRevision)) ||
    !(v.publishedRevision === null || integer(v.publishedRevision)) ||
    typeof v.gapsComplete !== 'boolean' ||
    !Array.isArray(v.gaps) ||
    Object.getPrototypeOf(v.gaps) !== Array.prototype ||
    v.gaps.length > 8 ||
    Reflect.ownKeys(v.gaps).length !== v.gaps.length + 1
  )
    return invalid();
  const gaps: ChannelCoverageGap[] = [];
  let sum = 0;
  for (let i = 0; i < v.gaps.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(v.gaps, i);
    if (!descriptor || !('value' in descriptor)) return invalid();
    const gap = record(descriptor.value, ['startMs', 'endMs']);
    if (
      !instant(gap.startMs) ||
      !instant(gap.endMs) ||
      gap.startMs < q.startMs ||
      gap.endMs > q.endMs ||
      gap.endMs <= gap.startMs ||
      (i > 0 && gap.startMs <= gaps[i - 1]!.endMs)
    )
      return invalid();
    sum += gap.endMs - gap.startMs;
    gaps.push(Object.freeze({ startMs: gap.startMs, endMs: gap.endMs }));
  }
  const exactRevisions =
    v.sourceRevision === q.expectedSourceRevision &&
    v.publishedRevision === q.expectedPublishedRevision &&
    v.sourceRevision === v.publishedRevision;
  if (v.status === 'not-assessed') {
    if (
      typeof v.reason !== 'string' ||
      !['source-missing', 'source-stale', 'channel-missing', 'work-limit'].includes(v.reason) ||
      v.coveredMs !== null ||
      v.gapCount !== null ||
      v.unknownEndCount !== null ||
      gaps.length !== 0 ||
      v.gapsComplete
    )
      return invalid();
    if (
      v.reason === 'source-missing'
        ? v.sourceRevision !== null || v.publishedRevision !== null
        : v.reason === 'source-stale'
          ? v.sourceRevision === null || exactRevisions
          : v.reason === 'work-limit'
            ? !exactRevisions && !(v.sourceRevision === null && v.publishedRevision === null)
            : !exactRevisions
    )
      return invalid();
  } else {
    const duration = q.endMs - q.startMs;
    if (
      v.reason !== null ||
      !exactRevisions ||
      !integer(v.coveredMs, duration) ||
      !integer(v.gapCount, 4097) ||
      !integer(v.unknownEndCount, 4096) ||
      v.gapCount > 4097 - v.unknownEndCount
    )
      return invalid();
    const missing = duration - v.coveredMs;
    if (
      (missing === 0) !== (v.gapCount === 0) ||
      v.gapCount > missing ||
      (v.coveredMs === 0 && v.gapCount !== 1) ||
      v.gapsComplete !== v.gapCount <= 8
    )
      return invalid();
    if (
      v.gapsComplete
        ? gaps.length !== v.gapCount || sum !== missing
        : gaps.length !== 8 || sum >= missing || v.gapCount - gaps.length > missing - sum
    )
      return invalid();
  }
  return Object.freeze({ ...v, gaps: Object.freeze(gaps) }) as unknown as ChannelCoverageReply;
}
