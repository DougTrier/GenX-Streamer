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

import { ReceiverConfirmationGate, type ReceiverDetails } from './receiver-confirmation';
import type { NativeReceiverNetworkScope, ReceiverValidation } from './receiver-validation';
export interface ConfirmedReceiverSnapshot {
  readonly receiver: Readonly<ReceiverDetails>;
  readonly network: Readonly<NativeReceiverNetworkScope>;
  readonly revision: number;
  readonly requiresUnverifiedAcknowledgment: boolean;
  readonly confirmed: boolean;
}
export interface ReceiverValidationDependencies {
  readNetworkScope(signal: AbortSignal): Promise<Readonly<NativeReceiverNetworkScope>>;
  validateReceiver(
    device: ReceiverDetails,
    network: NativeReceiverNetworkScope,
    acknowledge: boolean,
    signal: AbortSignal,
  ): Promise<ReceiverValidation>;
}
function changed(): never {
  throw new Error('Receiver selection changed. Select and confirm your TV again.');
}
function sameNetwork(a: NativeReceiverNetworkScope, b: NativeReceiverNetworkScope): boolean {
  return (
    a.generation === b.generation && a.scopeId === b.scopeId && a.observation === b.observation
  );
}
function sameReceiver(a: ReceiverDetails, b: ReceiverDetails): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.protocol === b.protocol &&
    a.protocolReceiverId === b.protocolReceiverId &&
    a.model === b.model &&
    a.address === b.address
  );
}
/** Owns confirmation only. It sends no media commands and never caches a start handle. */
export function createConfirmedReceiver(dependencies: ReceiverValidationDependencies) {
  let gate = new ReceiverConfirmationGate();
  let state: ConfirmedReceiverSnapshot | null = null;
  let revision = 0;
  let operation = 0;
  let acknowledged = false;
  const next = () => {
    if (operation === Number.MAX_SAFE_INTEGER) throw new Error('Receiver operation limit reached.');
    return ++operation;
  };
  function guard(id: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (id !== operation) changed();
  }
  function invalidate(id: number) {
    if (id === operation && state) {
      state = Object.freeze({ ...state, confirmed: false });
      acknowledged = false;
    }
  }
  async function fresh(id: number, signal: AbortSignal, ack: boolean): Promise<ReceiverValidation> {
    guard(id, signal);
    if (!state) changed();
    const selected = state;
    const network = await dependencies.readNetworkScope(signal);
    guard(id, signal);
    if (!sameNetwork(selected.network, network)) changed();
    const result = await dependencies.validateReceiver(selected.receiver, network, ack, signal);
    guard(id, signal);
    if (!sameReceiver(selected.receiver, result.device) || !sameNetwork(network, result.network))
      changed();
    return result;
  }
  return {
    get snapshot(): ConfirmedReceiverSnapshot | null {
      return state;
    },
    clear() {
      next();
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Receiver revision limit reached.');
      revision++;
      state = null;
      acknowledged = false;
      gate = new ReceiverConfirmationGate();
    },
    async select(device: ReceiverDetails, signal: AbortSignal): Promise<ReceiverValidation> {
      signal.throwIfAborted();
      const id = next();
      if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Receiver revision limit reached.');
      const selectedRevision = ++revision;
      state = null;
      acknowledged = false;
      gate = new ReceiverConfirmationGate();
      const receiver = Object.freeze({ ...device });
      const network = await dependencies.readNetworkScope(signal);
      guard(id, signal);
      const result = await dependencies.validateReceiver(receiver, network, false, signal);
      guard(id, signal);
      if (!sameReceiver(receiver, result.device) || !sameNetwork(network, result.network))
        changed();
      const selection = gate.select(result.device, result.network);
      state = Object.freeze({
        receiver: selection.receiver,
        network: Object.freeze({ ...result.network }),
        revision: selectedRevision,
        requiresUnverifiedAcknowledgment:
          result.identityRecheck === 'unavailable' || !result.device.protocolReceiverId,
        confirmed: false,
      });
      return result;
    },
    async confirm(ack: boolean, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const id = next();
      try {
        if (typeof ack !== 'boolean' || !state) changed();
        const result = await fresh(id, signal, ack);
        guard(id, signal);
        const required =
          result.identityRecheck === 'unavailable' || !result.device.protocolReceiverId;
        if (required && !ack) {
          state = Object.freeze({
            ...state!,
            requiresUnverifiedAcknowledgment: true,
            confirmed: false,
          });
          throw new Error(
            'This TV identity could not be rechecked. Explicitly acknowledge the uncertainty before casting.',
          );
        }
        const decision = gate.confirmOwnTv(
          gate.snapshot!.revision,
          result.device,
          result.network,
          ack ? { acknowledgeUnverifiedIdentity: true } : {},
        );
        if (!decision.allowed) changed();
        acknowledged = ack;
        state = Object.freeze({
          ...state!,
          requiresUnverifiedAcknowledgment: required,
          confirmed: true,
        });
      } catch (error) {
        invalidate(id);
        throw error;
      }
    },
    async authorize(device: ReceiverDetails, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const id = next();
      try {
        if (!state?.confirmed || !sameReceiver(device, state.receiver)) changed();
        const result = await fresh(id, signal, acknowledged);
        guard(id, signal);
        if (result.identityRecheck === 'unavailable' && !acknowledged) {
          state = Object.freeze({
            ...state!,
            requiresUnverifiedAcknowledgment: true,
            confirmed: false,
          });
          throw new Error(
            'The TV identity is unavailable. Confirm the uncertainty again before casting.',
          );
        }
        const decision = gate.canStart(gate.snapshot!.revision, result.device, result.network);
        if (!decision.allowed || !result.issuedHandle) changed();
        return result.issuedHandle;
      } catch (error) {
        invalidate(id);
        throw error;
      }
    },
  };
}
