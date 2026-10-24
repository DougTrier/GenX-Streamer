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

import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import { validateSource, type Source } from '../catalog';
import {
  validateBoundedScanResumePlan,
  validateBoundedScanCandidatePage,
  validateScanResumeCommitWindow,
  scanResumeCommitWindow,
  scanResumeTakeTiming,
  validateScanResumeTakeTiming,
  type BoundedScanResumeHost,
  type BoundedScanResumePlan,
  type BoundedScanAck,
  type BoundedScanCommit,
} from '../application/bounded-scan-resume';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { createHealthObservation, type HealthObservation } from '../discovery/health';
const bad = () => new Error('Native bounded scan resume response refused.');
const decimal = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const nativeDiagnosticCodes = [
  'catalog-cas',
  'catalog-compact-scope-invalid',
  'catalog-endpoint-database-failed',
  'catalog-endpoint-invalid',
  'catalog-endpoint-invalid-scope',
  'catalog-endpoint-limit',
  'catalog-fixture',
  'catalog-group-database-failed',
  'catalog-group-invalid',
  'catalog-group-invalid-category',
  'catalog-group-invalid-request',
  'catalog-group-invalid-revision',
  'catalog-group-preference-limit',
  'catalog-group-preferences-required',
  'catalog-group-revision-stale',
  'catalog-group-selection-stale',
  'catalog-invalid',
  'catalog-invalid-channels',
  'catalog-projection-invalid-scope',
  'catalog-query-cancelled',
  'catalog-query-cleanup-failed',
  'catalog-query-count-limit',
  'catalog-query-cursor-stale',
  'catalog-query-database-failed',
  'catalog-query-encoding-failed',
  'catalog-query-invalid',
  'catalog-query-invalid-cursor',
  'catalog-query-invalid-geography',
  'catalog-query-invalid-ordinal',
  'catalog-query-invalid-revision',
  'catalog-query-projection-stale',
  'catalog-query-response-limit',
  'catalog-query-worker-failed',
  'catalog-revision-exhausted',
  'catalog-revision-invalid',
  'catalog-revision-required',
  'catalog-revision-stale',
  'catalog-view-revision-exhausted',
  'catalog-view-revision-stale',
  'health-cas',
  'health-duplicate-record',
  'health-encoding-failed',
  'health-invalid-catalog',
  'health-invalid-evidence',
  'health-invalid-integer',
  'health-invalid-interval',
  'health-invalid-json',
  'health-invalid-record',
  'health-invalid-sample',
  'health-invalid-status',
  'health-invalid-stored-record',
  'health-revision-invalid',
  'health-revision-required',
  'health-revision-stale',
  'health-sqlite-failed',
  'health-stored-target-mismatch',
  'health-target',
  'health-target-invalid',
  'health-target-mismatch',
  'health-target-v1',
  'health-too-large',
  'health-unsupported-schema',
  'record-array-too-large',
  'record-category-override-limit',
  'record-duplicate-channel',
  'record-duplicate-provider',
  'record-duplicate-source',
  'record-duplicate-url',
  'record-encoding-failed',
  'record-invalid-array',
  'record-invalid-automatic-guide-updates',
  'record-invalid-category-override',
  'record-invalid-content-kind',
  'record-invalid-content-library',
  'record-invalid-field',
  'record-invalid-geography',
  'record-invalid-geography-provenance',
  'record-invalid-http-grant',
  'record-invalid-identity',
  'record-invalid-json',
  'record-invalid-mime',
  'record-invalid-panel',
  'record-invalid-preferences',
  'record-invalid-preferred-region',
  'record-invalid-provider',
  'record-invalid-provider-array',
  'record-invalid-provider-field',
  'record-invalid-provider-http',
  'record-invalid-provider-url',
  'record-invalid-source-kind',
  'record-invalid-source-refresh',
  'record-invalid-url',
  'record-invalid-voice-consent',
  'record-invalid-volume',
  'record-missing-source',
  'record-missing-url',
  'record-orphaned-channel-url',
  'record-provider-limit',
  'record-source-mirror-mismatch',
  'record-too-large',
  'record-unsupported-schema',
  'request-canceled',
  'request-generation-exhausted',
  'request-limit-unverified',
  'request-lock',
  'scan-checkpoint-absent',
  'scan-checkpoint-advance-requires-v2',
  'scan-checkpoint-advance-unavailable',
  'scan-checkpoint-clear-required',
  'scan-checkpoint-continue-required',
  'scan-checkpoint-expired',
  'scan-checkpoint-full-recheck-empty',
  'scan-checkpoint-invalid',
  'scan-checkpoint-job-stale',
  'scan-checkpoint-policy-stale',
  'scan-checkpoint-preferences-required',
  'scan-checkpoint-progress-conflict',
  'scan-checkpoint-progress-stale',
  'scan-checkpoint-revision-exhausted',
  'scan-checkpoint-revision-invalid',
  'scan-checkpoint-revision-required',
  'scan-checkpoint-revision-stale',
  'scan-checkpoint-source-not-resumable',
  'scan-checkpoint-storage-failed',
  'scan-checkpoint-target-validation-limit',
  'scan-checkpoint-too-large',
  'scan-checkpoint-unpublished-channel',
  'scan-resume-cache-capacity',
  'scan-resume-cache-conflict',
  'scan-resume-cache-full',
  'scan-resume-candidate-stale',
  'scan-resume-candidate-too-large',
  'scan-resume-clock-invalid',
  'scan-resume-commit-invalid',
  'scan-resume-commit-stale',
  'scan-resume-commit-too-large',
  'scan-resume-directory-mismatch',
  'scan-resume-header-limit',
  'scan-resume-http-grant-required',
  'scan-resume-immutable-stale',
  'scan-resume-observation-unconfirmed',
  'scan-resume-owner-busy',
  'scan-resume-owner-closed',
  'scan-resume-owner-invalid',
  'scan-resume-owner-quarantined',
  'scan-resume-page-invalid',
  'scan-resume-page-limit',
  'scan-resume-plan-invalid',
  'scan-resume-plan-quarantined',
  'scan-resume-plan-stale',
  'scan-resume-plan-unavailable',
  'scan-resume-probe-capacity',
  'scan-resume-probe-invalid',
  'scan-resume-probe-stale',
  'scan-resume-probe-unjoined',
  'scan-resume-profile-stale',
  'scan-resume-progress-conflict',
  'scan-resume-projection-entry-too-large',
  'scan-resume-projection-invalid',
  'scan-resume-projection-stale',
  'scan-resume-projection-unavailable',
  'scan-resume-publication-unconfirmed',
  'scan-resume-random-failed',
  'scan-resume-reconcile-invalid',
  'scan-resume-registry-lock',
  'scan-resume-release-invalid',
  'scan-resume-request-invalid',
  'scan-resume-stop-unconfirmed',
  'scan-resume-take-busy',
  'scan-resume-take-invalid',
  'scan-resume-work-invalid',
  'source-snapshot-ambiguity-invalid',
  'source-snapshot-ambiguity-too-large',
  'source-snapshot-clock-invalid',
  'source-snapshot-count-coverage-stale',
  'source-snapshot-count-version-unsupported',
  'source-snapshot-evidence-stale',
  'source-snapshot-incomplete',
  'source-snapshot-invalid',
  'source-snapshot-order-stale',
  'source-snapshot-permission-stale',
  'source-snapshot-retention-limit',
  'source-snapshot-revision-stale',
  'source-snapshot-runtime-profile-invalid',
  'source-snapshot-source-limit',
  'source-snapshot-source-refused',
  'source-snapshot-stage-absent',
  'source-snapshot-too-large',
  'source-snapshot-version-unsupported',
  'sqlite-backup-failed',
  'sqlite-chunk-backup-dbpage-unavailable',
  'sqlite-chunk-backup-quota',
  'sqlite-chunk-backup-refused',
  'sqlite-create-failed',
  'sqlite-incomplete-archive-bookmark-schema',
  'sqlite-incomplete-archive-schema',
  'sqlite-integrity-failed',
  'sqlite-invalid-archive-bookmarks',
  'sqlite-invalid-geography',
  'sqlite-local-volume-required',
  'sqlite-operation-failed',
  'sqlite-page-size-invalid',
  'sqlite-recovery-failed',
  'sqlite-recovery-inspection-failed',
  'sqlite-recovery-journal-present',
  'sqlite-recovery-unavailable',
  'sqlite-required-database-missing',
  'sqlite-storage-busy',
  'sqlite-busy',
  'network-concurrency-limit',
  'sqlite-storage-full',
  'sqlite-storage-stat-invalid',
  'sqlite-unsupported-automatic-guide-updates',
  'sqlite-unsupported-category-overrides',
  'sqlite-unsupported-schema',
  'sqlite-verification-worker-failed',
  'storage-bookmark-invalid',
  'storage-bookmark-unavailable',
  'storage-choice-busy',
  'storage-choice-canceled',
  'storage-choice-directory-unavailable',
  'storage-choice-invalid-location',
  'storage-choice-platform-unavailable',
  'storage-choices',
  'storage-directory-invalid',
  'storage-directory-read-only',
  'storage-directory-unavailable',
  'storage-explicit-environment-restart-required',
  'storage-failed',
  'storage-generation-exhausted',
  'storage-healthy-switch-refused',
  'storage-initializing',
  'storage-link-refused',
  'storage-lock',
  'storage-not-ready',
  'storage-read-failed',
  'storage-recovery-stop-unconfirmed',
  'storage-revision-exhausted',
  'storage-revision-invalid',
  'storage-startup-already-started',
  'storage-startup-obsolete',
  'storage-startup-worker-failed',
  'storage-unavailable',
  'storage-worker-failed',
  'storage-writer-lock',
] as const;
export type KnownBoundedNativeFailureCode = (typeof nativeDiagnosticCodes)[number];
export type BoundedScanCommand =
  | 'take_scan_resume_candidates'
  | 'probe_scan_resume_candidate'
  | 'commit_scan_resume_candidates'
  | 'defer_scan_resume_candidates'
  | 'release_scan_resume_candidates'
  | 'close_scan_resume_plan';
export interface BoundedScanTransportDiagnostic {
  readonly command: BoundedScanCommand;
  readonly stage:
    | 'local-validation'
    | 'native-dispatch'
    | 'native-refusal'
    | 'response-validation'
    | 'response-accepted';
  readonly code:
    | KnownBoundedNativeFailureCode
    | 'bounded-request-invalid'
    | 'bounded-response-invalid'
    | 'native-refusal-unclassified'
    | null;
}
/** Staged transport only. Explicit native capability is required by the root integration. */
export function createBoundedNativeScanResumeTransport(options: {
  runtime: OwnedNativeRuntime;
  currentFence: () => { expectedCatalogRevision: string; expectedCheckpointRevision: string };
  onDiagnostic?(event: Readonly<BoundedScanTransportDiagnostic>): void;
}) {
  let plan: BoundedScanResumePlan | null = null;
  let sources: readonly Source[] = Object.freeze([]);
  let closed = false;
  let commitWindow: typeof scanResumeCommitWindow | undefined;
  let takeTiming: typeof scanResumeTakeTiming | undefined;
  const diagnose = (event: BoundedScanTransportDiagnostic) => {
    try {
      options.onDiagnostic?.(Object.freeze(event));
    } catch {
      // Observations never replace an original command/validation outcome.
    }
  };
  function active(id?: string) {
    if (closed || !plan || (id !== undefined && id !== plan.planId)) throw bad();
    return plan;
  }
  const rpc = <T>(
    command: BoundedScanCommand,
    request: Record<string, unknown>,
    signal: AbortSignal | undefined,
    validate: (raw: unknown) => T,
    durable = false,
  ) =>
    invokeOwnedNative(
      {
        ...options.runtime,
        async invoke(actualCommand, args) {
          if (actualCommand === command)
            diagnose({ command, stage: 'native-dispatch', code: null });
          try {
            return await options.runtime.invoke(actualCommand, args);
          } catch (error) {
            if (actualCommand === command)
              diagnose({
                command,
                stage: 'native-refusal',
                code:
                  typeof error === 'string' &&
                  (nativeDiagnosticCodes as readonly string[]).includes(error)
                    ? (error as KnownBoundedNativeFailureCode)
                    : 'native-refusal-unclassified',
              });
            throw error;
          }
        },
      },
      command,
      { request: { schemaVersion: 1, ...request } },
      {
        signal,
        durable,
        validate(raw) {
          try {
            const result = validate(raw);
            diagnose({ command, stage: 'response-accepted', code: null });
            return result;
          } catch (error) {
            diagnose({ command, stage: 'response-validation', code: 'bounded-response-invalid' });
            throw error;
          }
        },
      },
    );
  const host: BoundedScanResumeHost = {
    admit: async (signal) => {
      if (closed || plan) throw bad();
      const fence = options.currentFence();
      if (
        !decimal(fence.expectedCatalogRevision) ||
        !decimal(fence.expectedCheckpointRevision) ||
        Object.keys(fence).length !== 2
      )
        throw bad();
      let admitted: BoundedScanResumePlan;
      const openingRequestId = (options.runtime.idFactory ?? (() => crypto.randomUUID()))();
      try {
        admitted = await invokeOwnedNative(
          { ...options.runtime, idFactory: () => openingRequestId },
          'open_scan_resume_plan',
          { request: { schemaVersion: 1, ...fence } },
          {
            signal,
            validate: (raw) => {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
              const header = raw as Record<string, unknown>;
              // These are local negotiated permissions, never authority carried by a raw header.
              if (Object.hasOwn(header, 'commitWindow') || Object.hasOwn(header, 'takeTiming'))
                throw bad();
              if (!Array.isArray(header.sourcePolicies) || header.sourcePolicies.length > 100)
                throw bad();
              const canonical: Source[] = [];
              const policies = header.sourcePolicies.map((value) => {
                if (!value || typeof value !== 'object' || Object.keys(value).length !== 3)
                  throw bad();
                const p = value as {
                  source: unknown;
                  definitionFingerprint: unknown;
                  capturedFingerprint: unknown;
                };
                if (
                  typeof p.definitionFingerprint !== 'string' ||
                  !/^[a-f0-9]{64}$/.test(p.definitionFingerprint) ||
                  typeof p.capturedFingerprint !== 'string'
                )
                  throw bad();
                if (
                  !p.source ||
                  typeof p.source !== 'object' ||
                  Object.keys(p.source).some(
                    (k) =>
                      ![
                        'id',
                        'name',
                        'kind',
                        'location',
                        'allowHttp',
                        'contentKind',
                        'mediaMime',
                      ].includes(k),
                  )
                )
                  throw bad();
                const source = Object.freeze(validateSource(p.source));
                canonical.push(source);
                return {
                  sourceId: source.id,
                  fingerprint: p.capturedFingerprint,
                  allowHttp: source.allowHttp === true,
                };
              });
              boundedJsonUtf8Bytes(raw, 1024 * 1024);
              const mapped = validateBoundedScanResumePlan({ ...header, sourcePolicies: policies });
              sources = Object.freeze(canonical);
              plan = mapped;
              return mapped;
            },
          },
        );
      } catch (error) {
        // A malformed/lost reply may already have allocated an episode. Cancel
        // the exact opener and join its actual native owner before classifying
        // this historical admission failure as safe to dispose.
        await options.runtime.invoke('cancel_playlist', { requestId: openingRequestId });
        empty(await options.runtime.invoke('close_scan_resume_open', { openingRequestId }));
        closed = true;
        plan = null;
        sources = Object.freeze([]);
        const refused = new Error('Scan could not continue. Native admission has closed.', {
          cause: error,
        });
        refused.name = 'ScanAdmissionClosedError';
        throw refused;
      }
      if (commitWindow)
        admitted = validateBoundedScanResumePlan({
          ...admitted,
          commitWindow,
          ...(takeTiming ? { takeTiming } : {}),
        });
      plan = admitted;
      return admitted;
    },
    take: async (id, request, signal) => {
      const p = active(id);
      if (
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 16 ||
        request.blockedOrigins.length > 16 ||
        new Set(request.blockedOrigins).size !== request.blockedOrigins.length ||
        request.blockedOrigins.some((v) => typeof v !== 'string' || v.length > 128)
      )
        throw bad();
      return rpc(
        'take_scan_resume_candidates',
        {
          schemaVersion: p.commitWindow ? 2 : 1,
          planId: id,
          ...request,
          ...(p.takeTiming ? { takeTimingVersion: 1 } : {}),
        },
        signal,
        (raw) => validateBoundedScanCandidatePage(raw, p, request.limit, request.blockedOrigins),
      );
    },
    probe: async (candidate, signal, budget, policy) => {
      const p = active();
      if (
        budget !== p.budgetMs ||
        !p.sourcePolicies.some(
          (s) =>
            s.sourceId === candidate.sourceId &&
            s.fingerprint === candidate.sourceFingerprint &&
            s.sourceId === policy.sourceId &&
            s.fingerprint === policy.fingerprint &&
            s.allowHttp === policy.allowHttp,
        )
      )
        throw bad();
      return rpc(
        'probe_scan_resume_candidate',
        { planId: p.planId, candidateKey: candidate.key },
        signal,
        (raw) => {
          if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 7) throw bad();
          const o = raw as HealthObservation;
          if (
            o.channelId !== candidate.key ||
            o.sourceId !== candidate.sourceId ||
            o.fingerprint !== candidate.sourceFingerprint ||
            o.platform !== p.platform
          )
            throw bad();
          boundedJsonUtf8Bytes(raw, 128 * 1024);
          const checked = createHealthObservation(
            { channelId: o.channelId, sourceId: o.sourceId, fingerprint: o.fingerprint },
            { platform: o.platform, observedAt: o.observedAt },
            o.evidence,
          );
          if (checked.verdict !== o.verdict) throw bad();
          return checked;
        },
      );
    },
    commit: async (id, request, signal) => {
      let schemaVersion: 1 | 2;
      try {
        active(id);
        if (
          request.observations.length < 1 ||
          request.observations.length > (active(id).commitWindow?.maxObservations ?? 64) ||
          request.publicationIndices.length > (active(id).commitWindow?.maxObservations ?? 64)
        )
          throw bad();
        schemaVersion = active(id).commitWindow ? 2 : 1;
        boundedJsonUtf8Bytes({ schemaVersion, planId: id, ...request }, 1024 * 1024);
      } catch (error) {
        diagnose({
          command: 'commit_scan_resume_candidates',
          stage: 'local-validation',
          code: 'bounded-request-invalid',
        });
        throw error;
      }
      return rpc(
        'commit_scan_resume_candidates',
        { schemaVersion, planId: id, ...request },
        signal,
        (raw) => {
          if (!raw || typeof raw !== 'object') throw bad();
          const a = raw as BoundedScanAck;
          if (
            Object.keys(a).length !== 8 ||
            a.committed !== true ||
            a.planId !== id ||
            ![a.catalogRevision, a.healthRevision, a.checkpointRevision].every(decimal) ||
            !Array.isArray(a.acknowledgedIndices) ||
            !Array.isArray(a.publicationIndices) ||
            a.acknowledgedIndices.length > (active(id).commitWindow?.maxObservations ?? 64) ||
            a.publicationIndices.length > (active(id).commitWindow?.maxObservations ?? 64) ||
            new Set(a.acknowledgedIndices).size !== a.acknowledgedIndices.length ||
            new Set(a.publicationIndices).size !== a.publicationIndices.length
          )
            throw bad();
          // The owned worker verifies exact batch indices/count/revision transitions before accepting ACK.
          validateBoundedScanResumePlan({
            ...active(),
            counts: a.counts,
            revisions: {
              catalogRevision: a.catalogRevision,
              healthRevision: a.healthRevision,
              checkpointRevision: a.checkpointRevision,
            },
          });
          boundedJsonUtf8Bytes(raw, 128 * 1024);
          return a;
        },
        true,
      );
    },
    defer: async (id, ids, signal) => {
      active(id);
      if (ids.length > 256 || new Set(ids).size !== ids.length) throw bad();
      await rpc('defer_scan_resume_candidates', { planId: id, reservationIds: ids }, signal, empty);
    },
    release: async (id, ids, signal) => {
      active(id);
      if (ids.length > 256 || new Set(ids).size !== ids.length) throw bad();
      await rpc(
        'release_scan_resume_candidates',
        { planId: id, reservationIds: ids },
        signal,
        empty,
      );
    },
    close: async (id) => {
      active(id);
      await rpc('close_scan_resume_plan', { planId: id }, undefined, empty);
      closed = true;
      plan = null;
      sources = Object.freeze([]);
    },
  };
  function empty(raw: unknown): void {
    if (raw !== null && raw !== undefined) throw bad();
  }
  return {
    host,
    sources: () => sources,
    lastPlanSnapshot: () => plan,
    capabilities: async (signal?: AbortSignal) =>
      invokeOwnedNative(
        options.runtime,
        'scan_resume_capabilities',
        { windowVersion: 2, takeTimingVersion: 1 },
        {
          signal,
          validate: (raw) => {
            if (
              !raw ||
              typeof raw !== 'object' ||
              ![2, 3, 4].includes(Object.keys(raw).length) ||
              Object.keys(raw).some(
                (key) =>
                  !['schemaVersion', 'boundedResume', 'commitWindow', 'takeTiming'].includes(key),
              ) ||
              (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
              ![0, 1].includes((raw as { boundedResume: number }).boundedResume)
            )
              throw bad();
            let nextWindow: typeof scanResumeCommitWindow | undefined;
            let nextTiming: typeof scanResumeTakeTiming | undefined;
            if (Object.hasOwn(raw, 'commitWindow')) {
              if ((raw as { boundedResume: number }).boundedResume !== 1 || plan) throw bad();
              nextWindow = validateScanResumeCommitWindow(
                (raw as { commitWindow: unknown }).commitWindow,
              );
            }
            if (Object.hasOwn(raw, 'takeTiming')) {
              if (!nextWindow || plan) throw bad();
              nextTiming = validateScanResumeTakeTiming(
                (raw as { takeTiming: unknown }).takeTiming,
              );
            }
            // Publish local permissions only after the complete capability reply validates.
            if (!plan) {
              commitWindow = nextWindow;
              takeTiming = nextTiming;
            }
            return (raw as { boundedResume: number }).boundedResume === 1;
          },
        },
      ),
  };
}
export type { BoundedScanCommit };
