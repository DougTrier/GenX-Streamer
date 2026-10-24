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

import { expect, it } from 'vitest';
import { validateAccountCatalogRefreshReceipt } from '../../src/platform/account-catalog';

const id = 'a'.repeat(32);
const base = {
  schemaVersion: 1,
  committed: true,
  accountId: id,
  accountRevision: '1',
  mediaRevision: '2',
  channels: 19_600,
  cleanupPending: false,
};

it('a refresh reports how many unusable provider entries were left out', () => {
  expect(validateAccountCatalogRefreshReceipt({ ...base, skipped: 18 }, id, '1').skipped).toBe(18);
  // Older native builds send no count.
  expect(validateAccountCatalogRefreshReceipt(base, id, '1').skipped).toBeUndefined();
  for (const skipped of [-1, 1.5, '3', 100_001, null])
    expect(() => validateAccountCatalogRefreshReceipt({ ...base, skipped }, id, '1')).toThrow();
});
