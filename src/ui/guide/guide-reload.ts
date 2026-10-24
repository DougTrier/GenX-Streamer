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

import { SEARCH_WEEK_MS } from '../../search/catalog-search';
import {
  validateChannelCoverageReply,
  type ChannelCoverageReply,
  type ChannelCoverageRequest,
} from '../../guide/channel-coverage';
import {
  ChannelCoverageCleanupError,
  type GuideChannelCursor,
  type GuideCursor,
  type GuideSource,
  type MappedProgram,
} from '../../guide/native';
import { describeChannelCoverage } from '../../guide/coverage-presentation';
import { queryGuide, type GuideProgram } from '../../guide/query';
import { type createGuidePresentation } from './guide-presentation';
import { type TimelineChannel } from './guide-timeline-model';
import { identity, type GuideCatalogChannel, type GuideHost } from './guide-model';

/** What this part reads from, and writes back to, mountGuide. */
export interface GuideReloadEnvironment {
  readonly disposed: boolean;
  readonly suspending: boolean;
  readonly foreground: boolean;
  readonly dialog: HTMLDialogElement;
  cursor: GuideCursor | null;
  pageAnchor: {
    signature: string;
    instant: number;
    start: number;
    end: number;
    mapping: string;
  } | null;
  readonly syncSummary: (force?: boolean) => Promise<void>;
  readonly error: HTMLElement;
  readonly programView: string;
  readonly chosen: () => GuideCatalogChannel | null;
  readonly host: GuideHost;
  readonly day: number;
  readonly programSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly searchSource: HTMLSelectElement;
  viewController: AbortController | null;
  viewEpoch: number;
  viewWork: Promise<void>;
  readonly timeline: {
    refresh(): Promise<void>;
    refreshArtwork: () => void;
    closeDetails: () => boolean;
    setForeground(value: boolean): Promise<void>;
    suspend: () => Promise<void>;
    dispose(): Promise<void>;
  } | null;
  sources: GuideSource[];
  readonly mapEmpty: HTMLButtonElement;
  readonly advancedMode: boolean;
  readonly mappingPanel: HTMLElement;
  readonly renderSources: () => void;
  readonly renderChannels: () => void;
  readonly timelinePanel: HTMLElement;
  timelineChannels: readonly TimelineChannel[];
  readonly title: HTMLElement;
  readonly status: HTMLElement;
  readonly findEmpty: HTMLButtonElement;
  readonly timingRows: Map<
    HTMLButtonElement,
    {
      program: MappedProgram;
      channel: GuideCatalogChannel;
      conflict: boolean;
      snapshot: number;
      live: boolean;
    }
  >;
  readonly rows: HTMLUListElement;
  nextCursor: GuideCursor | null;
  readonly renderComplete: () => void;
  readonly freshness: HTMLElement;
  readonly programsPanel: HTMLElement;
  readonly setView: (target: string) => void;
  readonly text: (tag: string, value: string) => HTMLElement;
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  readonly timingLabel: (
    program: MappedProgram,
    channel: GuideCatalogChannel,
    conflict: boolean,
    instant: number,
    live: boolean,
  ) => string;
  readonly controls: () => void;
  readonly detail: HTMLElement;
  readonly eligibleDetail: () => boolean;
  readonly updateDetail: () => void;
  readonly run: ReturnType<typeof createGuidePresentation>['run'];
  detailState: {
    program: MappedProgram;
    channel: GuideCatalogChannel;
    action: HTMLButtonElement;
    message: HTMLElement;
    wasVisible: boolean;
  } | null;
  lastProgramFocus: HTMLElement | null;
  readonly back: HTMLButtonElement;
  readonly mapSource: HTMLSelectElement;
  lookupController: AbortController | null;
  lookupEpoch: number;
  readonly mapSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly afterId: GuideChannelCursor | null;
  lookupWork: Promise<void>;
  readonly mapChannel: HTMLSelectElement;
  nextId: GuideChannelCursor | null;
  readonly mapStatus: HTMLElement;
}

/**
 * Loading the guide's data: reloading sources and listings, program details
 * and channel lookup. Part of mountGuide.
 */
export function createGuideReload(env: GuideReloadEnvironment) {
  function reload(continuation = false): void {
    if (env.disposed || env.suspending || !env.foreground || !env.dialog.open) return;
    if (!continuation) {
      env.cursor = null;
      env.pageAnchor = null;
    }
    void env.syncSummary(!continuation).catch(() => {
      if (!env.disposed)
        env.error.textContent =
          'Current / next activity could not settle. Retry Now or close Guide.';
    });
    const captured = {
      searching: env.programView === 'search',
      channel: structuredClone(env.chosen()),
      fallbackChannel: structuredClone(env.host.channels?.()[0] ?? null),
      day: env.day,
      search: env.programSearch.field.value,
      searchSource: env.searchSource.value,
      cursor: structuredClone(env.cursor),
      anchor: env.pageAnchor,
      instant: env.host.now(),
    };
    const signature = JSON.stringify([
      captured.searching,
      captured.channel?.sourceId ?? null,
      captured.channel?.id ?? null,
      captured.day,
      captured.search,
      captured.searchSource,
    ]);
    env.viewController?.abort();
    const epoch = ++env.viewEpoch;
    const controller = new AbortController();
    env.viewController = controller;
    env.viewWork = env.viewWork
      .catch(() => {})
      .then(async () => {
        if (epoch !== env.viewEpoch || env.disposed || controller.signal.aborted) return;
        try {
          await env.timeline?.suspend();
          if (epoch !== env.viewEpoch || env.disposed || controller.signal.aborted) return;
          const fetched = await Promise.allSettled([
            env.host.sources(controller.signal),
            env.host.mappings(controller.signal),
          ]);
          if (fetched[0].status !== 'fulfilled' || fetched[1].status !== 'fulfilled')
            throw new Error('Guide configuration unavailable');
          if (epoch !== env.viewEpoch || env.disposed || controller.signal.aborted) return;
          env.sources = fetched[0].value;
          const allMappings = fetched[1].value;
          const selected = env.chosen();
          env.mapEmpty.hidden =
            env.advancedMode ||
            !selected ||
            !env.mappingPanel.hidden ||
            allMappings.some(
              (mapping) =>
                mapping.catalogSourceId === selected.sourceId &&
                mapping.appChannelId === selected.id &&
                env.sources.some((source) => source.id === mapping.guideSourceId),
            );
          env.renderSources();
          env.renderChannels();
          if (env.timeline && !env.timelinePanel.hidden) {
            // Links indexed once by channel: filtering every link for each of
            // ~9,000 channels took about 2 s on the Sansui TV per opening
            // (October 19, 2026). Same result: exactly one usable link counts.
            const revisions = new Map(env.sources.map((source) => [source.id, source.revision]));
            const links = new Map<string, (typeof allMappings)[number][]>();
            for (const entry of allMappings) {
              if (!revisions.has(entry.guideSourceId)) continue;
              const key = JSON.stringify([entry.catalogSourceId, entry.appChannelId]);
              const list = links.get(key);
              if (list) list.push(entry);
              else links.set(key, [entry]);
            }
            env.timelineChannels = (env.host.channels?.() ?? []).map((channel) => {
              const matches = links.get(JSON.stringify([channel.sourceId, channel.id])) ?? [];
              const mapping = matches.length === 1 ? matches[0] : null;
              return {
                ...channel,
                guideSourceId: mapping?.guideSourceId ?? null,
                xmltvChannelId: mapping?.xmltvChannelId ?? null,
                ...(mapping ? { guideRevision: revisions.get(mapping.guideSourceId)! } : {}),
              };
            });
            env.title.textContent = 'Program guide';
            const connected = env.timelineChannels.filter(
              (channel) => channel.guideSourceId !== null,
            ).length;
            const connectionStatus = connected
              ? `${connected} of ${env.timelineChannels.length} channels linked to program guides. Links do not confirm available schedules.`
              : 'No program guide connected yet.';
            env.status.textContent = env.host.listedChannels
              ? 'Checking saved listings…'
              : env.dialog.classList.contains('guide-compact-page')
                ? `${connected} of ${env.timelineChannels.length} linked`
                : connectionStatus;
            env.status.title = env.host.listedChannels ? env.status.textContent : connectionStatus;
            env.status.setAttribute('aria-label', env.status.title);
            env.findEmpty.hidden = !env.host.discover && !env.host.buildForChannels;
            await env.timeline.setForeground(true);
            return;
          }
          const searching = captured.searching;
          const channel = captured.channel ?? (searching ? captured.fallbackChannel : null);
          env.timingRows.clear();
          env.rows.replaceChildren();
          env.nextCursor = null;
          env.renderComplete();
          env.freshness.textContent = '';
          if (!env.sources.length) {
            env.status.textContent = 'No program guide saved yet.';
            env.findEmpty.hidden =
              (!env.host.discover && !env.host.buildForChannels) ||
              env.advancedMode ||
              (env.programsPanel.hidden && env.mappingPanel.hidden);
            return;
          }
          if (!channel) {
            env.status.textContent = 'Choose a channel to browse its guide.';
            return;
          }
          env.title.textContent = searching ? 'Program search' : `${channel.name} · Program guide`;
          const mappings = fetched[1].value.filter(
            (mapping) =>
              mapping.catalogSourceId === channel.sourceId && mapping.appChannelId === channel.id,
          );
          if (!searching && mappings.length !== 1) {
            env.status.textContent = mappings.length
              ? 'Channel mapping is ambiguous. Review its guide source.'
              : 'No program guide is connected to this channel yet.';
            if (env.advancedMode && !env.programsPanel.hidden) env.setView('mapping');
            else
              env.findEmpty.hidden =
                (!env.host.discover && !env.host.buildForChannels) ||
                (env.programsPanel.hidden && env.mappingPanel.hidden);
            return;
          }
          const mapping =
            mappings[0] ??
            allMappings.find((entry) =>
              env.sources.some((source) => source.id === entry.guideSourceId),
            );
          if (!mapping) {
            env.status.textContent =
              'No guide channels mapped. Map a catalog channel before searching programs.';
            if (env.advancedMode && !env.programsPanel.hidden) env.setView('mapping');
            else
              env.findEmpty.hidden =
                (!env.host.discover && !env.host.buildForChannels) ||
                (env.programsPanel.hidden && env.mappingPanel.hidden);
            return;
          }
          const source = env.sources.find((source) => source.id === mapping.guideSourceId);
          if (!source) {
            env.status.textContent = 'Mapped guide source is unavailable. Mapping retained.';
            return;
          }
          const mappingKey = JSON.stringify([
            mapping.catalogSourceId,
            mapping.appChannelId,
            mapping.guideSourceId,
            mapping.xmltvChannelId,
          ]);
          if (
            captured.cursor &&
            (!captured.anchor ||
              captured.anchor.signature !== signature ||
              captured.anchor.mapping !== mappingKey)
          )
            throw new Error('Guide query changed. Return to First programs before continuing.');
          const instant = captured.cursor ? captured.anchor!.instant : captured.instant;
          const start = captured.cursor
            ? captured.anchor!.start
            : instant + captured.day * 24 * 60 * 60 * 1000;
          const end = captured.cursor
            ? captured.anchor!.end
            : searching
              ? instant + SEARCH_WEEK_MS
              : Math.min(start + 24 * 60 * 60 * 1000, instant + SEARCH_WEEK_MS);
          if (!captured.cursor)
            env.pageAnchor = {
              signature,
              instant,
              start,
              end,
              mapping: mappingKey,
            };
          env.status.textContent = `Schedule: ${env.host.formatTime(start)} – ${env.host.formatTime(end)}`;
          const response = await env.host.query(
            {
              guideSourceId: searching ? captured.searchSource : mapping.guideSourceId,
              appChannelIds: searching ? [] : [channel.id],
              windowStartMs: start,
              windowEndMs: end,
              ...(!searching && captured.day === 0 && !captured.search.trim()
                ? { contextAtMs: instant }
                : {}),
              search: captured.search,
              pageSize: 50,
              cursor: captured.cursor,
            },
            controller.signal,
          );
          if (
            response.programs.length > 50 ||
            response.programs.some(
              (program) =>
                !allMappings.some(
                  (entry) =>
                    entry.catalogSourceId === program.catalogSourceId &&
                    entry.appChannelId === program.appChannelId &&
                    entry.guideSourceId === program.guideSourceId &&
                    env.sources.some((source) => source.id === entry.guideSourceId) &&
                    (!searching ||
                      !captured.searchSource ||
                      entry.guideSourceId === captured.searchSource) &&
                    entry.xmltvChannelId === program.xmltvChannelId &&
                    (searching ||
                      (entry.appChannelId === channel.id &&
                        entry.catalogSourceId === channel.sourceId)),
                ),
            )
          )
            throw new Error('Guide query ownership mismatch');
          const coverage =
            !searching && env.host.coverage
              ? await env.host.coverage(source.id, controller.signal)
              : null;
          let channelCoverage: ChannelCoverageReply | null = null;
          if (!searching && env.host.channelCoverage) {
            const coverageQuery: ChannelCoverageRequest = {
              schemaVersion: 1,
              sourceId: source.id,
              xmltvChannelId: mapping.xmltvChannelId,
              startMs: start,
              endMs: end,
              expectedSourceRevision: source.revision,
              expectedPublishedRevision: source.revision,
            };
            try {
              channelCoverage = validateChannelCoverageReply(
                await env.host.channelCoverage(coverageQuery, controller.signal),
                coverageQuery,
              );
            } catch (failure) {
              if (failure instanceof ChannelCoverageCleanupError) throw failure;
              // Coverage is observational; unavailable assessment must not hide saved listings.
            }
          }
          if (epoch !== env.viewEpoch || env.disposed || controller.signal.aborted) return;
          env.nextCursor = response.nextCursor;
          const updated = coverage?.updatedMs ?? source.updatedMs;
          const age =
            coverage && coverage.publishedRevision !== source.revision
              ? 'Stale guide: source configuration changed'
              : updated === null || updated > instant
                ? 'Update time unknown'
                : instant - updated > 24 * 60 * 60 * 1000
                  ? 'Stale guide'
                  : 'Guide updated';
          const bounds =
            coverage?.startMs !== null && coverage?.startMs !== undefined && coverage.endMs !== null
              ? coverage.startMs <= start && coverage.endMs >= end
                ? 'Feed time range spans this window'
                : 'Feed time range does not span this window'
              : 'Feed time range unknown';
          const channelBounds = channelCoverage
            ? describeChannelCoverage(channelCoverage, (instant) => env.host.formatTime(instant))
            : 'Channel schedule coverage not assessed. Listings do not confirm stream availability.';
          env.freshness.textContent = `${age}${updated !== null ? ` · ${env.host.formatTime(updated)}` : ''} · ${bounds}. ${channelBounds}`;
          if (searching)
            env.freshness.textContent = `${captured.searchSource ? 'Searching the selected guide' : 'Searching all configured guides'}. Feed freshness and time coverage may differ; a seven-day search does not guarantee complete listings or stream availability.`;
          const programs: GuideProgram[] = response.programs.map((program) => ({
            guideSourceId: program.guideSourceId,
            channelId: program.xmltvChannelId,
            startMs: program.startMs,
            stopMs: program.stopMs,
            title: program.title,
            ...(program.description !== null ? { description: program.description } : {}),
            ...(program.categories ? { categories: program.categories } : {}),
          }));
          const summary = queryGuide(programs, {
            guideSourceId: source.id,
            channelId: mapping.xmltvChannelId,
            nowMs: instant,
            windowStartMs: start,
            windowEndMs: end,
          });
          const conflicts = new Set(summary.conflicts.map(identity));
          env.renderComplete();
          if (!programs.length) env.rows.append(env.text('li', 'No schedule for this period.'));
          for (const [index, program] of programs.entries()) {
            const mapped = response.programs[index];
            const owner = (env.host.channels?.() ?? [channel]).find(
              (entry) =>
                entry.id === mapped.appChannelId && entry.sourceId === mapped.catalogSourceId,
            );
            if (!owner) continue;
            const conflict = searching
              ? queryGuide(programs, {
                  guideSourceId: program.guideSourceId,
                  channelId: program.channelId,
                  nowMs: instant,
                  windowStartMs: start,
                  windowEndMs: end,
                }).conflicts.some((entry) => identity(entry) === identity(program))
              : conflicts.has(identity(program));
            const item = document.createElement('li');
            const control = env.button('', () => showDetail(mapped, owner, conflict));
            env.timingRows.set(control, {
              program: mapped,
              channel: owner,
              conflict,
              snapshot: instant,
              live: !searching && captured.day === 0 && !captured.cursor,
            });
            control.textContent = env.timingLabel(
              mapped,
              owner,
              conflict,
              instant,
              !searching && captured.day === 0 && !captured.cursor,
            );
            item.append(control);
            env.rows.append(item);
          }
          env.error.textContent = '';
        } catch (failure) {
          if (failure instanceof ChannelCoverageCleanupError) throw failure;
          if (!env.disposed && epoch === env.viewEpoch && !controller.signal.aborted) {
            env.error.textContent =
              'Guide could not load. Retry Now or review the source and mapping; previous saved data is retained.';
          }
        } finally {
          if (!env.disposed && epoch === env.viewEpoch) env.controls();
        }
      });
    void env.viewWork.catch(() => {
      if (!env.disposed)
        env.error.textContent = 'Guide cleanup could not be confirmed. Retry closing.';
    });
  }
  function showDetail(
    program: MappedProgram,
    channel: GuideCatalogChannel,
    _conflict: boolean,
  ): void {
    env.detail.replaceChildren(
      env.text('h3', program.title),
      env.text('p', program.description ?? 'No description supplied.'),
      env.text(
        'p',
        `${env.host.formatTime(program.startMs)} – ${program.stopMs === null ? 'End unknown' : env.host.formatTime(program.stopMs)}`,
      ),
    );
    const message = env.text('p', '');
    const action = env.button('Watch channel', () => {
      if (!env.eligibleDetail()) {
        env.updateDetail();
        return;
      }
      env.run((signal) => {
        if (!env.eligibleDetail()) throw new Error('Current listing changed.');
        return env.host.watch(channel, signal);
      });
    });
    env.detailState = { program, channel, action, message, wasVisible: false };
    env.detail.append(message, action);
    env.updateDetail();
    env.lastProgramFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    env.setView('detail');
    env.back.focus();
  }
  function lookupChannels(): void {
    if (env.disposed || env.suspending || !env.foreground || !env.mapSource.value) return;
    env.lookupController?.abort();
    const epoch = ++env.lookupEpoch;
    const controller = new AbortController();
    env.lookupController = controller;
    const sourceId = env.mapSource.value;
    const search = env.mapSearch.field.value;
    const after = env.afterId;
    env.lookupWork = env.lookupWork
      .catch(() => {})
      .then(async () => {
        if (env.disposed || epoch !== env.lookupEpoch || controller.signal.aborted) return;
        try {
          const page = await env.host.guideChannels(
            { guideSourceId: sourceId, search, afterId: after, pageSize: 50 },
            controller.signal,
          );
          if (page.channels.length > 50) throw new Error('Guide channel page limit');
          if (
            env.disposed ||
            epoch !== env.lookupEpoch ||
            controller.signal.aborted ||
            env.mapSource.value !== sourceId
          )
            return;
          env.mapChannel.replaceChildren();
          for (const channel of page.channels) {
            const option = document.createElement('option');
            option.value = channel.id;
            option.textContent = channel.names.join(' · ') || channel.id;
            env.mapChannel.append(option);
          }
          env.nextId = page.nextCursor;
          env.mapStatus.textContent = page.channels.length
            ? `${page.channels.length} guide channels shown${page.nextCursor ? '; more available' : ''}. Match the station and region before saving.`
            : 'No matching schedule found in this guide. Try the station name or another guide source.';
        } catch {
          if (!env.disposed && !controller.signal.aborted)
            env.mapStatus.textContent =
              'Guide channels unavailable. Refresh this source or choose another.';
        } finally {
          env.controls();
        }
      });
  }
  return {
    reload,
    lookupChannels,
  };
}
