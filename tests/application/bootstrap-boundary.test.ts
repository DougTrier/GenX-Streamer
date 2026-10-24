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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBootstrapBoundary,
  BootstrapFailureError,
  type BootstrapRecoveryView,
  type BootstrapSnapshot,
} from '../../src/application/shell/bootstrap-boundary';

function view() {
  const renders: BootstrapSnapshot[] = [];
  const dispose = vi.fn();
  const implementation: BootstrapRecoveryView = {
    render(snapshot) {
      renders.push(snapshot);
    },
    dispose,
  };
  return { renders, dispose, implementation };
}
function deferred() {
  let resolve!: () => void, reject!: (value: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

describe('early bootstrap boundary', () => {
  it('preserves mount values and normal layout without claiming native/storage Ready', () => {
    const fixture = view(),
      boundary = createBootstrapBoundary({ view: fixture.implementation });
    const owned = { dispose: vi.fn() };
    expect(boundary.run('shell', () => owned)).toBe(owned);
    boundary.run('viewing-controls', () => undefined);
    boundary.mounted();
    expect(boundary.snapshot()).toMatchObject({
      stage: 'viewing-controls',
      phase: 'mounted',
      reason: 'none',
      errorCount: 0,
    });
    expect(fixture.renders).toEqual([]);
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(owned.dispose).not.toHaveBeenCalled();
  });

  it('records the exact failing mount and rethrows its original without retaining private data', () => {
    const fixture = view(),
      boundary = createBootstrapBoundary({ view: fixture.implementation });
    const original = new Error('https://private.invalid/user/token');
    expect(() =>
      boundary.run('viewing-controls', () => {
        throw original;
      }),
    ).toThrow(original);
    const snapshot = boundary.snapshot();
    expect(snapshot).toMatchObject({
      stage: 'viewing-controls',
      phase: 'failed',
      reason: 'mount-failed',
      errorCount: 1,
      pending: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'stage', 'secret')).toBe(false);
    expect(snapshot.stage).toBe('viewing-controls');
    expect(JSON.stringify(fixture.renders)).not.toContain('private');
    expect(JSON.stringify(snapshot)).not.toContain('token');
    expect(() => boundary.run('playback', () => undefined)).toThrow(BootstrapFailureError);
    boundary.mounted();
    expect(boundary.snapshot().phase).toBe('failed');
  });

  it('does not offer or invent Retry/Close when safe host ownership is unavailable', async () => {
    const fixture = view(),
      boundary = createBootstrapBoundary({ view: fixture.implementation });
    boundary.fail('initialization');
    expect(boundary.snapshot()).toMatchObject({
      canRetry: false,
      canClose: false,
      phase: 'failed',
    });
    expect(await boundary.retry()).toBe(false);
    expect(await boundary.close()).toBe(false);
    expect(boundary.snapshot().phase).toBe('failed');
    expect(fixture.dispose).not.toHaveBeenCalled();
  });

  it('a failed recovery renderer cannot replace the original mount error', () => {
    const original = new Error('original mount');
    const boundary = createBootstrapBoundary({
      view: {
        render() {
          throw new Error('renderer-secret');
        },
        dispose() {},
      },
    });
    expect(() =>
      boundary.run('shell', () => {
        throw original;
      }),
    ).toThrow(original);
    expect(boundary.snapshot()).toMatchObject({
      phase: 'failed',
      stage: 'shell',
      reason: 'mount-failed',
    });
    expect(JSON.stringify(boundary.snapshot())).not.toContain('renderer-secret');
  });

  it('rejects unknown stage/reason strings without publishing them to diagnostics', () => {
    const fixture = view(),
      boundary = createBootstrapBoundary({ view: fixture.implementation });
    expect(() => boundary.fail('https://private.invalid' as never)).toThrow(BootstrapFailureError);
    expect(() => boundary.fail('shell', 'private-message' as never)).toThrow(BootstrapFailureError);
    expect(JSON.stringify(boundary.snapshot())).not.toContain('private');
    expect(fixture.renders).toEqual([]);
  });

  it('owns one actual retry, blocks conflicting Close, and joins readiness before removing recovery', async () => {
    const fixture = view(),
      held = deferred(),
      retry = vi.fn(() => held.promise),
      close = vi.fn();
    const boundary = createBootstrapBoundary({ view: fixture.implementation, retry, close });
    boundary.fail('shell');
    const first = boundary.retry();
    expect(boundary.retry()).toBe(first);
    expect(await boundary.close()).toBe(false);
    expect(boundary.snapshot()).toMatchObject({
      phase: 'retrying',
      pending: true,
      canRetry: false,
      canClose: false,
    });
    expect(fixture.dispose).not.toHaveBeenCalled();
    held.resolve();
    expect(await first).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(boundary.snapshot()).toMatchObject({ phase: 'ready', pending: false });
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });

  it('settled retry failure stays actionable with a static explanation and no raw cause', async () => {
    const fixture = view();
    const boundary = createBootstrapBoundary({
      view: fixture.implementation,
      retry: async () => {
        throw new Error('credential-secret');
      },
    });
    boundary.fail('preferences');
    expect(await boundary.retry()).toBe(false);
    expect(boundary.snapshot()).toMatchObject({
      phase: 'failed',
      reason: 'retry-failed',
      errorCount: 2,
      canRetry: true,
    });
    expect(JSON.stringify(fixture.renders)).not.toContain('credential');
    expect(fixture.dispose).not.toHaveBeenCalled();
  });

  it('dispose joins held Close rather than fabricating close completion or interrupting its work', async () => {
    const fixture = view(),
      held = deferred(),
      close = vi.fn(() => held.promise);
    const boundary = createBootstrapBoundary({ view: fixture.implementation, close });
    boundary.fail('casting');
    const closing = boundary.close();
    expect(boundary.close()).toBe(closing);
    let disposed = false;
    const disposal = boundary.dispose();
    expect(boundary.dispose()).toBe(disposal);
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(boundary.snapshot()).toMatchObject({
      phase: 'disposing',
      pending: true,
      canClose: false,
    });
    expect(fixture.dispose).not.toHaveBeenCalled();
    held.resolve();
    expect(await closing).toBe(true);
    await disposal;
    expect(close).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(true);
    expect(boundary.snapshot()).toMatchObject({ phase: 'disposed', pending: false });
    boundary.fail('initialization');
    expect(boundary.snapshot().phase).toBe('disposed');
    expect(await boundary.retry()).toBe(false);
  });

  it('failed Close retains recovery and permits an explicit new attempt', async () => {
    const fixture = view(),
      close = vi
        .fn()
        .mockRejectedValueOnce(new Error('raw-error-secret'))
        .mockResolvedValueOnce(undefined);
    const boundary = createBootstrapBoundary({ view: fixture.implementation, close });
    boundary.fail('viewport');
    expect(await boundary.close()).toBe(false);
    expect(boundary.snapshot()).toMatchObject({
      phase: 'failed',
      reason: 'close-failed',
      canClose: true,
    });
    expect(JSON.stringify(fixture.renders)).not.toContain('raw-error');
    expect(await boundary.close()).toBe(true);
    expect(boundary.snapshot().phase).toBe('closed');
  });

  it('does not schedule reloads, retries or periodic recovery timers', async () => {
    vi.useFakeTimers();
    const fixture = view(),
      retry = vi.fn();
    const boundary = createBootstrapBoundary({ view: fixture.implementation, retry });
    boundary.fail('module');
    vi.advanceTimersByTime(60000);
    expect(retry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await boundary.dispose();
  });
});
