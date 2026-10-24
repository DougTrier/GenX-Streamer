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
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** Structural counts only: a valid summary does not authorize or admit Resume. */
export interface ScanCheckpointSummary {
  readonly schemaVersion: 1;
  readonly checkpointStatus: 'absent' | 'valid' | 'invalid';
  readonly storedVersion: 1 | 2 | 3 | null;
  readonly total: number;
  readonly checked: number;
  readonly responded: number;
  readonly published: number;
  readonly unfinished: boolean;
  readonly catalogRevision: string;
  readonly checkpointRevision: string;
}
export class ScanCheckpointSummaryValidationError extends Error {
  constructor() {
    super('Saved scan summary is invalid. Reopen the app before reviewing scan progress.');
    this.name = 'ScanCheckpointSummaryValidationError';
  }
}
export class ScanCheckpointSummaryReadError extends Error {
  constructor() {
    super('Saved scan progress could not be read. Retry when storage is available.');
    this.name = 'ScanCheckpointSummaryReadError';
  }
}
const fields = [
  'schemaVersion',
  'checkpointStatus',
  'storedVersion',
  'total',
  'checked',
  'responded',
  'published',
  'unfinished',
  'catalogRevision',
  'checkpointRevision',
] as const;
const invalid = (): never => {
  throw new ScanCheckpointSummaryValidationError();
};
function revision(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return invalid();
  return value;
}
export function validateScanCheckpointSummary(raw: unknown): ScanCheckpointSummary {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key as (typeof fields)[number]))
  )
    return invalid();
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
    value[field] = descriptor.value;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.checkpointStatus !== 'string' ||
    !['absent', 'valid', 'invalid'].includes(value.checkpointStatus) ||
    ![null, 1, 2, 3].includes(value.storedVersion as null | number) ||
    typeof value.unfinished !== 'boolean'
  )
    return invalid();
  for (const field of ['total', 'checked', 'responded', 'published'])
    if (
      !Number.isSafeInteger(value[field]) ||
      (value[field] as number) < 0 ||
      (value[field] as number) > 100000
    )
      return invalid();
  if (
    (value.published as number) > (value.responded as number) ||
    (value.responded as number) > (value.checked as number) ||
    (value.checked as number) > (value.total as number)
  )
    return invalid();
  if (
    value.checkpointStatus === 'valid'
      ? value.storedVersion === null
      : value.storedVersion !== null ||
        value.total !== 0 ||
        value.checked !== 0 ||
        value.responded !== 0 ||
        value.published !== 0 ||
        value.unfinished !== false
  )
    return invalid();
  if (
    value.checkpointStatus === 'valid' &&
    value.unfinished !==
      ((value.checked as number) < (value.total as number) ||
        (value.published as number) < (value.responded as number))
  )
    return invalid();
  return Object.freeze({
    schemaVersion: 1,
    checkpointStatus: value.checkpointStatus as ScanCheckpointSummary['checkpointStatus'],
    storedVersion: value.storedVersion as ScanCheckpointSummary['storedVersion'],
    total: value.total as number,
    checked: value.checked as number,
    responded: value.responded as number,
    published: value.published as number,
    unfinished: value.unfinished as boolean,
    catalogRevision: revision(value.catalogRevision),
    checkpointRevision: revision(value.checkpointRevision),
  });
}
export function createScanCheckpointSummaryAdapter(
  runtime: OwnedNativeRuntime & { isNative(): boolean },
) {
  return {
    async read(signal?: AbortSignal): Promise<ScanCheckpointSummary> {
      signal?.throwIfAborted();
      if (!runtime.isNative()) throw new ScanCheckpointSummaryReadError();
      return invokeOwnedNative(
        runtime,
        'read_scan_checkpoint_summary',
        {},
        {
          signal,
          validate: validateScanCheckpointSummary,
          failure(): never {
            throw new ScanCheckpointSummaryReadError();
          },
        },
      );
    },
  };
}
export const nativeScanCheckpointSummary = createScanCheckpointSummaryAdapter({
  isNative: isTauri,
  invoke,
});
