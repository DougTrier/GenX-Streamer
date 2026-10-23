import { expect, it, vi } from 'vitest';
import {
  createDailyGuideRefresh,
  type GuideRefreshPlanEntry,
  type GuideRefreshResult,
} from '../../src/guide/daily-refresh';
import type { DailyRefreshClock } from '../../src/catalog/daily-refresh';
function fixture() {
  let now = 1000,
    enabled = true;
  const timers = new Map<object, { callback: () => void; due: number }>();
  const clock: DailyRefreshClock = {
    now: () => now,
    setTimer(callback, delay) {
      const key = {};
      timers.set(key, { callback, due: now + delay });
      return key;
    },
    clearTimer(key) {
      timers.delete(key as object);
    },
  };
  const plan = vi.fn(async (_signal: AbortSignal): Promise<GuideRefreshPlanEntry[]> => [
    { sourceId: 'a', sourceRevision: 1, nextDueMs: 0 },
  ]);
  const refresh = vi.fn(
    async (_entry: GuideRefreshPlanEntry, _signal: AbortSignal): Promise<GuideRefreshResult> => ({
      status: 'refreshed' as const,
      nextDueMs: now + 86400000,
    }),
  );
  const onChanged = vi.fn(),
    onError = vi.fn();
  const owner = createDailyGuideRefresh({
    canRun: () => enabled,
    clock,
    plan,
    refresh,
    onChanged,
    onError,
  });
  return {
    owner,
    plan,
    refresh,
    onChanged,
    onError,
    timers,
    time(value: number) {
      now = value;
    },
    enable(value: boolean) {
      enabled = value;
    },
    fire() {
      const [key, item] = [...timers.entries()][0]!;
      timers.delete(key);
      now = item.due;
      item.callback();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it('notifies a durable refresh while Guide is open without acquiring the next source or arming work', async () => {
  const f = fixture();
  f.plan.mockResolvedValue([
    { sourceId: 'a', sourceRevision: 1, nextDueMs: 0 },
    { sourceId: 'b', sourceRevision: 1, nextDueMs: 0 },
  ]);
  let finish!: (receipt: GuideRefreshResult) => void;
  f.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.owner.wake();
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  // A dialog makes future acquisition ineligible, but does not dispose this owner.
  f.enable(false);
  finish({ status: 'refreshed', nextDueMs: 86400000 });
  await pending;
  expect(f.onChanged).toHaveBeenCalledTimes(1);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.timers.size).toBe(0);
  expect(f.onError).not.toHaveBeenCalled();
  f.enable(true);
  await f.owner.wake();
  expect(f.refresh.mock.calls.map((call) => call[0].sourceId)).toEqual(['a', 'b']);
  expect(f.onChanged).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});

it.each([
  { status: 'not-modified', nextDueMs: 86400000 },
  { status: 'refreshed', nextDueMs: NaN },
  { status: 'invented', nextDueMs: 86400000 },
])(
  'does not notify an unchanged or invalid receipt while acquisition is ineligible: %j',
  async (receipt) => {
    const f = fixture();
    let finish!: (result: GuideRefreshResult) => void;
    f.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.owner.wake();
    await flush();
    f.enable(false);
    finish(receipt as GuideRefreshResult);
    await pending;
    expect(f.onChanged).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.timers.size).toBe(0);
    await f.owner.dispose();
  },
);

it('disposal still suppresses a held durable receipt even when a dialog is open', async () => {
  const f = fixture();
  let finish!: (result: GuideRefreshResult) => void;
  f.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.owner.wake();
  await flush();
  f.enable(false);
  const disposed = f.owner.dispose();
  finish({ status: 'refreshed', nextDueMs: 86400000 });
  await Promise.all([pending, disposed]);
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
});

it('serializes due sources, schedules earliest due capped at24h, and checks foreground on timer delivery', async () => {
  const f = fixture();
  f.plan.mockResolvedValue([
    { sourceId: 'a', sourceRevision: 1, nextDueMs: 0 },
    { sourceId: 'b', sourceRevision: 2, nextDueMs: 5000 },
  ]);
  await f.owner.wake();
  expect(f.refresh.mock.calls.map((x) => x[0].sourceId)).toEqual(['a']);
  expect(f.onChanged).toHaveBeenCalledTimes(1);
  expect([...f.timers.values()][0]?.due).toBe(5000);
  f.enable(false);
  f.fire();
  await flush();
  expect(f.plan).toHaveBeenCalledTimes(1);
  expect(f.timers.size).toBe(0);
  f.enable(true);
  await f.owner.wake();
  expect(f.refresh.mock.calls.map((x) => x[0].sourceId)).toEqual(['a', 'b']);
  expect(f.timers.size).toBe(1);
  await f.owner.dispose();
  expect(f.timers.size).toBe(0);
});

it('one pending job is shared; suspend and resume join an aborted late publication without stale notification', async () => {
  const f = fixture();
  let finish!: () => void;
  f.refresh.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { status: 'refreshed', nextDueMs: 86400000 };
  });
  const first = f.owner.wake();
  expect(f.owner.wake()).toBe(first);
  await flush();
  const suspension = f.owner.suspend();
  let joined = false;
  void suspension.then(() => {
    joined = true;
  });
  const resume = f.owner.wake();
  await flush();
  expect(joined).toBe(false);
  expect(f.plan).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, suspension, resume]);
  expect(f.onChanged).toHaveBeenCalledTimes(1);
  expect(f.plan).toHaveBeenCalledTimes(2);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});

it('partial failures and deferred responses retain other refreshes and enforce15minute retries even explicit wakes', async () => {
  const f = fixture();
  f.plan.mockResolvedValue([
    { sourceId: 'a', sourceRevision: 1, nextDueMs: 0 },
    { sourceId: 'b', sourceRevision: 1, nextDueMs: 0 },
    { sourceId: 'c', sourceRevision: 1, nextDueMs: 0 },
  ]);
  f.refresh
    .mockRejectedValueOnce(new Error('https://secret.invalid/token'))
    .mockResolvedValueOnce({ status: 'deferred', nextDueMs: 0 });
  await f.owner.wake();
  expect(f.refresh).toHaveBeenCalledTimes(3);
  expect(f.onChanged).toHaveBeenCalledTimes(1);
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.onError.mock.calls[0]?.[0].message).not.toContain('secret');
  expect([...f.timers.values()][0]?.due).toBe(901000);
  await f.owner.wake();
  expect(f.refresh).toHaveBeenCalledTimes(3);
  f.time(901000);
  await f.owner.wake();
  expect(f.refresh.mock.calls.slice(3).map((x) => x[0].sourceId)).toEqual(['a', 'b']);
  await f.owner.dispose();
});

it('refuses oversized/invalid whole plans without refresh and paces failures, while changed revisions can be refreshed', async () => {
  const f = fixture();
  f.plan.mockResolvedValueOnce(
    Array.from({ length: 1001 }, (_, i) => ({
      sourceId: String(i),
      sourceRevision: 1,
      nextDueMs: 0,
    })),
  );
  await f.owner.wake();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledTimes(1);
  await f.owner.wake();
  expect(f.plan).toHaveBeenCalledTimes(1);
  f.time(901000);
  await f.owner.wake();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  f.plan.mockResolvedValue([{ sourceId: 'a', sourceRevision: 2, nextDueMs: 0 }]);
  await f.owner.wake();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});

it('canceled plan settles before disposal; generic cancellation failures cannot acknowledge cleanup', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.plan.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  const first = f.owner.wake();
  await flush();
  const drain = f.owner.dispose();
  reject(new Error('native cancellation unavailable secret'));
  await expect(first).rejects.toThrow('cancellation could not be confirmed');
  await expect(drain).rejects.toThrow('cancellation could not be confirmed');
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
  await f.owner.wake();
  expect(f.plan).toHaveBeenCalledTimes(1);
});

it('accepts abort acknowledgment and suppresses late plan results without starting a source', async () => {
  const f = fixture();
  let finish!: (entries: GuideRefreshPlanEntry[]) => void;
  f.plan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.owner.wake();
  await flush();
  const suspended = f.owner.suspend();
  finish([{ sourceId: 'a', sourceRevision: 1, nextDueMs: 0 }]);
  await Promise.all([first, suspended]);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
  await f.owner.dispose();
});

it('caps distant timers and refuses duplicate plan identities before any refresh', async () => {
  const f = fixture();
  f.plan.mockResolvedValueOnce([{ sourceId: 'a', sourceRevision: 1, nextDueMs: 10 * 86400000 }]);
  await f.owner.wake();
  expect([...f.timers.values()][0]?.due).toBe(86401000);
  expect(f.refresh).not.toHaveBeenCalled();
  f.plan.mockResolvedValueOnce([
    { sourceId: 'a', sourceRevision: 1, nextDueMs: 0 },
    { sourceId: 'a', sourceRevision: 2, nextDueMs: 0 },
  ]);
  await f.owner.wake();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});

it('an acknowledged refresh abort does not report a source failure or schedule hidden work', async () => {
  const f = fixture();
  f.refresh.mockImplementationOnce(
    async (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), {
          once: true,
        }),
      ),
  );
  const pending = f.owner.wake();
  await flush();
  f.enable(false);
  await f.owner.suspend();
  await pending;
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
  await f.owner.dispose();
});

it('schedules a validated not-modified result without publishing a false change notification', async () => {
  const f = fixture();
  f.refresh.mockResolvedValue({ status: 'not-modified', nextDueMs: 86400000 });
  await f.owner.wake();
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  await f.owner.wake();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.timers.size).toBe(1);
  await f.owner.dispose();
  expect(f.timers.size).toBe(0);
});
