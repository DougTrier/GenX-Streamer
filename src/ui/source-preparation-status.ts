import type { SourceSnapshotPreparationProgress } from '../platform/source-snapshot-progress';
/** Manifest preparation is distinct from observing or saving playable channels. */
export function sourcePreparationStatus(progress: SourceSnapshotPreparationProgress): string {
  return progress.phase === 'sealing'
    ? `Sealing channel checks · ${progress.preparedCandidates} of ${progress.totalCandidates} prepared`
    : `Preparing channel checks · ${progress.preparedCandidates} of ${progress.totalCandidates} prepared`;
}
