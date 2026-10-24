/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const SCAN_PUBLICATION_STAGES = [
  'checkpoint-prepare',
  'checkpoint-reconcile',
  'queued',
  'read-revisions',
  'actor-prepare',
  'patch-admission',
  'window-admission',
  'native-dispatch',
  'native-settled',
  'actor-ack',
  'apply-ui',
  'checkpoint-ack',
  'completed',
] as const;
export type ScanPublicationStage = (typeof SCAN_PUBLICATION_STAGES)[number];
export const SCAN_PUBLICATION_FAILURES = [
  'canceled',
  'checkpoint-failed',
  'revision-changed',
  'actor-failed',
  'admission-refused',
  'window-size',
  'native-failed',
  'ack-failed',
  'application-closing',
  'unknown',
] as const;
export type ScanPublicationFailure = (typeof SCAN_PUBLICATION_FAILURES)[number];
export interface ScanPublicationFailureSnapshot {
  readonly attempt: number;
  readonly stage: ScanPublicationStage | 'idle';
  readonly code: ScanPublicationFailure;
  readonly dispatched: boolean;
  readonly durableCommitted: boolean;
}
export interface ScanPublicationPatch {
  checked?: number;
  total?: number;
  published?: number;
  selected?: number;
  chunks?: number;
  wireBytes?: number;
  catalogRevision?: string | null;
  healthRevision?: string | null;
  checkpointRevision?: string | null;
  dispatched?: boolean;
  durableCommitted?: boolean;
}
export interface ScanPublicationSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly stage: ScanPublicationStage | 'idle';
  readonly state: 'idle' | 'active' | 'failed' | 'completed';
  readonly failure: ScanPublicationFailure | null;
  readonly checked: number;
  readonly total: number;
  readonly published: number;
  readonly selected: number;
  readonly chunks: number;
  readonly wireBytes: number;
  readonly catalogRevision: string | null;
  readonly healthRevision: string | null;
  readonly checkpointRevision: string | null;
  readonly dispatched: boolean;
  readonly durableCommitted: boolean;
  readonly failures: readonly ScanPublicationFailureSnapshot[];
}
declare const handleBrand: unique symbol;
export type ScanPublicationHandle = Readonly<{ [handleBrand]: true }>;
const refusal = () => new Error('Scan publication observation is invalid.');
const defaults = {
  checked: 0,
  total: 0,
  published: 0,
  selected: 0,
  chunks: 0,
  wireBytes: 0,
  catalogRevision: null,
  healthRevision: null,
  checkpointRevision: null,
  dispatched: false,
  durableCommitted: false,
} as const;
const limits: Record<string, number> = {
  checked: 100000,
  total: 100000,
  published: 100000,
  selected: 256,
  chunks: 4,
  wireBytes: 20 * 1024 * 1024,
};
const revisionKeys = new Set(['catalogRevision', 'healthRevision', 'checkpointRevision']);
function patched(
  current: ScanPublicationSnapshot,
  patch: ScanPublicationPatch,
): ScanPublicationSnapshot {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Object.getPrototypeOf(patch) !== Object.prototype ||
    Object.getOwnPropertySymbols(patch).length
  )
    throw refusal();
  const descriptors = Object.getOwnPropertyDescriptors(patch);
  if (Object.keys(descriptors).length > 11) throw refusal();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw refusal();
    const value: unknown = descriptor.value;
    if (Object.hasOwn(limits, key)) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > limits[key]
      )
        throw refusal();
    } else if (revisionKeys.has(key)) {
      if (
        value !== null &&
        (typeof value !== 'string' ||
          !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
          BigInt(value) > 9223372036854775807n)
      )
        throw refusal();
    } else if (key === 'dispatched' || key === 'durableCommitted') {
      if (typeof value !== 'boolean' || (current[key] && !value)) throw refusal();
    } else throw refusal();
  }
  const next = { ...current, ...patch };
  if (next.durableCommitted && !next.dispatched) throw refusal();
  return Object.freeze(next);
}
/** Scalar-only evidence. A failure records its original stage; it never fabricates an ACK. */
export function createScanPublicationObserver() {
  let current: ScanPublicationHandle | null = null;
  let value: ScanPublicationSnapshot = Object.freeze({
    schemaVersion: 1,
    generation: 0,
    stage: 'idle',
    state: 'idle',
    failure: null,
    failures: Object.freeze([]),
    ...defaults,
  });
  const owns = (handle: ScanPublicationHandle) => handle === current && value.state === 'active';
  return {
    begin(patch: ScanPublicationPatch = {}): ScanPublicationHandle {
      const next = patched(
        {
          ...value,
          ...defaults,
          stage: 'checkpoint-prepare',
          state: 'active',
          failure: null,
          generation: Math.min(Number.MAX_SAFE_INTEGER, value.generation + 1),
        },
        patch,
      );
      const handle = Object.freeze({}) as ScanPublicationHandle;
      current = handle;
      value = next;
      return handle;
    },
    resume(handle: ScanPublicationHandle): ScanPublicationHandle | null {
      return owns(handle) ? handle : null;
    },
    step(
      handle: ScanPublicationHandle,
      stage: Exclude<ScanPublicationStage, 'completed'>,
      patch: ScanPublicationPatch = {},
    ) {
      if (!owns(handle)) return;
      if (!SCAN_PUBLICATION_STAGES.includes(stage) || stage === ('completed' as string))
        throw refusal();
      value = Object.freeze({ ...patched(value, patch), stage });
    },
    fail(handle: ScanPublicationHandle, failure: ScanPublicationFailure) {
      if (!owns(handle)) return;
      if (!SCAN_PUBLICATION_FAILURES.includes(failure)) throw refusal();
      const record = Object.freeze({
        attempt: value.generation,
        stage: value.stage,
        code: failure,
        dispatched: value.dispatched,
        durableCommitted: value.durableCommitted,
      });
      value = Object.freeze({
        ...value,
        state: 'failed',
        failure,
        failures: Object.freeze([...value.failures.slice(-1), record]),
      });
    },
    complete(handle: ScanPublicationHandle, patch: ScanPublicationPatch = {}) {
      if (!owns(handle)) return;
      const next = patched(value, patch);
      if (next.dispatched && !next.durableCommitted) throw refusal();
      value = Object.freeze({ ...next, state: 'completed', stage: 'completed' });
    },
    snapshot(): ScanPublicationSnapshot {
      return value;
    },
  };
}
