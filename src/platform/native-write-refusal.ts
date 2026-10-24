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

const confirmed = new WeakSet<object>();

/** Private brand: messages, names and arbitrary errors cannot assert a noncommit receipt. */
class NativeWriteNotCommittedError extends Error {
  constructor(readonly reason: 'application-closing' | 'canceled') {
    super('The settings write was refused before publication.');
    this.name = 'NativeWriteNotCommittedError';
    confirmed.add(this);
    Object.freeze(this);
  }
}

/** Internal seam; call only after the actual native RPC and cancellation work have joined. */
export function classifySettledNativeWriteFailure(command: string, error: unknown): Error | null {
  if (
    !['write_record_receipt', 'write_record_pair'].includes(command) ||
    (error !== 'application-closing' && error !== 'canceled')
  )
    return null;
  return new NativeWriteNotCommittedError(error);
}

export function isNativeWriteNotCommittedError(error: unknown): error is Error {
  return error instanceof NativeWriteNotCommittedError && confirmed.has(error);
}
