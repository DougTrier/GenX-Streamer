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

import { createDailyGuideRefresh, type DailyGuideRefreshOptions } from '../../guide/daily-refresh';
import { GUIDE_REFRESH_INTERVAL_MS } from '../../guide/refresh-interval';
import { createOwnedAbortSignals } from '../../platform/abort';
import type { AccountGuide } from '../../platform/account-guide';
import type { AccountMetadata } from '../../platform/account-vault';

export interface PaidGuideRefreshScope {
  account: Readonly<AccountMetadata>;
  signal: AbortSignal;
  identity: string;
}
/** Renews only a selected account's already stored guide; never opens media. */
export function createPaidGuideRefresh(options: {
  guide: Pick<AccountGuide, 'status' | 'refresh'>;
  scope(): PaidGuideRefreshScope | null;
  subscribe(listener: () => void): () => void;
  canRun: DailyGuideRefreshOptions['canRun'];
  canAcquire?: DailyGuideRefreshOptions['canAcquire'];
  onChanged?: DailyGuideRefreshOptions['onChanged'];
  onError?: DailyGuideRefreshOptions['onError'];
  clock?: DailyGuideRefreshOptions['clock'];
}) {
  const now = options.clock?.now ?? Date.now;
  let planned: PaidGuideRefreshScope | null = null;
  const current = (scope: PaidGuideRefreshScope) =>
    !scope.signal.aborted && options.scope()?.identity === scope.identity;
  const owner = createDailyGuideRefresh({
    ...options,
    async plan(signal) {
      planned = options.scope();
      if (!planned || !current(planned)) return [];
      const scope = planned;
      const joined = createOwnedAbortSignals([signal, scope.signal]);
      try {
        const stored = await options.guide.status(scope.account, joined.signal);
        joined.signal.throwIfAborted();
        if (!stored || !current(scope)) return [];
        return [
          {
            sourceId: scope.account.id,
            sourceRevision: stored.revision,
            nextDueMs: stored.fetchedMs + GUIDE_REFRESH_INTERVAL_MS,
          },
        ];
      } finally {
        joined.dispose();
      }
    },
    async refresh(entry, signal) {
      const scope = planned;
      if (!scope || !current(scope) || scope.account.id !== entry.sourceId)
        return { status: 'deferred', nextDueMs: now() + GUIDE_REFRESH_INTERVAL_MS };
      const joined = createOwnedAbortSignals([signal, scope.signal]);
      try {
        const stored = await options.guide.status(scope.account, joined.signal);
        joined.signal.throwIfAborted();
        if (!stored || !current(scope))
          return { status: 'deferred', nextDueMs: now() + GUIDE_REFRESH_INTERVAL_MS };
        const due = stored.fetchedMs + GUIDE_REFRESH_INTERVAL_MS;
        // A manual update may have won since planning. Do not acquire twice.
        if (stored.revision !== entry.sourceRevision || due > now())
          return { status: 'not-due', nextDueMs: due };
        const receipt = await options.guide.refresh(scope.account, joined.signal);
        joined.signal.throwIfAborted();
        if (!current(scope)) throw new DOMException('Account selection changed.', 'AbortError');
        return { status: 'refreshed', nextDueMs: receipt.fetchedMs + GUIDE_REFRESH_INTERVAL_MS };
      } finally {
        joined.dispose();
      }
    },
  });
  const unsubscribe = options.subscribe(() => {
    // Join the native account-owned cancellation before renewing another account.
    void owner
      .suspend()
      .then(owner.wake)
      .catch(() =>
        options.onError?.(new Error('Automatic Paid TV guide cleanup could not be confirmed.')),
      );
  });
  return {
    wake: owner.wake,
    suspend: owner.suspend,
    async dispose() {
      unsubscribe();
      await owner.dispose();
    },
  };
}
