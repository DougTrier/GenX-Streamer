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
