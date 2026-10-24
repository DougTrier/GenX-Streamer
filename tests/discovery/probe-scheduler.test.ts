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

import { describe, it, expect, vi } from 'vitest';
import { createProbeScheduler, type ProbeTimer } from '../../src/discovery/probe-scheduler';
function clock(start = 0) {
  let time = start,
    id = 0;
  const handles = new Map<number, { at: number; call: () => void }>();
  const clear = vi.fn((handle: unknown) => {
    handles.delete(handle as number);
  });
  const timer: ProbeTimer = {
    set: (call, delay) => {
      const key = id++;
      handles.set(key, { at: time + delay, call });
      return key;
    },
    clear,
  };
  return {
    now: () => time,
    timer,
    clear,
    handles,
    tick(ms: number) {
      time += ms;
      for (const [key, value] of [...handles])
        if (value.at <= time) {
          handles.delete(key);
          value.call();
        }
    },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function flush() {
  for (let n = 0; n < 8; n++) await Promise.resolve();
}
describe('explicit provider pacing', () => {
  it('caller abort retains active ownership until the operation settles before admitting its successor', async () => {
    const c = clock(),
      scheduler = createProbeScheduler(c),
      gate = deferred<number>(),
      caller = new AbortController();
    let owned: AbortSignal | undefined,
      started = false;
    const active = scheduler.run('https://provider.invalid', caller.signal, async (signal) => {
      owned = signal;
      return gate.promise;
    });
    const rejecting = expect(active).rejects.toThrow('canceled');
    const next = scheduler.run(
      'https://provider.invalid',
      new AbortController().signal,
      async () => {
        started = true;
        return 2;
      },
    );
    caller.abort();
    c.tick(1000);
    await flush();
    expect(owned?.aborted).toBe(true);
    expect(started).toBe(false);
    gate.resolve(1);
    await rejecting;
    expect(await next).toBe(2);
    await scheduler.dispose();
  });
  it('serializes a provider burst, spaces starts and allows independent origins', async () => {
    const c = clock(),
      scheduler = createProbeScheduler(c);
    const starts: number[] = [];
    const first = deferred<number>();
    const signal = new AbortController().signal;
    const a = scheduler.run('https://provider.invalid/first', signal, async () => {
      starts.push(c.now());
      return first.promise;
    });
    const b = scheduler.run('https://provider.invalid/second?token=secret', signal, async () => {
      starts.push(c.now());
      return 2;
    });
    const unrelated = await scheduler.run('https://other.invalid', signal, async () => 3);
    expect(unrelated).toBe(3);
    c.tick(200);
    expect(starts).toEqual([0]);
    first.resolve(1);
    expect(await a).toBe(1);
    await flush();
    c.tick(149);
    expect(starts).toEqual([0]);
    c.tick(1);
    expect(await b).toBe(2);
    expect(starts).toEqual([0, 350]);
    scheduler.clear();
    await scheduler.dispose();
  });
  it('cancels a queued timer immediately and preserves spacing for the next job', async () => {
    const c = clock(),
      scheduler = createProbeScheduler(c),
      signal = new AbortController().signal;
    await scheduler.run('https://provider.invalid', signal, async () => 1);
    await flush();
    const canceled = new AbortController(),
      operation = vi.fn(async () => 2);
    const b = scheduler.run('https://provider.invalid', canceled.signal, operation);
    const rejected = expect(b).rejects.toThrow('canceled');
    expect(c.handles.size).toBe(1);
    canceled.abort();
    await rejected;
    expect(c.handles.size).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    const next = scheduler.run('https://provider.invalid', signal, async () => 3);
    c.tick(350);
    expect(await next).toBe(3);
    await scheduler.dispose();
  });
  it('applies RetryAfter inside operation before provider successors can start', async () => {
    const c = clock(),
      scheduler = createProbeScheduler(c),
      signal = new AbortController().signal;
    let second = false;
    const first = scheduler.run('https://provider.invalid', signal, async () => {
      scheduler.noteRetryAfter('https://provider.invalid/path', '2', 429);
      return 429;
    });
    const next = scheduler.run('https://provider.invalid', signal, async () => {
      second = true;
      return 200;
    });
    await first;
    await flush();
    c.tick(1999);
    expect(second).toBe(false);
    c.tick(1);
    expect(await next).toBe(200);
    await scheduler.dispose();
  });
  it('uses bounded retry seconds/date/fallback without clearing prior cooldown on success', async () => {
    const start = Date.parse('Sat, 10 Oct 2026 18:00:00 GMT'),
      c = clock(start),
      scheduler = createProbeScheduler(c);
    const origin = 'https://provider.invalid';
    expect(scheduler.noteRetryAfter(origin, '3', 429)).toBe(3000);
    expect(scheduler.noteRetryAfter(origin, 'Sat, 10 Oct 2026 18:00:05 GMT', 503)).toBe(5000);
    expect(scheduler.noteRetryAfter(origin, '9'.repeat(128), 503)).toBe(60000);
    expect(scheduler.noteRetryAfter(origin, '9'.repeat(129), 503)).toBe(10000);
    expect(scheduler.noteRetryAfter(origin, '-1', 429)).toBe(10000);
    expect(scheduler.noteRetryAfter(origin, '1.5', 429)).toBe(10000);
    expect(scheduler.noteRetryAfter(origin, null, 503)).toBe(10000);
    expect(scheduler.noteRetryAfter(origin, 'Fri, 31 Feb 2026 18:00:00 GMT', 503)).toBe(10000);
    expect(scheduler.noteRetryAfter(origin, 'Fri, 09 Oct 2026 18:00:00 GMT', 503)).toBe(0);
    expect(scheduler.noteRetryAfter(origin, '0', 200)).toBe(0);
    let started = false;
    const pending = scheduler.run(origin, new AbortController().signal, async () => {
      started = true;
      return 1;
    });
    c.tick(59999);
    expect(started).toBe(false);
    c.tick(1);
    await pending;
    await scheduler.dispose();
  });
  it('dispose aborts active operation but joins real settlement and rejects queued work', async () => {
    const c = clock(),
      scheduler = createProbeScheduler(c),
      gate = deferred<number>();
    let ownedSignal: AbortSignal | undefined;
    const active = scheduler.run(
      'https://provider.invalid',
      new AbortController().signal,
      async (signal) => {
        ownedSignal = signal;
        return gate.promise;
      },
    );
    const activeReject = expect(active).rejects.toThrow('canceled');
    const queued = scheduler.run(
      'https://provider.invalid',
      new AbortController().signal,
      async () => 2,
    );
    const queueReject = expect(queued).rejects.toThrow('canceled');
    expect(() => scheduler.clear()).toThrow('cleanup');
    let complete = false;
    const disposing = scheduler.dispose().then(() => {
      complete = true;
    });
    await queueReject;
    await flush();
    expect(ownedSignal?.aborted).toBe(true);
    expect(complete).toBe(false);
    gate.resolve(1);
    await activeReject;
    await disposing;
    expect(complete).toBe(true);
    expect(c.handles.size).toBe(0);
    await expect(
      scheduler.run('https://new.invalid', new AbortController().signal, async () => 1),
    ).rejects.toThrow('closed');
  });
  it('bounds registry/queue, validates destinations, and permits idle scan reset', async () => {
    const scheduler = createProbeScheduler();
    expect(() =>
      scheduler.noteRetryAfter('https://user:password@provider.invalid', '1', 429),
    ).toThrow('credentials');
    expect(() => scheduler.noteRetryAfter('file:///private', '1', 429)).toThrow('HTTP');
    for (let n = 0; n < 100; n++)
      scheduler.noteRetryAfter(`https://provider${n}.invalid`, null, 429);
    expect(() => scheduler.noteRetryAfter('https://overflow.invalid', null, 429)).toThrow(
      '100 active or cooling',
    );
    scheduler.clear();
    expect(scheduler.noteRetryAfter('https://overflow.invalid', null, 429)).toBe(10000);
    scheduler.clear();
    const gate = deferred<number>(),
      signal = new AbortController().signal;
    const queued = Array.from({ length: 1000 }, () =>
      scheduler.run('https://provider.invalid', signal, async () => gate.promise),
    );
    const rejections = queued.map((p) => expect(p).rejects.toThrow('canceled'));
    await expect(scheduler.run('https://provider.invalid', signal, async () => 1)).rejects.toThrow(
      '1,000',
    );
    const stopping = scheduler.dispose();
    gate.resolve(1);
    await stopping;
    await Promise.all(rejections);
  });
  it('aborted admission and malformed pacing options launch no work', async () => {
    expect(() => createProbeScheduler({ minIntervalMs: 5001 })).toThrow('limits');
    expect(() => createProbeScheduler({ maxCooldownMs: Infinity })).toThrow('limits');
    const scheduler = createProbeScheduler(),
      signal = new AbortController(),
      operation = vi.fn(async () => 1);
    signal.abort();
    await expect(
      scheduler.run('https://provider.invalid', signal.signal, operation),
    ).rejects.toThrow('canceled');
    expect(operation).not.toHaveBeenCalled();
    await scheduler.dispose();
  });
});

it('evicts only expired fully idle origins across a 150-provider scan and preserves revisit pacing', async () => {
  const c = clock(),
    scheduler = createProbeScheduler(c),
    signal = new AbortController().signal;
  for (let n = 0; n < 150; n++) {
    expect(await scheduler.run(`https://p${n}.invalid`, signal, async () => n)).toBe(n);
    await flush();
    c.tick(350);
  }
  expect(await scheduler.run('https://p0.invalid', signal, async () => 1)).toBe(1);
  await flush();
  let called = false;
  const next = scheduler.run('https://p0.invalid', signal, async () => {
    called = true;
    return 2;
  });
  c.tick(349);
  await flush();
  expect(called).toBe(false);
  c.tick(1);
  expect(await next).toBe(2);
  await scheduler.dispose();
  expect(c.handles.size).toBe(0);
});
it('registry pressure preserves RetryAfter cooldown and waits for protected origins', async () => {
  const c = clock(),
    scheduler = createProbeScheduler(c),
    signal = new AbortController().signal;
  scheduler.noteRetryAfter('https://cooling.invalid', '60', 429);
  for (let n = 0; n < 149; n++) {
    await scheduler.run(`https://ordinary${n}.invalid`, signal, async () => 1);
    await flush();
    c.tick(350);
  }
  let called = false;
  const held = scheduler.run('https://cooling.invalid', signal, async () => {
    called = true;
    return 1;
  });
  c.tick(60000 - c.now() - 1);
  await flush();
  expect(called).toBe(false);
  c.tick(1);
  expect(await held).toBe(1);
  await scheduler.dispose();
  const full = createProbeScheduler(c);
  for (let n = 0; n < 100; n++) full.noteRetryAfter(`https://cool${n}.invalid`, '60', 503);
  const waiting = new AbortController(),
    operation = vi.fn(async () => 1);
  const overflow = full.run('https://overflow.invalid', waiting.signal, operation);
  const canceled = expect(overflow).rejects.toThrow('canceled');
  expect(operation).not.toHaveBeenCalled();
  expect(c.handles.size).toBe(1);
  expect(() => full.clear()).toThrow('cleanup');
  waiting.abort();
  await canceled;
  expect(c.handles.size).toBe(0);
  await full.dispose();
  expect(c.handles.size).toBe(0);
});

it('admits all 121 fast unique origins with real pacing time rather than dropping cooling overflow', async () => {
  const scheduler = createProbeScheduler(),
    signal = new AbortController().signal;
  const calls: number[] = [];
  try {
    for (let index = 0; index < 121; index++)
      expect(
        await scheduler.run(`https://fast${index}.invalid`, signal, async () => {
          calls.push(index);
          return index;
        }),
      ).toBe(index);
    expect(calls).toEqual(Array.from({ length: 121 }, (_, index) => index));
  } finally {
    await scheduler.dispose();
  }
});

it('capacity expiry wakes waiting admission without shortening RetryAfter on retained origins', async () => {
  const c = clock(),
    scheduler = createProbeScheduler(c),
    signal = new AbortController().signal;
  for (let n = 0; n < 100; n++) scheduler.noteRetryAfter(`https://held${n}.invalid`, '2', 429);
  const operation = vi.fn(async () => 101);
  const waiting = scheduler.run('https://new.invalid', signal, operation);
  c.tick(1999);
  await flush();
  expect(operation).not.toHaveBeenCalled();
  c.tick(1);
  expect(await waiting).toBe(101);
  expect(operation).toHaveBeenCalledTimes(1);
  await scheduler.dispose();
  expect(c.handles.size).toBe(0);
});

it('full active capacity wakes on real settlement and disposal joins active jobs while canceling admissions', async () => {
  const c = clock(),
    scheduler = createProbeScheduler({ ...c, minIntervalMs: 0 });
  const gates = Array.from({ length: 100 }, () => deferred<number>());
  const active = gates.map((gate, index) =>
    scheduler.run(
      `https://active${index}.invalid`,
      new AbortController().signal,
      async () => gate.promise,
    ),
  );
  const failures = active.map((job) => expect(job).rejects.toThrow('canceled'));
  const operation = vi.fn(async () => 101);
  const waiting = scheduler.run('https://waiting.invalid', new AbortController().signal, operation);
  const rejection = expect(waiting).rejects.toThrow('canceled');
  expect(c.handles.size).toBe(0);
  let stopped = false;
  const disposal = scheduler.dispose().then(() => {
    stopped = true;
  });
  await rejection;
  await flush();
  expect(stopped).toBe(false);
  expect(operation).not.toHaveBeenCalled();
  gates.forEach((gate) => gate.resolve(1));
  await Promise.all(failures);
  await disposal;
  expect(stopped).toBe(true);
  expect(c.handles.size).toBe(0);
});

it('admits a new origin after an active slot actually settles, without an expiry poll', async () => {
  const c = clock(),
    scheduler = createProbeScheduler({ ...c, minIntervalMs: 0 });
  const gates = Array.from({ length: 100 }, () => deferred<number>());
  const active = gates.map((gate, index) =>
    scheduler.run(
      `https://active${index}.invalid`,
      new AbortController().signal,
      async () => gate.promise,
    ),
  );
  const operation = vi.fn(async () => 101);
  const waiting = scheduler.run('https://waiting.invalid', new AbortController().signal, operation);
  expect(operation).not.toHaveBeenCalled();
  expect(c.handles.size).toBe(0);
  gates[0].resolve(1);
  expect(await waiting).toBe(101);
  expect(operation).toHaveBeenCalledTimes(1);
  gates.slice(1).forEach((gate) => gate.resolve(1));
  await Promise.all(active);
  await scheduler.dispose();
});

it('counts capacity-waiting admissions toward the 1000 job bound and cancels their shared timer', async () => {
  const c = clock(),
    scheduler = createProbeScheduler(c),
    signal = new AbortController().signal;
  for (let index = 0; index < 100; index++)
    scheduler.noteRetryAfter(`https://cool${index}.invalid`, '60', 429);
  const operation = vi.fn(async () => 1);
  const waiting = Array.from({ length: 1000 }, (_, index) =>
    scheduler.run(`https://waiting${index}.invalid`, signal, operation),
  );
  const failures = waiting.map((job) => expect(job).rejects.toThrow('canceled'));
  await expect(scheduler.run('https://overflow.invalid', signal, operation)).rejects.toThrow(
    '1,000',
  );
  expect(c.handles.size).toBe(1);
  await scheduler.dispose();
  await Promise.all(failures);
  expect(operation).not.toHaveBeenCalled();
  expect(c.handles.size).toBe(0);
});
