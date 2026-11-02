// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { createAccountBrowser } from '../../src/application/accounts/account-browser';
import type { AccountMetadata } from '../../src/platform/account-vault';
const account = (id: string): AccountMetadata => ({
  schemaVersion: 1,
  id: id.repeat(32),
  name: 'Provider',
  kind: 'xtream',
  serverOrigin: 'https://provider.invalid',
  allowHttp: false,
  revision: '1',
  requiresSignIn: false,
});
it('Guide selection signals follow account identity, abort on reselection and close, and release subscribers', async () => {
  const owner = createAccountBrowser();
  const changed = vi.fn();
  const unsubscribe = owner.subscribeSelection(changed);
  const initial = owner.selectionSignal;
  await owner.select(account('a'));
  expect(initial.aborted).toBe(true);
  const first = owner.selectionSignal,
    identity = owner.identity();
  expect(first.aborted).toBe(false);
  await owner.select(account('a'));
  expect(first.aborted).toBe(true);
  expect(owner.identity()).not.toBe(identity);
  const again = owner.selectionSignal;
  await owner.select(account('b'));
  expect(again.aborted).toBe(true);
  expect(changed).toHaveBeenCalledTimes(3);
  const last = owner.selectionSignal;
  unsubscribe();
  await owner.select(null);
  expect(last.aborted).toBe(true);
  expect(changed).toHaveBeenCalledTimes(3);
  const closing = owner.selectionSignal;
  await owner.dispose();
  expect(closing.aborted).toBe(true);
  expect(owner.selectedAccount).toBeNull();
});
