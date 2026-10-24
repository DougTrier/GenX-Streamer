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
  createAccountVault,
  validateAccountMetadata,
  type AccountSaveRequest,
} from '../../src/platform/account-vault';

// Test-only values; no real provider or credentials.
const id = 'a'.repeat(32);
const metadata = (serverOrigin: string, allowHttp: boolean) => ({
  schemaVersion: 1,
  id,
  name: 'Fixture TV',
  kind: 'xtream',
  serverOrigin,
  allowHttp,
  revision: '1',
  requiresSignIn: false,
});
const xtream = (serverUrl: string, allowHttp: boolean): AccountSaveRequest => ({
  schemaVersion: 1,
  name: 'Fixture TV',
  allowHttp,
  kind: 'xtream',
  serverUrl,
  username: 'fixture-user',
  password: 'fixture-pass',
});
const runtime = (reply: (request: Record<string, unknown>) => unknown) => {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'save_iptv_account') return reply(args!.request as Record<string, unknown>);
    return undefined;
  });
  return { invoke, idFactory: () => 'request-1' };
};

describe('per-account HTTP grant', () => {
  it('metadata accepts an HTTP origin only when the account carries the grant', () => {
    expect(
      validateAccountMetadata(metadata('http://tv.fixture.invalid:8080', true)).allowHttp,
    ).toBe(true);
    expect(() =>
      validateAccountMetadata(metadata('http://tv.fixture.invalid:8080', false)),
    ).toThrow();
    expect(validateAccountMetadata(metadata('https://tv.fixture.invalid', false)).allowHttp).toBe(
      false,
    );
  });

  it('refuses an HTTP sign-in without the grant, before anything is sent', async () => {
    const native = runtime(() => undefined);
    const vault = createAccountVault(native);
    await expect(vault.save(xtream('http://tv.fixture.invalid:8080', false))).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('sends the grant and requires the stored origin and grant to match exactly', async () => {
    const native = runtime((request) => ({
      schemaVersion: 1,
      committed: true,
      cleanupPending: false,
      metadata: metadata('http://tv.fixture.invalid:8080', request.allowHttp as boolean),
    }));
    const vault = createAccountVault(native);
    const receipt = await vault.save(xtream('http://tv.fixture.invalid:8080', true));
    expect(receipt.metadata).toMatchObject({
      serverOrigin: 'http://tv.fixture.invalid:8080',
      allowHttp: true,
    });
    const sent = native.invoke.mock.calls.find(([command]) => command === 'save_iptv_account')!;
    expect((sent[1] as { request: { allowHttp: boolean } }).request.allowHttp).toBe(true);
    // A receipt that silently dropped the grant (or changed the port) is refused.
    const mismatch = createAccountVault(
      runtime(() => ({
        schemaVersion: 1,
        committed: true,
        cleanupPending: false,
        metadata: metadata('http://tv.fixture.invalid', true),
      })),
    );
    await expect(mismatch.save(xtream('http://tv.fixture.invalid:8080', true))).rejects.toThrow();
  });
});
