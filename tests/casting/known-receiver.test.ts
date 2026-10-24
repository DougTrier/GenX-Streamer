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

import { beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { probeKnownReceiver } from '../../src/casting/known-receiver';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
});
it('probes an explicitly entered receiver without issuing playback commands', async () => {
  const receiver = { id: 'verified', name: 'My TV', protocol: 'chromecast' };
  vi.mocked(invoke).mockResolvedValue(receiver);
  expect(await probeKnownReceiver(' 192.168.1.23 ', '', new AbortController().signal)).toEqual(
    receiver,
  );
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['cast_register_receiver', { address: '192.168.1.23', name: 'My TV' }],
  ]);
});
it('suppresses a late probe reply after the dialog owner is cancelled', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const owner = new AbortController();
  const result = probeKnownReceiver('192.168.1.23', 'TV', owner.signal);
  owner.abort();
  finish({ id: 'late', name: 'TV', protocol: 'chromecast' });
  await expect(result).rejects.toThrow();
});
it('declines browser preview and already cancelled probes before native invocation', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(
    probeKnownReceiver('192.168.1.23', 'TV', new AbortController().signal),
  ).rejects.toThrow('installed');
  const owner = new AbortController();
  owner.abort();
  await expect(probeKnownReceiver('192.168.1.23', 'TV', owner.signal)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
