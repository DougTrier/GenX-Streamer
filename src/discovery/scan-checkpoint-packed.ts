/** Packed wire codec. Production emission requires the native packed-reference capability. */
import type { ReferencedScanCheckpoint } from './scan-checkpoint';
import type { GeographyProvenance } from '../catalog/geography';
export const PACKED_CHECKPOINT_LIMIT = 20 * 1024 * 1024;
type Slot<T> = [] | [T];
type ProvenanceTuple = [number, string, Slot<string>, number, number];
export type PackedCandidate = [
  string,
  number,
  Slot<string>,
  string,
  number,
  Slot<Slot<string>[]>,
  Slot<ProvenanceTuple[]>,
  string,
  string[],
];
export interface PackedScanCheckpoint extends Omit<
  ReferencedScanCheckpoint,
  'schemaVersion' | 'review' | 'observations' | 'publishedKeys'
> {
  schemaVersion: 3;
  categoryTable: string[];
  review: Omit<ReferencedScanCheckpoint['review'], 'candidates'> & {
    candidates: PackedCandidate[];
  };
  observations: [
    number,
    number,
    string,
    ReferencedScanCheckpoint['observations'][number]['evidence'],
  ][];
  publishedIndices: number[];
}
export class PackedCheckpointSizeError extends Error {
  constructor() {
    super('Scan checkpoint exceeds the 20 MiB limit.');
  }
}
const fields = ['country', 'region', 'state'] as const;
const kinds = ['provider', 'm3u', 'registry', 'user'] as const;
const scopes = ['channel-origin', 'provider-declared', 'country-group', 'user-reviewed'] as const;
function invalid(): never {
  throw new Error('Scan checkpoint is invalid or cannot safely resume.');
}
const slot = <T>(value: T | undefined): Slot<T> => (value === undefined ? [] : [value]);
function plainArray(value: unknown): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertySymbols(value).length
  )
    invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) invalid();
  }
}
function unSlot<T>(value: unknown): T | undefined {
  plainArray(value);
  if (value.length > 1 || (value.length === 1 && value[0] == null)) invalid();
  return value[0] as T | undefined;
}
function index(value: unknown, length: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length)
    invalid();
  return value as number;
}
function tuple(value: unknown, length: number): unknown[] {
  plainArray(value);
  if (value.length !== length) invalid();
  return value;
}
function candidateTuple(
  c: ReferencedScanCheckpoint['review']['candidates'][number],
  source: number,
  category: number,
): PackedCandidate {
  return [
    c.key,
    source,
    slot(c.channel.providerId),
    c.channel.name,
    category,
    slot(
      c.channel.geography === undefined
        ? undefined
        : fields.map((f) => slot(c.channel.geography![f])),
    ),
    slot(
      c.channel.geographyProvenance?.map((p) => [
        fields.indexOf(p.field),
        p.value,
        slot(p.providerId),
        kinds.indexOf(p.kind),
        scopes.indexOf(p.scope),
      ]),
    ),
    packedHash(c.reference.candidateDigest),
    c.reference.urlHashes.map(packedHash),
  ];
}
/** JSON-value equality for small admitted metadata/tuples; object order is immaterial. */
function canonicalEqual(left: unknown, right: unknown, depth = 0): void {
  if (depth > 32) invalid();
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    if (left !== right) invalid();
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length ||
      Object.getPrototypeOf(left) !== Array.prototype ||
      Object.keys(left).length !== left.length ||
      Object.getOwnPropertySymbols(left).length
    )
      invalid();
    for (let index = 0; index < left.length; index++) {
      const item = Object.getOwnPropertyDescriptor(left, index);
      if (!item || !('value' in item)) invalid();
      canonicalEqual(item.value, right[index], depth + 1);
    }
    return;
  }
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(left)) ||
    Object.getOwnPropertySymbols(left).length
  )
    invalid();
  const keys = (value: object) =>
    Object.keys(value).filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) invalid();
      return descriptor.value !== undefined;
    });
  const l = keys(left),
    r = keys(right);
  if (l.length !== r.length) invalid();
  for (const key of l) {
    if (!r.includes(key)) invalid();
    canonicalEqual(
      Object.getOwnPropertyDescriptor(left, key)!.value,
      Object.getOwnPropertyDescriptor(right, key)!.value,
      depth + 1,
    );
  }
}
/** Assert the old re-encoding identity one bounded tuple at a time, without re-encoding the job. */
export function assertPackedCanonical(
  packed: PackedScanCheckpoint,
  semantic: ReferencedScanCheckpoint,
): PackedScanCheckpoint {
  const {
    schemaVersion: _packedVersion,
    categoryTable: _table,
    review,
    observations,
    publishedIndices,
    ...header
  } = packed;
  const {
    schemaVersion: _referenceVersion,
    review: referenceReview,
    observations: referenceObservations,
    publishedKeys,
    ...referenceHeader
  } = semantic;
  canonicalEqual(header, referenceHeader);
  const { candidates, ...reviewHeader } = review;
  const { candidates: referenceCandidates, ...referenceReviewHeader } = referenceReview;
  canonicalEqual(reviewHeader, referenceReviewHeader);
  if (
    candidates.length !== referenceCandidates.length ||
    observations.length !== referenceObservations.length ||
    publishedIndices.length !== publishedKeys.length
  )
    invalid();
  let canonicalCandidates = candidates;
  for (let index = 0; index < candidates.length; index++) {
    const row = candidates[index]!,
      c = referenceCandidates[index]!;
    const canonical = candidateTuple(c, row[1] === 0 ? 0 : row[1], row[4] === 0 ? 0 : row[4]);
    canonicalEqual(row, canonical);
    if (
      review.sources[row[1]]?.sourceId !== c.sourceId ||
      packed.categoryTable[row[4]] !== c.channel.category
    )
      invalid();
    // JSON -0 indices are admitted as zero by the historical encoder. Copy
    // only a noncanonical vector; ordinary captured jobs reuse their tuples.
    if (
      Object.is(row[1], -0) ||
      Object.is(row[4], -0) ||
      row[6][0]?.some((p) => [p[0], p[3], p[4]].some((i) => Object.is(i, -0)))
    ) {
      if (canonicalCandidates === candidates) canonicalCandidates = candidates.slice();
      canonicalCandidates[index] = canonical;
    }
  }
  let canonicalObservations = observations;
  for (let index = 0; index < observations.length; index++) {
    const row = observations[index]!,
      o = referenceObservations[index]!;
    if (candidates[row[0]]?.[0] !== o.channelId) invalid();
    canonicalEqual(row, [row[0], o.observedAt, o.verdict, o.evidence]);
    if (Object.is(row[0], -0)) {
      if (canonicalObservations === observations) canonicalObservations = observations.slice();
      canonicalObservations[index] = [0, o.observedAt, o.verdict, o.evidence];
    }
  }
  for (let index = 0; index < publishedIndices.length; index++)
    if (candidates[publishedIndices[index]!]?.[0] !== publishedKeys[index]) invalid();
  return {
    ...referenceHeader,
    schemaVersion: 3,
    categoryTable: packed.categoryTable,
    review: { ...referenceReviewHeader, candidates: canonicalCandidates },
    observations: canonicalObservations,
    publishedIndices: publishedIndices.some((i) => Object.is(i, -0))
      ? publishedIndices.map((i) => (i === 0 ? 0 : i))
      : publishedIndices,
  };
}
export function packedHash(hex: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hex)) invalid();
  return btoa(String.fromCharCode(...hex.match(/../gu)!.map((v) => parseInt(v, 16))))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}
export function expandedHash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(raw)) invalid();
  const hex = [...atob(raw.replace(/-/gu, '+').replace(/_/gu, '/') + '=')]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  if (packedHash(hex) !== raw) invalid();
  return hex;
}
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PACKED_CHECKPOINT_LIMIT)
    throw new PackedCheckpointSizeError();
}
/** Public raw callers cannot retain mutable aliases across asynchronous hashing.
 * Serialized/worker callers already own their parsed wire and need no extra copy. */
export function capturePackedWire(raw: unknown): unknown {
  // These limits exceed every supported header/evidence record. A candidate
  // has nine slots, at most three provenance rows and sixteen URL hashes.
  // Bound non-JSON omitted properties as work, independently of JSON bytes.
  const maxArrayLength = 100000,
    maxRecordKeys = 32,
    maxEdges = 12000000;
  const data = (value: object, key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    return descriptor.value;
  };
  const arrayBound = (value: unknown) => {
    if (Array.isArray(value) && value.length > maxArrayLength) invalid();
  };
  // Refuse oversized schema vectors before traversing unrelated header data.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['categoryTable', 'observations', 'publishedIndices', 'sourceDefinitions'])
      if (Object.hasOwn(raw, key)) arrayBound(data(raw, key));
    if (Object.hasOwn(raw, 'review')) {
      const review = data(raw, 'review');
      if (review && typeof review === 'object' && !Array.isArray(review))
        for (const key of ['candidates', 'sources'])
          if (Object.hasOwn(review, key)) arrayBound(data(review, key));
    }
  }
  let edges = 0;
  const visiting = new Set<object>();
  const preflight = (value: unknown, depth: number): void => {
    if (++edges > maxEdges || depth > 32) invalid();
    if (!value || typeof value !== 'object') return;
    if (visiting.has(value) || 'toJSON' in value || Object.getOwnPropertySymbols(value).length)
      invalid();
    const array = Array.isArray(value);
    if (array) {
      arrayBound(value);
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
    } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    visiting.add(value);
    // Collect at most 32 record keys, never materialize an unbounded key array.
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) invalid();
      if (array) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) invalid();
      } else if (count === maxRecordKeys) invalid();
      count++;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) invalid();
    }
    if (array && count !== value.length) invalid();
    for (const key in value) preflight(data(value, key), depth + 1);
    visiting.delete(value);
  };
  preflight(raw, 0);
  const encoder = new TextEncoder();
  const ancestors = new Set<object>();
  let bytes = 0;
  const add = (n: number) => {
    bytes += n;
    if (bytes > PACKED_CHECKPOINT_LIMIT) throw new PackedCheckpointSizeError();
  };
  const scalar = (value: string | number | boolean | null) => {
    if (typeof value === 'string' && value.length > PACKED_CHECKPOINT_LIMIT)
      throw new PackedCheckpointSizeError();
    add(encoder.encode(JSON.stringify(value)).byteLength);
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 32) invalid();
    if (value === undefined) {
      scalar(null);
      return undefined;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      scalar(value);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      scalar(value);
      return value;
    }
    if (
      typeof value !== 'object' ||
      ancestors.has(value) ||
      'toJSON' in value ||
      Object.getOwnPropertySymbols(value).length
    )
      invalid();
    ancestors.add(value);
    add(2);
    let result: object;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      let count = 0;
      for (const key in value) {
        if (
          !Object.hasOwn(value, key) ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        )
          invalid();
        count++;
      }
      if (count !== value.length) invalid();
      const rows: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) invalid();
        if (index) add(1);
        rows.push(copy(descriptor.value, depth + 1));
      }
      result = rows;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (![Object.prototype, null].includes(prototype)) invalid();
      const object: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      let first = true;
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) invalid();
        if (descriptor.value === undefined) {
          Object.defineProperty(object, key, {
            value: undefined,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          continue;
        }
        if (!first) add(1);
        first = false;
        scalar(key);
        add(1);
        Object.defineProperty(object, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(raw, 0);
}
export async function packedReviewDigest(
  value: Pick<PackedScanCheckpoint, 'categoryTable' | 'review'>,
): Promise<string> {
  const r = value.review;
  const text = JSON.stringify([
    'genx-scan-reference-v3',
    value.categoryTable,
    r.sessionRevision,
    r.query,
    r.status,
    r.sources.map((s) => [s.sourceId, s.fingerprint, s.status, s.inspected, s.matched, s.warnings]),
    [r.counts.inspected, r.counts.matched, r.counts.failedSources, r.counts.canceledSources],
    r.candidates,
  ]);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > PACKED_CHECKPOINT_LIMIT) throw new PackedCheckpointSizeError();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function encodePackedReference(
  input: ReferencedScanCheckpoint,
): Promise<PackedScanCheckpoint> {
  const sourceIndex = new Map(input.review.sources.map((s, i) => [s.sourceId, i]));
  const categoryTable: string[] = [],
    categories = new Map<string, number>();
  const candidateIndex = new Map<string, number>();
  const candidates: PackedCandidate[] = input.review.candidates.map((c, i) => {
    const si = sourceIndex.get(c.sourceId);
    if (si === undefined || candidateIndex.has(c.key)) invalid();
    candidateIndex.set(c.key, i);
    let ci = categories.get(c.channel.category);
    if (ci === undefined) {
      ci = categoryTable.length;
      categories.set(c.channel.category, ci);
      categoryTable.push(c.channel.category);
    }
    return candidateTuple(c, si, ci);
  });
  const {
    schemaVersion: _version,
    review: _review,
    observations: _observations,
    publishedKeys: _keys,
    ...header
  } = input;
  const result: PackedScanCheckpoint = {
    ...header,
    schemaVersion: 3,
    categoryTable,
    review: { ...input.review, candidates },
    observations: input.observations.map((o) => [
      index(candidateIndex.get(o.channelId), candidates.length),
      o.observedAt,
      o.verdict,
      o.evidence,
    ]),
    publishedIndices: input.publishedKeys.map((k) =>
      index(candidateIndex.get(k), candidates.length),
    ),
  };
  result.reviewDigest = await packedReviewDigest(result);
  bounded(result);
  return result;
}
/** Structural decode; caller must run shared semantic/header/evidence admission before use. */
export async function decodePackedReference(
  raw: unknown,
): Promise<{ packed: PackedScanCheckpoint; reference: ReferencedScanCheckpoint }> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    invalid();
  const p = raw as PackedScanCheckpoint;
  const allowed = [
    'schemaVersion',
    'reviewDigest',
    'jobId',
    'createdAtMs',
    'catalogRevision',
    'policyFingerprint',
    'sourceDefinitions',
    'budgetMs',
    'platform',
    'observerProfile',
    'preferredRegion',
    'categoryTable',
    'review',
    'observations',
    'publishedIndices',
  ];
  if (
    Object.keys(p).some((k) => !allowed.includes(k)) ||
    p.schemaVersion !== 3 ||
    !Array.isArray(p.categoryTable) ||
    p.categoryTable.length > 100000 ||
    p.categoryTable.some((v) => typeof v !== 'string') ||
    new Set(p.categoryTable).size !== p.categoryTable.length ||
    !p.review ||
    !Array.isArray(p.review.sources) ||
    p.review.sources.length > 100 ||
    !Array.isArray(p.review.candidates) ||
    p.review.candidates.length > 100000 ||
    !Array.isArray(p.observations) ||
    p.observations.length > 100000 ||
    !Array.isArray(p.publishedIndices) ||
    p.publishedIndices.length > 100000
  )
    invalid();
  for (const rows of [
    p.categoryTable,
    p.review.sources,
    p.review.candidates,
    p.observations,
    p.publishedIndices,
  ])
    if (
      Object.getPrototypeOf(rows) !== Array.prototype ||
      Object.getOwnPropertySymbols(rows).length
    )
      invalid();
  bounded(p);
  // Authenticate the bounded immutable tuple before expanding candidate metadata.
  if ((await packedReviewDigest(p)) !== p.reviewDigest) invalid();
  const categories = new Set<number>();
  let nextCategory = 0;
  const candidates = p.review.candidates.map((rawCandidate) => {
    const c = tuple(rawCandidate, 9),
      si = index(c[1], p.review.sources.length),
      category = index(c[4], p.categoryTable.length);
    if (!categories.has(category)) {
      if (category !== nextCategory++) invalid();
      categories.add(category);
    }
    const source = p.review.sources[si]!;
    const providerId = unSlot<string>(c[2]);
    const geographySlots = unSlot<unknown[]>(c[5]);
    let geography: Record<string, string> | undefined;
    if (geographySlots !== undefined) {
      tuple(geographySlots, 3);
      geography = {};
      fields.forEach((field, i) => {
        const v = unSlot<string>(geographySlots[i]);
        if (v !== undefined) geography![field] = v;
      });
    }
    const provenanceRows = unSlot<unknown[]>(c[6]);
    let geographyProvenance: GeographyProvenance[] | undefined;
    if (provenanceRows !== undefined) {
      if (!Array.isArray(provenanceRows) || provenanceRows.length > 3) invalid();
      geographyProvenance = provenanceRows.map((row) => {
        const t = tuple(row, 5),
          provider = unSlot<string>(t[2]);
        return {
          field: fields[index(t[0], fields.length)]!,
          value: t[1] as string,
          sourceId: source.sourceId,
          kind: kinds[index(t[3], kinds.length)]!,
          scope: scopes[index(t[4], scopes.length)]!,
          ...(provider === undefined ? {} : { providerId: provider }),
        };
      });
    }
    if (!Array.isArray(c[8]) || !c[8].length || c[8].length > 16) invalid();
    return {
      key: c[0] as string,
      sourceId: source.sourceId,
      sourceFingerprint: source.fingerprint,
      sessionRevision: p.review.sessionRevision,
      channel: {
        sourceId: source.sourceId,
        name: c[3] as string,
        category: p.categoryTable[category]!,
        ...(providerId === undefined ? {} : { providerId }),
        ...(geography === undefined ? {} : { geography }),
        ...(geographyProvenance === undefined ? {} : { geographyProvenance }),
      },
      reference: { candidateDigest: expandedHash(c[7]), urlHashes: c[8].map(expandedHash) },
    };
  });
  if (categories.size !== p.categoryTable.length) invalid();
  const observations = p.observations.map((row) => {
    const t = tuple(row, 4),
      c = candidates[index(t[0], candidates.length)]!;
    return {
      channelId: c.key,
      sourceId: c.sourceId,
      fingerprint: c.sourceFingerprint,
      platform: p.platform,
      observedAt: t[1] as number,
      verdict: t[2] as ReferencedScanCheckpoint['observations'][number]['verdict'],
      evidence: t[3] as ReferencedScanCheckpoint['observations'][number]['evidence'],
    };
  });
  const publishedKeys = p.publishedIndices.map((i) => candidates[index(i, candidates.length)]!.key);

  const { categoryTable: _table, publishedIndices: _indices, ...header } = p;
  return {
    packed: p,
    reference: {
      ...header,
      schemaVersion: 2,
      review: { ...p.review, candidates },
      observations,
      publishedKeys,
    },
  };
}
