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

import type {
  ScanCheckpoint,
  PersistedScanCheckpoint,
  LegacyPersistedScanCheckpoint,
  PackedScanCheckpoint,
  ReferencedScanCheckpoint,
} from '../../discovery/scan-checkpoint';
import type { ScanReview } from '../../discovery/scan';
import {
  MAX_SCAN_CHECKPOINT_BYTES,
  isScanReconstructionFailureCode,
  ScanReconstructionError,
} from '../../discovery/scan-checkpoint';
import { boundedUtf8Text } from '../../platform/bounded-text';
import {
  validateCheckpointProgressObservation,
  validateScanCheckpointMutation,
  checkpointRevision,
  validateScanWindowPublishedKeys,
  type ScanCheckpointMutation,
} from '../../discovery/scan-checkpoint';
import type { InitialProgressCapture } from './scan-checkpoint-capture';
import type { ScanCheckpointCaptureInput } from './scan-checkpoint-capture';

function runCapture(
  operation:
    | 'prepare'
    | 'parse'
    | 'prepare-stored'
    | 'parse-stored'
    | 'parse-stored-packed'
    | 'restore-packed-reference'
    | 'restore-reference'
    | 'prepare-progress-initial'
    | 'prepare-progress-initial-packed',
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scan-checkpoint-capture-worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      action();
    };
    const cancel = () =>
      finish(() => reject(new DOMException('Scan checkpoint capture canceled.', 'AbortError')));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent) =>
      finish(() => {
        const reply = event.data;
        if (reply?.ok !== true || reply.operation !== operation) {
          if (
            reply?.ok === false &&
            reply.operation === operation &&
            (operation === 'restore-reference' || operation === 'restore-packed-reference') &&
            isScanReconstructionFailureCode(reply.reconstructionFailure)
          ) {
            reject(new ScanReconstructionError(reply.reconstructionFailure));
            return;
          }
          reject(new Error('Scan checkpoint could not be prepared or read.'));
          return;
        }
        if (
          (operation === 'prepare' || operation === 'prepare-stored') &&
          reply.value !== null &&
          !boundedUtf8Text(reply.value, MAX_SCAN_CHECKPOINT_BYTES)
        ) {
          reject(new Error('Scan checkpoint reply is invalid.'));
          return;
        }
        if (
          [
            'parse',
            'parse-stored',
            'parse-stored-packed',
            'restore-reference',
            'restore-packed-reference',
          ].includes(operation) &&
          (!reply.value ||
            ![
              1,
              ...(operation === 'parse-stored'
                ? [2]
                : operation === 'parse-stored-packed'
                  ? [2, 3]
                  : []),
            ].includes(reply.value.schemaVersion) ||
            !Array.isArray(reply.value.sourceDefinitions) ||
            !Array.isArray(reply.value.observations))
        ) {
          reject(new Error('Scan checkpoint reply is invalid.'));
          return;
        }
        if (
          ['prepare-progress-initial', 'prepare-progress-initial-packed'].includes(operation) &&
          reply.value !== null &&
          (!reply.value ||
            !boundedUtf8Text(reply.value.checkpoint, MAX_SCAN_CHECKPOINT_BYTES) ||
            !/^[a-f0-9]{64}$/u.test(reply.value.reviewDigest) ||
            !/^[a-f0-9]{64}$/u.test(reply.value.policyFingerprint) ||
            Object.keys(reply.value).some(
              (k) => !['checkpoint', 'reviewDigest', 'policyFingerprint'].includes(k),
            ))
        ) {
          reject(new Error('Scan checkpoint reply is invalid.'));
          return;
        }
        resolve(reply.value);
      });
    worker.onerror = () =>
      finish(() => reject(new Error('Scan checkpoint capture could not finish.')));
    worker.onmessageerror = () =>
      finish(() => reject(new Error('Scan checkpoint reply is invalid.')));
    try {
      worker.postMessage({ operation, input });
    } catch {
      finish(() => reject(new Error('Scan checkpoint capture could not start.')));
    }
    if (signal.aborted) cancel();
  });
}
export async function prepareStoredCapture(
  input: ScanCheckpointCaptureInput,
  signal: AbortSignal,
): Promise<string | null> {
  return (await runCapture('prepare-stored', input, signal)) as string | null;
}
export async function parseStoredCapture(
  serialized: string,
  signal: AbortSignal,
): Promise<LegacyPersistedScanCheckpoint> {
  return (await runCapture('parse-stored', serialized, signal)) as LegacyPersistedScanCheckpoint;
}
export async function restoreReferencedCapture(
  reference: ReferencedScanCheckpoint,
  review: ScanReview,
  signal: AbortSignal,
): Promise<ScanCheckpoint> {
  return (await runCapture('restore-reference', { reference, review }, signal)) as ScanCheckpoint;
}

export async function prepareCapture(
  input: ScanCheckpointCaptureInput,
  signal: AbortSignal,
): Promise<string | null> {
  return (await runCapture('prepare', input, signal)) as string | null;
}
export async function parseCapture(
  serialized: string,
  signal: AbortSignal,
): Promise<ScanCheckpoint> {
  return (await runCapture('parse', serialized, signal)) as ScanCheckpoint;
}

export async function prepareInitialProgressCapture(
  input: ScanCheckpointCaptureInput,
  signal: AbortSignal,
): Promise<InitialProgressCapture | null> {
  return (await runCapture(
    'prepare-progress-initial',
    input,
    signal,
  )) as InitialProgressCapture | null;
}
export interface ScanCheckpointProgressCaptureOptions {
  /** True only after explicit native advance-v1 capability confirmation. */
  supportsAdvance: boolean;
  /** True only after exact packedReference:3 capability confirmation. Default emits v2. */
  supportsPackedReference?: boolean;
  packedInitial?(
    input: ScanCheckpointCaptureInput,
    signal: AbortSignal,
  ): Promise<InitialProgressCapture | null>;
  initial?(
    input: ScanCheckpointCaptureInput,
    signal: AbortSignal,
  ): Promise<InitialProgressCapture | null>;
  legacy?(input: ScanCheckpointCaptureInput, signal: AbortSignal): Promise<string | null>;
}
/** Cache only one owned immutable review and acknowledged progress; no per-batch full-review IPC. */
export function createScanCheckpointProgressCapture(options: ScanCheckpointProgressCaptureOptions) {
  type Baseline = {
    jobId: string;
    review: ScanCheckpointCaptureInput['review'];
    scope: string;
    digest: string;
    observations: Map<string, string>;
    originals: Map<string, ReturnType<typeof validateCheckpointProgressObservation>>;
    candidates: Map<string, { sourceId: string; fingerprint: string }>;
    published: Set<string>;
    revision: string | null;
  };
  let baseline: Baseline | null = null,
    pending: { mutation: ScanCheckpointMutation; next: Baseline } | null = null,
    disposed = false,
    running = false;
  const scope = (input: ScanCheckpointCaptureInput) =>
    JSON.stringify([
      input.jobId,
      input.createdAtMs,
      input.budgetMs,
      input.platform,
      input.observerProfile,
      input.preferredRegion ?? null,
      input.sources.map((s) => [
        s.id,
        s.name,
        s.kind,
        s.location,
        s.allowHttp === true,
        s.contentKind ?? null,
        s.mediaMime ?? null,
      ]),
      input.providers?.map((p) => [p.id, p.name, p.location, p.provenance, p.allowHttp === true]) ??
        null,
    ]);
  const refuse = () =>
    new Error('Scan checkpoint progress changed or awaits its durable acknowledgment.');
  async function performMutation(
    input: ScanCheckpointCaptureInput,
    signal: AbortSignal,
  ): Promise<ScanCheckpointMutation | null> {
    signal.throwIfAborted();
    if (disposed || running) throw refuse();
    running = true;
    try {
      if (!options.supportsAdvance) {
        const text = await (options.legacy ?? prepareStoredCapture)(input, signal);
        signal.throwIfAborted();
        return text === null ? null : { kind: 'save', checkpoint: text };
      }
      const sourceIdentity = (source: ScanCheckpointCaptureInput['sources'][number]) =>
        JSON.stringify([
          source.id,
          source.name,
          source.kind,
          source.location,
          source.allowHttp === true,
          source.contentKind ?? null,
          source.mediaMime ?? null,
        ]);
      if (input.sources.length > 100 || (input.canonicalSources?.length ?? 0) > 100) throw refuse();
      const canonical = new Map<string, string>();
      for (const source of input.canonicalSources ?? []) {
        if (canonical.has(source.id)) throw refuse();
        canonical.set(source.id, sourceIdentity(source));
      }
      for (const source of input.sources) {
        const saved = canonical.get(source.id);
        if (saved !== undefined) {
          if (saved !== sourceIdentity(source)) throw refuse();
        } else if (
          source.kind !== 'url' ||
          !input.providers?.some(
            (provider) =>
              provider.location === source.location &&
              (provider.allowHttp === true) === (source.allowHttp === true),
          )
        )
          throw refuse();
      }
      const identity = scope(input);
      if (baseline && baseline.jobId !== input.jobId) {
        if (pending) throw refuse();
        baseline = null;
      }
      if (baseline && (baseline.review !== input.review || baseline.scope !== identity))
        throw refuse();
      const observations = new Map<string, string>(),
        originals = new Map<string, ReturnType<typeof validateCheckpointProgressObservation>>();
      for (const raw of input.observations) {
        const cached = baseline?.originals.get(raw.channelId);
        if (cached === raw && Object.isFrozen(raw)) {
          if (observations.has(raw.channelId)) throw refuse();
          observations.set(raw.channelId, baseline!.observations.get(raw.channelId)!);
          originals.set(raw.channelId, raw);
          continue;
        }
        const checked = validateCheckpointProgressObservation(raw);
        originals.set(checked.channelId, raw);
        if (observations.has(checked.channelId)) throw refuse();
        observations.set(checked.channelId, JSON.stringify(checked));
      }
      const published = new Set(input.publishedKeys);
      if (published.size !== input.publishedKeys.length) throw refuse();
      if (pending) {
        if (
          pending.next.review !== input.review ||
          pending.next.scope !== identity ||
          JSON.stringify([...pending.next.observations]) !== JSON.stringify([...observations]) ||
          JSON.stringify([...pending.next.published]) !== JSON.stringify([...published])
        )
          throw refuse();
        return pending.mutation;
      }
      let mutation: ScanCheckpointMutation, digest: string;
      if (!baseline) {
        const initial = await (
          options.supportsPackedReference === true
            ? (options.packedInitial ?? prepareInitialPackedProgressCapture)
            : (options.initial ?? prepareInitialProgressCapture)
        )(input, signal);
        signal.throwIfAborted();
        if (initial === null) return null;
        mutation = { kind: 'save', checkpoint: initial.checkpoint };
        digest = initial.reviewDigest;
      } else {
        for (const [key, value] of baseline.observations)
          if (observations.get(key) !== value) throw refuse();
        for (const key of baseline.published) if (!published.has(key)) throw refuse();
        const candidates = baseline.candidates;
        const newObservations = [];
        for (const [key, value] of observations) {
          if (baseline.observations.has(key)) continue;
          const observation = JSON.parse(value) as ReturnType<
              typeof validateCheckpointProgressObservation
            >,
            candidate = candidates.get(key);
          if (
            !candidate ||
            candidate.sourceId !== observation.sourceId ||
            candidate.fingerprint !== observation.fingerprint ||
            observation.platform !== input.platform ||
            observation.observedAt < input.createdAtMs ||
            observation.observedAt - input.createdAtMs >= 86400000
          )
            throw refuse();
          newObservations.push(observation);
        }
        const newKeys = [...published].filter((key) => !baseline!.published.has(key));
        for (const key of newKeys) {
          const observation = observations.get(key);
          if (
            !observation ||
            !['Reachable', 'PlayedHere'].includes(JSON.parse(observation).verdict)
          )
            throw refuse();
        }
        mutation = validateScanCheckpointMutation({
          kind: 'advance',
          jobId: input.jobId,
          reviewDigest: baseline.digest,
          observations: newObservations,
          publishedKeys: newKeys,
        });
        digest = baseline.digest;
      }
      pending = {
        mutation,
        next: {
          jobId: input.jobId,
          review: input.review,
          scope: identity,
          digest,
          observations,
          originals,
          candidates:
            baseline?.candidates ??
            new Map(
              input.review.candidates.map((c) => [
                c.key,
                { sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
              ]),
            ),
          published,
          revision: baseline?.revision ?? null,
        },
      };
      return mutation;
    } finally {
      running = false;
    }
  }
  let owned: { controller: AbortController; work: Promise<ScanCheckpointMutation | null> } | null =
    null;
  function prepareMutation(
    input: ScanCheckpointCaptureInput,
    signal: AbortSignal,
  ): Promise<ScanCheckpointMutation | null> {
    signal.throwIfAborted();
    if (disposed || owned) return Promise.reject(refuse());
    const controller = new AbortController(),
      cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const work = performMutation(input, controller.signal).finally(() => {
      signal.removeEventListener('abort', cancel);
      owned = null;
    });
    owned = { controller, work };
    return work;
  }
  function acknowledgeMutation(mutation: ScanCheckpointMutation, revision: string): void {
    if (!options.supportsAdvance) return;
    const actual = checkpointRevision(revision);
    if (
      disposed ||
      !pending ||
      pending.mutation !== mutation ||
      (baseline?.revision !== null &&
        baseline?.revision !== undefined &&
        BigInt(actual) < BigInt(baseline.revision))
    )
      throw refuse();
    baseline = { ...pending.next, revision: actual };
    pending = null;
  }
  return {
    prepareMutation,
    prepareWindowMutation(
      input: ScanCheckpointCaptureInput,
      publicationKeys: readonly string[],
      signal: AbortSignal,
    ): Promise<ScanCheckpointMutation | null> {
      signal.throwIfAborted();
      const keys = validateScanWindowPublishedKeys(publicationKeys);
      if (!Array.isArray(input.publishedKeys) || input.publishedKeys.length > 100000)
        return Promise.reject(refuse());
      const published = new Set(input.publishedKeys);
      if (published.size !== input.publishedKeys.length || keys.some((key) => !published.has(key)))
        return Promise.reject(refuse());
      if (options.supportsAdvance && baseline) {
        const added = input.publishedKeys.filter((key) => !baseline!.published.has(key));
        const requested = new Set(keys);
        if (added.length !== keys.length || added.some((key) => !requested.has(key)))
          return Promise.reject(refuse());
      }
      // One shared pending owner; no per-chunk baseline advance or fake ACK.
      return prepareMutation(input, signal);
    },
    acknowledgeMutation,
    get hasPendingPreparation(): boolean {
      return pending !== null;
    },
    /** Caller must first join failed publication and read authoritative native catalog/checkpoint CAS. */
    releaseUncommittedPreparation(expectedRevision: string, actualRevision: string): void {
      const expected = checkpointRevision(expectedRevision),
        actual = checkpointRevision(actualRevision);
      if (
        disposed ||
        running ||
        owned ||
        !pending ||
        expected !== actual ||
        (baseline !== null && baseline.revision !== expected)
      )
        throw refuse();
      pending = null;
    },
    reset() {
      if (running) throw refuse();
      baseline = null;
      pending = null;
    },
    async dispose() {
      disposed = true;
      const job = owned;
      if (job) {
        job.controller.abort();
        await Promise.allSettled([job.work]);
      }
      baseline = null;
      pending = null;
    },
  };
}

/** Explicit opt-in consumer; legacy main remains fail-closed for schema3 until integrated. */
export async function parseStoredCaptureWithPacked(
  serialized: string,
  signal: AbortSignal,
): Promise<PersistedScanCheckpoint> {
  return (await runCapture('parse-stored-packed', serialized, signal)) as PersistedScanCheckpoint;
}
export async function restorePackedCapture(
  reference: PackedScanCheckpoint,
  review: ScanReview,
  signal: AbortSignal,
): Promise<ScanCheckpoint> {
  return (await runCapture(
    'restore-packed-reference',
    { reference, review },
    signal,
  )) as ScanCheckpoint;
}
export function parseScanCheckpointCapabilities(raw: unknown): {
  advance: boolean;
  packedReference: boolean;
} {
  const unavailable = { advance: false, packedReference: false };
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return unavailable;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['schemaVersion', 'advance', 'packedReference'].includes(key),
    ) ||
    !Object.hasOwn(value, 'schemaVersion') ||
    !Object.hasOwn(value, 'advance') ||
    value.schemaVersion !== 1 ||
    value.advance !== 1 ||
    (Object.hasOwn(value, 'packedReference') && value.packedReference !== 3)
  )
    return unavailable;
  return { advance: true, packedReference: value.packedReference === 3 };
}

export async function prepareInitialPackedProgressCapture(
  input: ScanCheckpointCaptureInput,
  signal: AbortSignal,
): Promise<InitialProgressCapture | null> {
  return (await runCapture(
    'prepare-progress-initial-packed',
    input,
    signal,
  )) as InitialProgressCapture | null;
}
