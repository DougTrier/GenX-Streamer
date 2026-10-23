import { describe, it, expect } from 'vitest';
import {
  ReceiverConfirmationGate,
  type ReceiverDetails,
} from '../../src/casting/receiver-confirmation';
const network = { generation: 1, scopeId: 'session-network-a' };
const receiver: ReceiverDetails = {
  id: 'handle-a',
  name: 'Room TV',
  protocol: 'chromecast',
  protocolReceiverId: 'protocol-a',
  model: 'Model A',
  address: 'opaque-address-a',
};
function confirmed() {
  const gate = new ReceiverConfirmationGate();
  const selection = gate.select(receiver, network);
  expect(gate.confirmOwnTv(selection.revision, receiver, network).allowed).toBe(true);
  return gate;
}
describe('explicit receiver and network admission', () => {
  it('selection alone never starts; confirmation has no cryptographic attestation claim', () => {
    const gate = new ReceiverConfirmationGate();
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network)).toEqual({
      allowed: false,
      reason: 'no-selection',
    });
    const selection = gate.select(receiver, network);
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network)).toEqual({
      allowed: false,
      reason: 'confirmation-required',
    });
    expect(selection).toMatchObject({
      identity: 'protocol-reported',
      confirmed: false,
      cryptographicallyAttested: false,
    });
    expect(gate.confirmOwnTv(selection.revision, receiver, network).allowed).toBe(true);
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network).allowed).toBe(true);
  });
  it('friendly names, addresses and selection handles do not establish identity', () => {
    const gate = new ReceiverConfirmationGate();
    const details = {
      id: 'protocol-looking-uuid',
      name: 'My TV',
      protocol: 'dlna' as const,
      address: 'opaque-address',
    };
    const selected = gate.select(details, network);
    expect(selected.identity).toBe('unverified');
    expect(gate.confirmOwnTv(selected.revision, details, network)).toEqual({
      allowed: false,
      reason: 'unverified-identity',
    });
    expect(gate.canStart(gate.snapshot?.revision ?? 0, details, network).allowed).toBe(false);
    expect(
      gate.confirmOwnTv(selected.revision, details, network, {
        acknowledgeUnverifiedIdentity: true,
      }),
    ).toMatchObject({
      allowed: true,
      selection: { identity: 'unverified', cryptographicallyAttested: false },
    });
  });
  it('duplicate names remain distinct and stale confirmation cannot confirm a new selection', () => {
    const gate = new ReceiverConfirmationGate();
    const first = gate.select(receiver, network);
    const other = { ...receiver, id: 'handle-b', protocolReceiverId: 'protocol-b' };
    const second = gate.select(other, network);
    expect(second.receiver.name).toBe(first.receiver.name);
    expect(second.receiver.id).not.toBe(first.receiver.id);
    expect(gate.confirmOwnTv(first.revision, receiver, network)).toEqual({
      allowed: false,
      reason: 'selection-changed',
    });
    expect(gate.snapshot).toBe(second);
    expect(gate.canStart(gate.snapshot?.revision ?? 0, other, network)).toEqual({
      allowed: false,
      reason: 'confirmation-required',
    });
  });
  it('late start intents cannot reuse a new confirmation even after selecting the identical TV again', () => {
    const gate = confirmed();
    const previous = gate.snapshot!;
    const next = gate.select(receiver, network);
    gate.confirmOwnTv(next.revision, receiver, network);
    expect(gate.canStart(previous.revision, receiver, network)).toEqual({
      allowed: false,
      reason: 'selection-changed',
    });
    expect(gate.canStart(next.revision, receiver, network).allowed).toBe(true);
  });
  it.each(['protocolReceiverId', 'model', 'address', 'id', 'name'] as const)(
    'changed %s invalidates confirmation even at the same address',
    (key) => {
      const gate = confirmed();
      expect(
        gate.canStart(gate.snapshot?.revision ?? 0, { ...receiver, [key]: 'different' }, network),
      ).toEqual({
        allowed: false,
        reason: 'receiver-changed',
      });
      expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network)).toEqual({
        allowed: false,
        reason: 'receiver-changed',
      });
      expect(gate.snapshot?.confirmed).toBe(false);
    },
  );
  it('protocol changes and disappearing reported identity cannot reuse confirmation', () => {
    const gate = confirmed();
    const other = confirmed();
    expect(
      gate.canStart(gate.snapshot!.revision, { ...receiver, protocol: 'dlna' }, network).allowed,
    ).toBe(false);
    expect(
      other.canStart(
        other.snapshot!.revision,
        { ...receiver, protocolReceiverId: undefined },
        network,
      ).allowed,
    ).toBe(false);
  });
  it('network/interface generation changes fence late results and cannot be undone by old observations', () => {
    const gate = confirmed();
    const newer = { generation: 2, scopeId: network.scopeId };
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, newer)).toEqual({
      allowed: false,
      reason: 'network-changed',
    });
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network)).toEqual({
      allowed: false,
      reason: 'network-changed',
    });
    expect(() => gate.select(receiver, network)).toThrow('obsolete');
    const selection = gate.select(receiver, newer);
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, newer).allowed).toBe(false);
    expect(gate.confirmOwnTv(selection.revision, receiver, newer).allowed).toBe(true);
  });
  it('scope changes invalidate even if network generation was accidentally unchanged', () => {
    const gate = confirmed();
    expect(
      gate.canStart(gate.snapshot?.revision ?? 0, receiver, {
        ...network,
        scopeId: 'different-interface',
      }),
    ).toEqual({
      allowed: false,
      reason: 'network-changed',
    });
    expect(() => gate.select(receiver, network)).toThrow('fresh network generation');
    expect(() => gate.select(receiver, { ...network, scopeId: 'different-interface' })).toThrow(
      'fresh network generation',
    );
  });
  it('mutating discovery objects cannot rewrite captured receiver or network details', () => {
    const details = { ...receiver };
    const scope = { ...network };
    const gate = new ReceiverConfirmationGate();
    const selected = gate.select(details, scope);
    details.protocolReceiverId = 'changed';
    scope.generation = 2;
    expect(selected.receiver.protocolReceiverId).toBe('protocol-a');
    expect(selected.network.generation).toBe(1);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.receiver)).toBe(true);
    expect(Object.isFrozen(selected.network)).toBe(true);
  });
  it('clear/expired pairing requires new selection and fresh user confirmation', () => {
    const gate = confirmed();
    gate.invalidate();
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network).allowed).toBe(false);
    gate.clear();
    expect(gate.canStart(gate.snapshot?.revision ?? 0, receiver, network)).toEqual({
      allowed: false,
      reason: 'no-selection',
    });
    const selection = gate.select(receiver, network);
    expect(selection.confirmed).toBe(false);
  });
  it.each([
    {},
    { ...receiver, name: 'x'.repeat(513) },
    { ...receiver, model: 'x'.repeat(129) },
    { ...receiver, protocolReceiverId: '' },
    { ...receiver, name: 'TV\n' },
  ])('rejects malformed or oversized identity snapshots', (value) => {
    expect(() => new ReceiverConfirmationGate().select(value as ReceiverDetails, network)).toThrow(
      'invalid',
    );
  });
  it.each([
    { generation: -1, scopeId: 'x' },
    { generation: 1.5, scopeId: 'x' },
    { generation: 1, scopeId: '' },
    { generation: 1, scopeId: 'x'.repeat(129) },
  ])('rejects invalid network scope', (scope) => {
    expect(() => new ReceiverConfirmationGate().select(receiver, scope)).toThrow('invalid');
  });
});
