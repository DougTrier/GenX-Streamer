import { SelectedGuideUnavailableError } from '../guide/native';
import {
  validVisibleChannels,
  validGuideRevision,
  type VisibleGuideChannel,
  type VisibleGuideQuery,
  type VisibleGuideSummary,
} from '../guide/visible-native';
import { createGuideSummaryOwner, type GuideSummaryClock } from './guide-summary-owner';

export interface VisibleGuideScope {
  channels: readonly VisibleGuideChannel[];
  catalogRevision: string;
  generation: number;
}
/** A single bounded local snapshot for the exact viewport; no network or playback actions. */
export function createVisibleGuideOwner(options: {
  fetch(query: VisibleGuideQuery, signal: AbortSignal): Promise<VisibleGuideSummary>;
  cancel?(requestId: string): Promise<unknown>;
  isCurrent(scope: Readonly<VisibleGuideScope>): boolean;
  available?(): boolean;
  clock?: GuideSummaryClock;
  requestId?(): string;
}) {
  return createGuideSummaryOwner<VisibleGuideScope, VisibleGuideQuery, VisibleGuideSummary>({
    ...options,
    validateScope: (scope) =>
      validVisibleChannels(scope.channels) &&
      validGuideRevision(scope.catalogRevision) &&
      Number.isSafeInteger(scope.generation) &&
      scope.generation >= 0,
    query: (scope, atMs, requestId) => ({ channels: scope.channels, atMs, requestId }),
    validateReply: (reply, query, scope) =>
      reply.requestId === query.requestId &&
      reply.atMs === query.atMs &&
      reply.catalogRevision === scope.catalogRevision &&
      reply.rows.length === query.channels.length &&
      reply.rows.every(
        (row, index) =>
          row.catalogSourceId === query.channels[index].catalogSourceId &&
          row.appChannelId === query.channels[index].appChannelId &&
          row.atMs === query.atMs &&
          row.requestId === query.requestId &&
          row.catalogRevision === reply.catalogRevision &&
          row.databaseRevision === reply.databaseRevision,
      ),
    boundaries: (reply) => reply.rows.flatMap((row) => [row.current?.stopMs, row.next?.startMs]),
    isUnavailable: (error) => error instanceof SelectedGuideUnavailableError,
  });
}
