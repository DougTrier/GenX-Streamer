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

export type GuideMaintenanceState =
  'skipped' | 'compacted' | 'deferred' | 'failed' | 'reopen-required';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const code = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length && expected.every((key) => Object.hasOwn(v, key));
function pages(v: unknown, requireCoherent = true): boolean {
  return (
    record(v) &&
    keys(v, ['pageSize', 'pages', 'freePages', 'fileBytes']) &&
    count(v.pageSize) &&
    count(v.pages) &&
    count(v.freePages) &&
    count(v.fileBytes) &&
    (!requireCoherent ||
      (v.pageSize >= 512 &&
        v.pageSize <= 65536 &&
        Number.isInteger(Math.log2(v.pageSize)) &&
        v.freePages <= v.pages &&
        v.fileBytes === v.pageSize * v.pages))
  );
}
/** Validate the committed retention receipt separately from physical optimization. */
export function validateGuideMaintenance(value: unknown): GuideMaintenanceState {
  const invalid = () => new Error('The guide storage maintenance receipt is invalid.');
  if (
    !record(value) ||
    !keys(value, ['maintenance', 'rootGeneration', 'quarantined', 'quarantineError']) ||
    !count(value.rootGeneration) ||
    typeof value.quarantined !== 'boolean' ||
    !(value.quarantineError === null || code(value.quarantineError)) ||
    !record(value.maintenance)
  )
    throw invalid();
  const m = value.maintenance;
  if (
    !keys(m, ['value', 'compaction', 'fatalVerification']) ||
    !(m.fatalVerification === null || code(m.fatalVerification)) ||
    ((value.quarantined || value.quarantineError !== null) && m.fatalVerification === null) ||
    !record(m.value) ||
    !keys(m.value, [
      'sourcesChanged',
      'programsBefore',
      'programsAfter',
      'programsRemoved',
      'headersRetained',
    ]) ||
    !Object.values(m.value).every(count) ||
    (m.value.sourcesChanged as number) > 1000 ||
    (m.value.programsBefore as number) - (m.value.programsAfter as number) !==
      m.value.programsRemoved ||
    !record(m.compaction)
  )
    throw invalid();
  const c = m.compaction;
  switch (c.status) {
    case 'skipped':
      if (!keys(c, ['status', 'pages']) || !pages(c.pages)) throw invalid();
      break;
    case 'compacted':
      if (!keys(c, ['status', 'before', 'after']) || !pages(c.before) || !pages(c.after))
        throw invalid();
      break;
    case 'deferred':
      if (
        !keys(c, ['status', 'reason', 'pages']) ||
        !code(c.reason) ||
        !(c.pages === null || pages(c.pages))
      )
        throw invalid();
      break;
    case 'failed':
      if (
        !keys(c, ['status', 'reason', 'before', 'after']) ||
        !code(c.reason) ||
        // Incoherent physical geometry can itself be the verified fatal error.
        // Keep bounded raw measurements so quarantine is never hidden as a routine retry.
        !(c.before === null || pages(c.before, m.fatalVerification === null)) ||
        !(c.after === null || pages(c.after, m.fatalVerification === null))
      )
        throw invalid();
      break;
    default:
      throw invalid();
  }
  return m.fatalVerification !== null ? 'reopen-required' : c.status;
}

/** Retain the command AND cancellation until settled; a durable receipt wins a late abort. */
export async function maintainGuideStorage(signal: AbortSignal): Promise<GuideMaintenanceState> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error('Guide storage maintenance requires the installed app.');
  const requestId = crypto.randomUUID();
  let cancellation: Promise<unknown> | null = null;
  let cancellationError: unknown;
  const cancel = () => {
    cancellation = invoke('cancel_playlist', { requestId }).catch((error: unknown) => {
      cancellationError = error;
    });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return validateGuideMaintenance(await invoke('guide_retention_cleanup', { requestId }));
  } finally {
    signal.removeEventListener('abort', cancel);
    await Promise.resolve(cancellation).then(() => {
      if (cancellationError)
        throw new Error('Guide maintenance cancellation could not be confirmed.');
    });
  }
}
