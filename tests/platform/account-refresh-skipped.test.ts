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
