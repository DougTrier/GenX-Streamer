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
  createArchiveCatalog,
  validateArchiveQuery,
  type ArchiveFileProgressQuery,
  type ArchiveLanguageMode,
  type ArchiveQuery,
} from '../../src/platform/archive-catalog';

const query: ArchiveQuery = {
  schemaVersion: 1,
  query: 'Gilligan',
  expectedRevision: '7',
  offset: 0,
  pageSize: 25,
  curatedOnly: false,
  decade: 1960,
  favoritesOnly: true,
};
const progressQuery: ArchiveFileProgressQuery = {
  schemaVersion: 1,
  expectedRevision: '7',
  offset: 0,
  pageSize: 25,
  query: 'Gilligan',
  decade: 1960,
  favoritesOnly: true,
};
const emptyPage = {
  schemaVersion: 1,
  revision: '7',
  totalCount: 0,
  offset: 0,
  items: [],
  more: false,
};
const modes: ArchiveLanguageMode[] = ['all', 'english-first', 'english', 'unlisted'];

describe('Archive local language query boundary', () => {
  it.each(modes)(
    'forwards exact %s mode with existing local title and pending-file filters',
    async (mode) => {
      const invoke = vi.fn(async () => emptyPage);
      const catalog = createArchiveCatalog({ idFactory: () => 'language-request', invoke });
      const titleRequest = { ...query, languageMode: mode };
      const filesRequest = { ...progressQuery, languageMode: mode };

      expect(validateArchiveQuery(titleRequest)).toEqual(titleRequest);
      await expect(catalog.query(titleRequest)).resolves.toEqual(emptyPage);
      await expect(catalog.itemFilesProgress(filesRequest)).resolves.toEqual(emptyPage);
      expect(invoke.mock.calls).toEqual([
        ['archive_query_catalog', { request: { ...titleRequest, requestId: 'language-request' } }],
        [
          'archive_item_files_progress',
          { request: { ...filesRequest, requestId: 'language-request' } },
        ],
      ]);
    },
  );

  it('retains omitted-mode compatibility without inventing a request field', async () => {
    const invoke = vi.fn(async () => emptyPage);
    const catalog = createArchiveCatalog({ idFactory: () => 'legacy-request', invoke });
    expect(validateArchiveQuery(query)).toEqual(query);
    await catalog.query(query);
    await catalog.itemFilesProgress(progressQuery);
    expect(invoke.mock.calls).toEqual([
      ['archive_query_catalog', { request: { ...query, requestId: 'legacy-request' } }],
      [
        'archive_item_files_progress',
        { request: { ...progressQuery, requestId: 'legacy-request' } },
      ],
    ]);
  });

  it.each([null, '', 'English', 'english-only', 'ALL', 0, true, [], {}, ['english']])(
    'rejects invalid mode %j before any native work',
    (mode) => {
      const invoke = vi.fn(async () => emptyPage);
      const catalog = createArchiveCatalog({ invoke });
      const titleRequest = { ...query, languageMode: mode } as ArchiveQuery;
      const filesRequest = { ...progressQuery, languageMode: mode } as ArchiveFileProgressQuery;
      expect(() => validateArchiveQuery(titleRequest)).toThrow(/invalid/u);
      expect(() => catalog.query(titleRequest)).toThrow(/invalid/u);
      expect(() => catalog.itemFilesProgress(filesRequest)).toThrow(/invalid/u);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('keeps local language preference out of online discovery requests', () => {
    const invoke = vi.fn(async () => emptyPage);
    const catalog = createArchiveCatalog({ invoke });
    const scope = {
      schemaVersion: 1 as const,
      query: 'Gilligan',
      year: null,
      languageMode: 'english',
    };
    expect(() => catalog.progress(scope)).toThrow(/invalid/u);
    expect(() =>
      catalog.discoverStep({ ...scope, expectedRevision: '7', page: 1, explicitAction: true }),
    ).toThrow(/invalid/u);
    expect(invoke).not.toHaveBeenCalled();
  });
});
