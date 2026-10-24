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
  createRendererRecoveryPolicy,
  validateRendererRecoveryBootstrap,
} from '../../src/application/shell/renderer-recovery-policy';

describe('renderer recovery session consent', () => {
  it('holds automatic work until one actual bootstrap reply settles', async () => {
    let resolve!: (value: unknown) => void;
    const read = vi.fn(
      () =>
        new Promise<unknown>((r) => {
          resolve = r;
        }),
    );
    const policy = createRendererRecoveryPolicy(read);
    policy.authorize('scan');
    expect(policy.allowAutomaticWork()).toBe(false);
    const work = policy.initialize();
    expect(policy.initialize()).toBe(work);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(policy.allowAutomaticWork()).toBe(false);
    resolve({ schemaVersion: 1, recoveredRenderer: false });
    await work;
    expect(policy.allowAutomaticWork()).toBe(true);
  });
  it.each(['scan', 'refresh', 'update-settings'] as const)(
    'recovered session requires explicit %s without changing the bootstrap flag',
    async (intent) => {
      const receipt = Object.freeze({ schemaVersion: 1, recoveredRenderer: true });
      const policy = createRendererRecoveryPolicy(async () => receipt);
      await policy.initialize();
      expect(policy.allowAutomaticWork()).toBe(false);
      policy.authorize(intent);
      expect(policy.allowAutomaticWork()).toBe(true);
      expect(policy.status()).toBe('recovered');
      expect(receipt.recoveredRenderer).toBe(true);
    },
  );
  it('unknown bridge failure leaves manual controls usable but no automatic acquisition', async () => {
    const policy = createRendererRecoveryPolicy(async () => {
      throw Error('failure');
    });
    await policy.initialize();
    expect(policy.status()).toBe('unavailable');
    expect(policy.allowAutomaticWork()).toBe(false);
    policy.authorize('refresh');
    expect(policy.allowAutomaticWork()).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { schemaVersion: 2, recoveredRenderer: false },
    { schemaVersion: 1, recoveredRenderer: 'false' },
    { schemaVersion: 1, recoveredRenderer: false, autoplay: true },
  ])('refuses malformed bootstrap %j', (value) => {
    expect(() => validateRendererRecoveryBootstrap(value)).toThrow();
  });
});
