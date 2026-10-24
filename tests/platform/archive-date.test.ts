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
  archiveCompactYearLabel,
  archiveItemDateFacts,
  archiveTitleYearLabel,
} from '../../src/ui/genxtra/archive-date';

it('labels both old and assessed IA years as source claims with original year unknown', () => {
  const legacy = { releaseYear: 2020 };
  const assessed = {
    ...legacy,
    dateAssessment: {
      version: 1 as const,
      providerListedYear: 2020,
      originalReleaseYear: null,
      status: 'unverified-item-date' as const,
      provenance: 'legacy-item-year' as const,
      field: 'unknown' as const,
    },
  };
  for (const title of [legacy, assessed]) {
    expect(archiveTitleYearLabel(title)).toBe('Source year 2020');
    expect(archiveCompactYearLabel(title)).toBeNull();
    expect(archiveItemDateFacts(title)).toContainEqual(['Original release year', 'Unknown']);
    expect(archiveItemDateFacts(title)).toContainEqual(['Source-listed year', '2020']);
    expect(archiveItemDateFacts(title)).toContainEqual(['Date assessment', 'Unverified item date']);
    expect(archiveItemDateFacts(title)).toContainEqual([
      'Date provenance',
      'Source metadata; exact date field not retained',
    ]);
  }
});
it('preserves unknown IA dates and existing public provider year presentation', () => {
  expect(archiveTitleYearLabel({ releaseYear: null })).toBe('Source year unknown');
  expect(archiveCompactYearLabel({ releaseYear: null })).toBeNull();
  expect(archiveItemDateFacts({ releaseYear: null })).toContainEqual([
    'Source-listed year',
    'Not listed',
  ]);
  expect(archiveTitleYearLabel({ providerId: 'loc', releaseYear: 1903 })).toBe('1903');
  expect(archiveCompactYearLabel({ providerId: 'loc', releaseYear: 1903 })).toBe('1903');
  expect(archiveCompactYearLabel({ providerId: 'loc', releaseYear: null })).toBeNull();
  expect(archiveTitleYearLabel({ providerId: 'nasa', releaseYear: null })).toBe('Year unknown');
  expect(archiveCompactYearLabel({ providerId: 'nasa', releaseYear: null })).toBeNull();
  expect(archiveItemDateFacts({ providerId: 'nasa', releaseYear: null })).toEqual([]);
});
