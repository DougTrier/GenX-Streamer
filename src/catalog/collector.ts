import { MAX_CHANNELS, PlaylistError, type ChannelCandidate } from './parser';

function exactMetadata(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 32)
    throw new PlaylistError('metadata', 'Candidate metadata nesting exceeds the supported limit.');
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string' && value.length > 16_384)
    throw new PlaylistError(
      'metadata',
      'A candidate metadata field exceeds the supported size limit.',
    );
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value))
    return ['number', Object.is(value, -0) ? '-0' : value];
  if (typeof value !== 'object' || seen.has(value))
    throw new PlaylistError('metadata', 'Candidate metadata is not finite JSON data.');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return ['array', value.map((item) => exactMetadata(item, seen, depth + 1))];
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new PlaylistError('metadata', 'Candidate metadata must use plain records.');
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          exactMetadata((value as Record<string, unknown>)[key], seen, depth + 1),
        ]),
    ];
  } finally {
    seen.delete(value);
  }
}

/** Removes exact metadata/URL tuple repeats only; source identities never collapse. */
export function exactCandidateDedup<T extends ChannelCandidate>(candidates: readonly T[]): T[] {
  if (candidates.length > MAX_CHANNELS)
    throw new PlaylistError(
      'entries',
      'Collection exceeds the 100,000 candidate limit. Narrow the configured sources and retry.',
    );
  const output: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const tuple = JSON.stringify(exactMetadata(candidate));
    if (!seen.has(tuple)) {
      seen.add(tuple);
      output.push(candidate);
    }
  }
  return output;
}

export type SourceCollectionStatus = 'completed' | 'failed' | 'canceled';
export type SourceOperationResult<T> =
  { status: 'completed'; value: T; published?: boolean } | { status: 'canceled' };
export interface SourceCollectionResult<T> {
  sourceId: string;
  index: number;
  status: SourceCollectionStatus;
  value?: T;
  error?: string;
}
export interface CollectionProgress {
  sourceId: string;
  index: number;
  status: SourceCollectionStatus;
  settled: number;
  total: number;
}

/**
 * Every configured source has one ordered outcome. The operation owns its atomic
 * publication and closes readers/workers on abort. published:true is its durable
 * receipt; cancellation cannot undo or falsely hide an acknowledged publication.
 */
export async function collectSources<S extends { id: string }, T>(
  sources: readonly S[],
  operation: (source: S, signal: AbortSignal) => Promise<SourceOperationResult<T>>,
  signal: AbortSignal,
  progress?: (event: CollectionProgress) => void,
): Promise<SourceCollectionResult<T>[]> {
  const configured = [...sources];
  const owned = new AbortController();
  const cancel = (): void => owned.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) owned.abort();
  const results: SourceCollectionResult<T>[] = configured.map((source, index) => ({
    sourceId: source.id,
    index,
    status: 'canceled',
  }));
  let cursor = 0;
  let settled = 0;
  async function worker(): Promise<void> {
    while (!owned.signal.aborted && cursor < configured.length) {
      const index = cursor++;
      const source = configured[index]!;
      let outcome: SourceCollectionResult<T>;
      try {
        const result = await operation(source, owned.signal);
        outcome =
          result.status === 'completed' && (!owned.signal.aborted || result.published === true)
            ? { sourceId: source.id, index, status: 'completed', value: result.value }
            : { sourceId: source.id, index, status: 'canceled' };
      } catch {
        outcome = {
          sourceId: source.id,
          index,
          status: owned.signal.aborted ? 'canceled' : 'failed',
          ...(owned.signal.aborted
            ? {}
            : {
                error:
                  'This source could not be collected. Its previous catalog was retained. Retry it later.',
              }),
        };
      }
      results[index] = outcome;
      settled++;
      if (!owned.signal.aborted) {
        try {
          progress?.({
            sourceId: source.id,
            index,
            status: outcome.status,
            settled,
            total: configured.length,
          });
        } catch {
          owned.abort();
          throw new Error('Collection progress handler failed.');
        }
      }
    }
  }
  try {
    // allSettled waits for every owned task even if a presentation callback throws.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, configured.length) }, () => worker()),
    );
    if (workers.some((result) => result.status === 'rejected'))
      throw new Error('Collection progress handler failed after resource cleanup.');
    return results;
  } finally {
    signal.removeEventListener('abort', cancel);
    owned.abort();
  }
}
