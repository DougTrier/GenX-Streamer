import { describe, expect, it, vi } from 'vitest';
import {
  createViewingWakeOwner,
  createViewingForegroundAdmission,
  validateViewingWakeReceipt,
  type ViewingWakeReceipt,
} from '../../src/playback/viewing-wake-owner';
function receipt(active: boolean, overrides: Partial<ViewingWakeReceipt> = {}): ViewingWakeReceipt {
  return {
    schemaVersion: 1,
    adapterVersion: 'viewing-wake-v1',
    requestedActive: active,
    foreground: true,
    windowKeepScreenOn: active,
    webViewKeepScreenOn: false,
    decorKeepScreenOn: false,
    platform: 'android',
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('acknowledged viewing wake ownership', () => {
  it('reports immutable redacted diagnostics while close joins a stale disable and its fresh receipt', async () => {
    const first = deferred<ViewingWakeReceipt>();
    const final = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => final.promise);
    const owner = createViewingWakeOwner({ send });
    const initial = owner.snapshot();
    expect(initial).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      stage: 'idle',
      currentAttempt: 0,
      pending: false,
      closingPending: false,
      receipt: null,
    });
    const work = owner.setActive(false);
    await tick();
    expect(owner.snapshot()).toMatchObject({
      revision: 0,
      stage: 'dispatching',
      currentAttempt: 1,
      pending: true,
    });
    owner.setForeground(false);
    const close = owner.close();
    expect(owner.close()).toBe(close);
    let settled = false;
    void close.then(() => {
      settled = true;
    });
    expect(owner.snapshot()).toMatchObject({
      revision: 2,
      wanted: false,
      foreground: false,
      closing: true,
      closingPending: true,
      acknowledged: null,
    });
    first.resolve({ ...receipt(false), secret: 'private-provider-value' } as ViewingWakeReceipt);
    await tick();
    const pending = owner.snapshot();
    expect(pending).toMatchObject({
      revision: 2,
      stage: 'dispatching',
      currentAttempt: 2,
      pending: true,
      closingPending: true,
      acknowledged: null,
      failed: false,
    });
    expect(settled).toBe(false);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.receipt)).toBe(true);
    expect(JSON.stringify(pending)).not.toContain('private-provider-value');
    expect(Object.keys(pending)).toEqual([
      'schemaVersion',
      'revision',
      'wanted',
      'foreground',
      'closing',
      'acknowledged',
      'pending',
      'closingPending',
      'failed',
      'currentAttempt',
      'stage',
      'receipt',
    ]);
    expect(initial.stage).toBe('idle'); // Old snapshots never change as native work advances.
    final.resolve(receipt(false));
    await close;
    await work;
    expect(owner.snapshot()).toMatchObject({
      revision: 2,
      stage: 'receipt',
      currentAttempt: 2,
      pending: false,
      closingPending: false,
      acknowledged: false,
      failed: false,
    });
  });
  it('records failed stage without exposing the rejected native error', async () => {
    const owner = createViewingWakeOwner({
      send: async () => {
        throw new Error('secret provider credentials');
      },
    });
    await expect(owner.setActive(false)).rejects.toThrow('Screen wake policy');
    const snapshot = owner.snapshot();
    expect(snapshot).toMatchObject({
      stage: 'failed',
      failed: true,
      pending: false,
      currentAttempt: 1,
      receipt: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
  it('sends initial false once and deduplicates unchanged rendering after actual acknowledgement', async () => {
    const initial = deferred<ViewingWakeReceipt>();
    const send = vi.fn(() => initial.promise);
    const owner = createViewingWakeOwner({ send });
    const first = owner.setActive(false);
    expect(owner.setActive(false)).toBe(first);
    await tick();
    expect(send).toHaveBeenCalledExactlyOnceWith(false);
    expect(owner.receipt).toBeNull();
    initial.resolve(receipt(false));
    await first;
    await owner.setActive(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(owner.receipt)).toBe(true);
  });
  it('does not coalesce away initial disable before a same-turn enable request', async () => {
    const send = vi.fn(async (active: boolean) => receipt(active));
    const owner = createViewingWakeOwner({ send });
    const initial = owner.setActive(false);
    owner.setActive(true);
    await initial;
    expect(send.mock.calls.map((call) => call[0])).toEqual([false, true]);
  });
  it('serializes and coalesces toggles to latest desired state without overlapping native work', async () => {
    const first = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (active: boolean) => receipt(active));
    const owner = createViewingWakeOwner({ send });
    const work = owner.setActive(true);
    await tick();
    owner.setActive(false);
    owner.setActive(true);
    owner.setActive(false);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve(receipt(true));
    await work;
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });
  it('hides stale enable refusal and still joins the newest disable', async () => {
    const first = deferred<ViewingWakeReceipt>();
    const onError = vi.fn();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (active: boolean) => receipt(active));
    const owner = createViewingWakeOwner({ send, onError });
    const work = owner.setActive(true);
    await tick();
    owner.setForeground(false);
    first.reject(new Error('private provider error'));
    await work;
    expect(onError).not.toHaveBeenCalled();
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });
  it('failed same-state render calls do not retry; one explicit retry reawaits a new native receipt', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('private'))
      .mockImplementation(async (active: boolean) => receipt(active));
    const onError = vi.fn();
    const owner = createViewingWakeOwner({ send, onError });
    await expect(owner.setActive(false)).rejects.toThrow('Screen wake policy');
    await expect(owner.setActive(false)).rejects.toThrow('Screen wake policy');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await owner.retry();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('background fences pending true and foreground return never requests autoplay or old true', async () => {
    const first = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (active: boolean) => receipt(active));
    const owner = createViewingWakeOwner({ send });
    const work = owner.setActive(true);
    await tick();
    owner.setForeground(false);
    owner.setActive(true);
    first.resolve(receipt(true));
    await work;
    await owner.setForeground(true);
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false, false]);
    await owner.setActive(true);
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false, false, true]);
  });
  it('close waits actual pending enable and final disable, rejects new true and shares promise', async () => {
    const enable = deferred<ViewingWakeReceipt>(),
      disable = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => enable.promise)
      .mockImplementationOnce(() => disable.promise);
    const owner = createViewingWakeOwner({ send });
    const work = owner.setActive(true);
    await tick();
    const close = owner.close();
    expect(owner.close()).toBe(close);
    await expect(owner.setActive(true)).rejects.toThrow('closing');
    let done = false;
    void close.then(() => {
      done = true;
    });
    enable.resolve(receipt(true));
    await tick();
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false]);
    expect(done).toBe(false);
    disable.resolve(receipt(false));
    await close;
    await work;
    expect(done).toBe(true);
  });
  it('disable mismatch refuses close and retry remains frozen until actual disable settles', async () => {
    const retry = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(receipt(false, { webViewKeepScreenOn: true }))
      .mockImplementationOnce(() => retry.promise);
    const owner = createViewingWakeOwner({ send });
    await expect(owner.close()).rejects.toThrow('Screen wake policy');
    expect(owner.receipt?.webViewKeepScreenOn).toBe(true);
    const close = owner.close();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    await expect(owner.setActive(true)).rejects.toThrow('closing');
    retry.resolve(receipt(false));
    await close;
  });
  it('validates version, requested state and actual nullable desktop scope without fabricating awake state', async () => {
    for (const value of [
      undefined,
      {},
      receipt(false, { schemaVersion: 2 as 1 }),
      receipt(true),
      receipt(false, { windowKeepScreenOn: null }),
    ])
      expect(() => validateViewingWakeReceipt(value, false)).toThrow('acknowledgement');
    const desktop = receipt(false, {
      platform: 'windows',
      foreground: false,
      windowKeepScreenOn: null,
      webViewKeepScreenOn: null,
      decorKeepScreenOn: null,
    });
    const owner = createViewingWakeOwner({ send: async () => desktop });
    await owner.setActive(false);
    expect(owner.receipt?.windowKeepScreenOn).toBeNull();
  });
});

describe('independent lifecycle admission', () => {
  it('duplicate background during failed disable does not make its failure stale or start another call', async () => {
    const failed = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(receipt(true))
      .mockImplementationOnce(() => failed.promise);
    const onError = vi.fn();
    const owner = createViewingWakeOwner({ send, onError });
    await owner.setActive(true);
    const work = owner.setForeground(false);
    await tick();
    expect(owner.setForeground(false)).toBe(work);
    failed.reject(new Error('native failure'));
    await expect(work).rejects.toThrow('Screen wake policy');
    await expect(owner.setForeground(false)).rejects.toThrow('Screen wake policy');
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('native background cannot be reopened by document-visible events, and native foreground cannot override hidden document', async () => {
    const send = vi.fn(async (active: boolean) => receipt(active));
    const owner = createViewingWakeOwner({ send });
    const gate = createViewingForegroundAdmission((active) => owner.setForeground(active));
    await owner.setActive(true);
    await gate.setNativeForeground(false);
    await gate.setDocumentVisible(false);
    await gate.setDocumentVisible(true);
    await owner.setActive(true);
    expect(gate.admitted).toBe(false);
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false]);
    await gate.setDocumentVisible(false);
    await gate.setNativeForeground(true);
    await owner.setActive(true);
    expect(gate.admitted).toBe(false);
    await gate.setDocumentVisible(true);
    expect(gate.admitted).toBe(true);
    // Returning foreground rechecks disable instead of restoring old active intent.
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false, false]);
    await owner.setActive(true);
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, false, false, true]);
  });
  it('duplicate producer events after disable failure preserve failure without retry loops', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(receipt(true))
      .mockRejectedValue(new Error('failure'));
    const owner = createViewingWakeOwner({ send });
    const gate = createViewingForegroundAdmission((active) => owner.setForeground(active));
    await owner.setActive(true);
    await expect(gate.setNativeForeground(false)).rejects.toThrow('Screen wake policy');
    for (const repeat of [
      () => gate.setNativeForeground(false),
      () => gate.setDocumentVisible(false),
      () => gate.setDocumentVisible(true),
    ])
      await expect(repeat()).rejects.toThrow('Screen wake policy');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('fresh lifecycle disable barriers', () => {
  it('genuine return invalidates cached false after a provider reassertion without autoplay', async () => {
    let held = false;
    expect(held).toBe(false);
    const send = vi.fn(async (active: boolean) => {
      held = active;
      return receipt(active);
    });
    const owner = createViewingWakeOwner({ send });
    await owner.setActive(false);
    await owner.setForeground(false);
    held = true; // Simulates an external reassertion; it is not evidence of an Android cause.
    await owner.setForeground(true);
    expect(held).toBe(false);
    expect(send.mock.calls.map((call) => call[0])).toEqual([false, false, false]);
    await owner.setForeground(true);
    await owner.setActive(false);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('closing joins pending return-disable and then its own fresh disable receipt', async () => {
    const returned = deferred<ViewingWakeReceipt>();
    const final = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(receipt(false))
      .mockResolvedValueOnce(receipt(false))
      .mockImplementationOnce(() => returned.promise)
      .mockImplementationOnce(() => final.promise);
    const owner = createViewingWakeOwner({ send });
    await owner.setActive(false);
    await owner.setForeground(false);
    const foreground = owner.setForeground(true);
    await tick();
    const closing = owner.close();
    let done = false;
    void closing.then(() => {
      done = true;
    });
    expect(send).toHaveBeenCalledTimes(3);
    returned.resolve(receipt(false));
    await tick();
    expect(send).toHaveBeenCalledTimes(4);
    expect(done).toBe(false);
    final.resolve(receipt(false));
    await closing;
    await foreground;
    await owner.setForeground(false);
    await owner.setForeground(true);
    expect(send).toHaveBeenCalledTimes(4); // Closed owners never reopen on later lifecycle events.
  });
  it('old disable settling across a genuine return cannot acknowledge the newer barrier', async () => {
    const background = deferred<ViewingWakeReceipt>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(receipt(false))
      .mockImplementationOnce(() => background.promise)
      .mockResolvedValueOnce(receipt(false));
    const owner = createViewingWakeOwner({ send });
    await owner.setActive(false);
    const work = owner.setForeground(false);
    await tick();
    expect(owner.setForeground(true)).toBe(work);
    background.resolve(receipt(false, { foreground: false }));
    await work;
    expect(send.mock.calls.map((call) => call[0])).toEqual([false, false, false]);
    expect(owner.receipt?.foreground).toBe(true);
  });
});
