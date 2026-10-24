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
import {
  classifySettledNativeWriteFailure,
  isNativeWriteNotCommittedError,
} from '../../src/platform/native-write-refusal';
import { invokeOwnedNative } from '../../src/platform/owned-native-command';
import { validateCommitReceipt } from '../../src/platform/record-transaction';

const deferred = () => {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const receipt = { committed: true, catalogRevision: '4', healthRevision: '2' };
describe('joined native precommit write refusals', () => {
  it('admits only exact codes/commands and rejects error-message, object and prototype spoofing', () => {
    for (const command of ['write_record_receipt', 'write_record_pair']) {
      for (const code of ['application-closing', 'canceled']) {
        const failure = classifySettledNativeWriteFailure(command, code)!;
        expect(isNativeWriteNotCommittedError(failure)).toBe(true);
        expect(Object.isFrozen(failure)).toBe(true);
        expect(isNativeWriteNotCommittedError(Object.create(Object.getPrototypeOf(failure)))).toBe(
          false,
        );
      }
      for (const raw of [
        new Error('application-closing'),
        { message: 'canceled' },
        'request-canceled',
        'application-closing secret',
        'storage-worker-failed',
        'request-lock',
        'transport-timeout',
      ])
        expect(classifySettledNativeWriteFailure(command, raw)).toBeNull();
    }
    for (const command of [
      'write_health',
      'write_scan_checkpoint',
      'write_record',
      'inspect_source',
    ])
      expect(classifySettledNativeWriteFailure(command, 'application-closing')).toBeNull();
    expect(
      isNativeWriteNotCommittedError(
        Object.assign(new Error('refused'), { name: 'NativeWriteNotCommittedError' }),
      ),
    ).toBe(false);
  });
  for (const order of ['main-first', 'cancel-first']) {
    it(`does not classify until the actual RPC and cancellation both join (${order})`, async () => {
      const main = deferred(),
        cancel = deferred(),
        controller = new AbortController();
      const invoke = vi.fn((command: string) =>
        command === 'cancel_playlist' ? cancel.promise : main.promise,
      );
      let settled = false;
      const result = invokeOwnedNative(
        { invoke, idFactory: () => 'fixture-request' },
        'write_record_pair',
        {},
        { signal: controller.signal, durable: true, validate: validateCommitReceipt },
      ).catch((error) => error);
      void result.then(() => {
        settled = true;
      });
      controller.abort();
      await Promise.resolve();
      if (order === 'main-first') main.reject('application-closing');
      else cancel.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (order === 'main-first') cancel.resolve(undefined);
      else main.reject('application-closing');
      expect(isNativeWriteNotCommittedError(await result)).toBe(true);
      expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: 'fixture-request' });
    });
  }
  it('a durable commit wins a late abort even if cancellation fails', async () => {
    const main = deferred(),
      controller = new AbortController();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? Promise.reject('cancel unavailable') : main.promise,
    );
    const result = invokeOwnedNative(
      { invoke },
      'write_record_pair',
      {},
      { signal: controller.signal, durable: true, validate: validateCommitReceipt },
    );
    controller.abort();
    main.resolve(receipt);
    expect(await result).toEqual(receipt);
  });
  it('unknown cancellation failures and malformed commit receipts remain blocking', async () => {
    const main = deferred(),
      controller = new AbortController();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? Promise.reject('cancel unavailable') : main.promise,
    );
    const result = invokeOwnedNative(
      { invoke },
      'write_record_pair',
      {},
      { signal: controller.signal, durable: true, validate: validateCommitReceipt },
    );
    const failure = expect(result).rejects.toThrow('cancellation could not be confirmed');
    controller.abort();
    main.reject('application-closing');
    await failure;
    await expect(
      invokeOwnedNative(
        {
          invoke: async () => ({
            committed: true,
            catalogRevision: 'invalid',
            healthRevision: '2',
          }),
        },
        'write_record_pair',
        {},
        { durable: true, validate: validateCommitReceipt },
      ),
    ).rejects.toThrow('revision');
  });
});
