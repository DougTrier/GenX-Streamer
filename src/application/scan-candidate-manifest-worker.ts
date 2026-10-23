import {
  MAX_SCAN_CHECKPOINT_BYTES,
  type PackedScanCheckpoint,
  createScanCandidateManifestDecoder,
  MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
  type ScanCandidateManifestEntry,
} from '../discovery/scan-checkpoint';
import { boundedUtf8Text } from '../platform/bounded-text';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import type { ScanReview } from '../discovery/scan';
/** Isolated worker input; URLs and the complete review never appear in progress replies. */
export async function createOwnedManifestActor(
  checkpoint: string,
  review: ScanReview | undefined,
  signal: AbortSignal,
  capture = false,
) {
  if (!boundedUtf8Text(checkpoint, MAX_SCAN_CHECKPOINT_BYTES))
    throw new Error('Scan manifest checkpoint is invalid.');
  const packed = JSON.parse(checkpoint) as PackedScanCheckpoint;
  signal.throwIfAborted();
  const decoder = await createScanCandidateManifestDecoder(packed, signal);
  if (
    review &&
    (!Array.isArray(review.candidates) ||
      review.candidates.length !== decoder.candidateCount ||
      review.candidates.length > 100000 ||
      review.sessionRevision !== packed.review.sessionRevision ||
      review.query !== packed.review.query)
  )
    throw new Error('Scan manifest input is invalid.');
  let cursor = 0,
    active = false,
    closed = false;
  return {
    info: {
      jobId: decoder.jobId,
      reviewDigest: decoder.reviewDigest,
      candidateCount: decoder.candidateCount,
      sessionRevision: packed.review.sessionRevision,
      query: packed.review.query,
    },
    async next() {
      signal.throwIfAborted();
      if (!review || closed || active) throw new Error('Scan manifest capture is unavailable.');
      active = true;
      try {
        const entries: ScanCandidateManifestEntry[] = [];
        let bytes = 2;
        while (cursor + entries.length < review.candidates.length && entries.length < 64) {
          const index = cursor + entries.length;
          const candidate = review.candidates[index];
          const row = { candidateIndex: index, urls: [...candidate.channel.urls] };
          const size = boundedJsonUtf8Bytes(
            row,
            MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES - 2048,
            signal,
          );
          if (
            bytes + size + (entries.length ? 1 : 0) >
            MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES - 2048
          )
            break;
          bytes += size + (entries.length ? 1 : 0);
          entries.push(row);
        }
        if (!entries.length) {
          decoder.complete();
          return null;
        }
        await decoder.append(entries, {
          original: review.candidates.slice(cursor, cursor + entries.length),
          signal,
        });
        cursor += entries.length;
        signal.throwIfAborted();
        return entries;
      } finally {
        active = false;
      }
    },
    async append(
      entries: ScanCandidateManifestEntry[],
      identities?: Pick<
        ScanReview['candidates'][number],
        'key' | 'sourceId' | 'sourceFingerprint' | 'sessionRevision'
      >[],
    ) {
      signal.throwIfAborted();
      if (review || closed || active || (capture && !identities))
        throw new Error('Scan manifest restoration is unavailable.');
      active = true;
      try {
        return await decoder.append(entries, { retain: !capture, identities, signal });
      } finally {
        active = false;
      }
    },
    async finish() {
      signal.throwIfAborted();
      if (review || closed || active) throw new Error('Scan manifest restoration is unavailable.');
      if (capture) {
        decoder.complete();
        return;
      }
      return decoder.finish();
    },
    dispose() {
      closed = true;
      decoder.dispose();
    },
  };
}
export interface ManifestWorkerCommand {
  id: number;
  operation: 'capture-init' | 'restore-init' | 'next' | 'append' | 'finish' | 'cancel' | 'dispose';
  checkpoint?: string;
  review?: ScanReview;
  entries?: ScanCandidateManifestEntry[];
  identities?: Pick<
    ScanReview['candidates'][number],
    'key' | 'sourceId' | 'sourceFingerprint' | 'sessionRevision'
  >[];
}
export interface ManifestWorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  canceled?: boolean;
}
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  let actor: Awaited<ReturnType<typeof createOwnedManifestActor>> | null = null;
  const controller = new AbortController();
  let active: Promise<unknown> | null = null;
  let closing = false;
  const reply = (id: number, ok: boolean, value?: unknown, canceled = false) =>
    self.postMessage({
      id,
      ok,
      ...(value === undefined ? {} : { value }),
      ...(canceled ? { canceled: true } : {}),
    });
  self.onmessage = (event: MessageEvent<ManifestWorkerCommand>) => {
    const m = event.data;
    if (m.operation === 'cancel') {
      controller.abort();
      return;
    }
    if (m.operation === 'dispose') {
      closing = true;
      controller.abort();
      const join = (async () => {
        await Promise.allSettled([active]);
        actor?.dispose();
        actor = null;
        reply(m.id, true);
      })();
      void join.catch(() => reply(m.id, false));
      return;
    }
    const job = (async () => {
      if (closing || active) throw new Error('Scan manifest worker is busy.');
      if (m.operation === 'capture-init' || m.operation === 'restore-init') {
        if (actor || typeof m.checkpoint !== 'string')
          throw new Error('Scan manifest initialization refused.');
        actor = await createOwnedManifestActor(
          m.checkpoint,
          m.operation === 'capture-init' ? m.review : undefined,
          controller.signal,
          m.operation === 'capture-init',
        );
        return actor.info;
      }
      if (!actor) throw new Error('Scan manifest worker is unavailable.');
      if (m.operation === 'next') return actor.next();
      if (m.operation === 'append' && m.entries) return actor.append(m.entries, m.identities);
      if (m.operation === 'finish') return actor.finish();
      throw new Error('Scan manifest operation refused.');
    })();
    active = job;
    void job
      .then(
        (value) => reply(m.id, true, value),
        () => reply(m.id, false, undefined, controller.signal.aborted),
      )
      .finally(() => {
        if (active === job) active = null;
      });
  };
}
