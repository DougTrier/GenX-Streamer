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

import {
  validateBoundedScanResumePlan,
  validateBoundedScanCandidatePage,
  type BoundedScanResumeHost,
  type BoundedScanResumePlan,
  type BoundedScanResumeSnapshot,
  type BoundedScanCandidateRow,
  type BoundedScanCommit,
} from './bounded-scan-resume';
import {
  validateResumeWire,
  validateResumeSnapshot,
  type ResumeCall,
  type ResumeControl,
  type ResumeWire,
} from './bounded-scan-resume-protocol';
import { boundedJsonUtf8Bytes } from '../../data-transfer/json-byte-admission';
export type BoundedResumeWorkerTransport = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>;
export type BoundedScanServiceReason =
  | 'none'
  | 'wire-invalid'
  | 'message-kind'
  | 'duplicate-call'
  | 'callback-capacity'
  | 'operation-capacity'
  | 'admit-state'
  | 'missing-plan'
  | 'probe-binding'
  | 'plan-binding'
  | 'argument-count'
  | 'take-request'
  | 'reservation-binding'
  | 'commit-request'
  | 'commit-bytes'
  | 'host-refused'
  | 'worker-error'
  | 'worker-message-error'
  | 'control-reply'
  | 'reply-post';
export interface BoundedScanServiceDiagnostic {
  readonly generation: number;
  readonly stage:
    | 'wire-validation'
    | 'call-admission'
    | 'call-validation'
    | 'host-dispatch'
    | 'host-refusal'
    | 'worker-failure';
  readonly operation: ResumeCall | 'unknown';
  readonly reason: BoundedScanServiceReason;
  readonly activeCallbacks: number;
  readonly ownedRows: number;
}
let generations = 0;
const bad = () => new Error('Bounded scan worker unavailable.');
const initial: BoundedScanResumeSnapshot = Object.freeze({
  phase: 'idle',
  failure: 'none',
  counts: Object.freeze({ total: 0, checked: 0, responded: 0, published: 0 }),
  revisions: null,
  ownedReservations: 0,
  active: 0,
  maxOwnedReservations: 0,
  capabilityEnabled: false,
  observerFailed: false,
});
export function createBoundedScanResumeService(
  host: BoundedScanResumeHost,
  options: {
    workerFactory?: () => BoundedResumeWorkerTransport;
    signal?: AbortSignal;
    onDiagnostic?(event: Readonly<BoundedScanServiceDiagnostic>): void;
  } = {},
) {
  const generation = ++generations;
  if (!Number.isSafeInteger(generation)) throw bad();
  const worker = (
    options.workerFactory ??
    (() =>
      new Worker(new URL('./bounded-scan-resume-worker.ts', import.meta.url), { type: 'module' }))
  )();
  let sequence = 0,
    started = false,
    preparedRequested = false,
    disposing = false,
    stopped = false,
    broken = false,
    observerFailed = false,
    maxCallbacks = 0,
    current = initial,
    plan: BoundedScanResumePlan | null = null;
  let cleanup: Promise<void> | null = null;
  let closeWork: Promise<void> | null = null;
  let prepareWork: Promise<BoundedScanResumePlan> | null = null;
  const controls = new Map<
    number,
    { resolve: (value?: unknown) => void; reject: (e: Error) => void }
  >();
  const calls = new Map<
    number,
    { controller: AbortController; operation: ResumeCall; work: Promise<void> }
  >();
  const rows = new Map<string, BoundedScanCandidateRow>(),
    listeners = new Set<(value: ReturnType<typeof snapshot>) => void>();
  let lastEvents: readonly Readonly<BoundedScanServiceDiagnostic>[] = Object.freeze([]);
  let lastFailure: Readonly<BoundedScanServiceDiagnostic> | null = null;
  let failureCount = 0;
  function diagnose(
    stage: BoundedScanServiceDiagnostic['stage'],
    operation: BoundedScanServiceDiagnostic['operation'],
    reason: BoundedScanServiceReason,
  ) {
    const event = Object.freeze({
      generation,
      stage,
      operation,
      reason,
      activeCallbacks: calls.size,
      ownedRows: rows.size,
    });
    lastEvents = Object.freeze([...lastEvents.slice(-1), event]);
    if (reason !== 'none') {
      lastFailure = event;
      failureCount = Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1);
    }
    try {
      options.onDiagnostic?.(event);
    } catch {
      /* Diagnostics never own a callback. */
    }
  }
  function diagnostics() {
    return Object.freeze({ generation, lastEvents, lastFailure, failureCount });
  }
  function snapshot() {
    return Object.freeze({
      ...current,
      observerFailed: current.observerFailed || observerFailed,
      activeCallbacks: calls.size,
      maxActiveCallbacks: maxCallbacks,
      workerStopped: stopped,
      quarantined: broken || current.phase === 'quarantined',
    });
  }
  function notify() {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        observerFailed = true;
      }
    }
  }
  const post = (message: ResumeWire) => {
    if (!stopped) worker.postMessage(message);
  };
  function closeLease(): Promise<void> {
    if (closeWork) return closeWork;
    if (!plan) return Promise.reject(bad());
    const id = plan.planId;
    const attempt = Promise.resolve()
      .then(() => host.close(id))
      .then(() => {
        rows.clear();
      });
    closeWork = attempt;
    void attempt.catch(() => {
      if (closeWork === attempt) closeWork = null;
    });
    return attempt;
  }
  function beginCleanup(): Promise<void> {
    if (cleanup) return cleanup;
    if (stopped) return Promise.resolve();
    disposing = true;
    const attempt = (async () => {
      let controlError: unknown;
      if (!broken) {
        try {
          await control('dispose');
        } catch (error) {
          controlError = error;
        }
      }
      await Promise.allSettled([...calls.values()].map((call) => call.work));
      if (plan) await closeLease();
      else if (controlError || broken) throw controlError ?? bad();
      if (controlError) throw controlError;
      finish();
    })();
    cleanup = attempt;
    void attempt.catch(() => {
      // Retain the worker, exact plan and rows until an actual close succeeds.
      // A later disposal may retry only after this attempt has settled.
      if (cleanup === attempt) cleanup = null;
    });
    return attempt;
  }
  function finish() {
    if (stopped) return;
    stopped = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    rows.clear();
    options.signal?.removeEventListener('abort', aborted);
    notify();
    listeners.clear();
  }
  function fail() {
    if (broken) return;
    broken = true;
    for (const c of controls.values()) c.reject(bad());
    controls.clear();
    for (const c of calls.values()) c.controller.abort();
    current = Object.freeze({ ...current, phase: 'quarantined', failure: 'cleanup-unconfirmed' });
    void beginCleanup().catch(() => undefined);
    notify();
  }
  function control(operation: ResumeControl): Promise<unknown> {
    if (stopped || broken) return Promise.reject(bad());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      controls.set(id, { resolve, reject });
      try {
        post({ kind: 'control', operation, generation, sequence: id });
      } catch {
        fail();
      }
    });
  }
  function same(a: unknown, b: unknown) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  let validationStage: BoundedScanServiceReason = 'argument-count';
  function validateCall(operation: ResumeCall, args: unknown[]) {
    validationStage = 'admit-state';
    if (operation === 'admit') {
      if ((!started && !preparedRequested) || plan || args.length) throw bad();
      return;
    }
    validationStage = 'missing-plan';
    if (!plan) throw bad();
    if (operation === 'probe') {
      validationStage = 'probe-binding';
      if (args.length !== 3) throw bad();
      const c = args[0] as BoundedScanCandidateRow['candidate'];
      const row = [...rows.values()].find((r) => r.candidate.key === c?.key);
      const policy = plan.sourcePolicies.find(
        (p) => p.sourceId === c?.sourceId && p.fingerprint === c?.sourceFingerprint,
      );
      if (
        !row ||
        row.work !== 'probe' ||
        !same(row.candidate, c) ||
        !policy ||
        !same(policy, args[2]) ||
        args[1] !== plan.budgetMs
      )
        throw bad();
      return;
    }
    validationStage = 'plan-binding';
    if (args[0] !== plan.planId) throw bad();
    if (operation === 'close') {
      if (args.length !== 1) throw bad();
      return;
    }
    validationStage = 'argument-count';
    if (args.length !== 2) throw bad();
    if (operation === 'take') {
      validationStage = 'take-request';
      const r = args[1] as { limit: number; blockedOrigins: string[] };
      if (
        !r ||
        Object.keys(r).length !== 2 ||
        !Number.isInteger(r.limit) ||
        r.limit < 1 ||
        r.limit > 16 ||
        !Array.isArray(r.blockedOrigins) ||
        r.blockedOrigins.length > 16 ||
        new Set(r.blockedOrigins).size !== r.blockedOrigins.length ||
        r.blockedOrigins.some(
          (v) =>
            typeof v !== 'string' ||
            v.length > 128 ||
            ![...rows.values()].some((row) => row.originToken === v),
        )
      )
        throw bad();
      return;
    }
    if (operation === 'release' || operation === 'defer') {
      validationStage = 'reservation-binding';
      const ids = args[1];
      if (
        !Array.isArray(ids) ||
        ids.length > 256 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !rows.has(id))
      )
        throw bad();
      return;
    }
    validationStage = 'commit-request';
    const r = args[1] as BoundedScanCommit;
    if (
      !r ||
      Object.keys(r).length !== 3 ||
      !Object.hasOwn(r, 'expectedRevisions') ||
      !Array.isArray(r.observations) ||
      !r.observations.length ||
      r.observations.length > (plan.commitWindow?.maxObservations ?? 64) ||
      !Array.isArray(r.publicationIndices) ||
      r.publicationIndices.length > (plan.commitWindow?.maxObservations ?? 64) ||
      new Set(r.observations.map((o) => o.candidateIndex)).size !== r.observations.length ||
      new Set(r.publicationIndices).size !== r.publicationIndices.length ||
      r.observations.some(
        (o) =>
          !o ||
          Object.keys(o).length !== 2 ||
          ![...rows.values()].some(
            (row) =>
              row.candidateIndex === o.candidateIndex &&
              row.candidate.key === o.observation?.channelId,
          ),
      ) ||
      r.publicationIndices.some(
        (i) =>
          !r.observations.some(
            (o) =>
              o.candidateIndex === i && ['Reachable', 'PlayedHere'].includes(o.observation.verdict),
          ),
      )
    )
      throw bad();
    validationStage = 'commit-bytes';
    boundedJsonUtf8Bytes(r, 1024 * 1024);
  }
  async function invoke(
    operation: ResumeCall,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (operation === 'admit') {
      const result = validateBoundedScanResumePlan(await host.admit(signal));
      plan = result;
      return result;
    }
    if (!plan) throw bad();
    const id = plan.planId;
    if (operation === 'take') {
      const request = args[1] as { limit: number; blockedOrigins: string[] };
      const page = validateBoundedScanCandidatePage(
        await host.take(id, request, signal),
        plan,
        request.limit,
        request.blockedOrigins,
      );
      for (const row of page.rows) {
        if (
          rows.has(row.reservationId) ||
          [...rows.values()].some((r) => r.candidateIndex === row.candidateIndex)
        )
          throw bad();
        rows.set(row.reservationId, row);
      }
      if (rows.size > 256) throw bad();
      return page;
    }
    if (operation === 'probe')
      return host.probe(
        args[0] as BoundedScanCandidateRow['candidate'],
        signal,
        args[1] as BoundedScanResumePlan['budgetMs'],
        args[2] as BoundedScanResumePlan['sourcePolicies'][number],
      );
    if (operation === 'commit') return host.commit(id, args[1] as BoundedScanCommit, signal);
    if (operation === 'close') {
      await closeLease();
      return;
    }
    const ids = args[1] as string[];
    await host[operation](id, ids, signal);
    for (const r of ids) rows.delete(r);
  }
  worker.onmessage = (event) => {
    const stale =
      event.data && typeof event.data === 'object'
        ? Object.getOwnPropertyDescriptor(event.data, 'generation')
        : null;
    if (
      stale &&
      'value' in stale &&
      Number.isSafeInteger(stale.value) &&
      stale.value !== generation
    )
      return;
    let message: ResumeWire;
    try {
      message = validateResumeWire(event.data);
    } catch {
      diagnose('wire-validation', 'unknown', 'wire-invalid');
      fail();
      return;
    }
    if (message.generation !== generation) return;
    if (broken || stopped) return;
    if (message.kind === 'snapshot') {
      current = validateResumeSnapshot(message.value);
      notify();
      return;
    }
    if (message.kind === 'done') {
      const target = controls.get(message.sequence);
      if (!target) {
        diagnose('worker-failure', 'unknown', 'control-reply');
        fail();
        return;
      }
      controls.delete(message.sequence);
      if (message.ok) target.resolve(message.value);
      else target.reject(bad());
      return;
    }
    if (message.kind === 'cancel') {
      const call = calls.get(message.sequence);
      if (call) call.controller.abort();
      return;
    }
    if (message.kind !== 'call') {
      diagnose('call-admission', 'unknown', 'message-kind');
      fail();
      return;
    }
    const maximum = message.operation === 'probe' || message.operation === 'defer' ? 16 : 1;
    if (
      calls.has(message.sequence) ||
      calls.size >= 64 ||
      [...calls.values()].filter((c) => c.operation === message.operation).length >= maximum
    ) {
      diagnose(
        'call-admission',
        message.operation,
        calls.has(message.sequence)
          ? 'duplicate-call'
          : calls.size >= 64
            ? 'callback-capacity'
            : 'operation-capacity',
      );
      fail();
      return;
    }
    try {
      validateCall(message.operation, message.args);
    } catch {
      diagnose('call-validation', message.operation, validationStage);
      fail();
      return;
    }
    const controller = new AbortController();
    const work = Promise.resolve().then(async () => {
      let hostSettled = false;
      try {
        diagnose('host-dispatch', message.operation, 'none');
        const value = await invoke(message.operation, message.args, controller.signal);
        hostSettled = true;
        boundedJsonUtf8Bytes(value ?? null, 1024 * 1024);
        post({
          kind: 'reply',
          generation,
          sequence: message.sequence,
          ok: true,
          ...(value === undefined ? {} : { value }),
        });
      } catch (error) {
        diagnose('host-refusal', message.operation, hostSettled ? 'reply-post' : 'host-refused');
        post({
          kind: 'reply',
          generation,
          sequence: message.sequence,
          ok: false,
          failure:
            message.operation === 'admit' &&
            error instanceof Error &&
            error.name === 'ScanAdmissionClosedError'
              ? 'admission-closed'
              : controller.signal.aborted &&
                  error instanceof DOMException &&
                  error.name === 'AbortError'
                ? 'canceled'
                : error instanceof Error &&
                    error.message === 'Native command cancellation could not be confirmed.'
                  ? 'cancel-unconfirmed'
                  : 'callback-failed',
        });
      } finally {
        calls.delete(message.sequence);
        notify();
      }
    });
    calls.set(message.sequence, { controller, operation: message.operation, work });
    maxCallbacks = Math.max(maxCallbacks, calls.size);
    notify();
  };
  worker.onerror = () => {
    diagnose('worker-failure', 'unknown', 'worker-error');
    fail();
  };
  worker.onmessageerror = () => {
    diagnose('worker-failure', 'unknown', 'worker-message-error');
    fail();
  };
  const aborted = () => {
    void service.suspend().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  const service = {
    snapshot,
    diagnostics,
    prepare(): Promise<BoundedScanResumePlan> {
      if (disposing || stopped || broken || options.signal?.aborted) return Promise.reject(bad());
      if (prepareWork) return prepareWork;
      if (started) return Promise.reject(bad());
      preparedRequested = true;
      prepareWork = control('prepare').then(validateBoundedScanResumePlan);
      return prepareWork;
    },
    subscribe(listener: (value: ReturnType<typeof snapshot>) => void) {
      if (stopped) throw bad();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): Promise<void> {
      if (started || disposing || options.signal?.aborted) return Promise.reject(bad());
      started = true;
      return control('start').then(() => undefined);
    },
    suspend(): Promise<void> {
      if (!started && !preparedRequested) return Promise.resolve();
      if (broken) return cleanup ?? Promise.reject(bad());
      if (stopped) return Promise.resolve();
      return control('suspend').then(() => undefined);
    },
    dispose(): Promise<void> {
      return beginCleanup();
    },
  };
  return service;
}
