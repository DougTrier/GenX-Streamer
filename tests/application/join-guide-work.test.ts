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
