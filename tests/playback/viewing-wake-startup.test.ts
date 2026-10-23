import { expect, it, vi } from 'vitest';
import { createWakeTransportAdmission } from '../../src/playback/viewing-wake-startup';
import { createViewingWakeOwner } from '../../src/playback/viewing-wake-owner';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const receipt = () => ({
  schemaVersion: 1,
  adapterVersion: 'viewing-wake-v1',
  requestedActive: false,
  foreground: true,
  windowKeepScreenOn: false,
  webViewKeepScreenOn: false,
  decorKeepScreenOn: false,
  platform: 'android',
});
const tick = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};
it('does not dispatch before acknowledged bridge or mark ready before actual receipt', async () => {
  const gate = createWakeTransportAdmission();
  const bridge = deferred<void>();
  const native = deferred<unknown>();
  const send = vi.fn((_active: boolean) => native.promise);
  const owner = createViewingWakeOwner({
    send: async (active) => {
      await gate.wait();
      return send(active);
    },
  });
  const initial = owner.setActive(false);
  let ready = false;
  const startup = (async () => {
    await bridge.promise;
    gate.release();
    await owner.setActive(false);
    ready = true;
  })();
  await tick();
  expect(send).not.toHaveBeenCalled();
  bridge.resolve();
  await tick();
  expect(send).toHaveBeenCalledExactlyOnceWith(false);
  expect(ready).toBe(false);
  native.resolve(receipt());
  await startup;
  await initial;
  expect(ready).toBe(true);
});
it('close before admission joins held initial disable and then fresh closing disable', async () => {
  const gate = createWakeTransportAdmission();
  const first = deferred<unknown>();
  const last = deferred<unknown>();
  const send = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => last.promise);
  const owner = createViewingWakeOwner({
    send: async (active) => {
      await gate.wait();
      return send(active);
    },
  });
  const initial = owner.setActive(false);
  await tick();
  const close = owner.close();
  let done = false;
  void close.then(() => {
    done = true;
  });
  await tick();
  expect(send).not.toHaveBeenCalled();
  expect(done).toBe(false);
  gate.release();
  await tick();
  expect(send).toHaveBeenCalledTimes(1);
  first.resolve(receipt());
  await tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(done).toBe(false);
  last.resolve(receipt());
  await close;
  await initial;
  expect(done).toBe(true);
});
it('registration failure rejects ownership; explicit recovery waits for fresh admission without replaying sent work', async () => {
  const gate = createWakeTransportAdmission();
  const send = vi.fn(async () => receipt());
  const owner = createViewingWakeOwner({
    send: async () => {
      await gate.wait();
      return send();
    },
  });
  const initial = owner.setActive(false);
  gate.fail();
  await expect(initial).rejects.toThrow('Screen wake policy');
  expect(send).not.toHaveBeenCalled();
  gate.retry();
  const retry = owner.retry();
  await tick();
  expect(send).not.toHaveBeenCalled();
  gate.release();
  await retry;
  expect(send).toHaveBeenCalledTimes(1);
  gate.retry();
  gate.release();
  await owner.setActive(false);
  expect(send).toHaveBeenCalledTimes(1);
});
