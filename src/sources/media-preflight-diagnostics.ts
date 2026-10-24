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

const fixedReasons = [
  'timeout',
  'dns-failure',
  'tls-failure',
  'connectivity-failure',
  'network-failure',
  'redirect-refused',
  'url-policy-refused',
  'playlist-too-large',
  'playlist-invalid-utf8',
  'network-unavailable',
  'resource-read-unavailable',
  'resource-http-unavailable',
  'drm-unverified',
  'external-audio-unverified',
  'format-unverified',
  'init-map-unverified',
  'key-invalid',
  'manifest-cycle-unverified',
  'manifest-depth-unverified',
  'manifest-invalid',
  'media-format-unverified',
  'range-invalid',
  'range-unavailable',
  'request-limit-unverified',
  'resource-empty',
  'resource-error-document',
  'resource-too-large',
  'resource-url-invalid',
] as const;
const reasons = new Set<string>(fixedReasons);
export type MediaPreflightFailureReason = (typeof fixedReasons)[number] | 'unknown';
export interface MediaPreflightDiagnosticReceipt {
  status: 'resources-responded' | 'unavailable' | 'unverified';
  reasonCode: string;
  httpStatus?: number;
  checkedResources: number;
  headerRetryCount?: 1;
  headerRetryReason?: 'network-failure';
}
export interface MediaPreflightNegative {
  readonly ordinal: number;
  readonly timestampMs: number;
  readonly status: 'unavailable' | 'unverified';
  readonly reasonCode: MediaPreflightFailureReason;
  readonly httpStatus: number | null;
  readonly checkedResources: number;
}
export interface MediaPreflightRetry {
  readonly ordinal: number;
  readonly timestampMs: number;
  readonly status: 'resources-responded' | 'unavailable' | 'unverified';
  readonly headerRetryCount: 1;
  readonly headerRetryReason: 'network-failure';
}
/** Absent fields are legacy zero; present fields prove exactly one admitted retry. */
export function mediaPreflightHeaderRetry(value: object): 0 | 1 | null {
  const count = Object.getOwnPropertyDescriptor(value, 'headerRetryCount');
  const reason = Object.getOwnPropertyDescriptor(value, 'headerRetryReason');
  if (!count && !reason)
    return 'headerRetryCount' in value || 'headerRetryReason' in value ? null : 0;
  return count &&
    reason &&
    'value' in count &&
    'value' in reason &&
    count.value === 1 &&
    reason.value === 'network-failure'
    ? 1
    : null;
}
/** Non-authoritative scalar receipt evidence; no persistence, timers or diagnostics errors escape. */
export function createMediaPreflightDiagnostics(
  options: {
    now?: () => number;
    /** Lower ceiling enables deterministic saturation fixtures; production uses MAX_SAFE_INTEGER. */
    counterLimit?: number;
  } = {},
) {
  const limit = options.counterLimit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Invalid diagnostic counter limit.');
  let receipts = 0,
    negativeReceipts = 0,
    retriedReceipts = 0,
    successfulRetryReceipts = 0,
    overflow = false;
  const negatives: Readonly<MediaPreflightNegative>[] = [];
  const retries: Readonly<MediaPreflightRetry>[] = [];
  return {
    record(value: MediaPreflightDiagnosticReceipt, canceled = false): void {
      try {
        if (
          canceled ||
          !value ||
          !['resources-responded', 'unavailable', 'unverified'].includes(value.status) ||
          typeof value.reasonCode !== 'string' ||
          !Number.isSafeInteger(value.checkedResources) ||
          value.checkedResources < 0 ||
          value.checkedResources > 8 ||
          (value.httpStatus !== undefined &&
            (!Number.isInteger(value.httpStatus) ||
              value.httpStatus < 100 ||
              value.httpStatus > 599))
        )
          return;
        const retry = mediaPreflightHeaderRetry(value);
        if (retry === null || (retry === 1 && value.checkedResources < 2)) return;
        const negative = value.status !== 'resources-responded';
        const timestampMs = negative || retry ? (options.now ?? Date.now)() : 0;
        if (
          (negative || retry) &&
          (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 8640000000000000)
        )
          return;
        if (receipts === limit) overflow = true;
        else receipts++;
        if (retry) {
          if (retriedReceipts === limit) overflow = true;
          else retriedReceipts++;
          if (value.status === 'resources-responded') {
            if (successfulRetryReceipts === limit) overflow = true;
            else successfulRetryReceipts++;
          }
          if (retries.length === 64) retries.shift();
          retries.push(
            Object.freeze({
              ordinal: receipts,
              timestampMs,
              status: value.status,
              headerRetryCount: 1,
              headerRetryReason: 'network-failure',
            }),
          );
        }
        if (!negative) return;
        if (negativeReceipts === limit) overflow = true;
        else negativeReceipts++;
        const record = Object.freeze({
          ordinal: receipts,
          timestampMs,
          status: value.status as 'unavailable' | 'unverified',
          reasonCode: reasons.has(value.reasonCode)
            ? (value.reasonCode as MediaPreflightFailureReason)
            : ('unknown' as const),
          httpStatus: value.httpStatus ?? null,
          checkedResources: value.checkedResources,
        });
        if (negatives.length === 64) negatives.shift();
        negatives.push(record);
      } catch {
        /* Observational failure cannot alter health or cleanup ownership. */
      }
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 1 as const,
        receipts,
        negativeReceipts,
        retriedReceipts,
        successfulRetryReceipts,
        overflow,
        negatives: Object.freeze([...negatives]),
        retries: Object.freeze([...retries]),
      });
    },
  };
}
const observer = createMediaPreflightDiagnostics();
/** Internal caller supplies only the already validated matching receipt scalars. */
export const recordValidatedMediaPreflightReceipt = observer.record;
export const mediaPreflightDiagnosticsSnapshot = observer.snapshot;
