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

import { describe, expect, it, vi } from 'vitest';
import {
  createDailyRefresh,
  DailyRefreshAttemptNotStartedError,
  DAILY_REFRESH_INTERVAL_MS as DAY,
  type DailyRefreshClock,
} from '../../src/catalog/daily-refresh';
import { SerializedPreferencesStore } from '../../src/preferences';
import { classifySettledNativeWriteFailure } from '../../src/platform/native-write-refusal';
import type { RefreshCadence } from '../../src/catalog/refresh-cadence';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let now = 1000,
    last = 0,
    enabled = true,
    cadence: RefreshCadence = 'daily';
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const clock: DailyRefreshClock = {
    now: () => now,
    setTimer(callback, delay) {
      const key = {};
      timers.set(key, { callback, delay });
      return key;
    },
    clearTimer(handle) {
      timers.delete(handle as object);
    },
  };
  const persist = vi.fn(async (time: number, _signal: AbortSignal) => {
    last = time;
  });
  const run = vi.fn(async (_signal: AbortSignal) => {});
  const owner = createDailyRefresh({
    clock,
    canRun: () => enabled,
    lastAttemptAt: () => last,
    cadence: () => cadence,
    persistAttempt: persist,
    run,
  });
  return {
    owner,
    run,
    persist,
    timers,
    time(value: number) {
      now = value;
    },
    enabled(value: boolean) {
      enabled = value;
    },
    last(value: number) {
      last = value;
    },
    cadence(value: RefreshCadence) {
      cadence = value;
    },
  };
}
describe('daily foreground refresh ownership', () => {
  it('Off cancels and joins owned work, then never leaves a timer or starts another attempt', async () => {
    const f = fixture(),
      work = deferred();
    let signal!: AbortSignal;
    f.run.mockImplementation((s) => {
      signal = s;
      return work.promise;
    });
    const running = f.owner.wake();
    await Promise.resolve();
    await Promise.resolve();
    f.cadence('off');
    let settled = false;
    const disabled = f.owner.wake().then(() => {
      settled = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    work.resolve();
    await Promise.all([running, disabled]);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.timers.size).toBe(0);
    await f.owner.dispose();
  });
  it('cadence change during persisted admission fences the old attempt and uses the new interval', async () => {
    const f = fixture(),
      save = deferred();
    f.persist.mockImplementationOnce(async (time) => {
      await save.promise;
      f.last(time);
    });
    const old = f.owner.wake();
    await Promise.resolve();
    f.cadence('hourly');
    save.resolve();
    await old;
    expect(f.run).not.toHaveBeenCalled();
    expect([...f.timers.values()][0]?.delay).toBe(3_600_000);
    f.time(3_601_000);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.owner.dispose();
  });
  it('long weekly/monthly timers are capped without treating a cap wake as due', async () => {
    const f = fixture();
    f.cadence('weekly');
    f.last(1000);
    await f.owner.wake();
    const [key, timer] = [...f.timers.entries()][0]!;
    expect(timer.delay).toBe(DAY);
    f.timers.delete(key);
    f.time(1000 + DAY);
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect([...f.timers.values()][0]?.delay).toBe(DAY);
    await f.owner.suspend();
    expect(f.timers.size).toBe(0);
    f.cadence('monthly');
    f.last(Date.UTC(2024, 0, 31, 12));
    f.time(Date.UTC(2024, 1, 29, 12) - 1);
    await f.owner.wake();
    expect([...f.timers.values()][0]?.delay).toBe(1);
    f.time(Date.UTC(2024, 1, 29, 12));
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.owner.dispose();
  });
  it('timer delivery rechecks foreground eligibility and never starts hidden work', async () => {
    const f = fixture();
    f.last(1000);
    await f.owner.wake();
    const [key, scheduled] = [...f.timers.entries()][0]!;
    f.timers.delete(key);
    f.time(1000 + DAY);
    f.enabled(false);
    scheduled.callback();
    await Promise.resolve();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    f.enabled(true);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.owner.dispose();
  });
  it('resume behind canceled work waits for its actual settlement before a new due attempt', async () => {
    const f = fixture(),
      work = deferred();
    f.run.mockImplementationOnce(() => work.promise);
    const first = f.owner.wake();
    await Promise.resolve();
    await Promise.resolve();
    const suspension = f.owner.suspend();
    f.time(1000 + DAY);
    const resumed = f.owner.wake();
    await Promise.resolve();
    expect(f.run).toHaveBeenCalledTimes(1);
    work.resolve();
    await Promise.all([first, suspension, resumed]);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.timers.size).toBe(1);
    await f.owner.dispose();
  });
  it('first enabled wake persists before run, repeats coalesce and the next attempt is exactly daily', async () => {
    const f = fixture(),
      work = deferred();
    f.run.mockImplementation(() => work.promise);
    const first = f.owner.wake();
    expect(f.owner.wake()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.persist).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(f.run).toHaveBeenCalledTimes(1);
    work.resolve();
    await first;
    expect([...f.timers.values()][0]?.delay).toBe(DAY);
    f.time(1000 + DAY - 1);
    await f.owner.wake();
    expect([...f.timers.values()][0]?.delay).toBe(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    f.time(1000 + DAY);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(2);
    await f.owner.dispose();
    expect(f.timers.size).toBe(0);
  });
  it('hidden/disabled has no timer, resume uses persisted attempt and rollback timers remain bounded', async () => {
    const f = fixture();
    f.last(1000);
    f.enabled(false);
    await f.owner.wake();
    expect(f.timers.size).toBe(0);
    expect(f.run).not.toHaveBeenCalled();
    f.enabled(true);
    await f.owner.wake();
    expect(f.timers.size).toBe(1);
    await f.owner.suspend();
    expect(f.timers.size).toBe(0);
    f.time(500);
    await f.owner.wake();
    expect([...f.timers.values()][0]?.delay).toBe(DAY);
    await f.owner.dispose();
  });
  it('suspension joins pending persistence, then prevents a stale run even with permission restored', async () => {
    const f = fixture(),
      save = deferred();
    f.persist.mockImplementation(() => save.promise);
    const wake = f.owner.wake();
    await Promise.resolve();
    let joined = false;
    const suspension = f.owner.suspend().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    save.resolve();
    await Promise.all([wake, suspension]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    await f.owner.dispose();
  });
  it('rechecks host admission after persistence without starting refresh', async () => {
    const f = fixture(),
      save = deferred();
    f.persist.mockImplementation(() => save.promise);
    const wake = f.owner.wake();
    await Promise.resolve();
    f.enabled(false);
    save.resolve();
    await wake;
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    await f.owner.dispose();
  });
  it('disposal aborts actual work and waits for settlement, refusing new resources', async () => {
    const f = fixture(),
      work = deferred();
    let signal!: AbortSignal;
    f.run.mockImplementation((s) => {
      signal = s;
      return work.promise;
    });
    const wake = f.owner.wake();
    await Promise.resolve();
    await Promise.resolve();
    let done = false;
    const closing = f.owner.dispose().then(() => {
      done = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(done).toBe(false);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    work.resolve();
    await Promise.all([closing, wake]);
    expect(f.timers.size).toBe(0);
  });
  it('persistence failure does not run or schedule a retry loop; explicit wake retries', async () => {
    const f = fixture();
    f.persist.mockRejectedValueOnce(new Error('storage'));
    await expect(f.owner.wake()).rejects.toThrow('storage');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    await f.owner.wake();
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.owner.dispose();
  });
  it('run failure retains persisted attempt and close propagates actual unsettled failure', async () => {
    const f = fixture(),
      work = deferred();
    f.run.mockImplementation(() => work.promise);
    const wake = f.owner.wake();
    await Promise.resolve();
    await Promise.resolve();
    const close = f.owner.dispose();
    work.reject(new Error('drain refused'));
    await expect(wake).rejects.toThrow('drain refused');
    await expect(close).rejects.toThrow('drain refused');
    await f.owner.dispose();
    expect(f.timers.size).toBe(0);
  });
  it('joins a queued pre-write refusal without making clean disposal retry an operational error', async () => {
    const prior = deferred(),
      writes = vi.fn(async () => {});
    const preferences = new SerializedPreferencesStore({
      read: async () => {
        await prior.promise;
        return null;
      },
      write: writes,
    });
    const previous = preferences.load();
    let entered = false;
    const run = vi.fn(async () => {});
    const owner = createDailyRefresh({
      canRun: () => true,
      lastAttemptAt: () => 0,
      persistAttempt: async (time, signal) => {
        entered = true;
        await preferences.update(
          (draft) => {
            draft.sourceRefreshAttemptAt = time;
          },
          async () => {
            if (signal.aborted) throw new DailyRefreshAttemptNotStartedError();
            return true;
          },
        );
      },
      run,
    });
    const wake = owner.wake();
    const failure = expect(wake).rejects.toBeInstanceOf(DailyRefreshAttemptNotStartedError);
    await vi.waitFor(() => expect(entered).toBe(true));
    let joined = false;
    const closing = owner.dispose().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    prior.resolve();
    await Promise.all([previous, failure, closing]);
    expect(writes).not.toHaveBeenCalled();
    expect(preferences.snapshot().sourceRefreshAttemptAt).toBe(0);
    expect(run).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('joins an already admitted persistence receipt and retains its attempt without starting refresh after close', async () => {
    const f = fixture(),
      receipt = deferred();
    f.persist.mockImplementation(async (time) => {
      await receipt.promise;
      f.last(time);
    });
    const wake = f.owner.wake();
    await vi.waitFor(() => expect(f.persist).toHaveBeenCalledTimes(1));
    let joined = false;
    const close = f.owner.dispose().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    receipt.resolve();
    await Promise.all([wake, close]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.persist.mock.calls[0]![1].aborted).toBe(true);
    expect(f.timers.size).toBe(0);
  });
  it('does not classify generic AbortError or unknown persistence failure as a pre-write receipt', async () => {
    for (const error of [
      new DOMException('Canceled', 'AbortError'),
      new Error('Unknown write outcome'),
    ]) {
      const f = fixture(),
        work = deferred();
      f.persist.mockImplementation(() => work.promise);
      const wake = f.owner.wake();
      const failedWake = expect(wake).rejects.toBe(error);
      await vi.waitFor(() => expect(f.persist).toHaveBeenCalledTimes(1));
      let closed = false;
      const close = f.owner.dispose().then(() => {
        closed = true;
      });
      const failedClose = expect(close).rejects.toBe(error);
      await Promise.resolve();
      expect(closed).toBe(false);
      work.reject(error);
      await Promise.all([failedWake, failedClose]);
      expect(f.run).not.toHaveBeenCalled();
    }
  });
  it('suspend joins a known canceled pre-write refusal while active operational refusals still reject wake', async () => {
    const f = fixture(),
      work = deferred();
    f.persist.mockImplementationOnce(() => work.promise);
    const wake = f.owner.wake();
    const failedWake = expect(wake).rejects.toBeInstanceOf(DailyRefreshAttemptNotStartedError);
    await vi.waitFor(() => expect(f.persist).toHaveBeenCalledTimes(1));
    const suspended = f.owner.suspend();
    work.reject(new DailyRefreshAttemptNotStartedError());
    await Promise.all([failedWake, suspended]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    f.persist.mockRejectedValueOnce(new DailyRefreshAttemptNotStartedError());
    await expect(f.owner.wake()).rejects.toBeInstanceOf(DailyRefreshAttemptNotStartedError);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    await f.owner.dispose();
  });
  it('does not accept the pre-write error type from the run/cleanup stage', async () => {
    const f = fixture(),
      work = deferred();
    const error = new DailyRefreshAttemptNotStartedError();
    f.run.mockImplementation(() => work.promise);
    const wake = f.owner.wake();
    const failedWake = expect(wake).rejects.toBe(error);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const close = f.owner.dispose();
    const failedClose = expect(close).rejects.toBe(error);
    work.reject(error);
    await Promise.all([failedWake, failedClose]);
  });
  it('accepts a joined native persistence noncommit receipt only during canceled lifecycle work', async () => {
    const f = fixture(),
      work = deferred();
    const error = classifySettledNativeWriteFailure('write_record_receipt', 'application-closing')!;
    f.persist.mockImplementation(() => work.promise);
    const wake = f.owner.wake();
    const failedWake = expect(wake).rejects.toBe(error);
    await vi.waitFor(() => expect(f.persist).toHaveBeenCalledTimes(1));
    const close = f.owner.dispose();
    work.reject(error);
    await Promise.all([failedWake, close]);
    expect(f.run).not.toHaveBeenCalled();
    const running = fixture(),
      runWork = deferred();
    running.run.mockImplementation(() => runWork.promise);
    const active = running.owner.wake(),
      failedRun = expect(active).rejects.toBe(error);
    await vi.waitFor(() => expect(running.run).toHaveBeenCalledTimes(1));
    const runClose = running.owner.dispose(),
      failedClose = expect(runClose).rejects.toBe(error);
    runWork.reject(error);
    await Promise.all([failedRun, failedClose]);
  });
});
