import { expect, it, vi } from 'vitest';
import {
  createViewingSettings,
  validateViewingSettings,
} from '../../src/platform/viewing-settings';

const ACCOUNT = 'a'.repeat(32);
/** A native fake that stores the last written value and replies in the given order. */
function storage(options: { failFirstWrite?: boolean; delays?: number[] } = {}) {
  let stored = { hideAdult: true, accountBuffers: {} as Record<string, string> };
  let writes = 0;
  const order: string[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const delay = options.delays?.shift() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (command === 'write_viewing_settings') {
      const request = args!.request as Record<string, unknown>;
      if (options.failFirstWrite && writes++ === 0) throw new Error('disk busy');
      if (typeof request.hideAdult === 'boolean')
        stored = { ...stored, hideAdult: request.hideAdult };
      if (request.accountId)
        stored = {
          ...stored,
          accountBuffers: {
            ...stored.accountBuffers,
            [request.accountId as string]: request.buffer as string,
          },
        };
      order.push(`write:${String(request.hideAdult ?? request.buffer)}`);
    } else order.push('read');
    return { schemaVersion: 1, ...structuredClone(stored) };
  });
  return { runtime: { invoke }, stored: () => stored, order };
}

it('defaults to hiding adult channels until stored choices load', () => {
  const settings = createViewingSettings(storage().runtime);
  expect(settings.current.hideAdult).toBe(true);
  expect(settings.bufferFor(ACCOUNT)).toBe('balanced');
});

it('rapid ON → OFF → ON ends stored and shown as the last choice', async () => {
  // Earlier writes are slower: without ordering they would finish last.
  const fake = storage({ delays: [30, 10, 0] });
  const settings = createViewingSettings(fake.runtime);
  await Promise.all([
    settings.setHideAdult(false),
    settings.setHideAdult(true),
    settings.setHideAdult(false),
  ]);
  expect(fake.order).toEqual(['write:false', 'write:true', 'write:false']);
  expect(fake.stored().hideAdult).toBe(false);
  expect(settings.current.hideAdult).toBe(false);
});

it('a failed write does not stop later writes', async () => {
  const fake = storage({ failFirstWrite: true });
  const settings = createViewingSettings(fake.runtime);
  const failed = settings.setHideAdult(false);
  const next = settings.setBuffer(ACCOUNT, 'smooth');
  await expect(failed).rejects.toThrow('could not be saved');
  await expect(next).resolves.toMatchObject({ accountBuffers: { [ACCOUNT]: 'smooth' } });
  expect(settings.current.hideAdult).toBe(true);
  expect(settings.bufferFor(ACCOUNT)).toBe('smooth');
});

it('a choice made during the first read is not overwritten by that read', async () => {
  const fake = storage({ delays: [40, 0] });
  const settings = createViewingSettings(fake.runtime);
  const loading = settings.load();
  const choice = settings.setHideAdult(false);
  await Promise.all([loading, choice]);
  expect(fake.order).toEqual(['read', 'write:false']);
  expect(settings.current.hideAdult).toBe(false);
});

it('a reopened store restores the last saved choice', async () => {
  const fake = storage();
  await createViewingSettings(fake.runtime).setHideAdult(false);
  const reopened = createViewingSettings(fake.runtime);
  await reopened.load();
  expect(reopened.current.hideAdult).toBe(false);
});

it('refuses malformed settings and buffer values', async () => {
  expect(() =>
    validateViewingSettings({ schemaVersion: 1, hideAdult: 'yes', accountBuffers: {} }),
  ).toThrow();
  expect(() =>
    validateViewingSettings({
      schemaVersion: 1,
      hideAdult: true,
      accountBuffers: { [ACCOUNT]: 'huge' },
    }),
  ).toThrow();
  const settings = createViewingSettings(storage().runtime);
  await expect(settings.setBuffer('../x', 'fast')).rejects.toThrow();
});
