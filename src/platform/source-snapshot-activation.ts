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

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  validateSourceSnapshotPreparationProgress,
  type SourceSnapshotPreparationProgress,
} from './source-snapshot-progress';
import type { PreferredRegion } from '../location/region';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface SourceSnapshotActivationRequest {
  schemaVersion: 1;
  sources: readonly { sourceId: string; sourceRevision: string }[];
  query: string;
  preferredRegion: PreferredRegion | null;
  budgetMs: 20000 | 45000 | 60000;
  mode: 'refresh' | 'fullRecheck' | 'slow';
  expectedCatalogRevision: string;
  expectedCheckpointRevision: string;
  /** Published channel IDs (no feed suffix) whose names match the query. */
  aliasProviderIds?: readonly string[];
  /** Closed, replaced, blocklisted or adult channel IDs, checked last. */
  demotedProviderIds?: readonly string[];
}
export interface SourceSnapshotActivationReply {
  schemaVersion: 1;
  jobId: string | null;
  reviewDigest: string | null;
  candidateCount: number;
  catalogRevision: string;
  checkpointRevision: string;
}
/** Native refused replacement before committing; the prior saved owner remains authoritative. */
export class SourceSnapshotFullRecheckEmptyError extends Error {
  constructor() {
    super(
      'No channels matched the full recheck. Previous scan progress is retained; use Continue or change the search and recheck.',
    );
    this.name = 'SourceSnapshotFullRecheckEmptyError';
  }
}
export interface SourceSnapshotActivationRuntime extends OwnedNativeRuntime {
  listenProgress?(callback: (payload: unknown) => void): Promise<() => void | Promise<void>>;
}
export function createSourceSnapshotActivationTransport(
  runtime: SourceSnapshotActivationRuntime = {
    invoke,
    listenProgress: async (callback) => {
      const unlisten = await listen('source-activation-progress', (event) =>
        callback(event.payload),
      );
      // Pinned Tauri 2.11 actually returns an async function even though typed void.
      return async () => {
        await unlisten();
      };
    },
  },
) {
  const pendingUnlisteners = new Set<() => void | Promise<void>>();
  let active = false;
  let activeSettled: Promise<void> | undefined;
  let cleanupJoin: Promise<void> | undefined;
  const warning = () => {
    try {
      console.warn('Source preparation progress unavailable.');
    } catch {
      /* Diagnostics are observational. */
    }
  };
  const retryPending = async () => {
    for (const pending of pendingUnlisteners) {
      try {
        await pending();
        pendingUnlisteners.delete(pending);
      } catch {
        warning();
      }
    }
  };
  // The application retains this factory across scans. Closing first aborts its
  // existing scan owner, then joins this exact registration/producer/unlisten.
  const settleProgressCleanup = (): Promise<void> => {
    if (cleanupJoin) return cleanupJoin;
    const joined = (async () => {
      await activeSettled;
      await retryPending();
      if (pendingUnlisteners.size)
        throw new Error('Source preparation progress cleanup could not be confirmed.');
    })();
    cleanupJoin = joined;
    const clear = () => {
      if (cleanupJoin === joined) cleanupJoin = undefined;
    };
    void joined.then(clear, clear);
    return joined;
  };
  const activate = async (
    request: SourceSnapshotActivationRequest,
    signal: AbortSignal,
    onProgress?: (progress: SourceSnapshotPreparationProgress) => void,
  ) => {
    const requestId = (runtime.idFactory ?? (() => crypto.randomUUID()))();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId))
      throw new Error('Invalid source preparation request.');
    signal.throwIfAborted();
    if (active || cleanupJoin) throw new Error('Source preparation is already active or closing.');
    active = true;
    let finishActive!: () => void;
    activeSettled = new Promise<void>((resolve) => {
      finishActive = resolve;
    });
    let finished = false;
    let previous: SourceSnapshotPreparationProgress | undefined;
    let unlisten: (() => void | Promise<void>) | undefined;
    const observe = (raw: unknown) => {
      if (finished || signal.aborted || !onProgress) return;
      try {
        const progress = validateSourceSnapshotPreparationProgress(raw);
        if (
          progress.requestId !== requestId ||
          (previous &&
            (progress.rootGeneration !== previous.rootGeneration ||
              progress.totalCandidates !== previous.totalCandidates ||
              progress.preparedCandidates < previous.preparedCandidates ||
              (previous.phase === 'sealing' && progress.phase !== 'sealing') ||
              (previous.phase === progress.phase &&
                previous.preparedCandidates === progress.preparedCandidates)))
        )
          return;
        previous = progress;
        onProgress(progress);
      } catch {
        /* Invalid/late observer data cannot confer authority or stop a healthy scan. */
      }
    };
    try {
      signal.throwIfAborted();
      if (pendingUnlisteners.size) await retryPending();
      signal.throwIfAborted();
      if (onProgress && runtime.listenProgress && pendingUnlisteners.size === 0) {
        try {
          unlisten = await runtime.listenProgress(observe);
        } catch {
          warning();
        }
      }
      signal.throwIfAborted();
      boundedJsonUtf8Bytes(request, 1024 * 1024, signal);
      return await invokeOwnedNative(
        { invoke: (command, args) => runtime.invoke(command, args), idFactory: () => requestId },
        'activate_source_snapshot_checks',
        { request },
        {
          signal,
          durable: true,
          failure(failure): never {
            const code = failure instanceof Error ? failure.message : failure;
            if (code === 'scan-checkpoint-full-recheck-empty')
              throw new SourceSnapshotFullRecheckEmptyError();
            // The native code (a fixed string) is kept as the cause for diagnostics.
            throw new Error('Source checks could not be activated. Saved channels are retained.', {
              cause: typeof code === 'string' ? code : undefined,
            });
          },
          validate(raw): SourceSnapshotActivationReply {
            boundedJsonUtf8Bytes(raw, 4096);
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
              throw new Error('Source checks could not be confirmed.');
            const value = raw as Record<string, unknown>;
            const keys = [
              'schemaVersion',
              'jobId',
              'reviewDigest',
              'candidateCount',
              'catalogRevision',
              'checkpointRevision',
            ];
            if (
              Object.keys(value).length !== keys.length ||
              Object.keys(value).some((key) => !keys.includes(key))
            )
              throw new Error('Source checks could not be confirmed.');
            const decimal = (v: unknown) =>
              typeof v === 'string' &&
              /^(0|[1-9][0-9]{0,18})$/u.test(v) &&
              BigInt(v) <= 9223372036854775807n;
            if (
              value.schemaVersion !== 1 ||
              !Number.isSafeInteger(value.candidateCount) ||
              (value.candidateCount as number) < 0 ||
              (value.candidateCount as number) > 100_000 ||
              !decimal(value.catalogRevision) ||
              !decimal(value.checkpointRevision) ||
              value.catalogRevision !== request.expectedCatalogRevision
            )
              throw new Error('Source checks could not be confirmed.');
            if (value.candidateCount === 0) {
              if (
                value.jobId !== null ||
                value.reviewDigest !== null ||
                value.checkpointRevision !== request.expectedCheckpointRevision
              )
                throw new Error('Source checks could not be confirmed.');
            } else if (
              typeof value.jobId !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(value.jobId) ||
              typeof value.reviewDigest !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(value.reviewDigest) ||
              BigInt(value.checkpointRevision as string) !==
                BigInt(request.expectedCheckpointRevision) + 1n
            )
              throw new Error('Source checks could not be confirmed.');
            return Object.freeze(value) as unknown as SourceSnapshotActivationReply;
          },
        },
      );
    } finally {
      finished = true;
      if (unlisten) {
        try {
          await unlisten();
        } catch {
          pendingUnlisteners.add(unlisten);
          warning();
        }
      }
      active = false;
      activeSettled = undefined;
      finishActive();
    }
  };
  return Object.defineProperty(
    Object.assign(activate, { settleProgressCleanup }),
    'cleanupPending',
    {
      get: () => pendingUnlisteners.size > 0,
    },
  ) as typeof activate & {
    readonly cleanupPending: boolean;
    settleProgressCleanup(): Promise<void>;
  };
}
