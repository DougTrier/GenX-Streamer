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

import { ChannelCoverageCleanupError, type MappedProgram } from '../guide/native';
import { describeGuideAvailability } from '../guide/summary-reason';
import {
  validateChannelCoverageReply,
  type ChannelCoverageReply,
  type ChannelCoverageRequest,
} from '../guide/channel-coverage';
import { describeChannelCoverage } from '../guide/coverage-presentation';
import { validateGuideCategories } from '../guide/categories';
import { WINDOW, aborted, type TimelineChannel, type TimelineHost } from './guide-timeline-model';

/** What this part reads from, and writes back to, mountGuideTimeline. */
export interface TimelineDetailsEnvironment {
  readonly closeDetails: () => boolean;
  returnFocus: HTMLElement | null;
  readonly details: HTMLElement;
  readonly root: HTMLElement;
  readonly doc: Document;
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  readonly host: TimelineHost;
  readonly launch: (job: Promise<void>) => Promise<void>;
  readonly report: () => void;
  readonly currentChannel: (channel: TimelineChannel) => boolean;
  detailVersion: number;
  detailController: AbortController | null;
  readonly closed: boolean;
  readonly foreground: boolean;
  readonly generation: number;
  readonly addWeekCoverage: (
    channel: TimelineChannel,
    abort: AbortController,
    valid: () => boolean,
  ) => void;
  cleanupError: unknown;
  readonly from: number;
  countdown: { node: HTMLElement; program: MappedProgram; valid(): boolean } | null;
  readonly clock: () => void;
}

/**
 * The timeline guide's program details and the channel chooser. Part of
 * mountGuideTimeline.
 */
export function createTimelineDetails(env: TimelineDetailsEnvironment) {
  function showChooser(
    channel: TimelineChannel,
    programs: MappedProgram[],
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
  ) {
    env.closeDetails();
    env.returnFocus = cell;
    env.details.hidden = false;
    env.root.classList.add('gx-timeline-has-details');
    const heading = env.doc.createElement('strong');
    heading.textContent = 'Choose a listing';
    const exit = env.button('Back to timeline', () => env.closeDetails());
    const list = env.doc.createElement('div');
    list.className = 'gx-timeline-choices';
    for (const program of programs) {
      list.append(
        env.button(
          `${program.title} · ${env.host.formatTime(program.startMs)}${program.categories?.length ? ` · ${program.categories.map((c) => c.text).join(' · ')}` : ''}`,
          () => {
            void env.launch(showDetail(channel, program, cell, revision, mine)).catch(env.report);
          },
        ),
      );
    }
    env.details.append(exit, heading, list);
    exit.focus();
  }
  async function confirmed(
    channel: TimelineChannel,
    program: MappedProgram,
    revision: string,
    signal: AbortSignal,
    requireCurrent = true,
  ): Promise<boolean> {
    if (
      !env.host.summary ||
      (!requireCurrent && channel.guideRevision === undefined) ||
      !env.currentChannel(channel) ||
      env.host.catalogRevision() !== revision ||
      signal.aborted
    )
      return false;
    const atMs = env.host.now(),
      summary = await env.host.summary(channel, atMs, signal);
    return (
      !signal.aborted &&
      env.currentChannel(channel) &&
      env.host.catalogRevision() === revision &&
      summary.catalogRevision === revision &&
      summary.atMs === atMs &&
      summary.appChannelId === channel.id &&
      summary.catalogSourceId === channel.sourceId &&
      summary.mappingStatus === 'mapped' &&
      summary.mapping?.guideSourceId === channel.guideSourceId &&
      summary.mapping.catalogSourceId === channel.sourceId &&
      summary.mapping.appChannelId === channel.id &&
      summary.mapping.xmltvChannelId === channel.xmltvChannelId &&
      summary.cacheStatus === 'current' &&
      (channel.guideRevision === undefined || summary.sourceRevision === channel.guideRevision) &&
      (!requireCurrent ||
        (summary.currentStatus === 'current' &&
          summary.current?.title === program.title &&
          summary.current.startMs === program.startMs &&
          summary.current.stopMs === program.stopMs &&
          program.stopMs !== null &&
          env.host.now() >= program.startMs &&
          env.host.now() < program.stopMs))
    );
  }
  async function showEmptyDetail(
    channel: TimelineChannel,
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
    anchor: number,
  ) {
    channel = { ...channel };
    env.closeDetails();
    env.returnFocus = cell;
    const version = ++env.detailVersion,
      abort = new AbortController();
    env.detailController = abort;
    const valid = () =>
      !env.closed &&
      env.foreground &&
      !abort.signal.aborted &&
      env.generation === mine &&
      version === env.detailVersion &&
      env.host.catalogRevision() === revision &&
      env.currentChannel(channel);
    env.details.hidden = false;
    env.root.classList.add('gx-timeline-has-details');
    env.details.replaceChildren();
    const exit = env.button('Back to timeline', () => env.closeDetails());
    const title = env.doc.createElement('strong');
    title.textContent = channel.name;
    title.className = 'gx-timeline-detail-title';
    const timing = env.doc.createElement('p');
    timing.textContent = `${env.host.formatTime(anchor)} – ${env.host.formatTime(anchor + WINDOW)}`;
    const state = env.doc.createElement('p');
    state.textContent =
      channel.guideSourceId && channel.xmltvChannelId
        ? 'No listings in this window. Checking saved schedule…'
        : 'No program guide connected. You can still watch this channel.';
    const coverage = env.doc.createElement('p');
    coverage.className = 'gx-timeline-channel-coverage';
    coverage.textContent =
      'Schedule coverage not assessed. Schedule information does not confirm stream availability.';
    env.details.append(exit, title, timing, state, coverage);
    env.addWeekCoverage(channel, abort, valid);
    const watch = env.host.channelActivate
      ? env.button('Watch channel', () => {
          if (valid()) env.host.channelActivate!({ ...channel });
        })
      : null;
    if (watch) env.details.append(watch);
    exit.focus();
    try {
      if (env.host.summary) {
        const atMs = env.host.now(),
          summary = await env.host.summary(channel, atMs, abort.signal);
        if (!valid()) return;
        if (
          summary.catalogSourceId !== channel.sourceId ||
          summary.appChannelId !== channel.id ||
          summary.atMs !== atMs ||
          summary.catalogRevision !== revision
        )
          throw new Error('Guide scope mismatch.');
        if (summary.mappingStatus === 'channel-unavailable') {
          if (watch) watch.disabled = true;
          state.textContent = 'Channel is no longer available. Return to Guide to refresh.';
          return;
        }
        state.textContent = describeGuideAvailability(summary);
        if (
          summary.mappingStatus === 'mapped' &&
          (summary.mapping?.guideSourceId !== channel.guideSourceId ||
            summary.mapping.xmltvChannelId !== channel.xmltvChannelId ||
            summary.sourceRevision !== channel.guideRevision ||
            summary.publishedRevision !== channel.guideRevision)
        )
          throw new Error('Guide mapping changed.');
      }
      if (
        env.host.channelCoverage &&
        channel.guideSourceId &&
        channel.xmltvChannelId &&
        channel.guideRevision !== undefined
      ) {
        const query: ChannelCoverageRequest = {
          schemaVersion: 1,
          sourceId: channel.guideSourceId,
          xmltvChannelId: channel.xmltvChannelId,
          startMs: anchor,
          endMs: anchor + WINDOW,
          expectedSourceRevision: channel.guideRevision,
          expectedPublishedRevision: channel.guideRevision,
        };
        const assessment = validateChannelCoverageReply(
          await env.host.channelCoverage(query, abort.signal),
          query,
        );
        if (!valid()) return;
        coverage.textContent = describeChannelCoverage(assessment, (instant) =>
          env.host.formatTime(instant),
        );
      }
    } catch (error) {
      if (
        error instanceof ChannelCoverageCleanupError ||
        (abort.signal.aborted && !aborted(error))
      ) {
        env.cleanupError = error;
        throw error;
      }
      if (!valid()) return;
      state.textContent =
        'Schedule details could not be checked. Saved listings are retained; refresh Guide or review the mapping.';
    }
    if (valid() && env.host.mapChannel)
      env.details.append(
        env.button('Map guide', () => {
          if (!valid()) return;
          const selected = { ...channel };
          env.closeDetails();
          void env
            .launch(
              Promise.resolve().then(() => {
                if (
                  env.closed ||
                  !env.foreground ||
                  env.generation !== mine ||
                  env.detailVersion !== version + 1 ||
                  env.host.catalogRevision() !== revision ||
                  !env.currentChannel(selected)
                )
                  return;
                return env.host.mapChannel!(selected);
              }),
            )
            .catch(env.report);
        }),
      );
  }
  async function showDetail(
    channel: TimelineChannel,
    program: MappedProgram,
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
  ) {
    channel = { ...channel };
    env.closeDetails();
    env.returnFocus = cell;
    const version = ++env.detailVersion,
      abort = new AbortController();
    env.detailController = abort;
    const valid = () =>
      !env.closed &&
      env.foreground &&
      !abort.signal.aborted &&
      env.generation === mine &&
      version === env.detailVersion &&
      env.host.catalogRevision() === revision &&
      env.currentChannel(channel);
    env.details.hidden = false;
    env.root.classList.add('gx-timeline-has-details');
    env.details.replaceChildren();
    const exit = env.button('Back to timeline', () => env.closeDetails());
    const title = env.doc.createElement('strong');
    title.textContent = program.title;
    title.className = 'gx-timeline-detail-title';
    const channelName = env.doc.createElement('span');
    channelName.className = 'gx-timeline-detail-channel';
    channelName.textContent = channel.name;
    const timing = env.doc.createElement('p');
    timing.textContent = `${env.host.formatTime(program.startMs)} · ${program.stopMs === null ? 'End unknown' : env.host.formatTime(program.stopMs)}`;
    const scheduled = env.doc.createElement('p');
    scheduled.className = 'gx-timeline-countdown';
    scheduled.textContent = 'Checking schedule…';
    const description = env.doc.createElement('p');
    description.textContent = program.description ?? 'Description unavailable';
    const categories = env.doc.createElement('p');
    categories.textContent = validateGuideCategories(program.categories)
      .map((c) => c.text)
      .join(' · ');
    const coverage = env.doc.createElement('p');
    coverage.className = 'gx-timeline-channel-coverage';
    coverage.textContent =
      'Channel schedule coverage not assessed. Listings do not confirm stream availability.';
    env.details.append(
      exit,
      channelName,
      title,
      timing,
      scheduled,
      description,
      categories,
      coverage,
    );
    env.addWeekCoverage(channel, abort, valid);
    exit.focus();
    const current =
      program.stopMs !== null &&
      env.host.now() >= program.startMs &&
      env.host.now() < program.stopMs;
    try {
      if (
        env.host.channelCoverage &&
        channel.guideSourceId &&
        channel.xmltvChannelId &&
        channel.guideRevision !== undefined
      ) {
        const query: ChannelCoverageRequest = {
          schemaVersion: 1,
          sourceId: channel.guideSourceId,
          xmltvChannelId: channel.xmltvChannelId,
          startMs: env.from,
          endMs: env.from + WINDOW,
          expectedSourceRevision: channel.guideRevision,
          expectedPublishedRevision: channel.guideRevision,
        };
        let assessment: ChannelCoverageReply | null = null;
        try {
          assessment = validateChannelCoverageReply(
            await env.host.channelCoverage(query, abort.signal),
            query,
          );
        } catch (error) {
          if (error instanceof ChannelCoverageCleanupError) throw error;
        }
        if (!valid()) return;
        if (assessment)
          coverage.textContent = describeChannelCoverage(assessment, env.host.formatTime);
      }
      if (!valid()) return;
      if (!(await confirmed(channel, program, revision, abort.signal, current)) || !valid()) {
        if (valid()) {
          scheduled.textContent = 'Schedule may have changed. Open the listing again to check.';
          if (current) timing.append(' · Current listing not confirmed');
        }
        return;
      }
      env.countdown = { node: scheduled, program: { ...program }, valid };
      env.clock();
      if (!current) return;
      const watch = env.button('Watch current channel', () => {
        if (!valid() || watch.disabled) return;
        watch.disabled = true;
        const job = (async () => {
          if (!(await confirmed(channel, program, revision, abort.signal)) || !valid()) return;
          await env.host.watch({ ...channel }, abort.signal);
        })();
        void env
          .launch(job)
          .catch((error: unknown) => {
            if (abort.signal.aborted && !aborted(error)) env.cleanupError = error;
            if (valid()) timing.textContent = 'Channel could not be opened.';
          })
          .finally(() => {
            if (valid() && env.host.now() < program.stopMs!) watch.disabled = false;
          });
      });
      watch.dataset.stop = String(program.stopMs);
      env.details.append(watch);
    } catch (error) {
      if (
        error instanceof ChannelCoverageCleanupError ||
        (abort.signal.aborted && !aborted(error))
      ) {
        env.cleanupError = error;
        throw error;
      }
      if (valid()) {
        scheduled.textContent = 'Schedule could not be checked.';
        timing.append(' · Current status unavailable');
      }
    }
  }
  return {
    showDetail,
    showEmptyDetail,
    showChooser,
  };
}
