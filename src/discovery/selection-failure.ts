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

/** Fixed diagnostics only: never transport source values or arbitrary exception text. */
export const SCAN_PREPARATION_FAILURE_CODES = [
  'prepare-source-mime',
  'prepare-source-scope',
  'prepare-catalog-validation',
  'prepare-preferences-validation',
  'prepare-health-ownership',
  'prepare-health-validation',
  'prepare-capacity',
  'prepare-crypto-failed',
  'prepare-runtime-unsupported',
  'prepare-worker-runtime',
  'prepare-worker-clone',
  'prepare-worker-protocol',
  'prepare-unknown',
] as const;
export type ScanPreparationFailureCode = (typeof SCAN_PREPARATION_FAILURE_CODES)[number];
const messages: Readonly<Record<string, ScanPreparationFailureCode>> = {
  'Invalid media MIME type.': 'prepare-source-mime',
  'Invalid playlist source.': 'prepare-source-scope',
  'Invalid source content kind.': 'prepare-source-scope',
  'Invalid HTTP permission.': 'prepare-source-scope',
  'The reviewed source scope is invalid.': 'prepare-source-scope',
  'The reviewed source changed. Scan it again.': 'prepare-source-scope',
  'A reviewed channel belongs to a different source.': 'prepare-source-scope',
  'Invalid catalog schema.': 'prepare-catalog-validation',
  'Invalid catalog channel.': 'prepare-catalog-validation',
  'Invalid provider identity.': 'prepare-catalog-validation',
  'Invalid channel URL.': 'prepare-catalog-validation',
  'Invalid catalog URL.': 'prepare-catalog-validation',
  'Unsupported catalog URL protocol.': 'prepare-catalog-validation',
  'HTTP requires explicit source permission.': 'prepare-catalog-validation',
  'Credentials embedded in catalog URLs are not supported.': 'prepare-catalog-validation',
  'Duplicate catalog channel identity.': 'prepare-catalog-validation',
  'Duplicate catalog source identity.': 'prepare-catalog-validation',
  'Duplicate channel stream candidates.': 'prepare-catalog-validation',
  'Channel references a missing catalog source.': 'prepare-catalog-validation',
  'Unsupported or invalid preferences schema.': 'prepare-preferences-validation',
  'Invalid favorites.': 'prepare-preferences-validation',
  'Favorites contain duplicate identities.': 'prepare-preferences-validation',
  'Invalid removed channel identities.': 'prepare-preferences-validation',
  'Invalid audio preferences.': 'prepare-preferences-validation',
  'Invalid panel width.': 'prepare-preferences-validation',
  'Invalid voice search consent.': 'prepare-preferences-validation',
  'Invalid automatic source refresh preferences.': 'prepare-preferences-validation',
  'Invalid playlist sources.': 'prepare-preferences-validation',
  'Duplicate source identity.': 'prepare-preferences-validation',
  'Invalid preferred region.': 'prepare-preferences-validation',
  'Preferred region requires a country.': 'prepare-preferences-validation',
  'Preferred region postal code is invalid.': 'prepare-preferences-validation',
  'Reviewed health candidate identity is invalid.': 'prepare-health-ownership',
  'Reviewed health source is obsolete.': 'prepare-health-ownership',
  'Reviewed health includes an unselected or changed channel.': 'prepare-health-ownership',
  'Reviewed health ownership or canonical mapping changed.': 'prepare-health-ownership',
  'Reviewed health observation is obsolete.': 'prepare-health-ownership',
  'Repeated reviewed health candidate.': 'prepare-health-ownership',
  'Duplicate contextual health identity.': 'prepare-health-ownership',
  'Duplicate current health target.': 'prepare-health-ownership',
  'Health metadata is invalid.': 'prepare-health-validation',
  'Health record contains unsupported fields.': 'prepare-health-validation',
  'Health target is invalid.': 'prepare-health-validation',
  'Health target identity is invalid.': 'prepare-health-validation',
  'Health decoder sample is invalid.': 'prepare-health-validation',
  'Health evidence is invalid.': 'prepare-health-validation',
  'Health HTTP evidence is invalid.': 'prepare-health-validation',
  'Health decoder interval is invalid.': 'prepare-health-validation',
  'Unsupported health evidence.': 'prepare-health-validation',
  'Unsupported health record schema.': 'prepare-health-validation',
  'Health observation metadata is invalid.': 'prepare-health-validation',
  'Health verdict does not match its evidence.': 'prepare-health-validation',
  'Reviewed verdict lacks its claimed evidence.': 'prepare-health-validation',
  'The checked health target is invalid.': 'prepare-health-validation',
  'The checked health URL is not admitted.': 'prepare-health-validation',
  'The checked source is not admitted.': 'prepare-health-validation',
  'Catalog exceeds source or channel limits.': 'prepare-capacity',
  'Catalog exceeds the 20 MiB storage limit.': 'prepare-capacity',
  'Health records exceed the supported bound.': 'prepare-capacity',
  'Health target count exceeds bound.': 'prepare-capacity',
  'Reviewed health batch exceeds bound.': 'prepare-capacity',
  'Reviewed health exceeds the selected check bound.': 'prepare-capacity',
  'Health payload exceeds its standalone20MiB bound.': 'prepare-capacity',
  'Preferences record exceeds the 20 MiB limit.': 'prepare-capacity',
};
export function isScanPreparationFailureCode(value: unknown): value is ScanPreparationFailureCode {
  return typeof value === 'string' && SCAN_PREPARATION_FAILURE_CODES.some((code) => code === value);
}
export function classifyScanPreparationFailure(failure: unknown): ScanPreparationFailureCode {
  if (!(failure instanceof Error)) return 'prepare-unknown';
  const known = Object.prototype.hasOwnProperty.call(messages, failure.message)
    ? messages[failure.message]
    : undefined;
  if (known) return known;
  // Names identify standard platform failures; no engine-specific message is returned.
  if (failure.name === 'NotSupportedError') return 'prepare-runtime-unsupported';
  if (failure.name === 'OperationError') return 'prepare-crypto-failed';
  if (failure.name === 'DataCloneError') return 'prepare-worker-clone';
  return 'prepare-unknown';
}
