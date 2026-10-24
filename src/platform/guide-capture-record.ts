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

import { boundedUtf8Text } from './bounded-text';
import { validateRevision } from './record-transaction';
import type { AutomaticGuideSavedSnapshot } from '../application/guide/automatic-guide-capture';
export type GuideCaptureRecord = AutomaticGuideSavedSnapshot;
export interface GuideCaptureRecordHost {
  isNative(): boolean;
  invoke(command: 'read_guide_capture'): Promise<unknown>;
  openDatabase(): Promise<IDBDatabase>;
}
const invalid = () => new Error('Saved program guide snapshot is invalid.');
/** Validate only the bounded wire envelope; catalog/preferences decoding remains worker-owned. */
export function validateGuideCaptureRecord(raw: unknown): GuideCaptureRecord {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw invalid();
  const input = raw as Record<string, unknown>;
  const keys = ['catalog', 'preferences', 'catalogRevision'];
  if (
    Reflect.ownKeys(input).length !== 3 ||
    !keys.every((key) => Object.hasOwn(input, key)) ||
    Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw invalid();
  const record = (value: unknown): string | null => {
    if (value === null) return null;
    if (!boundedUtf8Text(value, 20 * 1024 * 1024)) throw invalid();
    return value;
  };
  let revision: string;
  try {
    revision = validateRevision(input.catalogRevision);
  } catch {
    throw invalid();
  }
  return {
    catalog: record(input.catalog),
    preferences: record(input.preferences),
    catalogRevision: revision,
  };
}
/** One readonly transaction captures the pair/revision and never requests operational health. */
export function readIndexedDbGuideCaptureRecord(
  database: IDBDatabase,
): Promise<GuideCaptureRecord> {
  return new Promise((resolve, reject) => {
    try {
      const tx = database.transaction('records', 'readonly'),
        store = tx.objectStore('records');
      const requests = ['catalog', 'preferences', 'catalogRevision'].map((key) => store.get(key));
      tx.oncomplete = () => {
        try {
          resolve(
            validateGuideCaptureRecord({
              catalog: requests[0]!.result ?? null,
              preferences: requests[1]!.result ?? null,
              catalogRevision: requests[2]!.result ?? '0',
            }),
          );
        } catch {
          reject(invalid());
        }
      };
      tx.onabort = () => reject(new Error('Saved program guide snapshot could not be read.'));
      // The transaction's abort/completion owns settlement after any request error.
      tx.onerror = () => undefined;
    } catch {
      reject(new Error('Saved program guide snapshot could not be read.'));
    }
  });
}
/** Await the actual owned read before admitting or rejecting a late result. */
export async function readGuideCaptureRecord(
  host: GuideCaptureRecordHost,
  signal?: AbortSignal,
): Promise<GuideCaptureRecord> {
  signal?.throwIfAborted();
  const snapshot = host.isNative()
    ? validateGuideCaptureRecord(await host.invoke('read_guide_capture'))
    : await readIndexedDbGuideCaptureRecord(await host.openDatabase());
  signal?.throwIfAborted();
  return snapshot;
}
