import type { ChannelCoverageReply } from './channel-coverage';

/** Present only validated interval evidence; never claim programme accuracy. */
export function describeChannelCoverage(
  coverage: ChannelCoverageReply,
  formatTime: (instant: number) => string,
  period = 'this window',
): string {
  if (coverage.status !== 'assessed') {
    switch (coverage.reason) {
      case 'source-stale':
        return 'Guide changed. Refresh it to check this period.';
      case 'source-missing':
        return 'Saved guide source is unavailable. Review its source or map another guide.';
      case 'channel-missing':
        return 'This channel is absent from the saved guide. Review its mapping.';
      default:
        return "Couldn't check this period. Try a shorter period.";
    }
  }
  const gaps = coverage.gapCount!,
    ends = coverage.unknownEndCount!;
  const firstGap = coverage.gaps[0];
  const availability =
    coverage.coveredMs === 0
      ? `No listings available in ${period}.`
      : !firstGap || firstGap.startMs > coverage.startMs
        ? `Schedule available through ${formatTime(firstGap?.startMs ?? coverage.endMs)}.`
        : `Schedule has a gap at the start of ${period}.`;
  const gapText =
    gaps === 0
      ? `No schedule gaps in ${period}.`
      : `Schedule has ${gaps} ${gaps === 1 ? 'gap' : 'gaps'} in ${period}.${firstGap ? ` First gap: ${formatTime(firstGap.startMs)} – ${formatTime(firstGap.endMs)}.` : ''}`;
  const unknown = ends ? ` ${ends} program end ${ends === 1 ? 'time' : 'times'} unknown.` : '';
  return `${availability} ${gapText}${unknown}`;
}
