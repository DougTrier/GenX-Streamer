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

import { nativeGuide } from '../guide/native';
import { maintainGuideStorage } from '../guide/maintenance';

/** Quiescent full-Guide maintenance; startup cache-only work never calls this host. */
export function createGuideMaintenance(host: {
  scanning(): boolean;
  scopeCurrent(): boolean;
  changed(): void;
}) {
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (host.scanning()) return 'deferred' as const;
    const sources = await nativeGuide.sources();
    signal.throwIfAborted();
    if (!sources.length) return undefined;
    const coverage = await nativeGuide.coverage(sources[0].id);
    signal.throwIfAborted();
    // Older installed hosts have no projection/maintenance capability.
    if (typeof coverage.projectionCompatible !== 'boolean') return undefined;
    if (host.scanning()) return 'deferred' as const;
    if (!host.scopeCurrent()) throw new DOMException('Guide configuration changed.', 'AbortError');
    const state = await maintainGuideStorage(signal);
    if (state !== 'reopen-required') {
      // Retention may commit even if later physical optimization is deferred.
      try {
        host.changed();
      } catch {
        // A presentation observer cannot erase a durable maintenance receipt.
      }
    }
    return state;
  };
}
