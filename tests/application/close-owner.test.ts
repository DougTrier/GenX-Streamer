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
import { createCloseOwner } from '../../src/application/close-owner';
const token = (generation = 1) => ({ requestId: `close-${generation}`, generation });
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('close cleanup owner', () => {
  it('times independent slots separately before the actual final acknowledgment', async () => {
    let now = 5;
    const first = deferred(),
      second = deferred(),
      ack = deferred();
    const owner = createCloseOwner({
      freeze() {},
      timingNow: () => now,
      owners: [() => first.promise, () => second.promise],
      acknowledge: () => ack.promise,
    });
    const closing = owner.begin(token(4));
    await flush();
    expect(owner.snapshot().timings.active.map((span) => span.slot)).toEqual([0, 1]);
    now = 20;
    first.resolve();
    await vi.waitFor(() => expect(owner.snapshot().slots[0]).toBe('done'));
    expect(owner.snapshot().timings.active.map((span) => span.slot)).toEqual([1]);
    now = 50;
    second.resolve();
    await vi.waitFor(() => expect(owner.snapshot().acknowledgmentPending).toBe(true));
    const waiting = owner.snapshot();
    expect(waiting.timings.active[0]).toMatchObject({ phase: 'close-acknowledge', generation: 4 });
    now = 70;
    ack.resolve();
    await closing;
    expect(owner.snapshot().timings.completed.map((span) => span.elapsedMs)).toEqual([15, 45, 20]);
    expect(waiting.timings.active[0].outcome).toBe('pending');
  });
  it('distinguishes a retained owner wait from an acknowledgment wait without leaking identity or errors', async () => {
    const disposal = deferred(),
      ack = deferred();
    const owner = createCloseOwner({
      freeze() {},
      owners: [
        () => disposal.promise,
        () => {
          throw new Error('secret-provider-url');
        },
      ],
      acknowledge: () => ack.promise,
    });
    const initial = owner.snapshot();
    const request = owner.begin({ requestId: 'private-token', generation: 4 });
    const rejected = expect(request).rejects.toThrow('Cleanup could not be confirmed');
    await flush();
    await flush();
    const waiting = owner.snapshot();
    expect(waiting.slots).toEqual(['pending', 'failed']);
    expect(waiting.acknowledgmentPending).toBe(false);
    expect(initial.slots).toEqual(['idle', 'idle']);
    expect(Object.isFrozen(waiting)).toBe(true);
    expect(Object.isFrozen(waiting.slots)).toBe(true);
    expect(JSON.stringify(waiting)).not.toMatch(/private-token|secret-provider-url/);
    disposal.resolve();
    await vi.waitFor(() => expect(owner.snapshot().acknowledgmentPending).toBe(true));
    expect(owner.snapshot().slots).toEqual(['done', 'failed']);
    ack.resolve();
    await rejected;
    await flush();
    expect(owner.snapshot()).toMatchObject({
      running: false,
      acknowledged: false,
      acknowledgmentPending: false,
    });
  });
  it('keeps acknowledgment pending while an obsolete transport still settles', async () => {
    const olderAck = deferred(),
      newerAck = deferred();
    const owner = createCloseOwner({
      freeze() {},
      owners: [],
      acknowledge: (t) => (t.generation === 1 ? olderAck.promise : newerAck.promise),
    });
    const older = owner.begin(token());
    const rejected = expect(older).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(owner.snapshot().acknowledgmentPending).toBe(true));
    const newer = owner.begin(token(2));
    await flush();
    newerAck.resolve();
    await newer;
    expect(owner.snapshot()).toMatchObject({
      generation: 2,
      acknowledged: true,
      acknowledgmentPending: true,
    });
    olderAck.resolve();
    await rejected;
    expect(owner.snapshot().acknowledgmentPending).toBe(false);
  });
  it('freezes synchronously, starts independent owners and joins before exact ACK', async () => {
    const a = deferred(),
      b = deferred(),
      freeze = vi.fn(),
      acknowledge = vi.fn(async () => {});
    const first = vi.fn(() => a.promise),
      second = vi.fn(() => b.promise);
    const owner = createCloseOwner({ freeze, owners: [first, second], acknowledge });
    const work = owner.begin(token());
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(owner.begin(token())).toBe(work);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    a.resolve();
    await flush();
    expect(acknowledge).not.toHaveBeenCalled();
    b.resolve();
    await work;
    expect(acknowledge).toHaveBeenCalledWith(token(), 'drained');
    await owner.begin(token());
    expect(first).toHaveBeenCalledTimes(1);
  });
  it('retains successful owners and retries rejected ownership after all pending settles', async () => {
    const wait = deferred(),
      acknowledge = vi.fn(async () => {}),
      freeze = vi.fn();
    const retry = vi.fn().mockRejectedValueOnce(new Error('private')).mockResolvedValue(undefined);
    const keep = vi.fn(() => wait.promise);
    const owner = createCloseOwner({ freeze, owners: [retry, keep], acknowledge });
    const failed = owner.begin(token());
    const assertion = expect(failed).rejects.toThrow('Cleanup could not be confirmed');
    await flush();
    expect(acknowledge).not.toHaveBeenCalled();
    wait.resolve();
    await assertion;
    expect(acknowledge).toHaveBeenLastCalledWith(token(), 'failed');
    await owner.begin(token(2));
    expect(retry).toHaveBeenCalledTimes(2);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenLastCalledWith(token(2), 'drained');
  });
  it('never acknowledges an older generation once a newer request owns cleanup', async () => {
    const wait = deferred(),
      acknowledge = vi.fn(async () => {}),
      cleanup = vi.fn(() => wait.promise);
    const owner = createCloseOwner({ freeze() {}, owners: [cleanup], acknowledge });
    const older = owner.begin(token());
    const rejected = expect(older).rejects.toThrow('superseded');
    const newer = owner.begin(token(2));
    wait.resolve();
    await rejected;
    await newer;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.calls).toEqual([[token(2), 'drained']]);
  });
  it('retries transport failure without recreating cleaned resources', async () => {
    const cleanup = vi.fn(),
      acknowledge = vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValue(undefined);
    const owner = createCloseOwner({ freeze() {}, owners: [cleanup], acknowledge });
    await expect(owner.begin(token())).rejects.toThrow(
      'Cleanup acknowledgment could not be confirmed',
    );
    await owner.begin(token());
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid tokens and same-generation different identities', async () => {
    const wait = deferred(),
      freeze = vi.fn(),
      owner = createCloseOwner({ freeze, owners: [() => wait.promise], async acknowledge() {} });
    for (const value of [
      { requestId: '', generation: 1 },
      { requestId: 'x', generation: 0 },
      { requestId: 'x', generation: Infinity },
      { requestId: 'x\n', generation: 1 },
      { requestId: 'x'.repeat(129), generation: 1 },
    ])
      await expect(owner.begin(value)).rejects.toThrow('Invalid cleanup request');
    expect(freeze).not.toHaveBeenCalled();
    const work = owner.begin(token());
    await expect(owner.begin({ requestId: 'other', generation: 1 })).rejects.toThrow(
      'Invalid cleanup request',
    );
    wait.resolve();
    await work;
  });
  it('reserves duplicate promise before a synchronous freeze callback re-enters', async () => {
    let duplicate: Promise<void> | undefined;
    const acknowledge = vi.fn(async () => {});
    const owner = createCloseOwner({
      freeze() {
        duplicate = owner.begin(token());
      },
      owners: [],
      acknowledge,
    });
    const work = owner.begin(token());
    expect(duplicate).toBe(work);
    await work;
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('reports synchronous owner failure without blocking independent disposal', async () => {
    const cleanup = vi.fn(),
      acknowledge = vi.fn(async () => {});
    const owner = createCloseOwner({
      freeze() {},
      owners: [
        () => {
          throw new Error('secret');
        },
        cleanup,
      ],
      acknowledge,
    });
    await expect(owner.begin(token())).rejects.toThrow('Cleanup could not be confirmed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(token(), 'failed');
  });
});
