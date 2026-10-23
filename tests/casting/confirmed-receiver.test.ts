import { describe, expect, it, vi } from 'vitest';
import { createConfirmedReceiver } from '../../src/casting/confirmed-receiver';
import type { ReceiverValidation } from '../../src/casting/receiver-validation';
import type { ReceiverDetails } from '../../src/casting/receiver-confirmation';
const network = {
  generation: 1,
  scopeId: 'scope-A',
  observation: 'interfaces-and-routes' as const,
};
const device = {
  id: 'A',
  name: 'TV',
  protocol: 'chromecast' as const,
  protocolReceiverId: 'reported-A',
  model: 'Model',
};
const signal = () => new AbortController().signal;
function setup() {
  let ticket = 0;
  const readNetworkScope = vi.fn(async () => ({ ...network }));
  const validateReceiver = vi.fn(
    async (d: ReceiverDetails, n: typeof network, _ack: boolean): Promise<ReceiverValidation> => ({
      device: { ...d },
      network: { ...n },
      issuedHandle: `fresh-${++ticket}`,
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    }),
  );
  const owner = createConfirmedReceiver({ readNetworkScope, validateReceiver });
  return { owner, readNetworkScope, validateReceiver };
}
describe('owned receiver confirmation (no media commands)', () => {
  it('never confirms through selection, discards selection/confirmation handles and revalidates every authorization', async () => {
    const { owner, readNetworkScope, validateReceiver } = setup();
    expect(owner.snapshot).toBeNull();
    await owner.select(device, signal());
    expect(owner.snapshot?.confirmed).toBe(false);
    await expect(owner.authorize(device, signal())).rejects.toThrow('confirm');
    await owner.confirm(false, signal());
    expect(owner.snapshot?.confirmed).toBe(true);
    expect(await owner.authorize(device, signal())).toBe('fresh-3');
    expect(await owner.authorize(device, signal())).toBe('fresh-4');
    expect(readNetworkScope).toHaveBeenCalledTimes(4);
    expect(validateReceiver).toHaveBeenCalledTimes(4);
  });
  it('requires an acknowledgment when a known reported ID cannot be freshly rechecked', async () => {
    const { owner, validateReceiver } = setup();
    validateReceiver.mockImplementation(async (d, n, ack) => ({
      device: d,
      network: n,
      issuedHandle: ack ? 'ack-ticket' : null,
      identityRecheck: 'unavailable',
      cryptographicallyAttested: false,
    }));
    await owner.select(device, signal());
    expect(owner.snapshot?.requiresUnverifiedAcknowledgment).toBe(true);
    await expect(owner.confirm(false, signal())).rejects.toThrow('acknowledge');
    expect(owner.snapshot?.confirmed).toBe(false);
    await owner.confirm(true, signal());
    expect(await owner.authorize(device, signal())).toBe('ack-ticket');
  });
  it('refuses an identity downgrade after a matched confirmation and never transfers confirmation to a duplicate name', async () => {
    const { owner, validateReceiver } = setup();
    await owner.select(device, signal());
    await owner.confirm(false, signal());
    validateReceiver.mockResolvedValue({
      device,
      network,
      issuedHandle: null,
      identityRecheck: 'unavailable',
      cryptographicallyAttested: false,
    });
    await expect(owner.authorize(device, signal())).rejects.toThrow('unavailable');
    expect(owner.snapshot?.confirmed).toBe(false);
    expect(owner.snapshot?.requiresUnverifiedAcknowledgment).toBe(true);
    validateReceiver.mockImplementation(async (d, n) => ({
      device: d,
      network: n,
      issuedHandle: 'new',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    }));
    await owner.select({ ...device, id: 'B', protocolReceiverId: 'reported-B' }, signal());
    await expect(owner.authorize(device, signal())).rejects.toThrow('selection changed');
    expect(owner.snapshot?.confirmed).toBe(false);
  });
  it('invalidates confirmation on changed network before validation or changed receiver after validation', async () => {
    const { owner, readNetworkScope, validateReceiver } = setup();
    await owner.select(device, signal());
    await owner.confirm(false, signal());
    readNetworkScope.mockResolvedValue({ ...network, generation: 2 });
    await expect(owner.authorize(device, signal())).rejects.toThrow('selection changed');
    expect(validateReceiver).toHaveBeenCalledTimes(2);
    expect(owner.snapshot?.confirmed).toBe(false);
    readNetworkScope.mockResolvedValue(network);
    await owner.select(device, signal());
    await owner.confirm(false, signal());
    validateReceiver.mockResolvedValue({
      device: { ...device, model: 'Other' },
      network,
      issuedHandle: 'ticket',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    });
    await expect(owner.authorize(device, signal())).rejects.toThrow('selection changed');
    expect(owner.snapshot?.confirmed).toBe(false);
  });
  it('clear and a new selection fence pending late selection replies without mutating the new owner', async () => {
    const { owner, validateReceiver } = setup();
    let resolve!: (value: ReceiverValidation) => void;
    validateReceiver.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = owner.select(device, signal());
    await Promise.resolve();
    owner.clear();
    await owner.select({ ...device, id: 'B' }, signal());
    const revision = owner.snapshot?.revision;
    resolve({
      device,
      network,
      issuedHandle: 'obsolete',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    });
    await expect(pending).rejects.toThrow('selection changed');
    expect(owner.snapshot?.receiver.id).toBe('B');
    expect(owner.snapshot?.revision).toBe(revision);
    expect(owner.snapshot?.confirmed).toBe(false);
  });
  it('a superseded pending confirmation cannot confirm a new owner', async () => {
    const { owner, validateReceiver } = setup();
    await owner.select(device, signal());
    let resolve!: (value: ReceiverValidation) => void;
    validateReceiver.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = owner.confirm(false, signal());
    await Promise.resolve();
    await owner.select({ ...device, id: 'B' }, signal());
    resolve({
      device,
      network,
      issuedHandle: 'obsolete',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    });
    await expect(pending).rejects.toThrow('selection changed');
    expect(owner.snapshot?.receiver.id).toBe('B');
    expect(owner.snapshot?.confirmed).toBe(false);
  });
  it('late authorization cancellation settles its dependency and never returns a handle', async () => {
    const { owner, validateReceiver } = setup();
    await owner.select(device, signal());
    await owner.confirm(false, signal());
    let resolve!: (value: ReceiverValidation) => void;
    validateReceiver.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const controller = new AbortController();
    const pending = owner.authorize(device, controller.signal);
    await Promise.resolve();
    controller.abort();
    resolve({
      device,
      network,
      issuedHandle: 'late',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(owner.snapshot?.confirmed).toBe(false);
  });
  it('concurrent confirmation only admits the latest operation; no late failure can clear its confirmation', async () => {
    const { owner, validateReceiver } = setup();
    await owner.select(device, signal());
    let resolve!: (value: ReceiverValidation) => void;
    validateReceiver.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const old = owner.confirm(false, signal());
    await Promise.resolve();
    await owner.confirm(false, signal());
    resolve({
      device,
      network,
      issuedHandle: 'old',
      identityRecheck: 'matched',
      cryptographicallyAttested: false,
    });
    await expect(old).rejects.toThrow('selection changed');
    expect(owner.snapshot?.confirmed).toBe(true);
  });
});
