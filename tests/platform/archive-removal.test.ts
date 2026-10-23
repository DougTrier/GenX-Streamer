import { expect, it } from 'vitest';
import {
  createArchiveCatalog,
  validateArchiveRemovalReceipt,
} from '../../src/platform/archive-catalog';

const request = { schemaVersion: 1 as const, expectedRevision: '7', explicitAction: true as const };
const receipt = {
  schemaVersion: 1,
  committed: true,
  revision: '8',
  removedTitles: 1,
  removedFiles: 2,
  removedFavorites: 1,
  clearedProgress: 1,
  cleanupPending: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it('removal receipts require exact bounded metadata and truthful CAS increments', () => {
  expect(validateArchiveRemovalReceipt(receipt, '7')).toEqual(receipt);
  expect(
    validateArchiveRemovalReceipt(
      {
        ...receipt,
        revision: '7',
        removedTitles: 0,
        removedFiles: 0,
        removedFavorites: 0,
        clearedProgress: 0,
      },
      '7',
    ).revision,
  ).toBe('7');
  for (const bad of [
    { ...receipt, committed: false },
    { ...receipt, revision: '09' },
    { ...receipt, revision: '9' },
    { ...receipt, revision: '7' },
    { ...receipt, removedFiles: 1400001 },
    { ...receipt, removedTitles: 1401 },
    { ...receipt, removedFavorites: 10001 },
    { ...receipt, clearedProgress: 1442 },
    { ...receipt, cleanupPending: 'false' },
    { ...receipt, mediaUrl: 'https://fixture.invalid/private' },
  ])
    expect(() => validateArchiveRemovalReceipt(bad, '7')).toThrow();
  expect(() =>
    validateArchiveRemovalReceipt(
      {
        ...receipt,
        revision: '7',
        removedTitles: 0,
        removedFiles: 0,
        removedFavorites: 0,
        clearedProgress: 0,
      },
      '7',
      true,
    ),
  ).toThrow();
});

it('late COMMIT joins original removal and exact cancellation before returning durable truth', async () => {
  const actual = deferred<unknown>(),
    cancel = deferred<unknown>();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const catalog = createArchiveCatalog({
    idFactory: () => 'removal-request',
    invoke: (command, args) => {
      calls.push({ command, args });
      return command === 'cancel_playlist' ? cancel.promise : actual.promise;
    },
  });
  const controller = new AbortController();
  let settled = false;
  const pending = catalog
    .remove(
      { kind: 'file', titleRef: 'a'.repeat(64), fileRef: 'b'.repeat(64) },
      request,
      controller.signal,
    )
    .then((value) => {
      settled = true;
      return value;
    });
  controller.abort();
  await Promise.resolve();
  expect(calls[0]).toEqual({
    command: 'archive_remove_file',
    args: {
      request: {
        ...request,
        titleRef: 'a'.repeat(64),
        fileRef: 'b'.repeat(64),
        requestId: 'removal-request',
      },
    },
  });
  expect(calls[1]).toEqual({ command: 'cancel_playlist', args: { requestId: 'removal-request' } });
  actual.resolve({ ...receipt, cleanupPending: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  cancel.resolve(undefined);
  expect(await pending).toEqual({ ...receipt, cleanupPending: true });
});

it('clear and title removal use separate bounded command identities, rejecting caller extras before IPC', async () => {
  const commands: string[] = [];
  const catalog = createArchiveCatalog({
    invoke: async (command) => {
      commands.push(command);
      return receipt;
    },
  });
  await catalog.remove({ kind: 'library' }, request);
  await catalog.remove({ kind: 'title', titleRef: 'a'.repeat(64) }, request);
  expect(commands).toEqual(['archive_clear_library', 'archive_remove_title']);
  for (const target of [
    { kind: 'title', titleRef: '../private' },
    { kind: 'file', titleRef: 'a'.repeat(64), fileRef: 'b'.repeat(63) },
    { kind: 'library', titleRef: 'a'.repeat(64) },
  ])
    expect(() => catalog.remove(target as never, request)).toThrow();
  expect(() =>
    catalog.remove({ kind: 'library' }, { ...request, requestId: 'caller-chosen' } as never),
  ).toThrow();
  expect(commands).toHaveLength(2);
});
