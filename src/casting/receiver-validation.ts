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

import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ReceiverDetails, ReceiverNetworkScope } from './receiver-confirmation';

export interface NativeReceiverNetworkScope extends ReceiverNetworkScope {
  observation: 'interfaces-and-routes' | 'interfaces-only';
}
export interface ReceiverValidation {
  device: Readonly<ReceiverDetails>;
  network: Readonly<NativeReceiverNetworkScope>;
  issuedHandle: string | null;
  identityRecheck: 'matched' | 'unavailable';
  cryptographicallyAttested: false;
}
interface Transport {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  isNative: () => boolean;
}
function invalid(): never {
  throw new Error(
    'Receiver validation was invalid. Refresh the receiver list and confirm your TV again.',
  );
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function network(value: unknown): Readonly<NativeReceiverNetworkScope> {
  const v = record(value, ['generation', 'scopeId', 'observation']);
  if (
    !Number.isSafeInteger(v.generation) ||
    (v.generation as number) < 0 ||
    !text(v.scopeId, 128) ||
    !['interfaces-and-routes', 'interfaces-only'].includes(v.observation as string)
  )
    invalid();
  return Object.freeze({
    generation: v.generation as number,
    scopeId: v.scopeId,
    observation: v.observation as NativeReceiverNetworkScope['observation'],
  });
}
function details(value: unknown, native: boolean): Readonly<ReceiverDetails> {
  const keys = [
    'id',
    'name',
    'protocol',
    'protocolReceiverId',
    'model',
    'identityStatus',
    'cryptographicallyAttested',
  ];
  const v = native ? record(value, keys) : (value as unknown as Record<string, unknown>);
  if (
    !v ||
    !text(v.id, 512) ||
    !text(v.name, 512) ||
    !['chromecast', 'dlna'].includes(v.protocol as string) ||
    (v.protocolReceiverId !== undefined && !text(v.protocolReceiverId, 512)) ||
    (v.model !== undefined && !text(v.model, 128)) ||
    v.address !== undefined
  )
    invalid();
  if (
    native &&
    (v.cryptographicallyAttested !== false ||
      v.identityStatus !== (v.protocolReceiverId ? 'protocol-reported' : 'unverified'))
  )
    invalid();
  return Object.freeze({
    id: v.id,
    name: v.name,
    protocol: v.protocol as ReceiverDetails['protocol'],
    ...(v.protocolReceiverId !== undefined
      ? { protocolReceiverId: v.protocolReceiverId as string }
      : {}),
    ...(v.model !== undefined ? { model: v.model as string } : {}),
  });
}
function sameDevice(a: Readonly<ReceiverDetails>, b: Readonly<ReceiverDetails>): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.protocol === b.protocol &&
    a.protocolReceiverId === b.protocolReceiverId &&
    a.model === b.model
  );
}
export function createReceiverValidationAdapter(
  transport: Transport = { invoke, isNative: isTauri },
) {
  async function call(
    command: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (!transport.isNative())
      throw new Error('Receiver validation requires the native application.');
    try {
      const result = await transport.invoke(command, args);
      signal.throwIfAborted();
      return result;
    } catch {
      signal.throwIfAborted();
      throw new Error(
        'Receiver validation could not finish. Check your network and confirm your TV again.',
      );
    }
  }
  return {
    async readNetworkScope(signal: AbortSignal): Promise<Readonly<NativeReceiverNetworkScope>> {
      return network(await call('cast_network_scope', undefined, signal));
    },
    async validateReceiver(
      device: ReceiverDetails,
      expectedNetwork: NativeReceiverNetworkScope,
      allowUnverifiedIdentity: boolean,
      signal: AbortSignal,
    ): Promise<ReceiverValidation> {
      signal.throwIfAborted();
      const selected = details(device, false);
      const expected = network(expectedNetwork);
      if (typeof allowUnverifiedIdentity !== 'boolean') invalid();
      const raw = await call(
        'cast_validate_receiver',
        { deviceId: selected.id, expectedNetwork: expected, allowUnverifiedIdentity },
        signal,
      );
      const v = record(raw, ['device', 'network', 'issuedHandle', 'identityRecheck']);
      const current = network(v.network);
      const receiver = details(v.device, true);
      if (
        !sameDevice(selected, receiver) ||
        current.generation !== expected.generation ||
        current.scopeId !== expected.scopeId ||
        current.observation !== expected.observation ||
        !['matched', 'unavailable'].includes(v.identityRecheck as string) ||
        (v.issuedHandle !== null && !text(v.issuedHandle, 128))
      )
        invalid();
      if (
        v.identityRecheck === 'matched' &&
        (!receiver.protocolReceiverId || v.issuedHandle === null)
      )
        invalid();
      if (
        v.identityRecheck === 'unavailable' &&
        ((allowUnverifiedIdentity && v.issuedHandle === null) ||
          (!allowUnverifiedIdentity && v.issuedHandle !== null))
      )
        invalid();
      return Object.freeze({
        device: receiver,
        network: current,
        issuedHandle: v.issuedHandle as string | null,
        identityRecheck: v.identityRecheck as ReceiverValidation['identityRecheck'],
        cryptographicallyAttested: false,
      });
    },
  };
}
const adapter = createReceiverValidationAdapter();
export const readNetworkScope = adapter.readNetworkScope;
export const validateReceiver = adapter.validateReceiver;
