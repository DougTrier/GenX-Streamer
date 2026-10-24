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

/**
 * The guide's host interface and the types and helpers its parts share.
 * Re-exported by guide.ts.
 */
import { type TimelineHost } from './guide-timeline-model';
import { type AutomaticGuideBuildResult } from '../guide/automatic-build';
import { type GuideDiscoveryResult } from '../guide/discovery';
import {
  type GuideChannelCursor,
  type GuideChannelPage,
  type GuideMapping,
  type GuidePreview,
  type GuideSource,
  type ProgramPage,
  type ProgramQuery,
  type SelectedGuideQuery,
  type SelectedGuideSummary,
} from '../guide/native';
import { type MappedGuideHydrationResult } from '../application/guide/mapped-guide-schedule';
import { type ChannelCoverageReply, type ChannelCoverageRequest } from '../guide/channel-coverage';
import { type SelectedGuideClock } from '../application/guide/selected-guide';
import { guideCategoryKey, type GuideCategory } from '../guide/categories';

export interface GuideCatalogChannel {
  id: string;
  sourceId: string;
  providerId?: string;
  name: string;
  category?: string;
  favorite?: boolean;
}

export interface GuideCoverage {
  publishedRevision: number | null;
  updatedMs: number | null;
  startMs: number | null;
  endMs: number | null;
}

export interface GuideHost {
  logos?: TimelineHost['logos'];
  listedChannels?: TimelineHost['listedChannels'];
  /** Normal Guide only; mapping and advanced management remain modal. */
  presentation?: 'page';
  opened?(): Promise<void>;
  closed?(): Promise<void>;
  enableTimeline?: boolean;
  buildForChannels?(signal: AbortSignal): Promise<AutomaticGuideBuildResult>;
  discover?(signal: AbortSignal): Promise<GuideDiscoveryResult>;
  selectedChannel(): GuideCatalogChannel | null;
  channels?(): readonly GuideCatalogChannel[];
  now(): number;
  formatTime(milliseconds: number): string;
  sources(signal: AbortSignal): Promise<GuideSource[]>;
  mappings(signal: AbortSignal): Promise<GuideMapping[]>;
  query(query: ProgramQuery, signal: AbortSignal): Promise<ProgramPage>;
  guideChannels(
    query: {
      guideSourceId: string;
      search: string;
      afterId: GuideChannelCursor | null;
      pageSize: 50;
    },
    signal: AbortSignal,
  ): Promise<GuideChannelPage>;
  /** New source configuration saves immediately; the schedule remains a reviewed preview. */
  preview(
    input:
      | {
          name: string;
          location: string;
          kind: 'url' | 'file';
          allowHttp: boolean;
        }
      | { sourceId: string },
    signal: AbortSignal,
  ): Promise<GuidePreview>;
  commitPreview(
    ticket: string,
    signal: AbortSignal,
  ): Promise<{ committed: true; matched?: number; unmatched?: number }>;
  discardPreview(ticket: string): Promise<void>;
  removeSource(sourceId: string, signal: AbortSignal): Promise<void>;
  setMapping(mapping: GuideMapping, signal: AbortSignal): Promise<void>;
  /** Explicit Map only; saved reports the durable mapping before schedule work. */
  mapAndHydrate?(
    mapping: GuideMapping,
    signal: AbortSignal,
    saved: () => void,
  ): Promise<MappedGuideHydrationResult>;
  /** Join after actionWork; failed native cleanup prevents successful close. */
  settleMappingHydration?(): Promise<void>;
  coverage?(sourceId: string, signal: AbortSignal): Promise<GuideCoverage>;
  channelCoverage?(
    query: ChannelCoverageRequest,
    signal: AbortSignal,
  ): Promise<ChannelCoverageReply>;
  pickFile?(signal: AbortSignal): Promise<{ name: string; location: string } | null>;
  watch(channel: GuideCatalogChannel, signal: AbortSignal): Promise<void>;
  summary?(query: SelectedGuideQuery, signal: AbortSignal): Promise<SelectedGuideSummary>;
  catalogRevision?(): string | null;
  cancelSummary?(requestId: string): Promise<unknown>;
  summaryClock?: SelectedGuideClock;
}

export const identity = (program: {
  startMs: number;
  stopMs: number | null;
  title: string;
  description?: string | null;
  categories?: readonly GuideCategory[];
}) =>
  JSON.stringify([
    program.startMs,
    program.stopMs,
    program.title,
    program.description ?? null,
    guideCategoryKey(program.categories),
  ]);
