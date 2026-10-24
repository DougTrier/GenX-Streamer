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

import { invoke, isTauri } from '@tauri-apps/api/core';
import { archiveSessionGeneration } from './archive-playback';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface ArchiveBookmarkPosition {
  positionMs: number;
  durationMs: number | null;
  completed: boolean;
  observedMs: number;
}
export interface ArchiveBookmarkReadReceipt {
  schemaVersion: 1;
  sessionGeneration: string;
  supported: boolean;
  revision: string;
  position: ArchiveBookmarkPosition | null;
}
export interface ArchiveBookmarkSaveRequest {
  schemaVersion: 1;
  sessionGeneration: string;
  expectedRevision: string;
  positionMs: number;
  durationMs: number | null;
  completed: boolean;
}
export interface ArchiveBookmarkSaveReceipt {
  schemaVersion: 1;
  sessionGeneration: string;
  committed: true;
  revision: string;
  changed: boolean;
}
export class ArchiveBookmarkError extends Error {
  constructor(readonly category: 'stale' | 'unproven' | 'failed' | 'unavailable' = 'failed') {
    super(
      category === 'stale'
        ? 'The saved playback position changed. Select this video again.'
        : category === 'unproven'
          ? 'This video cannot keep a verified playback position.'
          : category === 'unavailable'
            ? 'Saved playback positions require the installed application.'
            : 'The playback position could not be saved. Your previous saved position is preserved.',
    );
  }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new ArchiveBookmarkError();
  return value as Record<string, unknown>;
}
function revision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function timeline(positionMs: unknown, durationMs: unknown, completed: unknown): boolean {
  return (
    integer(positionMs, 0, 604800000) &&
    (durationMs === null || integer(durationMs, 1, 604800000)) &&
    (durationMs === null || positionMs <= durationMs) &&
    typeof completed === 'boolean'
  );
}
export function validateArchiveBookmarkRead(
  value: unknown,
  expectedSession: string,
): ArchiveBookmarkReadReceipt {
  const r = record(value, [
    'schemaVersion',
    'sessionGeneration',
    'supported',
    'revision',
    'position',
  ]);
  if (
    !archiveSessionGeneration(expectedSession) ||
    r.schemaVersion !== 1 ||
    r.sessionGeneration !== expectedSession ||
    typeof r.supported !== 'boolean' ||
    !revision(r.revision) ||
    (!r.supported && r.position !== null)
  )
    throw new ArchiveBookmarkError();
  if (r.position !== null) {
    const p = record(r.position, ['positionMs', 'durationMs', 'completed', 'observedMs']);
    if (
      !timeline(p.positionMs, p.durationMs, p.completed) ||
      !integer(p.observedMs, 0, Number.MAX_SAFE_INTEGER)
    )
      throw new ArchiveBookmarkError();
  }
  return {
    ...r,
    position: r.position === null ? null : { ...(r.position as ArchiveBookmarkPosition) },
  } as unknown as ArchiveBookmarkReadReceipt;
}
export function validateArchiveBookmarkSave(
  value: unknown,
  request: ArchiveBookmarkSaveRequest,
): ArchiveBookmarkSaveReceipt {
  if (
    request.schemaVersion !== 1 ||
    !archiveSessionGeneration(request.sessionGeneration) ||
    !revision(request.expectedRevision) ||
    !timeline(request.positionMs, request.durationMs, request.completed)
  )
    throw new ArchiveBookmarkError();
  const r = record(value, [
    'schemaVersion',
    'sessionGeneration',
    'committed',
    'revision',
    'changed',
  ]);
  if (
    r.schemaVersion !== 1 ||
    r.sessionGeneration !== request.sessionGeneration ||
    r.committed !== true ||
    !revision(r.revision) ||
    typeof r.changed !== 'boolean' ||
    BigInt(r.revision) !== BigInt(request.expectedRevision) + (r.changed ? 1n : 0n)
  )
    throw new ArchiveBookmarkError();
  return { ...r } as unknown as ArchiveBookmarkSaveReceipt;
}
function failure(error: unknown): never {
  if (error === 'archive-bookmark-revision-stale') throw new ArchiveBookmarkError('stale');
  if (error === 'archive-bookmark-identity-unproven') throw new ArchiveBookmarkError('unproven');
  if (error instanceof ArchiveBookmarkError) throw error;
  throw new ArchiveBookmarkError();
}
export function createArchiveBookmarks(runtime?: OwnedNativeRuntime) {
  const native: OwnedNativeRuntime = runtime ?? {
    invoke: (command, args) =>
      isTauri() ? invoke(command, args) : Promise.reject(new ArchiveBookmarkError('unavailable')),
  };
  return {
    read(sessionGeneration: string, signal?: AbortSignal): Promise<ArchiveBookmarkReadReceipt> {
      if (!archiveSessionGeneration(sessionGeneration))
        return Promise.reject(new ArchiveBookmarkError());
      return invokeOwnedNative(
        native,
        'read_archive_bookmark',
        { request: { schemaVersion: 1, sessionGeneration } },
        {
          signal,
          validate: (value) => validateArchiveBookmarkRead(value, sessionGeneration),
          failure,
        },
      );
    },
    save(
      input: ArchiveBookmarkSaveRequest,
      signal?: AbortSignal,
    ): Promise<ArchiveBookmarkSaveReceipt> {
      const r = record(input, [
        'schemaVersion',
        'sessionGeneration',
        'expectedRevision',
        'positionMs',
        'durationMs',
        'completed',
      ]);
      if (
        r.schemaVersion !== 1 ||
        !archiveSessionGeneration(r.sessionGeneration) ||
        !revision(r.expectedRevision) ||
        !timeline(r.positionMs, r.durationMs, r.completed)
      )
        return Promise.reject(new ArchiveBookmarkError());
      const request = { ...input };
      return invokeOwnedNative(
        native,
        'save_archive_bookmark',
        { request },
        {
          signal,
          durable: true,
          validate: (value) => validateArchiveBookmarkSave(value, request),
          failure,
        },
      );
    },
  };
}
