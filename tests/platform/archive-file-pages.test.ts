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
import {
  validateArchiveFileProgress,
  validateArchiveItemFilesReceipt,
} from '../../src/platform/archive-catalog';

const titleRef = 'a'.repeat(64);
const request = {
  schemaVersion: 1 as const,
  titleRef,
  expectedRevision: '7',
  expectedOffset: 64,
  explicitAction: true as const,
};
const progress = {
  titleRef,
  title: 'Classic collection',
  kind: 'tv',
  originalYear: 1965,
  providerFileCount: 1024,
  nextOffset: 128,
  availableFileCount: 0,
  complete: false,
  capacityReached: false,
};
const receipt = {
  schemaVersion: 1,
  committed: true,
  revision: '8',
  progress,
  admitted: 0,
  confirmedDead: 0,
};

it('a page with no compatible videos still preserves explicit continuation', () => {
  expect(validateArchiveItemFilesReceipt(receipt, request).progress).toEqual(progress);
  expect(
    validateArchiveFileProgress({ ...progress, nextOffset: 1024, complete: true }).complete,
  ).toBe(true);
});

it('partial metadata can never authorize removal or cross-title publication', () => {
  for (const changed of [
    { ...receipt, confirmedDead: 1 },
    { ...receipt, progress: { ...progress, titleRef: 'b'.repeat(64) } },
    { ...receipt, revision: '9' },
    { ...receipt, committed: false },
  ])
    expect(() => validateArchiveItemFilesReceipt(changed, request)).toThrow();
});

it('continuation must advance by a bounded provider page and report a coherent limit', () => {
  for (const changed of [
    { ...progress, nextOffset: 64 },
    { ...progress, nextOffset: 129 },
    { ...progress, nextOffset: 1025 },
    { ...progress, providerFileCount: 100001 },
    { ...progress, nextOffset: 1024, complete: true, capacityReached: true },
  ])
    expect(() =>
      validateArchiveItemFilesReceipt({ ...receipt, progress: changed }, request),
    ).toThrow();
  expect(
    validateArchiveItemFilesReceipt(
      { ...receipt, progress: { ...progress, capacityReached: true } },
      request,
    ).progress.capacityReached,
  ).toBe(true);
});

it('pending progress admits metadata only and refuses executable destinations', () => {
  expect(() =>
    validateArchiveFileProgress({ ...progress, mediaUrl: 'https://fixture.invalid/video.mp4' }),
  ).toThrow();
  expect(() => validateArchiveFileProgress({ ...progress, titleRef: '../file.mp4' })).toThrow();
  expect(() => validateArchiveFileProgress({ ...progress, nextOffset: 1024, complete: false })).toThrow();
});
