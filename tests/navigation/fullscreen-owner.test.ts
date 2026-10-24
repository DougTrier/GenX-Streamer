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

import { describe, expect, it } from 'vitest';
import { createFullscreenOwner } from '../../src/ui/fullscreen-owner';
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('fullscreen transition owner', () => {
  it('joins repeated activation and serializes Back after pending entry', async () => {
    const entry = deferred(),
      calls: boolean[] = [],
      states: boolean[] = [];
    const owner = createFullscreenOwner({
      apply: async (on) => {
        calls.push(on);
        if (on) await entry.promise;
      },
      changed: (on) => states.push(on),
    });
    const first = owner.toggle();
    expect(owner.toggle()).toBe(first);
    const back = owner.set(false);
    await tick();
    expect(calls).toEqual([true]);
    expect(owner.busy).toBe(true);
    entry.resolve();
    await Promise.all([first, back]);
    expect(calls).toEqual([true, false]);
    expect(states).toEqual([true, false]);
    expect(owner.active).toBe(false);
  });
  it('retains acknowledged state on rejection and permits deliberate retry', async () => {
    let refuse = true;
    const owner = createFullscreenOwner({
      apply: async () => {
        if (refuse) throw new Error('refused');
      },
      changed: () => {},
    });
    await expect(owner.set(true)).rejects.toThrow('refused');
    expect(owner.active).toBe(false);
    refuse = false;
    await owner.set(true);
    expect(owner.active).toBe(true);
    refuse = true;
    await expect(owner.set(false)).rejects.toThrow();
    expect(owner.active).toBe(true);
    refuse = false;
    await owner.set(false);
    expect(owner.active).toBe(false);
  });
  it('authoritative native exit fences a late entry acknowledgment', async () => {
    const entry = deferred(),
      states: boolean[] = [];
    const owner = createFullscreenOwner({
      apply: () => entry.promise,
      changed: (on) => states.push(on),
    });
    const operation = owner.set(true);
    await tick();
    owner.nativeExited();
    entry.resolve();
    await operation;
    expect(owner.active).toBe(false);
    expect(states).toEqual([]);
  });
  it('close freezes enable admission and joins actual entry then disable', async () => {
    const entry = deferred(),
      exit = deferred(),
      calls: boolean[] = [];
    const owner = createFullscreenOwner({
      apply: (on) => {
        calls.push(on);
        return on ? entry.promise : exit.promise;
      },
      changed: () => {},
    });
    const operation = owner.set(true);
    await tick();
    const close = owner.close();
    expect(owner.close()).toBe(close);
    await expect(owner.set(true)).rejects.toThrow('closed');
    expect(calls).toEqual([true]);
    let finished = false;
    void close.then(() => {
      finished = true;
    });
    entry.resolve();
    await operation;
    await tick();
    expect(calls).toEqual([true, false]);
    expect(finished).toBe(false);
    exit.resolve();
    await close;
    expect(owner.active).toBe(false);
    expect(owner.busy).toBe(false);
  });
  it('failed final disable rejects cleanup and retries without reopening', async () => {
    let count = 0;
    const owner = createFullscreenOwner({
      apply: async () => {
        if (++count === 1) throw new Error('disable refused');
      },
      changed: () => {},
    });
    await expect(owner.close()).rejects.toThrow('disable refused');
    await owner.close();
    expect(count).toBe(2);
    await expect(owner.toggle()).rejects.toThrow('closed');
  });
  it('disposal suppresses late presentation callbacks', async () => {
    const entry = deferred(),
      states: boolean[] = [];
    const owner = createFullscreenOwner({
      apply: () => entry.promise,
      changed: (on) => states.push(on),
    });
    const operation = owner.set(true);
    await tick();
    owner.dispose();
    entry.resolve();
    await operation;
    expect(states).toEqual([]);
    expect(owner.active).toBe(false);
    expect(owner.busy).toBe(false);
  });
});
