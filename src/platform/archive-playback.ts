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

import { downloadRef, downloadRevision } from './archive-downloads';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface ArchivePlaybackRequest {
  schemaVersion: 1;
  fileRef: string;
  expectedRevision: string;
}
/** Issued loopback capability: session-transient only, never persist/share/log. */
export interface ArchivePlaybackReceipt {
  mimeType?: 'video/mp4' | 'video/webm';
  kind: 'started';
  schemaVersion: 1;
  sessionGeneration: string;
  mediaUrl: string;
  leaseMs: 60000;
  cleanupPending: false;
}
export interface ArchivePlaybackConfirmedDeadReceipt {
  kind: 'confirmedDead';
  schemaVersion: 1;
  committed: true;
  revision: string;
  confirmedDead: number;
  titleCount: number;
}
export type ArchivePlaybackStartResult =
  ArchivePlaybackReceipt | ArchivePlaybackConfirmedDeadReceipt;
export interface ArchivePlaybackStopReceipt {
  schemaVersion: 1;
  sessionGeneration: string;
  stopped: true;
  cleanupPending: false;
}
export interface ArchivePlaybackRenewReceipt {
  schemaVersion: 1;
  sessionGeneration: string;
  renewed: true;
  leaseMs: 60000;
}
const invalid = () => new Error('The Archive playback request or response is invalid.');
export class ArchivePlaybackCleanupError extends Error {
  constructor() {
    super('Archive playback cleanup could not finish. Retry Stop.');
  }
}
export class ArchivePlaybackUnavailableError extends Error {
  constructor() {
    super('Archive playback requires the installed application.');
  }
}
export type ArchiveFailureCategory =
  | 'destination'
  | 'path'
  | 'dns'
  | 'encoding'
  | 'format'
  | 'codec'
  | 'inspection'
  | 'configuration'
  | 'range'
  | 'access'
  | 'rate-limit'
  | 'network'
  | 'stale'
  | 'unavailable'
  | 'cleanup'
  | 'local-copy'
  | 'unknown';
const archiveFailureMessages: Record<ArchiveFailureCategory, string> = {
  destination: 'This video’s server address could not be verified. Choose another saved video.',
  path: 'This video’s download location could not be verified. Reload its files or choose another video.',
  dns: 'The video server could not be safely reached. Retry later or choose another video.',
  encoding:
    'The server’s response encoding could not be verified for playback. Choose another video.',
  format: 'This video’s playback format could not be verified. Choose another video.',
  codec:
    'This file uses a video or audio format this player does not support. Choose another file.',
  inspection:
    'This file’s format could not be verified within the inspection limit. Choose another version or file.',
  configuration: 'This archive source is not enabled in this build. Choose another source or file.',
  range:
    'This video’s seekable download could not be verified. Retry later or choose another video.',
  access: 'The video server refused access. Choose another video or retry later.',
  'rate-limit':
    'Archive is limiting requests. Wait before retrying, or choose another saved video.',
  network:
    'The video server could not provide this video right now. Retry later or choose another video. It remains in your library.',
  stale:
    'Your GenXtra library or selected file changed. Reload this title’s files and select again.',
  unavailable:
    'This saved video is no longer available for selection. Reload its title’s files or choose another video.',
  cleanup: 'Archive playback could not stop. Retry Stop before choosing another item.',
  'local-copy':
    'This saved copy could not be opened or verified. Remove the download and save it again; streaming was not started.',
  unknown: 'This Archive file could not open. Choose another file or retry.',
};
const archiveNativeFailureCodes = Object.freeze({
  'public-archive-audio-codec-unsupported': 'codec',
  'public-archive-video-codec-unsupported': 'codec',
  'public-archive-format-unsupported': 'codec',
  'public-archive-inspection-limit': 'inspection',
  'public-archive-codec-unverified': 'format',
  'public-archive-video-codec-unverified': 'format',
  'public-archive-container-unverified': 'format',
  'public-archive-size-unverified': 'format',
  'public-archive-contact-required': 'configuration',
  'public-archive-destination-refused': 'destination',
  'public-archive-media-url-refused': 'destination',
  'public-archive-url-refused': 'destination',
  'public-archive-source-refused': 'destination',
  'public-archive-redirect-unverified': 'path',
  'public-archive-dns-unavailable': 'dns',
  'public-archive-range-unverified': 'range',
  'public-archive-access-refused': 'access',
  'public-archive-rate-limited': 'rate-limit',
  'public-archive-timeout': 'network',
  'public-archive-network-unavailable': 'network',
  'public-archive-server-unavailable': 'network',
  'public-archive-metadata-unavailable': 'network',
  'public-archive-response-refused': 'network',
  'public-archive-response-limit': 'network',
  'public-archive-file-changed': 'stale',
  'public-archive-size-changed': 'stale',
  'public-archive-container-changed': 'stale',
  'public-archive-file-unavailable': 'unavailable',
  'public-archive-work-join-failed': 'cleanup',
  'archive-download-file-corrupt': 'local-copy',
  'archive-download-file-missing': 'local-copy',
  'archive-download-file-unavailable': 'local-copy',
  'archive-download-file-read-failed': 'local-copy',
  'archive-download-file-changed': 'local-copy',
  'archive-download-integrity-failed': 'local-copy',
  'archive-download-revision-stale': 'stale',
  'archive-download-unavailable': 'local-copy',
  'archive-download-storage-failed': 'local-copy',
  'archive-download-repair-required': 'local-copy',

  'archive-proxy-refused': 'destination',
  'archive-proxy-url-refused': 'destination',
  'archive-proxy-host-unverified': 'destination',
  'archive-proxy-path-unverified': 'path',
  'archive-file-route-unverified': 'path',
  'archive-proxy-dns-private': 'dns',
  'archive-proxy-dns-address-limit': 'dns',
  'archive-proxy-dns': 'dns',
  'archive-proxy-response-encoding-unverified': 'encoding',
  'archive-media-format-unverified': 'format',
  'archive-media-container-unverified': 'format',
  'archive-media-range-unverified': 'range',
  'archive-proxy-range-unsatisfiable': 'range',
  'archive-media-access-refused': 'access',
  'archive-media-rate-limited': 'rate-limit',
  'archive-proxy-network': 'network',
  'archive-proxy-timeout': 'network',
  'archive-proxy-redirect-limit': 'network',
  'archive-proxy-work-limit': 'network',
  'archive-proxy-chunk-limit': 'network',
  'archive-media-truncated': 'network',
  'archive-media-unavailable': 'network',
  'archive-media-size-changed': 'stale',
  'archive-file-changed': 'stale',
  'archive-revision-stale': 'stale',
  'archive-playback-replaced': 'stale',
  'archive-playback-expired': 'stale',
  'archive-proxy-expired': 'stale',
  'archive-proxy-authority-lost': 'stale',
  'archive-file-unavailable': 'unavailable',
  'archive-title-unavailable': 'unavailable',
  'archive-playback-busy': 'cleanup',
  'archive-playback-owner-lost': 'cleanup',
  'archive-proxy-dns-join': 'cleanup',
  'archive-proxy-client-join-failed': 'cleanup',
  'archive-proxy-work-join-failed': 'cleanup',
  'archive-proxy-stop-unconfirmed': 'cleanup',
} satisfies Record<string, ArchiveFailureCategory>);
const classifiedArchiveFailures = new WeakSet<object>();
export class ArchivePlaybackFailureError extends Error {
  readonly category: ArchiveFailureCategory;
  constructor(readonly code: keyof typeof archiveNativeFailureCodes | 'unknown') {
    const category = code === 'unknown' ? 'unknown' : archiveNativeFailureCodes[code];
    if (!category || !Object.hasOwn(archiveFailureMessages, category)) throw invalid();
    super(archiveFailureMessages[category]);
    this.category = category;
    classifiedArchiveFailures.add(this);
    Object.freeze(this);
  }
}
export function isArchivePlaybackFailure(error: unknown): error is ArchivePlaybackFailureError {
  return error instanceof ArchivePlaybackFailureError && classifiedArchiveFailures.has(error);
}
export function archivePlaybackFailureGuidance(error: unknown): string {
  if (isArchivePlaybackFailure(error)) return archiveFailureMessages[error.category];
  if (error instanceof ArchivePlaybackCleanupError) return archiveFailureMessages.cleanup;
  if (error instanceof ArchivePlaybackUnavailableError)
    return 'GenXtra playback requires the installed application.';
  return archiveFailureMessages.unknown;
}
function rejectArchivePlaybackFailure(error: unknown): never {
  // Native rejects with exact static strings. Never inspect arbitrary Error.message,
  // object payloads or prefix matches, and never retain their private cause.
  if (typeof error === 'string' && Object.hasOwn(archiveNativeFailureCodes, error))
    throw new ArchivePlaybackFailureError(error as keyof typeof archiveNativeFailureCodes);
  throw new ArchivePlaybackFailureError('unknown');
}
const cleanupFailed = () => new ArchivePlaybackCleanupError();
const canceled = () => new DOMException('Archive playback was canceled.', 'AbortError');
function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  if (
    keys.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return row;
}
export function archiveSessionGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
function revision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function validateArchivePlaybackRequest(
  value: ArchivePlaybackRequest,
): ArchivePlaybackRequest {
  const row = record(value, ['schemaVersion', 'fileRef', 'expectedRevision']);
  if (
    row.schemaVersion !== 1 ||
    typeof row.fileRef !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.fileRef) ||
    !revision(row.expectedRevision)
  )
    throw invalid();
  return { ...row } as unknown as ArchivePlaybackRequest;
}
export function archiveCapabilityUrl(value: unknown): value is string {
  if (!boundedUtf8Text(value, 1024) || /[\p{Cc}\p{White_Space}?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      /^[1-9][0-9]{0,4}$/u.test(url.port) &&
      Number(url.port) <= 65535 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value &&
      /^\/archive\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:mp4|webm)$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export function validateArchivePlaybackReceipt(value: unknown): ArchivePlaybackReceipt {
  const row = record(
    value,
    ['kind', 'schemaVersion', 'sessionGeneration', 'mediaUrl', 'leaseMs', 'cleanupPending'],
    ['mimeType'],
  );
  if (
    row.kind !== 'started' ||
    row.schemaVersion !== 1 ||
    !archiveSessionGeneration(row.sessionGeneration) ||
    !archiveCapabilityUrl(row.mediaUrl) ||
    (row.mimeType !== undefined && !['video/mp4', 'video/webm'].includes(row.mimeType as string)) ||
    (typeof row.mediaUrl === 'string' &&
      !row.mediaUrl.endsWith((row.mimeType ?? 'video/mp4') === 'video/webm' ? '.webm' : '.mp4')) ||
    row.leaseMs !== 60000 ||
    row.cleanupPending !== false
  )
    throw invalid();
  return { ...row } as unknown as ArchivePlaybackReceipt;
}
export function validateArchivePlaybackConfirmedDeadReceipt(
  value: unknown,
  expectedRevision: string,
): ArchivePlaybackConfirmedDeadReceipt {
  const row = record(value, [
    'kind',
    'schemaVersion',
    'committed',
    'revision',
    'confirmedDead',
    'titleCount',
  ]);
  if (
    row.kind !== 'confirmedDead' ||
    row.schemaVersion !== 1 ||
    row.committed !== true ||
    !revision(row.revision) ||
    !revision(expectedRevision) ||
    BigInt(row.revision) <= BigInt(expectedRevision) ||
    !Number.isSafeInteger(row.confirmedDead) ||
    (row.confirmedDead as number) < 1 ||
    (row.confirmedDead as number) > 1000 ||
    !Number.isSafeInteger(row.titleCount) ||
    (row.titleCount as number) < 0 ||
    (row.titleCount as number) > 1400
  )
    throw invalid();
  return { ...row } as unknown as ArchivePlaybackConfirmedDeadReceipt;
}
export function validateArchivePlaybackStopReceipt(
  value: unknown,
  expected: string,
): ArchivePlaybackStopReceipt {
  const row = record(value, ['schemaVersion', 'sessionGeneration', 'stopped', 'cleanupPending']);
  if (
    !archiveSessionGeneration(expected) ||
    row.schemaVersion !== 1 ||
    row.sessionGeneration !== expected ||
    row.stopped !== true ||
    row.cleanupPending !== false
  )
    throw invalid();
  return { ...row } as unknown as ArchivePlaybackStopReceipt;
}
export function validateArchivePlaybackRenewReceipt(
  value: unknown,
  expected: string,
): ArchivePlaybackRenewReceipt {
  const row = record(value, ['schemaVersion', 'sessionGeneration', 'renewed', 'leaseMs']);
  if (
    !archiveSessionGeneration(expected) ||
    row.schemaVersion !== 1 ||
    row.sessionGeneration !== expected ||
    row.renewed !== true ||
    row.leaseMs !== 60000
  )
    throw invalid();
  return { ...row } as unknown as ArchivePlaybackRenewReceipt;
}
export function createArchivePlayback(runtime?: OwnedNativeRuntime) {
  const native: OwnedNativeRuntime = runtime ?? {
    invoke: (command, args) =>
      isTauri()
        ? invoke(command, args)
        : Promise.reject(new Error('Archive playback requires the installed application.')),
  };
  const pendingCleanup = new Set<string>();
  const stops = new Map<string, Promise<ArchivePlaybackStopReceipt>>();
  function stop(
    sessionGeneration: string,
    signal?: AbortSignal,
  ): Promise<ArchivePlaybackStopReceipt> {
    // Cleanup is exact-session authority; caller cancellation must never detach it.
    void signal;
    if (!archiveSessionGeneration(sessionGeneration)) return Promise.reject(invalid());
    const existing = stops.get(sessionGeneration);
    if (existing) return existing;
    pendingCleanup.add(sessionGeneration);
    const work = invokeOwnedNative(
      native,
      'stop_archive_playback',
      { request: { schemaVersion: 1, sessionGeneration } },
      {
        validate: (value) => validateArchivePlaybackStopReceipt(value, sessionGeneration),
      },
    )
      .then((receipt) => {
        pendingCleanup.delete(sessionGeneration);
        return receipt;
      })
      .catch(() => {
        throw cleanupFailed();
      })
      .finally(() => {
        if (stops.get(sessionGeneration) === work) stops.delete(sessionGeneration);
      });
    stops.set(sessionGeneration, work);
    return work;
  }
  async function retryCleanup(): Promise<void> {
    const results = await Promise.allSettled([...pendingCleanup].map((id) => stop(id)));
    if (results.some((result) => result.status === 'rejected')) throw cleanupFailed();
  }
  const api = {
    stop,
    retryCleanup,
    renew(sessionGeneration: string, signal?: AbortSignal): Promise<ArchivePlaybackRenewReceipt> {
      if (!archiveSessionGeneration(sessionGeneration)) return Promise.reject(invalid());
      return invokeOwnedNative(
        native,
        'renew_archive_playback',
        { request: { schemaVersion: 1, sessionGeneration } },
        {
          signal,
          failure: rejectArchivePlaybackFailure,
          validate: (value) => validateArchivePlaybackRenewReceipt(value, sessionGeneration),
        },
      );
    },
    async startSaved(
      input: { schemaVersion: 1; downloadRef: string; expectedRevision: string },
      signal?: AbortSignal,
    ): Promise<ArchivePlaybackReceipt> {
      if (
        !input ||
        Object.keys(input).length !== 3 ||
        input.schemaVersion !== 1 ||
        !downloadRef(input.downloadRef) ||
        !downloadRevision(input.expectedRevision)
      )
        throw invalid();
      const result = await api.start(
        { schemaVersion: 1, fileRef: input.downloadRef, expectedRevision: input.expectedRevision },
        signal,
        true,
      );
      if (result.kind !== 'started') throw invalid();
      return result;
    },
    async start(
      input: ArchivePlaybackRequest,
      signal?: AbortSignal,
      saved = false,
    ): Promise<ArchivePlaybackStartResult> {
      const admitted = validateArchivePlaybackRequest(input);
      if (signal?.aborted) throw canceled();
      if (!runtime && !isTauri()) throw new ArchivePlaybackUnavailableError();
      await retryCleanup();
      if (signal?.aborted) throw canceled();
      let issuedGeneration: string | null = null;
      let committedDead: ArchivePlaybackConfirmedDeadReceipt | null = null;
      try {
        return await invokeOwnedNative(
          native,
          saved ? 'start_archive_download_playback' : 'start_archive_playback',
          {
            request: saved
              ? {
                  schemaVersion: 1,
                  downloadRef: admitted.fileRef,
                  expectedRevision: admitted.expectedRevision,
                }
              : admitted,
          },
          {
            signal,
            failure: rejectArchivePlaybackFailure,
            validate: (value): ArchivePlaybackStartResult => {
              if (
                value &&
                typeof value === 'object' &&
                Object.hasOwn(value, 'kind') &&
                (value as { kind?: unknown }).kind === 'confirmedDead'
              ) {
                committedDead = validateArchivePlaybackConfirmedDeadReceipt(
                  value,
                  admitted.expectedRevision,
                );
                return committedDead;
              }
              // Capture a trusted allocation header even when the remaining receipt is
              // malformed or a late abort occurs after successful native startup.
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                const prototype = Object.getPrototypeOf(value),
                  row = value as Record<string, unknown>;
                if (
                  (prototype === Object.prototype || prototype === null) &&
                  Object.hasOwn(row, 'schemaVersion') &&
                  Object.hasOwn(row, 'sessionGeneration') &&
                  row.kind === 'started' &&
                  row.schemaVersion === 1 &&
                  archiveSessionGeneration(row.sessionGeneration)
                )
                  issuedGeneration = row.sessionGeneration;
              }
              return validateArchivePlaybackReceipt(value);
            },
          },
        );
      } catch (error) {
        // The original native command has joined. A durable removal remains
        // authoritative even when cancellation arrives after its COMMIT.
        if (committedDead !== null) return committedDead;
        if (issuedGeneration !== null) await stop(issuedGeneration);
        // This is the owned helper's fixed local failure after both original and
        // cancellation settled, not an arbitrary native/provider error message.
        if (
          error instanceof Error &&
          error.message === 'Native command cancellation could not be confirmed.'
        )
          throw cleanupFailed();
        if (isArchivePlaybackFailure(error) && error.category === 'cleanup') throw error;
        if (signal?.aborted) throw canceled();
        throw error;
      }
    },
  };
  return api;
}
