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

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createArchiveCatalog,
  validateArchiveArtworkResponse,
  validateArchiveQuery,
  type ArchiveArtworkRequest,
} from '../../src/platform/archive-catalog';
const request: ArchiveArtworkRequest = {
  schemaVersion: 1,
  titleRef: 'a'.repeat(64),
  expectedRevision: '7',
};
const bytes = readFileSync(
  new URL('../fixtures/archive-artwork/gilligan-item-tile.jpg', import.meta.url),
);
const receipt = {
  schemaVersion: 1,
  titleRef: request.titleRef,
  revision: '7',
  artworkRef: 'b'.repeat(64),
  mimeType: 'image/jpeg',
  width: 180,
  height: 135,
  byteLength: bytes.length,
  dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
};
describe('bounded actual provider artwork IPC', () => {
  it('admits the observed provider JPEG and a truthful absent-image null', async () => {
    expect(validateArchiveArtworkResponse(receipt, request)).toEqual(receipt);
    expect(validateArchiveArtworkResponse(null, request)).toBeNull();
    const invoke = vi.fn(async () => receipt);
    const catalog = createArchiveCatalog({ invoke, idFactory: () => 'artwork-owner' });
    expect(await catalog.artwork(request)).toEqual(receipt);
    expect(invoke).toHaveBeenCalledWith('archive_title_artwork', {
      request: { ...request, requestId: 'artwork-owner' },
    });
  });
  it.each([
    { titleRef: 'c'.repeat(64) },
    { revision: '8' },
    { artworkRef: 'bad' },
    { mimeType: 'image/svg+xml' },
    { dataUrl: 'https://example.invalid/image.jpg' },
    { width: 0 },
    { width: 2049 },
    { width: 2048, height: 2048 },
    { byteLength: 524289 },
    { byteLength: bytes.length + 1 },
    { dataUrl: 'data:image/jpeg;base64,not image' },
    { sourceUrl: 'https://example.invalid/image.jpg' },
  ])('refuses malformed authority, bytes, formats or dimensions: %j', (patch) => {
    expect(() => validateArchiveArtworkResponse({ ...receipt, ...patch }, request)).toThrow();
  });
  it('joins original image work and cancellation instead of publishing a late result', async () => {
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? Promise.resolve() : pending,
    );
    const catalog = createArchiveCatalog({ invoke, idFactory: () => 'image-job' });
    const abort = new AbortController();
    const work = catalog.artwork(request, abort.signal);
    abort.abort();
    complete(receipt);
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: 'image-job' });
  });
  it.each([2000, 2010, 2020] as const)(
    'admits actual modern browse year group %s without query-side URLs',
    (decade) => {
      const query = {
        schemaVersion: 1 as const,
        query: '',
        expectedRevision: null,
        offset: 0,
        pageSize: 50,
        decade,
        contentType: 'short' as const,
      };
      expect(validateArchiveQuery(query)).toEqual(query);
    },
  );
});
