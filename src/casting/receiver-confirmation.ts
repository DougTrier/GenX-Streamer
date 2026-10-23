import type { CastDevice } from './controller';

/** Native discovery must supply protocol identity explicitly; id is only its selection handle. */
export interface ReceiverDetails extends CastDevice {
  protocolReceiverId?: string;
  model?: string;
  address?: string;
}
/** Opaque local scope, not a Wi-Fi name, address, credential or venue pairing secret. */
export interface ReceiverNetworkScope {
  generation: number;
  scopeId: string;
}
export interface ReceiverSelectionSnapshot {
  readonly revision: number;
  readonly receiver: Readonly<ReceiverDetails>;
  readonly network: Readonly<ReceiverNetworkScope>;
  readonly identity: 'protocol-reported' | 'unverified';
  readonly confirmed: boolean;
  /** User comparison and protocol records do not establish cryptographic device identity. */
  readonly cryptographicallyAttested: false;
}
export type ReceiverStartDecision =
  | { allowed: true; selection: ReceiverSelectionSnapshot }
  | {
      allowed: false;
      reason:
        | 'no-selection'
        | 'selection-changed'
        | 'network-changed'
        | 'receiver-changed'
        | 'confirmation-required'
        | 'unverified-identity';
    };
function text(value: unknown, bound: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= bound &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function receiverSnapshot(receiver: ReceiverDetails): Readonly<ReceiverDetails> {
  if (
    !receiver ||
    !text(receiver.id, 512) ||
    !text(receiver.name, 512) ||
    !['chromecast', 'dlna'].includes(receiver.protocol) ||
    ['protocolReceiverId', 'model', 'address'].some(
      (key) =>
        receiver[key as keyof ReceiverDetails] !== undefined &&
        !text(receiver[key as keyof ReceiverDetails], key === 'model' ? 128 : 512),
    )
  )
    throw new Error('Receiver selection contains invalid bounded details.');
  return Object.freeze({
    id: receiver.id,
    name: receiver.name,
    protocol: receiver.protocol,
    ...(receiver.protocolReceiverId !== undefined
      ? { protocolReceiverId: receiver.protocolReceiverId }
      : {}),
    ...(receiver.model !== undefined ? { model: receiver.model } : {}),
    ...(receiver.address !== undefined ? { address: receiver.address } : {}),
  });
}
function networkSnapshot(network: ReceiverNetworkScope): Readonly<ReceiverNetworkScope> {
  if (
    !network ||
    !Number.isSafeInteger(network.generation) ||
    network.generation < 0 ||
    !text(network.scopeId, 128)
  )
    throw new Error('Receiver network scope is invalid.');
  return Object.freeze({ generation: network.generation, scopeId: network.scopeId });
}
function sameReceiver(a: Readonly<ReceiverDetails>, b: Readonly<ReceiverDetails>): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.protocol === b.protocol &&
    a.protocolReceiverId === b.protocolReceiverId &&
    a.model === b.model &&
    a.address === b.address
  );
}
function sameNetwork(
  a: Readonly<ReceiverNetworkScope>,
  b: Readonly<ReceiverNetworkScope>,
): boolean {
  return a.generation === b.generation && a.scopeId === b.scopeId;
}
/**
 * Pure admission policy only: it sends no commands and cannot stop or replace an owned session.
 * Callers must observe actual network changes, refresh receiver details and honor cancellation
 * before sending media. Passing stale snapshots cannot discover changes by itself.
 */
export class ReceiverConfirmationGate {
  private selected: ReceiverSelectionSnapshot | null = null;
  private revision = 0;
  private latestNetwork: Readonly<ReceiverNetworkScope> | null = null;
  private invalid: 'network-changed' | 'receiver-changed' | null = null;
  get snapshot(): ReceiverSelectionSnapshot | null {
    return this.selected;
  }
  select(receiver: ReceiverDetails, network: ReceiverNetworkScope): ReceiverSelectionSnapshot {
    const nextReceiver = receiverSnapshot(receiver);
    const nextNetwork = networkSnapshot(network);
    if (this.latestNetwork && nextNetwork.generation < this.latestNetwork.generation)
      throw new Error('An obsolete network generation cannot select a receiver.');
    if (
      this.invalid === 'network-changed' &&
      this.selected &&
      nextNetwork.generation <= this.selected.network.generation
    )
      throw new Error('A changed network scope requires a fresh network generation.');
    if (
      this.latestNetwork &&
      nextNetwork.generation === this.latestNetwork.generation &&
      nextNetwork.scopeId !== this.latestNetwork.scopeId
    )
      throw new Error('A changed network scope requires a fresh network generation.');
    if (this.revision === Number.MAX_SAFE_INTEGER)
      throw new Error('Receiver selection revision limit reached.');
    this.latestNetwork = nextNetwork;
    this.invalid = null;
    this.selected = Object.freeze({
      revision: ++this.revision,
      receiver: nextReceiver,
      network: nextNetwork,
      identity: nextReceiver.protocolReceiverId ? 'protocol-reported' : 'unverified',
      confirmed: false,
      cryptographicallyAttested: false,
    });
    return this.selected;
  }
  private revalidate(
    receiver: ReceiverDetails,
    network: ReceiverNetworkScope,
  ): ReceiverStartDecision | null {
    const currentReceiver = receiverSnapshot(receiver);
    const currentNetwork = networkSnapshot(network);
    if (!this.selected) return { allowed: false, reason: 'no-selection' };
    if (this.latestNetwork && currentNetwork.generation < this.latestNetwork.generation) {
      this.invalidate('network-changed');
      return { allowed: false, reason: 'network-changed' };
    }
    this.latestNetwork = currentNetwork;
    if (!sameNetwork(this.selected.network, currentNetwork)) this.invalidate('network-changed');
    else if (!sameReceiver(this.selected.receiver, currentReceiver))
      this.invalidate('receiver-changed');
    return this.invalid ? { allowed: false, reason: this.invalid } : null;
  }
  confirmOwnTv(
    revision: number,
    receiver: ReceiverDetails,
    network: ReceiverNetworkScope,
    acknowledgement: { acknowledgeUnverifiedIdentity?: true } = {},
  ): ReceiverStartDecision {
    if (!this.selected) return { allowed: false, reason: 'no-selection' };
    // A delayed dialog for a different selection cannot mutate the new owner.
    if (revision !== this.selected.revision) return { allowed: false, reason: 'selection-changed' };
    const failure = this.revalidate(receiver, network);
    if (failure) return failure;
    if (
      this.selected.identity === 'unverified' &&
      acknowledgement.acknowledgeUnverifiedIdentity !== true
    )
      return { allowed: false, reason: 'unverified-identity' };
    this.selected = Object.freeze({ ...this.selected, confirmed: true });
    return { allowed: true, selection: this.selected };
  }
  canStart(
    revision: number,
    receiver: ReceiverDetails,
    network: ReceiverNetworkScope,
  ): ReceiverStartDecision {
    if (this.selected && revision !== this.selected.revision)
      return { allowed: false, reason: 'selection-changed' };
    const failure = this.revalidate(receiver, network);
    if (failure) return failure;
    if (!this.selected) return { allowed: false, reason: 'no-selection' };
    return this.selected.confirmed
      ? { allowed: true, selection: this.selected }
      : { allowed: false, reason: 'confirmation-required' };
  }
  /** Irreversible for this selection; reselect and compare again after pairing/network changes. */
  invalidate(reason: 'network-changed' | 'receiver-changed' = 'network-changed'): void {
    if (!this.selected) return;
    this.invalid ??= reason;
    this.selected = Object.freeze({ ...this.selected, confirmed: false });
  }
  clear(): void {
    this.selected = null;
    this.invalid = null;
  }
}
