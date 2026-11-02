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

import { expect, it, vi } from 'vitest';
import {
  createPaidGuideRefresh,
  type PaidGuideRefreshScope,
} from '../../src/application/guide/paid-guide-refresh';
import { GUIDE_REFRESH_INTERVAL_MS as INTERVAL } from '../../src/guide/refresh-interval';
import type { AccountGuideStatus } from '../../src/platform/account-guide';
import type { AccountMetadata } from '../../src/platform/account-vault';

function fixture() {
  let now = INTERVAL + 1000,
    enabled = true,
    idle = true;
  const timers = new Map<object, { callback: () => void; due: number }>();
  let cancel = new AbortController();
  const account = (id: string) =>
    ({
      id,
      revision: '1',
      name: 'Provider',
      kind: 'xtream',
      schemaVersion: 1,
      serverOrigin: 'https://provider.invalid',
      allowHttp: false,
      requiresSignIn: false,
    }) as AccountMetadata;
  let scope: PaidGuideRefreshScope | null = {
    account: account('a'.repeat(32)),
    identity: 'first',
    signal: cancel.signal,
  };
  let changed: () => void = () => {};
  let stored: AccountGuideStatus | null = {
    revision: 1,
    fetchedMs: 1000,
    programs: 20,
    channels: 2,
    skipped: 0,
  };
  const status = vi.fn(
    async (_account: Readonly<AccountMetadata>, _signal?: AbortSignal) => stored,
  );
  const refresh = vi.fn(async (_account: Readonly<AccountMetadata>, _signal?: AbortSignal) => {
    stored = { ...stored!, revision: 2, fetchedMs: now };
    return stored;
  });
  const onChanged = vi.fn(),
    onError = vi.fn();
  const owner = createPaidGuideRefresh({
    guide: { status, refresh },
    scope: () => scope,
    subscribe(listener) {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    canRun: () => enabled,
    canAcquire: () => idle,
    onChanged,
    onError,
    clock: {
      now: () => now,
      setTimer(callback, delay) {
        const key = {};
        timers.set(key, { callback, due: now + delay });
        return key;
      },
      clearTimer(key) {
        timers.delete(key as object);
      },
    },
  });
  return {
    owner,
    status,
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
    idle(value: boolean) {
      idle = value;
    },
    stored(value: AccountGuideStatus | null) {
      stored = value;
    },
    select(id: string | null) {
      cancel.abort();
      cancel = new AbortController();
      scope = id ? { account: account(id.repeat(32)), identity: id, signal: cancel.signal } : null;
      changed();
    },
    fire() {
      const [key, timer] = [...timers][0]!;
      timers.delete(key);
      now = timer.due;
      timer.callback();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it('renews a cached selected account at three hours, never earlier or through media commands', async () => {
  const f = fixture();
  f.time(INTERVAL + 999);
  await f.owner.wake();
  expect(f.refresh).not.toHaveBeenCalled();
  expect([...f.timers.values()][0].due).toBe(INTERVAL + 1000);
  f.fire();
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.onChanged).toHaveBeenCalledTimes(1);
  expect([...f.timers.values()][0].due).toBe(2 * INTERVAL + 1000);
  await f.owner.dispose();
});
it('does not discover/download missing Paid guides or query an unselected account', async () => {
  const f = fixture();
  f.stored(null);
  await f.owner.wake();
  expect(f.refresh).not.toHaveBeenCalled();
  f.select(null);
  await flush();
  expect(f.status).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});
it('defers all database and provider work during playback/Guide load, then retries while idle', async () => {
  const f = fixture();
  f.idle(false);
  await f.owner.wake();
  expect(f.status).not.toHaveBeenCalled();
  expect([...f.timers.values()][0].due).toBe(INTERVAL + 1000 + 900000);
  f.idle(true);
  f.fire();
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});
it('keeps the saved schedule on provider failure and retries without marking it fresh', async () => {
  const f = fixture();
  f.refresh.mockRejectedValueOnce(new Error('private provider failure'));
  await f.owner.wake();
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect([...f.timers.values()][0].due).toBe(INTERVAL + 1000 + 900000);
  f.fire();
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});
it('rechecks the durable revision so a manual update wins without a second download', async () => {
  const f = fixture();
  f.status
    .mockResolvedValueOnce({ revision: 1, fetchedMs: 1000, programs: 20, channels: 2, skipped: 0 })
    .mockResolvedValueOnce({
      revision: 2,
      fetchedMs: INTERVAL + 1000,
      programs: 20,
      channels: 2,
      skipped: 0,
    });
  await f.owner.wake();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.onChanged).not.toHaveBeenCalled();
  expect([...f.timers.values()][0].due).toBe(2 * INTERVAL + 1000);
  await f.owner.dispose();
});
it('account switching aborts and joins its owned XML request before the next account can start', async () => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => (release = resolve));
  let oldSignal: AbortSignal | undefined;
  f.refresh.mockImplementationOnce(async (_account, signal) => {
    oldSignal = signal;
    entered();
    await new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    await cleanup;
    throw new DOMException('Canceled', 'AbortError');
  });
  const work = f.owner.wake();
  await started;
  f.select('b');
  expect(oldSignal!.aborted).toBe(true);
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.status.mock.calls.every(([account]) => account.id.startsWith('a'))).toBe(true);
  release();
  await work;
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.refresh.mock.calls[1][0].id).toBe('b'.repeat(32));
  expect(f.onError).not.toHaveBeenCalled();
  await f.owner.dispose();
});
it('disabled automatic updates start no reads, timers or provider requests', async () => {
  const f = fixture();
  f.enable(false);
  await f.owner.wake();
  expect(f.status).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
  await f.owner.dispose();
});

it('playback pressure cancels and joins a running XML acquisition before low-priority retry', async () => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => (release = resolve));
  let signal: AbortSignal | undefined;
  f.refresh.mockImplementationOnce(async (_account, owned) => {
    signal = owned;
    entered();
    await new Promise<void>((resolve) =>
      owned!.addEventListener('abort', () => resolve(), { once: true }),
    );
    await cleanup;
    throw new DOMException('Canceled', 'AbortError');
  });
  const work = f.owner.wake();
  await started;
  f.idle(false);
  let joined = false;
  const pause = f.owner.wake().then(() => {
    joined = true;
  });
  expect(signal!.aborted).toBe(true);
  await flush();
  expect(joined).toBe(false);
  expect(f.timers.size).toBe(0);
  release();
  await Promise.all([work, pause]);
  expect(joined).toBe(true);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(1);
  f.idle(true);
  f.fire();
  await flush();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});
