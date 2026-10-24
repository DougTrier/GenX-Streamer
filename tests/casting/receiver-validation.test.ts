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
import { createReceiverValidationAdapter } from '../../src/casting/receiver-validation';
const scope = {
  generation: 1,
  scopeId: 'opaque-network',
  observation: 'interfaces-and-routes' as const,
};
const device = {
  id: 'roster',
  name: 'Room TV',
  protocol: 'chromecast' as const,
  protocolReceiverId: 'reported-A',
  model: 'Model',
};
const reply = () => ({
  device: { ...device, identityStatus: 'protocol-reported', cryptographicallyAttested: false },
  network: { ...scope },
  issuedHandle: 'issued-opaque',
  identityRecheck: 'matched',
});
const setup = (value: unknown = reply()) => {
  const invoke = vi.fn().mockResolvedValue(value);
  return { invoke, adapter: createReceiverValidationAdapter({ invoke, isNative: () => true }) };
};
describe('native receiver validation boundary', () => {
  it('preserves opaque scope and exact non-attested selected identity with explicit IPC arguments', async () => {
    const { adapter, invoke } = setup();
    const signal = new AbortController().signal;
    const result = await adapter.validateReceiver(device, scope, false, signal);
    expect(invoke).toHaveBeenCalledWith('cast_validate_receiver', {
      deviceId: 'roster',
      expectedNetwork: scope,
      allowUnverifiedIdentity: false,
    });
    expect(result.device).toEqual(device);
    expect(result.issuedHandle).toBe('issued-opaque');
    expect(result.cryptographicallyAttested).toBe(false);
    expect(Object.isFrozen(result.device)).toBe(true);
    const net = setup(scope);
    expect(await net.adapter.readNetworkScope(signal)).toEqual(scope);
    expect(net.invoke).toHaveBeenCalledWith('cast_network_scope', undefined);
  });
  it('requires explicit acknowledgment for an unavailable identity even with a previously reported ID', async () => {
    const unavailable = { ...reply(), identityRecheck: 'unavailable', issuedHandle: null };
    expect(
      (
        await setup(unavailable).adapter.validateReceiver(
          device,
          scope,
          false,
          new AbortController().signal,
        )
      ).issuedHandle,
    ).toBeNull();
    await expect(
      setup({ ...unavailable, issuedHandle: 'ticket' }).adapter.validateReceiver(
        device,
        scope,
        false,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid');
    expect(
      (
        await setup({ ...unavailable, issuedHandle: 'ticket' }).adapter.validateReceiver(
          device,
          scope,
          true,
          new AbortController().signal,
        )
      ).issuedHandle,
    ).toBe('ticket');
    await expect(
      setup(unavailable).adapter.validateReceiver(
        device,
        scope,
        true,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid');
  });
  it('admits explicitly acknowledged manual receivers without inventing reported identity', async () => {
    const manual = { id: 'manual', name: 'My TV', protocol: 'chromecast' as const };
    const value = {
      device: { ...manual, identityStatus: 'unverified', cryptographicallyAttested: false },
      network: scope,
      identityRecheck: 'unavailable',
      issuedHandle: 'ticket',
    };
    expect(
      (
        await setup(value).adapter.validateReceiver(
          manual,
          scope,
          true,
          new AbortController().signal,
        )
      ).device.protocolReceiverId,
    ).toBeUndefined();
    await expect(
      setup({ ...value, identityRecheck: 'matched' }).adapter.validateReceiver(
        manual,
        scope,
        true,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid');
  });
  it.each(['id', 'name', 'protocol', 'protocolReceiverId', 'model'] as const)(
    'rejects changed selected %s without merging duplicate friendly names',
    async (key) => {
      const value = reply();
      Object.assign(value.device, { [key]: key === 'protocol' ? 'dlna' : 'changed' });
      await expect(
        setup(value).adapter.validateReceiver(device, scope, false, new AbortController().signal),
      ).rejects.toThrow('invalid');
    },
  );
  it.each([
    { ...scope, generation: 2 },
    { ...scope, scopeId: 'other' },
    { ...scope, observation: 'interfaces-only' },
  ])('refuses mismatched network scope', async (network) => {
    await expect(
      setup({ ...reply(), network }).adapter.validateReceiver(
        device,
        scope,
        false,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid');
  });
  it.each([
    null,
    [],
    { ...scope, generation: -1 },
    { ...scope, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...scope, scopeId: 'x'.repeat(129) },
    { ...scope, observation: 'SSID-verified' },
    { ...scope, address: '192.168.1.2' },
  ])('rejects malformed or identity-leaking network reply', async (value) => {
    await expect(
      setup(value).adapter.readNetworkScope(new AbortController().signal),
    ).rejects.toThrow('invalid');
  });
  it('rejects false attestation, contradictory reported identity, oversized handle and unknown fields', async () => {
    for (const value of [
      { ...reply(), device: { ...reply().device, cryptographicallyAttested: true } },
      { ...reply(), device: { ...reply().device, identityStatus: 'unverified' } },
      { ...reply(), issuedHandle: 'x'.repeat(129) },
      { ...reply(), secret: 'hidden' },
      { ...reply(), issuedHandle: null },
    ])
      await expect(
        setup(value).adapter.validateReceiver(device, scope, false, new AbortController().signal),
      ).rejects.toThrow('invalid');
  });
  it('waits actual late invocation settlement and refuses canceled reply publication', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((r) => {
          resolve = r;
        }),
    );
    const adapter = createReceiverValidationAdapter({ invoke, isNative: () => true });
    const controller = new AbortController();
    const operation = adapter.validateReceiver(device, scope, false, controller.signal);
    let settled = false;
    void operation.catch(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolve(reply());
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    const pre = setup();
    await expect(pre.adapter.readNetworkScope(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(pre.invoke).not.toHaveBeenCalled();
  });
  it('redacts raw native failure details and refuses preview operation', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('private-address token=secret'));
    const adapter = createReceiverValidationAdapter({ invoke, isNative: () => true });
    await expect(adapter.readNetworkScope(new AbortController().signal)).rejects.toThrow(
      'could not finish',
    );
    const browser = createReceiverValidationAdapter({ invoke, isNative: () => false });
    await expect(browser.readNetworkScope(new AbortController().signal)).rejects.toThrow(
      'native application',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
