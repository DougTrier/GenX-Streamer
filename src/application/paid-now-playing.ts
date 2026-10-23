import type { AccountGuide } from '../platform/account-guide';
import type { AccountMetadata } from '../platform/account-vault';
import type { VisibleGuideChannel } from '../ui/channel-guide';

/** What a Paid TV channel row on screen is showing now, from the stored provider guide. */
export interface NowPlayingRow extends VisibleGuideChannel {
  title: string;
  startMs: number;
  stopMs: number;
}
export interface PaidNowPlayingHost {
  guide: Pick<AccountGuide, 'programs'>;
  /** The selected Paid TV account, or null in Free TV / GenXtra. */
  account(): AccountMetadata | null;
  /** The row's provider EPG ID from the current channel page, or null. */
  epgId(channelId: string): string | null;
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
  async function load(): Promise<void> {
    owner?.abort();
    owner = null;
    const mine = ++generation;
    const account = host.account();
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
        const epgId = host.epgId(row.appChannelId);
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
              }
            : null;
        } catch {
          // A row without a readable listing keeps showing its channel name.
          return null;
        }
      }),
    );
    if (disposed || mine !== generation || controller.signal.aborted) return;
    if (host.account()?.id !== account.id) return;
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
      if (JSON.stringify(next) === JSON.stringify(scope)) return;
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
