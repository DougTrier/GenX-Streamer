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

import { GUIDE_GROUPING_POLICY } from '../../guide/listed-channels';
import { type ProgramPage, type ProgramQuery } from '../../guide/native';
import { type createTimelineDetails } from './guide-timeline-details';
import {
  HALF,
  MAX_CELLS,
  MAX_ROWS,
  WEEK,
  WINDOW,
  aborted,
  cellBounds,
  channelKey,
  clusterListings,
  savedChannelKey,
  timelineProgramKey,
  type Listed,
  type ListedCache,
  type TimelineChannel,
  type TimelineHost,
} from './guide-timeline-model';

/** Listing pages kept for reuse while scrolling (each at most 50 programmes). */
const PROGRAM_PAGES = 600;

/** What this part reads from, and writes back to, mountGuideTimeline. */
export interface TimelineRefreshEnvironment {
  readonly closed: boolean;
  readonly foreground: boolean;
  readonly invalidate: () => void;
  refreshWanted: boolean;
  active: Promise<void> | null;
  readonly drain: () => Promise<void>;
  readonly generation: number;
  controller: AbortController | null;
  readonly host: TimelineHost;
  readonly from: number;
  readonly listingScope: (channels: readonly TimelineChannel[]) => string;
  listedCache: ListedCache | null;
  readonly search: string;
  readonly channelCards: Map<HTMLButtonElement, TimelineChannel>;
  readonly agendaHeader: HTMLDivElement;
  readonly doc: Document;
  readonly now: HTMLButtonElement;
  readonly content: HTMLDivElement;
  readonly status: HTMLParagraphElement;
  readonly root: HTMLElement;
  readonly axis: HTMLDivElement;
  readonly navigationState: () => void;
  readonly launch: (job: Promise<void>) => Promise<void>;
  cleanupError: unknown;
  readonly report: () => void;
  readonly visibleChannels: () => readonly TimelineChannel[];
  readonly agendaLimit: () => number;
  agendaMode: boolean;
  readonly times: HTMLDivElement;
  readonly back: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly previousDay: HTMLButtonElement;
  readonly nextDay: HTMLButtonElement;
  agendaCompact: boolean;
  readonly controlsToggle: HTMLButtonElement;
  readonly toolbar: HTMLElement;
  readonly agendaControlsOpen: boolean;
  readonly viewport: HTMLDivElement;
  agendaRevision: string | null;
  agendaCursor: ProgramQuery['cursor'];
  agendaChannelKey: string | null;
  readonly rowFocus: { key: string; column: number } | null;
  agendaProgramFocus: string | null;
  readonly agendaChannel: () => TimelineChannel | undefined;
  agendaScope: string | null;
  readonly emptyCategoryStatus: () => string;
  rowHeight: number;
  readonly measuredRowHeight: () => number;
  renderedLimit: number;
  readonly viewportRowLimit: () => number;
  readonly OVERSCAN: number;
  renderedViewportHeight: number;
  renderedStart: number;
  renderedCount: number;
  renderedTotal: number;
  readonly browseChannel: HTMLButtonElement;
  readonly channelCard: (card: HTMLButtonElement, channel: TimelineChannel, label?: string) => void;
  readonly watchChannel: HTMLButtonElement;
  readonly previousChannel: HTMLButtonElement;
  readonly nextChannel: HTMLButtonElement;
  readonly currentChannel: (channel: TimelineChannel) => boolean;
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  readonly selectCell: (cell: HTMLButtonElement) => void;
  readonly showDetail: ReturnType<typeof createTimelineDetails>['showDetail'];
  readonly programMatches: (program: {
    title: string;
    description?: string | null;
    categories?: readonly { text: string }[];
  }) => boolean;
  readonly showEmptyDetail: ReturnType<typeof createTimelineDetails>['showEmptyDetail'];
  agendaFocusFirst: boolean;
  readonly visibleArtwork: () => void;
  readonly restoreRowFocus: () => void;
  readonly clock: () => void;
  readonly readLimit: <T>(task: () => Promise<T>) => Promise<T>;
  readonly programPages: Map<string, ProgramPage>;
  readonly showChooser: ReturnType<typeof createTimelineDetails>['showChooser'];
}

/**
 * Drawing the timeline guide: the visible window of channels and programs,
 * re-drawn as the guide scrolls or its data changes. Part of
 * mountGuideTimeline.
 */
export function createTimelineRefresh(env: TimelineRefreshEnvironment) {
  function refresh(): Promise<void> {
    if (env.closed || !env.foreground) return Promise.resolve();
    env.invalidate();
    env.refreshWanted = true;
    if (env.active) return env.active;
    const task = (async () => {
      while (env.refreshWanted && !env.closed && env.foreground) {
        env.refreshWanted = false;
        await env.drain();
        if (env.closed || !env.foreground) break;
        const mine = env.generation,
          abort = new AbortController();
        env.controller = abort;
        const revision = env.host.catalogRevision(),
          anchor = env.from;
        const valid = () =>
          !env.closed &&
          env.foreground &&
          !abort.signal.aborted &&
          mine === env.generation &&
          revision === env.host.catalogRevision();
        if (env.host.listedChannels) {
          const inventory = env.host.channels();
          const signature = env.listingScope(inventory);
          if (
            !env.listedCache ||
            env.listedCache.anchor !== anchor ||
            env.listedCache.search !== env.search ||
            env.listedCache.catalogRevision !== revision ||
            env.listedCache.signature !== signature
          ) {
            env.listedCache = null;
            env.channelCards.clear();
            if (env.agendaHeader.contains(env.doc.activeElement))
              env.now.focus({ preventScroll: true });
            env.agendaHeader.hidden = true;
            env.content.style.height = '0px';
            delete env.status.dataset.state;
            env.status.textContent = 'Checking saved listings…';
            env.host.listedCount?.(null, anchor, anchor + WINDOW);
            env.root.insertBefore(env.status, env.axis);
            env.navigationState();
            let membership: Listed | undefined;
            const searched = env.search;
            try {
              await env.launch(
                (async () => {
                  membership = searched
                    ? await env.host.listedChannels!(anchor, anchor + WEEK, abort.signal, searched)
                    : await env.host.listedChannels!(anchor, anchor + WINDOW, abort.signal);
                })(),
              );
              if (searched !== env.search) continue;
              if (!valid()) continue;
              if (
                !membership ||
                membership.catalogRevision !== revision ||
                !Number.isSafeInteger(membership.databaseRevision) ||
                membership.databaseRevision < 0 ||
                !Array.isArray(membership.channels) ||
                membership.channels.length > 100000 ||
                signature !== env.listingScope(env.host.channels())
              )
                throw new Error('Guide listing scope changed.');
              const grouped = membership.groupingPolicy !== undefined;
              if (
                grouped &&
                (membership.groupingPolicy !== GUIDE_GROUPING_POLICY ||
                  typeof membership.viewRevision !== 'string' ||
                  !/^(0|[1-9]\d{0,18})$/.test(membership.viewRevision) ||
                  BigInt(membership.viewRevision) > 9223372036854775807n)
              )
                throw new Error('Guide grouping policy invalid.');
              const members = new Map<string, Listed['channels'][number]>();
              for (const member of membership.channels) {
                if (
                  !member ||
                  [
                    member.catalogSourceId,
                    member.appChannelId,
                    member.guideSourceId,
                    member.xmltvChannelId,
                  ].some((value) => typeof value !== 'string' || !value.length) ||
                  !Number.isSafeInteger(member.sourceRevision) ||
                  member.sourceRevision < 1 ||
                  (grouped &&
                    (!Number.isInteger(member.filterMask) ||
                      member.filterMask! < 0 ||
                      member.filterMask! > 7))
                )
                  throw new Error('Guide listing scope invalid.');
                const key = JSON.stringify([member.catalogSourceId, member.appChannelId]);
                if (members.has(key)) throw new Error('Guide listing scope duplicated.');
                members.set(key, member);
              }
              for (const channel of inventory) {
                const member = members.get(savedChannelKey(channel));
                if (
                  member &&
                  (member.guideSourceId !== channel.guideSourceId ||
                    member.xmltvChannelId !== channel.xmltvChannelId ||
                    (channel.guideRevision !== undefined &&
                      member.sourceRevision !== channel.guideRevision) ||
                    (grouped && (member.filterMask! & 1) !== Number(channel.favorite === true)))
                )
                  throw new Error('Guide listing mapping changed.');
              }
              env.listedCache = {
                anchor,
                catalogRevision: revision,
                signature,
                databaseRevision: membership.databaseRevision,
                grouped,
                search: searched,
                channels: members,
              };
            } catch (error) {
              if (abort.signal.aborted && !aborted(error)) {
                env.cleanupError = error;
                throw error;
              }
              if (valid()) {
                env.host.listedCount?.(null, anchor, anchor + WINDOW, true);
                env.report();
              }
              continue;
            }
          }
        }
        const channels = env.visibleChannels();
        if (env.host.listedChannels)
          env.host.listedCount?.(channels.length, anchor, anchor + WINDOW);
        const nextAgendaMode = env.root.clientWidth <= env.agendaLimit();
        if (nextAgendaMode !== env.agendaMode) {
          const focused = env.doc.activeElement;
          env.times.replaceChildren(
            ...(nextAgendaMode
              ? [env.back, env.now, env.next, env.previousDay, env.nextDay]
              : [env.previousDay, env.back, env.now, env.next, env.nextDay]),
          );
          if (focused instanceof HTMLElement && env.times.contains(focused))
            focused.focus({ preventScroll: true });
        }
        env.agendaMode = nextAgendaMode;
        env.agendaCompact =
          env.agendaMode &&
          ((env.doc.defaultView?.visualViewport?.height ??
            env.doc.defaultView?.innerHeight ??
            1000) < 500 ||
            (env.host.channelActivate !== undefined &&
              env.root.clientWidth <= 420 &&
              parseFloat(getComputedStyle(env.root).fontSize) >= 24));
        env.controlsToggle.hidden = !env.agendaCompact;
        env.toolbar.hidden = env.agendaCompact && !env.agendaControlsOpen;
        env.controlsToggle.setAttribute(
          'aria-expanded',
          String(env.agendaCompact && env.agendaControlsOpen),
        );
        env.root.dataset.layout = env.agendaMode ? 'agenda' : 'timeline';
        env.root.dataset.agendaCompact = String(env.agendaCompact);
        env.axis.hidden = env.agendaMode;
        env.agendaHeader.hidden =
          !env.agendaMode || (!!env.host.listedChannels && channels.length === 0);
        env.viewport.setAttribute(
          'aria-label',
          env.agendaMode ? 'Channel programme agenda' : 'Guide channel rows',
        );
        if (env.agendaMode && env.agendaRevision !== revision) {
          env.agendaCursor = null;
          env.agendaRevision = revision;
        }
        if (env.agendaMode && !channels.some((c) => savedChannelKey(c) === env.agendaChannelKey)) {
          const remembered = channels.find((c) => channelKey(c) === env.rowFocus?.key);
          env.agendaChannelKey = remembered
            ? savedChannelKey(remembered)
            : channels[0]
              ? savedChannelKey(channels[0])
              : null;
          env.agendaCursor = null;
          env.agendaProgramFocus = null;
        }
        if (env.agendaMode) {
          const selected = env.agendaChannel();
          const scope = selected ? channelKey(selected) : null;
          if (env.agendaScope !== scope) {
            env.agendaScope = scope;
            env.agendaCursor = null;
            env.agendaProgramFocus = null;
          }
        }
        env.navigationState();
        // Keep the axis/status in their final slots before measuring. Compact TV
        // removes a ready status from flow, so measure that settled geometry rather
        // than the loading line that will disappear after every completed query.
        const readyStatus = channels.length
          ? `${env.host.formatAxisTime?.(anchor) ?? env.host.formatTime(anchor)}`
          : env.emptyCategoryStatus();
        delete env.status.dataset.state;
        env.status.textContent = 'Loading visible listings…';
        if (!env.agendaMode) env.root.insertBefore(env.status, env.axis);
        env.axis.replaceChildren();
        for (let i = 0; i < 6; i++) {
          const tick = env.doc.createElement('span');
          tick.textContent =
            env.host.formatAxisTime?.(anchor + i * HALF) ?? env.host.formatTime(anchor + i * HALF);
          tick.title = env.host.formatTime(anchor + i * HALF);
          env.axis.append(tick);
        }
        env.rowHeight = env.measuredRowHeight();
        env.root.style.setProperty('--gx-row-height', `${env.rowHeight}px`);
        env.viewport.style.maxHeight = `${(MAX_ROWS - 1) * env.rowHeight}px`;
        if (!env.agendaMode) {
          env.status.textContent = readyStatus;
          env.status.dataset.state = 'ready';
        }
        env.renderedLimit = env.agendaMode
          ? env.viewportRowLimit()
          : Math.min(MAX_ROWS, env.viewportRowLimit() + 2 * env.OVERSCAN);
        env.renderedViewportHeight = env.viewport.clientHeight;
        // Restore truthful pending feedback synchronously before any asynchronous
        // work. ResizeObserver already ignores loading-only viewport height changes.
        delete env.status.dataset.state;
        env.status.textContent = 'Loading visible listings…';
        const top = Math.min(
            Math.floor(env.viewport.scrollTop / env.rowHeight),
            Math.max(0, channels.length - 1),
          ),
          // Overscan never pushes a visible row out of the bounded rendered range.
          start = env.agendaMode
            ? top
            : Math.max(0, top - env.OVERSCAN, top + env.viewportRowLimit() - env.renderedLimit),
          visible = channels.slice(start, start + env.renderedLimit).map((c) => ({ ...c }));
        env.renderedStart = start;
        env.renderedCount = visible.length;
        env.renderedTotal = channels.length;
        env.channelCards.clear();
        env.content.replaceChildren();
        env.content.style.height = env.agendaMode ? 'auto' : `${channels.length * env.rowHeight}px`;
        if (env.agendaMode) env.content.append(env.status);
        const job = (async () => {
          if (env.agendaMode) {
            const channel = env.agendaChannel();
            env.browseChannel.textContent = channel?.name ?? 'No channels in this category';
            env.browseChannel.setAttribute(
              'aria-label',
              channel ? `Browse guide channel: ${channel.name}` : 'No channels in this category',
            );
            env.browseChannel.title = channel?.name ?? '';
            if (channel)
              env.channelCard(env.browseChannel, channel, `Browse guide channel: ${channel.name}`);
            env.browseChannel.disabled = !channel;
            env.watchChannel.disabled = !channel || !env.host.channelActivate;
            env.watchChannel.setAttribute(
              'aria-label',
              channel ? `Watch channel: ${channel.name}` : 'Watch channel',
            );
            env.watchChannel.title = channel ? `Watch channel: ${channel.name}` : 'Watch channel';
            const channelIndex = channel
              ? channels.findIndex((c) => channelKey(c) === channelKey(channel))
              : -1;
            env.previousChannel.disabled = channelIndex <= 0;
            env.nextChannel.disabled = channelIndex < 0 || channelIndex >= channels.length - 1;
            if (!channel) {
              env.status.textContent = env.emptyCategoryStatus();
              env.status.dataset.state = 'ready';
              return;
            }
            const page =
              channel.guideSourceId && channel.xmltvChannelId
                ? await env.host.query(
                    {
                      guideSourceId: channel.guideSourceId,
                      appChannelIds: [channel.id],
                      windowStartMs: anchor,
                      windowEndMs: anchor + WINDOW,
                      search: '',
                      pageSize: 50,
                      cursor: env.agendaCursor,
                      contextAtMs: anchor,
                    },
                    abort.signal,
                  )
                : null;
            if (!valid() || !env.currentChannel(channel)) return;
            if (
              page &&
              (page.programs.length > 50 ||
                (env.host.listedChannels &&
                  page.databaseRevision !== env.listedCache?.databaseRevision) ||
                (channel.guideRevision !== undefined &&
                  page.sourceRevision !== channel.guideRevision) ||
                page.programs.some(
                  (p) =>
                    p.appChannelId !== channel.id ||
                    p.catalogSourceId !== channel.sourceId ||
                    p.guideSourceId !== channel.guideSourceId ||
                    p.xmltvChannelId !== channel.xmltvChannelId,
                ))
            )
              throw new Error('Guide scope mismatch.');
            for (const program of page?.programs ?? [])
              cellBounds(program.startMs, program.stopMs, anchor);
            const programs = [...(page?.programs ?? [])]
              .filter(
                (p) => p.startMs < anchor + WINDOW && (p.stopMs === null || p.stopMs > anchor),
              )
              .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
            for (const program of programs) {
              const key = timelineProgramKey(program);
              const cell = env.button(program.title, () => {
                if (!valid() || !env.currentChannel(channel)) return;
                env.selectCell(cell);
                const job = env.showDetail(channel, program, cell, revision, mine);
                void env.launch(job).catch(env.report);
              });
              cell.className = 'gx-agenda-listing';
              if (env.programMatches(program)) cell.classList.add('gx-timeline-match');
              cell.dataset.programKey = key;
              cell.setAttribute('aria-label', program.title);
              cell.setAttribute('aria-pressed', 'false');
              cell.title = program.title;
              const title = env.doc.createElement('strong');
              title.textContent = program.title;
              const timing = env.doc.createElement('span');
              timing.className = 'gx-agenda-time';
              timing.id = `gx-agenda-time-${mine}-${program.ordinal}-${env.content.childElementCount}`;
              const absolute = env.doc.createElement('span');
              absolute.className = 'gx-agenda-absolute-time';
              absolute.id = timing.id;
              absolute.textContent = `${env.host.formatTime(program.startMs)}${program.stopMs === null ? ' · End time unknown' : ` – ${env.host.formatTime(program.stopMs)}`}`;
              timing.removeAttribute('id');
              timing.title = absolute.textContent;
              timing.textContent = `${env.host.formatAxisTime?.(program.startMs) ?? env.host.formatTime(program.startMs)}${program.stopMs === null ? ' · End time unknown' : ` – ${env.host.formatAxisTime?.(program.stopMs) ?? env.host.formatTime(program.stopMs)}`}`;
              timing.setAttribute('aria-hidden', 'true');
              cell.setAttribute('aria-describedby', absolute.id);
              cell.replaceChildren(title, timing, absolute);
              if (
                program.stopMs !== null &&
                program.startMs <= env.host.now() &&
                env.host.now() < program.stopMs
              )
                cell.classList.add('gx-timeline-current');
              env.content.append(cell);
            }
            if (!programs.length) {
              const note = env.doc.createElement('p');
              note.className = 'gx-timeline-note';
              note.textContent =
                channel.guideSourceId && channel.xmltvChannelId
                  ? 'No listings for this time'
                  : 'Guide not linked';
              env.content.append(note);
              const inspect = env.button('Schedule details', () => {
                if (valid() && env.currentChannel(channel))
                  void env
                    .launch(env.showEmptyDetail(channel, inspect, revision, mine, anchor))
                    .catch(env.report);
              });
              inspect.className = 'gx-agenda-listing';
              env.content.append(inspect);
            }
            if (env.agendaCursor !== null)
              env.content.append(
                env.button('First listings', () => {
                  if (!valid()) return;
                  env.agendaCursor = null;
                  env.agendaProgramFocus = null;
                  env.agendaFocusFirst = true;
                  env.viewport.scrollTop = 0;
                  void refresh().catch(env.report);
                }),
              );
            if (page?.nextCursor) {
              const cursor = structuredClone(page.nextCursor);
              env.content.append(
                env.button('More listings', () => {
                  if (!valid()) return;
                  env.agendaCursor = cursor;
                  env.agendaProgramFocus = null;
                  env.agendaFocusFirst = true;
                  env.viewport.scrollTop = 0;
                  void refresh().catch(env.report);
                }),
              );
            }
            env.status.textContent = `${programs.length} listings shown for ${channel.name}${page?.nextCursor ? ' · More listings available' : ''}.`;
            env.status.dataset.state = 'ready';
            env.visibleArtwork();
            env.content.append(env.status);
            env.restoreRowFocus();
            env.clock();
            return;
          }
          let count = 0;
          // Rows ask for their listings four at a time, and listings already
          // read are reused: holding Down on the Sansui TV outran one-at-a-time
          // reads that started over at every jump (owner report, October 19,
          // 2026). Rows are still drawn in order, each checked as before.
          const signal = abort.signal;
          let stopped = false;
          const pages = visible.map((channel) =>
            env.readLimit(() => {
              if (stopped || !channel.guideSourceId || !channel.xmltvChannelId)
                return Promise.resolve(null);
              // Reused only for the same window and the same guide data.
              const key = env.host.listedChannels
                ? JSON.stringify([
                    channelKey(channel),
                    anchor,
                    channel.guideRevision ?? null,
                    env.listedCache?.databaseRevision ?? null,
                  ])
                : null;
              const known = key ? env.programPages.get(key) : undefined;
              if (known) {
                env.programPages.delete(key!);
                env.programPages.set(key!, known);
                return Promise.resolve(known);
              }
              signal.throwIfAborted();
              return env.host
                .query(
                  {
                    guideSourceId: channel.guideSourceId,
                    appChannelIds: [channel.id],
                    windowStartMs: anchor,
                    windowEndMs: anchor + WINDOW,
                    contextAtMs: env.host.listedChannels ? undefined : anchor,
                    search: '',
                    pageSize: 50,
                    cursor: null,
                  },
                  signal,
                )
                .then((page) => {
                  if (key) {
                    env.programPages.set(key, page);
                    while (env.programPages.size > PROGRAM_PAGES)
                      env.programPages.delete(env.programPages.keys().next().value!);
                  }
                  return page;
                });
            }),
          );
          // Rows abandoned by a newer refresh must not report failures.
          for (const pending of pages) pending.catch(() => undefined);
          try {
            for (let i = 0; i < visible.length; i++) {
              const channel = visible[i]!;
              const page: ProgramPage | null = await pages[i]!;
              if (!valid() || !env.currentChannel(channel)) return;
              if (
                page &&
                (page.programs.length > 50 ||
                  (env.host.listedChannels &&
                    page.databaseRevision !== env.listedCache?.databaseRevision) ||
                  (channel.guideRevision !== undefined &&
                    page.sourceRevision !== channel.guideRevision) ||
                  page.programs.some(
                    (p) =>
                      p.appChannelId !== channel.id ||
                      p.catalogSourceId !== channel.sourceId ||
                      p.guideSourceId !== channel.guideSourceId ||
                      p.xmltvChannelId !== channel.xmltvChannelId,
                  ))
              )
                throw new Error('Guide scope mismatch.');
              const row = env.doc.createElement('div');
              row.className = 'gx-timeline-row';
              row.dataset.channelKey = channelKey(channel);
              row.style.top = `${(start + i) * env.rowHeight}px`;
              // Alternating bands, so the eye can follow one channel across.
              row.dataset.band = (start + i) % 2 ? 'b' : 'a';
              const label = env.button(channel.name, () => {
                if (!valid() || !env.currentChannel(channel)) return;
                if (env.host.channelActivate) env.host.channelActivate({ ...channel });
                else env.status.textContent = `${channel.name}: choose a listing.`;
              });
              label.className = 'gx-timeline-channel';
              label.title = channel.name;
              env.channelCard(label, channel);
              const track = env.doc.createElement('div');
              track.className = 'gx-timeline-track';
              row.append(label, track);
              env.content.append(row);
              const programs = (page?.programs ?? []).filter(
                (p) => cellBounds(p.startMs, p.stopMs, anchor) !== null,
              );
              count += programs.length;
              if (count > MAX_CELLS) throw new Error('Guide visible cell limit.');
              for (const group of clusterListings(programs, anchor, track.clientWidth)) {
                const first = group[0]!,
                  bounds = cellBounds(first.startMs, first.stopMs, anchor)!;
                const end = Math.max(...group.map((p) => p.stopMs ?? p.startMs));
                const right = Math.min(anchor + WINDOW, end);
                // Overlapping listings show the first title and how many more,
                // never a bare count: the row stays readable.
                const more = group.length - 1;
                const cell = env.button(
                  group.length === 1
                    ? `${first.title}${first.stopMs === null ? ' · end unknown' : ''}`
                    : `${first.title} +${more}`,
                  () => {
                    if (!valid() || !env.currentChannel(channel)) return;
                    env.selectCell(cell);
                    if (group.length === 1)
                      void env
                        .launch(env.showDetail(channel, first, cell, revision, mine))
                        .catch(env.report);
                    else env.showChooser(channel, group, cell, revision, mine);
                  },
                );
                cell.className = 'gx-timeline-cell';
                cell.dataset.programKey = timelineProgramKey(first);
                cell.setAttribute('aria-pressed', 'false');
                const listingLabel = env.doc.createElement('span');
                listingLabel.className = 'gx-timeline-cell-label';
                listingLabel.textContent = cell.textContent;
                cell.replaceChildren(listingLabel);
                if (more)
                  cell.setAttribute(
                    'aria-label',
                    `${first.title} and ${more} more ${more === 1 ? 'listing' : 'listings'}`,
                  );
                const left = Math.min(bounds.left, Math.max(0, 100 - 4400 / track.clientWidth));
                const width = Math.min(
                  100 - left,
                  Math.max(
                    4400 / track.clientWidth,
                    bounds.width,
                    ((right - Math.max(anchor, first.startMs)) / WINDOW) * 100,
                  ),
                );
                cell.style.left = `${left}%`;
                cell.style.width = `${width}%`;
                cell.title = group
                  .map(
                    (p) =>
                      `${p.title} · ${env.host.formatTime(p.startMs)}${p.stopMs === null ? ' · end unknown' : ` – ${env.host.formatTime(p.stopMs)}`}`,
                  )
                  .join('\n');
                if (group.length > 1) cell.classList.add('gx-timeline-conflict');
                if (group.some(env.programMatches)) cell.classList.add('gx-timeline-match');
                if (
                  group.length === 1 &&
                  first.stopMs !== null &&
                  first.startMs <= env.host.now() &&
                  env.host.now() < first.stopMs
                )
                  cell.classList.add('gx-timeline-current');
                track.append(cell);
              }
              if (!programs.length || page?.nextCursor) {
                const note = env.doc.createElement('span');
                note.className = 'gx-timeline-note';
                note.textContent = page?.nextCursor
                  ? 'More listings available'
                  : channel.guideSourceId && channel.xmltvChannelId
                    ? 'No listings for this time'
                    : 'Guide not linked';
                label.setAttribute('aria-label', `${channel.name} · ${note.textContent}`);
                const openScheduleDetails = (event: Event) => {
                  event.preventDefault();
                  if (valid() && env.currentChannel(channel))
                    void env
                      .launch(env.showEmptyDetail(channel, label, revision, mine, anchor))
                      .catch(env.report);
                };
                label.addEventListener('contextmenu', openScheduleDetails);
                label.addEventListener('keydown', (event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                    openScheduleDetails(event);
                });
                track.append(note);
              }
              env.content.append(row);
            }
            if (valid()) {
              env.status.textContent = readyStatus;
              env.status.dataset.state = 'ready';
              if (channels.length) {
                const line = env.doc.createElement('div');
                line.className = 'gx-timeline-now';
                env.content.append(line);
              }
              env.restoreRowFocus();
              env.visibleArtwork();
              env.clock();
            }
          } finally {
            // The job owns every read it started: nothing new starts, and
            // suspension or the next refresh waits for the ones in flight.
            stopped = true;
            await Promise.allSettled(pages);
          }
        })();
        try {
          await env.launch(job);
        } catch (error) {
          if (abort.signal.aborted && !aborted(error)) {
            env.cleanupError = error;
            throw error;
          }
          if (valid()) {
            if (env.host.listedChannels) {
              env.listedCache = null;
              env.content.replaceChildren();
              env.content.style.height = '0px';
              env.agendaHeader.hidden = true;
              env.host.listedCount?.(null, anchor, anchor + WINDOW, true);
            }
            env.report();
          }
        }
      }
    })();
    const settled = task.finally(() => {
      if (env.active === settled) env.active = null;
    });
    env.active = settled;
    return settled;
  }
  return {
    refresh,
  };
}
