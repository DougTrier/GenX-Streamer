import { validGuideInstant } from './time';
import { guideCategoryKey, validateGuideCategories, type GuideCategory } from './categories';
export interface GuideProgram {
  guideSourceId: string;
  channelId: string;
  startMs: number;
  stopMs: number | null;
  title: string;
  description?: string;
  categories?: GuideCategory[];
}
export interface GuideQuery {
  guideSourceId: string;
  channelId: string;
  nowMs: number;
  windowStartMs: number;
  windowEndMs: number;
}
export interface GuideQueryResult {
  current: GuideProgram | null;
  currentStatus: 'current' | 'overlap' | 'unknown-end' | 'gap' | 'empty';
  next: GuideProgram | null;
  nextStatus: 'next' | 'overlap' | 'none';
  upcoming: GuideProgram[];
  conflicts: GuideProgram[];
  unknownEnds: GuideProgram[];
}
const key = (p: GuideProgram) =>
  JSON.stringify([
    p.guideSourceId,
    p.channelId,
    p.startMs,
    p.stopMs,
    p.title,
    p.description ?? null,
    guideCategoryKey(p.categories),
  ]);
const compare = (a: GuideProgram, b: GuideProgram) =>
  a.startMs - b.startMs ||
  (a.stopMs ?? Infinity) - (b.stopMs ?? Infinity) ||
  (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
  (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
function validateProgram(p: GuideProgram): void {
  validateGuideCategories(p?.categories);
  if (
    !p ||
    typeof p.guideSourceId !== 'string' ||
    !p.guideSourceId ||
    p.guideSourceId.length > 256 ||
    typeof p.channelId !== 'string' ||
    !p.channelId ||
    p.channelId.length > 16384 ||
    !validGuideInstant(p.startMs) ||
    (p.stopMs !== null && (!validGuideInstant(p.stopMs) || p.stopMs <= p.startMs)) ||
    typeof p.title !== 'string' ||
    !p.title ||
    p.title.length > 16384 ||
    (p.description !== undefined &&
      (typeof p.description !== 'string' || p.description.length > 65536))
  )
    throw new Error('A guide program is invalid. The schedule was not queried.');
}
/** Pure deterministic full-domain query. Call off-thread for large imported feeds; this is not SQL paging. */
export function queryGuide(programs: readonly GuideProgram[], query: GuideQuery): GuideQueryResult {
  if (
    typeof query.guideSourceId !== 'string' ||
    !query.guideSourceId ||
    query.guideSourceId.length > 256 ||
    typeof query.channelId !== 'string' ||
    !query.channelId ||
    query.channelId.length > 16384 ||
    ![query.nowMs, query.windowStartMs, query.windowEndMs].every(validGuideInstant) ||
    query.windowEndMs <= query.windowStartMs
  )
    throw new Error('The guide query scope or time window is invalid.');
  if (programs.length > 500000) throw new Error('The guide program limit was exceeded.');
  const unique = new Map<string, GuideProgram>();
  for (const p of programs) {
    validateProgram(p);
    if (
      p.guideSourceId === query.guideSourceId &&
      p.channelId === query.channelId &&
      !unique.has(key(p))
    )
      unique.set(key(p), { ...p });
  }
  const ordered = [...unique.values()].sort(compare);
  const started = ordered.filter((p) => p.startMs <= query.nowMs);
  const currentKnown = started.filter((p) => p.stopMs !== null && query.nowMs < p.stopMs);
  // Missing stops stay unknown. Once another program starts, earlier unknown-end entries are historical.
  const latestStart = started.at(-1)?.startMs;
  const currentUnknown = started.filter((p) => p.stopMs === null && p.startMs === latestStart);
  const possible = [...currentKnown, ...currentUnknown].sort(compare);
  const overlap = possible.length > 1;
  const current = possible.length === 1 && possible[0].stopMs !== null ? possible[0] : null;
  const currentStatus: GuideQueryResult['currentStatus'] = overlap
    ? 'overlap'
    : current
      ? 'current'
      : currentUnknown.length
        ? 'unknown-end'
        : ordered.length
          ? 'gap'
          : 'empty';
  const future = ordered.filter((p) => p.startMs > query.nowMs);
  const nextGroup = future.filter((p) => p.startMs === future[0]?.startMs);
  const next = nextGroup.length === 1 ? nextGroup[0] : null;
  const nextStatus: GuideQueryResult['nextStatus'] =
    nextGroup.length > 1 ? 'overlap' : next ? 'next' : 'none';
  const visible = ordered.filter(
    (p) =>
      p.startMs < query.windowEndMs &&
      (p.stopMs === null ? p.startMs >= query.windowStartMs : p.stopMs > query.windowStartMs),
  );
  const conflicts = new Map<string, GuideProgram>();
  const mark = (p: GuideProgram) => conflicts.set(key(p), p);
  if (overlap) possible.forEach(mark);
  if (nextGroup.length > 1) nextGroup.forEach(mark);
  // A sweep detects every known-interval overlap without a quadratic pairwise walk.
  let longest: GuideProgram | null = null;
  for (const p of visible) {
    if (p.stopMs === null) continue;
    if (longest && p.startMs < longest.stopMs!) {
      mark(longest);
      mark(p);
    }
    if (!longest || p.stopMs > longest.stopMs!) longest = p;
  }
  return {
    current,
    currentStatus,
    next,
    nextStatus,
    upcoming: visible.filter((p) => p.startMs > query.nowMs),
    conflicts: [...conflicts.values()].sort(compare),
    unknownEnds: visible.filter((p) => p.stopMs === null),
  };
}
