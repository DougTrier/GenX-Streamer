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

import type { ArchiveTitle } from '../platform/archive-catalog';

type DatedTitle = Pick<ArchiveTitle, 'providerId' | 'releaseYear' | 'dateAssessment'>;

/** Compact rows reserve space for type and count; IA item dates stay in the details. */
export function archiveCompactYearLabel(title: DatedTitle): string | null {
  return title.providerId && title.releaseYear !== null ? String(title.releaseYear) : null;
}

/** Older IA DTOs carry the same unverified item-year claim without the assessment. */
export function archiveTitleYearLabel(title: DatedTitle): string {
  if (title.providerId)
    return title.releaseYear === null ? 'Year unknown' : String(title.releaseYear);
  const year = title.dateAssessment?.providerListedYear ?? title.releaseYear;
  return year === null ? 'Source year unknown' : `Source year ${year}`;
}

export function archiveItemDateFacts(title: DatedTitle): readonly (readonly [string, string])[] {
  if (title.providerId) return [];
  const year = title.dateAssessment?.providerListedYear ?? title.releaseYear;
  return [
    ['Original release year', 'Unknown'],
    ['Source-listed year', year === null ? 'Not listed' : String(year)],
    ['Date assessment', year === null ? 'Unknown' : 'Unverified item date'],
    ['Date provenance', 'Source metadata; exact date field not retained'],
  ];
}
