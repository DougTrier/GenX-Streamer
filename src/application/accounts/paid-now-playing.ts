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

import type { AccountGuide } from '../../platform/account-guide';
import type { AccountMetadata } from '../../platform/account-vault';
import type { VisibleGuideChannel } from '../../ui/guide/channel-guide';

/** What a Paid TV channel row on screen is showing now, from the stored provider guide. */
export interface NowPlayingRow extends VisibleGuideChannel {
  title: string;
  startMs: number;
  stopMs: number;
  description?: string | null;
  categories?: readonly { text: string }[];
}
export interface PaidNowPlayingHost {
  guide: Pick<AccountGuide, 'programs'>;
  /** The selected Paid TV account, or null in Free TV / GenXtra. */
  account(): AccountMetadata | null;
  /** The row's provider EPG ID from the current channel page, or null. */
  epgId(channelId: string): string | null;
  /** Current visible capability; PPV is permission for a scoped local guide read, not channel evidence. */
  scopeFor?(channelId: string): { epgId: string | null; ppv?: boolean } | null;
  now(): number;
  publish(rows: readonly NowPlayingRow[]): void;
  setInterval?(callback: () => void, ms: number): number;
  clearInterval?(handle: number): void;
}
const ROWS = 64;
const LOOK_AHEAD_MS = 6 * 3_600_000;
const REFRESH_MS = 60_000;

/**
 * Reads the provider guide already stored on this device (it never downloads)
 * for the Paid TV rows on screen, and publishes each row's current programme.
 * A newer scope or refresh cancels the older reads; their results are dropped.
 */
export function createPaidNowPlaying(host: PaidNowPlayingHost) {
  let scope: readonly VisibleGuideChannel[] = [];
  let scopeKey = '';
  let generation = 0;
  let owner: AbortController | null = null;
  let published = '';
  let disposed = false;
  const every = host.setInterval ?? ((callback, ms) => window.setInterval(callback, ms));
  const stop = host.clearInterval ?? ((handle) => window.clearInterval(handle));
  let timer: number | null = null;

  const publish = (rows: readonly NowPlayingRow[]) => {
    const key = JSON.stringify(rows);
    if (key === published) return;
    published = key;
    host.publish(rows);
  };
  const metadata = (row: VisibleGuideChannel) =>
    host.scopeFor
      ? host.scopeFor(row.appChannelId)
      : { epgId: host.epgId(row.appChannelId), ppv: false };
  const keyFor = (rows: readonly VisibleGuideChannel[], account: AccountMetadata | null) =>
    JSON.stringify([
      account?.id,
      account?.revision,
      rows.map((row) => [row.catalogSourceId, row.appChannelId, metadata(row)]),
    ]);
  async function load(): Promise<void> {
    owner?.abort();
    owner = null;
    const mine = ++generation;
    const account = host.account();
    const capturedKey = keyFor(scope, account);
    if (capturedKey !== scopeKey) publish([]);
    scopeKey = capturedKey;
    const source = account ? `account-${account.id}` : null;
    const wanted = source
      ? scope.filter((row) => row.catalogSourceId === source).slice(0, ROWS)
      : [];
    if (!account || !wanted.length) {
      publish([]);
      return;
    }
    const controller = (owner = new AbortController());
    const at = host.now();
    const rows = await Promise.all(
      wanted.map(async (row): Promise<NowPlayingRow | null> => {
        const admitted = metadata(row);
        const epgId = admitted?.epgId;
        if (!epgId) return null;
        try {
          const { programs } = await host.guide.programs(
            account,
            epgId,
            at,
            at + LOOK_AHEAD_MS,
            null,
            3,
            controller.signal,
            admitted?.ppv === true,
            row.appChannelId,
          );
          const current = programs.find(
            (program) => program.startMs <= at && program.stopMs !== null && program.stopMs > at,
          );
          return current
            ? {
                ...row,
                title: current.title,
                startMs: current.startMs,
                stopMs: current.stopMs!,
                ...(current.description ? { description: current.description } : {}),
                ...(current.categories?.length
                  ? { categories: current.categories.map((category) => ({ ...category })) }
                  : {}),
              }
            : null;
        } catch {
          // A row without a readable listing keeps showing its channel name.
          return null;
        }
      }),
    );
    if (disposed || mine !== generation || controller.signal.aborted) return;
    if (
      host.account()?.id !== account.id ||
      host.account()?.revision !== account.revision ||
      keyFor(scope, host.account()) !== capturedKey
    )
      return;
    owner = null;
    publish(rows.filter((row): row is NowPlayingRow => row !== null));
  }
  const reload = () => {
    if (!disposed) void load();
  };
  return {
    /** The rows now on screen (any library); only the selected account's are read. */
    setScope(rows: readonly VisibleGuideChannel[]) {
      if (disposed) return;
      const next = rows.map((row) => ({ ...row }));
      if (keyFor(next, host.account()) === scopeKey) return;
      scope = next;
      if (scope.length && timer === null) timer = every(reload, REFRESH_MS);
      if (!scope.length && timer !== null) {
        stop(timer);
        timer = null;
      }
      reload();
    },
    /** Read again now (after a guide download, or an account change). */
    refresh: reload,
    dispose() {
      disposed = true;
      owner?.abort();
      owner = null;
      if (timer !== null) stop(timer);
      timer = null;
    },
  };
}
