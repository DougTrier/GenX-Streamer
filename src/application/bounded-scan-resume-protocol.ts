import type { BoundedScanResumeSnapshot } from './bounded-scan-resume';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
export type ResumeCall = 'admit' | 'take' | 'probe' | 'commit' | 'defer' | 'release' | 'close';
export type ResumeControl = 'prepare' | 'start' | 'suspend' | 'dispose';
export type ResumeWire =
  | { generation: number; sequence: number; kind: 'control'; operation: ResumeControl }
  | { generation: number; sequence: number; kind: 'call'; operation: ResumeCall; args: unknown[] }
  | { generation: number; sequence: number; kind: 'cancel' }
  | { generation: number; sequence: number; kind: 'reply' | 'done'; ok: true; value?: unknown }
  | {
      generation: number;
      sequence: number;
      kind: 'reply' | 'done';
      ok: false;
      // callback-failed: the host call settled with a refusal (no native work
      // remains); cancel-unconfirmed: its cancellation was not acknowledged.
      failure:
        'canceled' | 'owner-failed' | 'callback-failed' | 'cancel-unconfirmed' | 'admission-closed';
    }
  | {
      generation: number;
      sequence: number;
      kind: 'snapshot';
      value: Readonly<BoundedScanResumeSnapshot>;
    };
const bad = () => new Error('Bounded resume worker message refused.');
export function validateResumeWire(raw: unknown): ResumeWire {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype)
    throw bad();
  const r = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(r.generation) ||
    Number(r.generation) < 1 ||
    !Number.isSafeInteger(r.sequence) ||
    Number(r.sequence) < 1
  )
    throw bad();
  const keys: string[] = ['generation', 'sequence', 'kind'];
  if (r.kind === 'control') {
    keys.push('operation');
    if (!['prepare', 'start', 'suspend', 'dispose'].includes(String(r.operation))) throw bad();
  } else if (r.kind === 'call') {
    keys.push('operation', 'args');
    if (
      !['admit', 'take', 'probe', 'commit', 'defer', 'release', 'close'].includes(
        String(r.operation),
      ) ||
      !Array.isArray(r.args) ||
      r.args.length > 3
    )
      throw bad();
  } else if (r.kind === 'reply' || r.kind === 'done') {
    keys.push('ok');
    if (r.ok === true) {
      if (Object.hasOwn(r, 'value')) keys.push('value');
    } else if (r.ok === false) {
      keys.push('failure');
      if (
        ![
          'canceled',
          'owner-failed',
          'callback-failed',
          'cancel-unconfirmed',
          'admission-closed',
        ].includes(String(r.failure))
      )
        throw bad();
    } else throw bad();
  } else if (r.kind === 'snapshot') {
    keys.push('value');
    validateResumeSnapshot(r.value);
  } else if (r.kind !== 'cancel') throw bad();
  if (
    Reflect.ownKeys(r).some((k) => typeof k !== 'string' || !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    throw bad();
  boundedJsonUtf8Bytes(r, 1024 * 1024);
  return r as unknown as ResumeWire;
}
export function validateResumeSnapshot(raw: unknown): Readonly<BoundedScanResumeSnapshot> {
  if (!raw || typeof raw !== 'object') throw bad();
  const r = raw as BoundedScanResumeSnapshot;
  const keys = [
    'phase',
    'failure',
    'counts',
    'revisions',
    'ownedReservations',
    'active',
    'maxOwnedReservations',
    'capabilityEnabled',
    'observerFailed',
  ];
  if (
    Object.keys(r).length !== keys.length ||
    Object.keys(r).some((k) => !keys.includes(k)) ||
    ![
      'idle',
      'admitting',
      'checking',
      'completed',
      'paused',
      'failed',
      'quarantined',
      'disposed',
    ].includes(r.phase) ||
    ![
      'none',
      'admission-failed',
      'probe-unconfirmed',
      'commit-unconfirmed',
      'cleanup-unconfirmed',
    ].includes(r.failure) ||
    r.capabilityEnabled !== false ||
    typeof r.observerFailed !== 'boolean' ||
    ![r.ownedReservations, r.maxOwnedReservations].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 256,
    ) ||
    !Number.isInteger(r.active) ||
    r.active < 0 ||
    r.active > 16
  )
    throw bad();
  if (
    !r.counts ||
    Object.keys(r.counts).length !== 4 ||
    !['total', 'checked', 'responded', 'published'].every((k) => Object.hasOwn(r.counts, k)) ||
    !Object.values(r.counts).every((n) => Number.isInteger(n) && n >= 0 && n <= 100000) ||
    r.counts.published > r.counts.responded ||
    r.counts.responded > r.counts.checked ||
    r.counts.checked > r.counts.total
  )
    throw bad();
  if (
    r.revisions !== null &&
    (Object.keys(r.revisions).length !== 3 ||
      !['catalogRevision', 'healthRevision', 'checkpointRevision'].every((k) =>
        Object.hasOwn(r.revisions!, k),
      ) ||
      Object.values(r.revisions).some(
        (v) =>
          typeof v !== 'string' ||
          !/^(0|[1-9][0-9]{0,18})$/.test(v) ||
          BigInt(v) > 9223372036854775807n,
      ))
  )
    throw bad();
  return Object.freeze({
    ...r,
    counts: Object.freeze({ ...r.counts }),
    revisions: r.revisions ? Object.freeze({ ...r.revisions }) : null,
  });
}
