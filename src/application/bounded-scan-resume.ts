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

import { type ScanProbeSourcePolicy } from '../discovery/automatic-check';
import { type HealthObservation } from '../discovery/health';
import type { ReviewCandidate } from '../discovery/scan';
import type { HealthCheckBudgetMs } from '../sources/health-inspection';
import { boundedJsonUtf8Bytes, JsonByteLimitError } from '../data-transfer/json-byte-admission';
import {
  fields,
  refusal,
  validateBoundedScanResumePlan,
  freeze,
  revisions,
  counts,
  sameIndices,
  trusted,
  validateBoundedScanCandidatePage,
} from './bounded-scan-resume-validation';
export {
  validateBoundedScanResumePlan,
  validateBoundedScanCandidatePage,
} from './bounded-scan-resume-validation';

export const scanResumeCommitWindow = Object.freeze({
  schemaVersion: 2 as const,
  maxObservations: 240 as const,
  maxRequestBytes: 1048576 as const,
  maxActiveProbes: 16 as const,
  maxHeldRows: 256 as const,
  maxCacheBytes: 20971520 as const,
  publicationDelayMs: 10000 as const,
});
/** Checks at once on one site; matches the native scan_resume_owner constant. */
export const MAX_PROBES_PER_ORIGIN = 2;
export const scanResumeTakeTiming = Object.freeze({
  schemaVersion: 1 as const,
  maxCoolingDelayMs: 60000 as const,
});
export function validateScanResumeTakeTiming(raw: unknown): typeof scanResumeTakeTiming {
  fields(raw, Object.keys(scanResumeTakeTiming));
  if (Object.entries(scanResumeTakeTiming).some(([key, value]) => raw[key] !== value))
    throw refusal();
  return scanResumeTakeTiming;
}
export function validateScanResumeCommitWindow(raw: unknown): typeof scanResumeCommitWindow {
  fields(raw, Object.keys(scanResumeCommitWindow));
  if (Object.entries(scanResumeCommitWindow).some(([key, value]) => raw[key] !== value))
    throw refusal();
  return scanResumeCommitWindow;
}

/** Choose a complete prefix; byte-limit refusal never truncates a record or hides malformed data. */
export function fitScanResumeCommitPrefix(
  count: number,
  payloadFor: (count: number) => unknown,
): number {
  if (!Number.isInteger(count) || count < 1 || count > 240) throw refusal();
  let low = 1,
    high = count,
    fitting = 0;
  while (low <= high) {
    const n = Math.floor((low + high) / 2);
    try {
      boundedJsonUtf8Bytes(payloadFor(n), 1048576 - 4096);
      fitting = n;
      low = n + 1;
    } catch (error) {
      if (!(error instanceof JsonByteLimitError)) throw error;
      high = n - 1;
    }
  }
  return fitting;
}

export interface BoundedScanRevisions {
  catalogRevision: string;
  healthRevision: string;
  checkpointRevision: string;
}
export interface BoundedScanCounts {
  total: number;
  checked: number;
  responded: number;
  published: number;
}
export interface BoundedScanResumePlan {
  schemaVersion: 1;
  planId: string;
  jobId: string;
  reviewDigest: string;
  sessionRevision: string;
  query: string;
  createdAtMs: number;
  platform: string;
  observerProfile: string;
  budgetMs: HealthCheckBudgetMs;
  sourcePolicies: readonly ScanProbeSourcePolicy[];
  /** Locally attached only after explicit native schema-2 capability negotiation. */
  commitWindow?: typeof scanResumeCommitWindow;
  takeTiming?: typeof scanResumeTakeTiming;
  counts: BoundedScanCounts;
  revisions: BoundedScanRevisions;
}
export interface BoundedScanCandidateRow {
  candidateIndex: number;
  candidate: ReviewCandidate;
  work: 'probe' | 'publish';
  observation?: HealthObservation;
  originToken: string;
  reservationId: string;
}
export interface BoundedScanCandidatePage {
  schemaVersion: 1;
  planId: string;
  rows: readonly BoundedScanCandidateRow[];
  exhausted: boolean;
  capacityBlocked?: true;
  coolingDelayMs?: number;
}
export interface BoundedScanCommit {
  expectedRevisions: BoundedScanRevisions;
  observations: readonly { candidateIndex: number; observation: HealthObservation }[];
  publicationIndices: readonly number[];
}
export interface BoundedScanAck extends BoundedScanRevisions {
  committed: true;
  planId: string;
  acknowledgedIndices: readonly number[];
  publicationIndices: readonly number[];
  counts: BoundedScanCounts;
}
/** Backend admission, original-review reconciliation and revision promotion remain authoritative.
 * take reserves only eligible original ordinals, one per origin, excluding blocked tokens.
 * commit settles observations (including negative-only batches) and publications atomically.
 * All callbacks must own coordinated native deadlines and join actual transport/cancellation
 * work before settling. This service does not abandon a hung callback with a Promise.race.
 * Final commit/release use a fresh signal so Stop can preserve confirmed observations;
 * their transport owner must enforce the application deadline, including uncertain writes.
 * This is a disabled pure service, not an implemented Worker transport or operational API. */
export interface BoundedScanResumeHost {
  admit(signal: AbortSignal): Promise<BoundedScanResumePlan>;
  take(
    planId: string,
    request: { limit: number; blockedOrigins: readonly string[] },
    signal: AbortSignal,
  ): Promise<BoundedScanCandidatePage>;
  probe(
    candidate: ReviewCandidate,
    signal: AbortSignal,
    budgetMs: HealthCheckBudgetMs,
    capturedSourcePolicy: Readonly<ScanProbeSourcePolicy>,
  ): Promise<HealthObservation>;
  commit(planId: string, request: BoundedScanCommit, signal: AbortSignal): Promise<BoundedScanAck>;
  /** Episode-only exclusion: no durable evidence/count advancement. close clears deferrals;
   * a newly admitted cold episode must offer those original indices again. */
  defer(planId: string, reservationIds: readonly string[], signal: AbortSignal): Promise<void>;
  release(planId: string, reservationIds: readonly string[], signal: AbortSignal): Promise<void>;
  close(planId: string): Promise<void>;
}
export interface BoundedScanResumeSnapshot {
  readonly phase:
    | 'idle'
    | 'admitting'
    | 'checking'
    | 'completed'
    | 'paused'
    | 'failed'
    | 'quarantined'
    | 'disposed';
  readonly failure:
    | 'none'
    | 'admission-failed'
    | 'probe-unconfirmed'
    | 'commit-unconfirmed'
    | 'cleanup-unconfirmed';
  readonly counts: Readonly<BoundedScanCounts>;
  readonly revisions: Readonly<BoundedScanRevisions> | null;
  readonly ownedReservations: number;
  readonly active: number;
  readonly maxOwnedReservations: number;
  readonly capabilityEnabled: false;
  readonly observerFailed: boolean;
}
export function createBoundedScanResumeOwner(
  host: BoundedScanResumeHost,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    onChange?: (snapshot: Readonly<BoundedScanResumeSnapshot>) => void;
  } = {},
) {
  const controller = new AbortController();
  let started = false,
    closed = false,
    work: Promise<void> | null = null,
    plan: BoundedScanResumePlan | null = null;
  let phase:
    | 'idle'
    | 'admitting'
    | 'checking'
    | 'completed'
    | 'paused'
    | 'failed'
    | 'quarantined'
    | 'disposed' = 'idle';
  let failure:
    | 'none'
    | 'admission-failed'
    | 'probe-unconfirmed'
    | 'commit-unconfirmed'
    | 'cleanup-unconfirmed' = 'none';
  let current: BoundedScanCounts = { total: 0, checked: 0, responded: 0, published: 0 },
    baseline: BoundedScanCounts = { ...current };
  const owned = new Map<string, BoundedScanCandidateRow>(),
    active = new Map<string, Promise<void>>(),
    probing = new Set<string>(),
    pending: { row: BoundedScanCandidateRow; observation: HealthObservation }[] = [];
  let maxOwnedReservations = 0,
    uncertain = false,
    fatal: unknown = null;
  let observerFailed = false;
  let callbackCleanupFailure: { error: unknown } | null = null;
  let preparation: Promise<BoundedScanResumePlan> | null = null;
  let closeWork: Promise<void> | null = null;
  let publishedThisEpisode = false;
  let publicationTimer: ReturnType<typeof setTimeout> | null = null;
  let publicationDue = false;
  let wakePublication: (() => void) | null = null;
  let publicationWake: Promise<void> | null = null;
  function clearPublicationTimer(): void {
    if (publicationTimer !== null) clearTimeout(publicationTimer);
    publicationTimer = null;
    wakePublication?.();
    wakePublication = null;
    publicationWake = null;
    publicationDue = false;
  }
  function queueObservation(value: (typeof pending)[number]): void {
    pending.push(value);
    if (plan?.commitWindow && publicationTimer === null && !publicationDue) {
      publicationWake = new Promise<void>((resolve) => {
        wakePublication = resolve;
      });
      publicationTimer = setTimeout(() => {
        publicationTimer = null;
        publicationDue = true;
        wakePublication?.();
      }, plan.commitWindow.publicationDelayMs);
    }
  }
  let coolingTimer: ReturnType<typeof setTimeout> | null = null;
  let coolingWake: Promise<void> | null = null;
  let wakeCooling: (() => void) | null = null;
  function clearCoolingTimer(): void {
    if (coolingTimer !== null) clearTimeout(coolingTimer);
    coolingTimer = null;
    wakeCooling?.();
    wakeCooling = null;
    coolingWake = null;
  }
  function waitForCooling(delay: number): void {
    clearCoolingTimer();
    coolingWake = new Promise<void>((resolve) => {
      wakeCooling = resolve;
    });
    coolingTimer = setTimeout(() => clearCoolingTimer(), delay);
  }
  // Stop wakes a wait immediately; the retained run promise still joins all actual commands.
  controller.signal.addEventListener('abort', clearCoolingTimer);
  function closeLease(): Promise<void> {
    if (closeWork) return closeWork;
    if (!plan) return Promise.resolve();
    const id = plan.planId;
    const attempt = Promise.resolve().then(() => host.close(id));
    closeWork = attempt;
    void attempt.catch(() => {
      if (closeWork === attempt) closeWork = null;
    });
    return closeWork;
  }
  async function settleCleanup(): Promise<void> {
    if (work) {
      // Joining a failed operation does not certify cleanup; its original caller
      // still receives that failure. The exact native close below is the proof.
      await work.catch(() => undefined);
      if (callbackCleanupFailure) throw callbackCleanupFailure.error;
      if (plan) {
        await closeLease();
        owned.clear();
        pending.length = 0;
        clearPublicationTimer();
        return;
      }
    }
    await stopPrepared();
  }
  function prepare(): Promise<BoundedScanResumePlan> {
    if (closed) return Promise.reject(refusal());
    if (preparation) return preparation;
    phase = 'admitting';
    notify();
    preparation = (async () => {
      try {
        plan = validateBoundedScanResumePlan(await host.admit(controller.signal));
        current = { ...plan.counts };
        baseline = { ...plan.counts };
        controller.signal.throwIfAborted();
        phase = 'paused';
        notify();
        return plan;
      } catch (error) {
        phase = controller.signal.aborted ? 'paused' : 'failed';
        failure = 'admission-failed';
        notify();
        throw error;
      }
    })();
    return preparation;
  }
  async function stopPrepared(): Promise<void> {
    let error: unknown;
    try {
      if (preparation) await preparation;
    } catch (e) {
      if (
        !(e instanceof Error && e.name === 'ScanAdmissionClosedError') &&
        !(controller.signal.aborted && e instanceof DOMException && e.name === 'AbortError')
      )
        error = e;
    }
    try {
      await closeLease();
      owned.clear();
      pending.length = 0;
      clearPublicationTimer();
    } catch (e) {
      failure = 'cleanup-unconfirmed';
      phase = 'failed';
      error = e;
    }
    notify();
    if (error) throw error;
  }
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const snapshot = (): Readonly<BoundedScanResumeSnapshot> =>
    freeze({
      phase,
      failure,
      counts: { ...current },
      revisions: plan ? { ...plan.revisions } : null,
      ownedReservations: owned.size,
      active: active.size,
      // Reservations only: excludes transient page/checker clones and all heap accounting.
      maxOwnedReservations,
      capabilityEnabled: false as const,
      observerFailed,
    });
  const notify = () => {
    try {
      options.onChange?.(snapshot());
    } catch {
      observerFailed = true;
    }
  };
  async function release(rows: readonly BoundedScanCandidateRow[]) {
    if (!rows.length || !plan) return;
    await host.release(
      plan.planId,
      rows.map((r) => r.reservationId),
      new AbortController().signal,
    );
    for (const r of rows) owned.delete(r.reservationId);
    notify();
  }
  async function flush() {
    if (!pending.length || !plan) return;
    const firstPositive =
      plan.commitWindow && !publishedThisEpisode
        ? pending.find((x) => ['Reachable', 'PlayedHere'].includes(x.observation.verdict))
        : undefined;
    const candidates = firstPositive
      ? [firstPositive, ...pending.filter((x) => x !== firstPositive)].slice(0, 16)
      : pending.slice(0, plan.commitWindow?.maxObservations ?? 64);
    const expectedRevisions = { ...plan.revisions };
    const requestFor = (batch: typeof pending): BoundedScanCommit => ({
      expectedRevisions,
      observations: batch.map((x) => ({
        candidateIndex: x.row.candidateIndex,
        observation: x.observation,
      })),
      publicationIndices: batch
        .filter((x) => ['Reachable', 'PlayedHere'].includes(x.observation.verdict))
        .map((x) => x.row.candidateIndex),
    });
    // Reserve a fixed small envelope budget for worker routing/request IDs.
    // Only byte-limit refusal shrinks a batch; malformed data is never hidden.
    const count = fitScanResumeCommitPrefix(candidates.length, (n) => ({
      schemaVersion: plan!.commitWindow ? 2 : 1,
      planId: plan!.planId,
      ...requestFor(candidates.slice(0, n)),
    }));
    if (!count) throw refusal();
    const batch = candidates
      .slice(0, count)
      .sort((a, b) => a.row.candidateIndex - b.row.candidateIndex);
    const request = freeze(requestFor(batch));
    const selected = new Set(batch);
    for (let i = pending.length - 1; i >= 0; i--)
      if (selected.has(pending[i]!)) pending.splice(i, 1);
    if (!pending.length) clearPublicationTimer();
    let confirmed = false;
    try {
      const ack = await host.commit(plan.planId, request, new AbortController().signal);
      fields(ack, [
        'committed',
        'planId',
        'catalogRevision',
        'healthRevision',
        'checkpointRevision',
        'acknowledgedIndices',
        'publicationIndices',
        'counts',
      ]);
      revisions({
        catalogRevision: ack.catalogRevision,
        healthRevision: ack.healthRevision,
        checkpointRevision: ack.checkpointRevision,
      });
      counts(ack.counts);
      const added = batch.filter((x) => x.row.work === 'probe');
      if (
        ack.committed !== true ||
        ack.planId !== plan.planId ||
        !Array.isArray(ack.acknowledgedIndices) ||
        !Array.isArray(ack.publicationIndices) ||
        !sameIndices(
          ack.acknowledgedIndices,
          batch.map((x) => x.row.candidateIndex),
        ) ||
        !sameIndices(ack.publicationIndices, request.publicationIndices) ||
        ack.counts.total !== baseline.total ||
        ack.counts.checked !== baseline.checked + added.length ||
        ack.counts.responded !==
          baseline.responded +
            added.filter((x) => ['Reachable', 'PlayedHere'].includes(x.observation.verdict))
              .length ||
        ack.counts.published !== baseline.published + request.publicationIndices.length ||
        BigInt(ack.catalogRevision) < BigInt(plan.revisions.catalogRevision) ||
        BigInt(ack.catalogRevision) > BigInt(plan.revisions.catalogRevision) + 1n ||
        BigInt(ack.healthRevision) < BigInt(plan.revisions.healthRevision) ||
        BigInt(ack.healthRevision) > BigInt(plan.revisions.healthRevision) + 1n ||
        BigInt(ack.checkpointRevision) !== BigInt(plan.revisions.checkpointRevision) + 1n
      )
        throw refusal();
      baseline = { ...ack.counts };
      publishedThisEpisode ||= request.publicationIndices.length > 0;
      current.published = ack.counts.published;
      plan = freeze({
        ...plan,
        counts: { ...baseline },
        revisions: {
          catalogRevision: ack.catalogRevision,
          healthRevision: ack.healthRevision,
          checkpointRevision: ack.checkpointRevision,
        },
      });
      confirmed = true;
      notify();
      await release(batch.map((x) => x.row));
    } catch (error) {
      if (confirmed) {
        failure = 'cleanup-unconfirmed';
        phase = 'failed';
      } else {
        uncertain = true;
        failure = 'commit-unconfirmed';
        phase = 'quarantined';
      }
      throw error;
    }
  }
  function launch(row: BoundedScanCandidateRow) {
    if (row.work === 'probe') probing.add(row.reservationId);
    const task = Promise.resolve().then(async () => {
      try {
        if (!plan) return;
        if (row.work === 'publish') {
          queueObservation({ row, observation: trusted(row.observation, row, plan) });
          return;
        }
        const policy = plan.sourcePolicies.find(
          (p) =>
            p.sourceId === row.candidate.sourceId &&
            p.fingerprint === row.candidate.sourceFingerprint,
        );
        if (!policy) throw refusal();
        let observed: HealthObservation | null = null;
        try {
          // Native owns this probe's deadline and exact held evidence. A generic
          // checker must never replace a refusal/late reply with invented evidence.
          let raw: HealthObservation;
          try {
            raw = await host.probe(row.candidate, controller.signal, plan.budgetMs, policy);
          } finally {
            // The network owner has joined. Deferral may still be awaiting its
            // acknowledgement; it must not keep an obsolete origin exclusion.
            probing.delete(row.reservationId);
          }
          if (controller.signal.aborted) return;
          observed = trusted(raw, row, plan);
        } catch (error) {
          // The original native command and cancellation have settled in the host.
          // A failed cancellation join remains cleanup uncertainty, even on Stop.
          if (controller.signal.aborted) {
            // A refusal that settled (for example the native side was already
            // closing) left nothing running; only an unacknowledged
            // cancellation is cleanup uncertainty.
            if (!(
              error instanceof Error &&
              (error.name === 'AbortError' || error.name === 'BoundedCallbackSettled')
            )) {
              failure = 'cleanup-unconfirmed';
              callbackCleanupFailure = { error };
              fatal = error;
              throw error;
            }
            return;
          }
          // Refusal is not proof that the destination failed.
        }
        if (!observed || ['NotChecked', 'Canceled'].includes(observed.verdict)) {
          failure = 'probe-unconfirmed';
          if (controller.signal.aborted) return;
          try {
            await host.defer(plan.planId, [row.reservationId], controller.signal);
          } catch (error) {
            failure = 'cleanup-unconfirmed';
            fatal = error;
            throw error;
          }
          owned.delete(row.reservationId);
          notify();
          return;
        }
        queueObservation({ row, observation: observed });
        current.checked++;
        if (['Reachable', 'PlayedHere'].includes(observed.verdict)) current.responded++;
        notify();
      } catch (error) {
        if (!controller.signal.aborted) {
          fatal = error;
          controller.abort();
        }
      } finally {
        probing.delete(row.reservationId);
        active.delete(row.reservationId);
        notify();
      }
    });
    active.set(row.reservationId, task);
    notify();
  }
  async function run() {
    let operationError: unknown = null;
    try {
      plan = await prepare();
      controller.signal.throwIfAborted();
      phase = 'checking';
      notify();
      let exhausted = false;
      let capacityBlocked = false;
      while (!controller.signal.aborted) {
        const firstPositive =
          plan.commitWindow &&
          !publishedThisEpisode &&
          pending.some((x) => ['Reachable', 'PlayedHere'].includes(x.observation.verdict));
        if (
          pending.length >= (plan.commitWindow?.maxObservations ?? 64) ||
          firstPositive ||
          (pending.length && (publicationDue || capacityBlocked))
        ) {
          await flush();
          capacityBlocked = false;
          continue;
        }
        if (exhausted && active.size === 0) break;
        // Sixteen checks at once, under the native request ceiling; at most
        // two on any one site (the native scheduler enforces both).
        const slots = Math.min(
          scanResumeCommitWindow.maxActiveProbes - active.size,
          256 - owned.size,
        );
        if (!exhausted && !capacityBlocked && !coolingWake && slots > 0) {
          const perOrigin = new Map<string, number>();
          for (const id of probing)
            if (owned.has(id)) {
              const origin = owned.get(id)!.originToken;
              perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + 1);
            }
          const blocked = [...perOrigin]
            .filter(([, count]) => count >= MAX_PROBES_PER_ORIGIN)
            .map(([origin]) => origin);
          const activeBeforeTake = active.size;
          const page = validateBoundedScanCandidatePage(
            await host.take(
              plan.planId,
              { limit: slots, blockedOrigins: blocked },
              controller.signal,
            ),
            plan,
            slots,
            blocked,
          );
          // A late admitted page is still owned and released even when cancellation wins.
          for (const row of page.rows) {
            if (
              owned.has(row.reservationId) ||
              [...owned.values()].some(
                (r) =>
                  r.candidateIndex === row.candidateIndex || r.candidate.key === row.candidate.key,
              )
            )
              throw refusal();
            owned.set(row.reservationId, row);
          }
          maxOwnedReservations = Math.max(maxOwnedReservations, owned.size);
          if (owned.size > 256) throw refusal();
          if (controller.signal.aborted) break;
          exhausted = page.exhausted;
          capacityBlocked = page.capacityBlocked === true;
          if (page.coolingDelayMs !== undefined) waitForCooling(page.coolingDelayMs);
          for (const row of page.rows) launch(row);
          if (!page.rows.length && !exhausted && !active.size && !pending.length && !coolingWake)
            throw capacityBlocked ? new Error('scan-resume-candidate-too-large') : refusal();
          if (page.rows.length) continue;
          // Every site was busy when asked, and those checks settled meanwhile:
          // ask again (they may be cooling) rather than save a small batch early.
          if (activeBeforeTake && !active.size && !coolingWake && !capacityBlocked && !exhausted)
            continue;
        }
        if (active.size || coolingWake) {
          const waits = [...active.values()];
          if (coolingWake) waits.push(coolingWake);
          if (publicationWake) waits.push(publicationWake);
          await Promise.race(waits);
          // A settled probe can make another origin eligible; replace the old hint on the next Take.
          clearCoolingTimer();
        } else if (pending.length) {
          await flush();
          capacityBlocked = false;
        }
      }
      await Promise.all(active.values());
      if (fatal) throw fatal;
      while (pending.length) await flush();
      phase =
        controller.signal.aborted ||
        current.checked < current.total ||
        current.published < current.responded
          ? 'paused'
          : 'completed';
    } catch (error) {
      operationError = error;
      if (!uncertain) {
        phase = controller.signal.aborted ? 'paused' : 'failed';
        if (failure === 'none') failure = 'admission-failed';
      }
    } finally {
      clearCoolingTimer();
      clearPublicationTimer();
      controller.abort();
      await Promise.all(active.values());
      try {
        if (!uncertain) {
          while (pending.length) await flush();
          await release([...owned.values()]);
        }
      } catch (error) {
        if (!operationError) operationError = error;
        failure = 'cleanup-unconfirmed';
        if (!uncertain) phase = 'failed';
      }
      // A failed flush/release must not prevent closing the native owner.
      try {
        if (plan) {
          await closeLease();
          owned.clear();
          pending.length = 0;
          clearPublicationTimer();
        }
      } catch (error) {
        if (!operationError) operationError = error;
        failure = 'cleanup-unconfirmed';
        if (!uncertain) phase = 'failed';
      }
      clearPublicationTimer();
      options.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', clearCoolingTimer);
      notify();
    }
    if (operationError && !controller.signal.aborted) throw operationError;
    // Real cleanup/storage uncertainty remains a rejection, even after lifecycle abort.
    if (uncertain || failure === 'cleanup-unconfirmed' || phase === 'failed')
      throw operationError ?? refusal();
  }
  return {
    snapshot,
    prepare,
    start(): Promise<void> {
      if (started || closed) throw refusal();
      started = true;
      work = run();
      return work;
    },
    async suspend(): Promise<void> {
      controller.abort();
      if (!work) closed = true;
      await settleCleanup();
    },
    async dispose(): Promise<void> {
      closed = true;
      controller.abort();
      try {
        await settleCleanup();
      } finally {
        clearPublicationTimer();
        options.signal?.removeEventListener('abort', abort);
        if (!uncertain && failure !== 'cleanup-unconfirmed') phase = 'disposed';
        notify();
      }
    },
  };
}
