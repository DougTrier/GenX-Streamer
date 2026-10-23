import { expect, it } from 'vitest';
import { joinGuideWork } from '../../src/application/join-guide-work';

it('retains the second suspension after the first fails, and redacts its failure', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const work = joinGuideWork([
    {
      suspend: async () => {
        throw new Error('private-source-address');
      },
    },
    { suspend: () => held },
  ]);
  const result = work.catch((error: Error) => {
    settled = true;
    return error.message;
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await result).toBe('Automatic guide cleanup could not be confirmed.');
});

it('starts and joins every owner even when one throws synchronously', async () => {
  let called = false;
  await expect(
    joinGuideWork([
      {
        suspend: () => {
          throw new Error('private-detail');
        },
      },
      {
        suspend: async () => {
          called = true;
        },
      },
    ]),
  ).rejects.toThrow('Automatic guide cleanup could not be confirmed.');
  expect(called).toBe(true);
});
