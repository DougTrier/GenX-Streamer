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

import type { OnlineSourceScanResult } from '../discovery/online-source-scan';

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Explains an empty online discovery truthfully: refused for quota versus nothing found. */
export function emptyOnlineDiscoveryText(
  result: Pick<OnlineSourceScanResult, 'rateLimited'>,
  nowMs = Date.now(),
): string {
  const limited = result.rateLimited;
  if (limited)
    return limited.retryAtMs !== null && limited.retryAtMs > nowMs
      ? `Public source lists are temporarily rate-limited until ${clock(limited.retryAtMs)}. Your saved channels are retained. Try Rescan after that time.`
      : 'Public source lists are temporarily rate-limited. Your saved channels are retained. Try Rescan in about an hour.';
  return 'No public channel sources could be found. Your saved channels are retained. Select Rescan to try again.';
}
