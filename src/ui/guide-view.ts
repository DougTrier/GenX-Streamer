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

import { channelGuideText } from './channel-guide';
import {
  type GuideChannelCursor,
  type GuideCursor,
  type GuidePreview,
  type GuideSource,
  type MappedProgram,
} from '../guide/native';
import {
  type SelectedGuideSnapshot,
  type createSelectedGuideOwner,
} from '../application/guide/selected-guide';
import { type createGuideReload } from './guide-reload';
import { identity, type GuideCatalogChannel, type GuideHost } from './guide-model';

/** What this part reads from, and writes back to, mountGuide. */
export interface GuideViewEnvironment {
  readonly day: number;
  programView: string;
  readonly cursor: GuideCursor | null;
  readonly detail: HTMLElement;
  readonly detailState: {
    program: MappedProgram;
    channel: GuideCatalogChannel;
    action: HTMLButtonElement;
    message: HTMLElement;
    wasVisible: boolean;
  } | null;
  readonly programsPanel: HTMLElement;
  readonly host: GuideHost;
  catalogKey: string;
  readonly foreground: boolean;
  readonly dialog: HTMLDialogElement;
  summaryKey: string;
  summaryGeneration: number;
  readonly current: HTMLElement;
  readonly summaryOwner: ReturnType<typeof createSelectedGuideOwner>;
  readonly disposed: boolean;
  readonly pageAnchor: {
    signature: string;
    instant: number;
    start: number;
    end: number;
    mapping: string;
  } | null;
  readonly complete: SelectedGuideSnapshot;
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
  readonly back: HTMLButtonElement;
  readonly browsed: GuideCatalogChannel | null;
  readonly view: HTMLDivElement & { value: string; disabled: boolean };
  readonly advancedMode: boolean;
  readonly timeline: {
    refresh(): Promise<void>;
    refreshArtwork: () => void;
    closeDetails: () => boolean;
    setForeground(value: boolean): Promise<void>;
    suspend: () => Promise<void>;
    dispose(): Promise<void>;
  } | null;
  readonly sourceTask: HTMLDivElement & { value: string; disabled: boolean };
  readonly manualSource: HTMLDetailsElement;
  readonly findGuides: HTMLButtonElement;
  readonly explanation: HTMLElement;
  readonly returnGuide: HTMLButtonElement;
  readonly findEmpty: HTMLButtonElement;
  readonly mapEmpty: HTMLButtonElement;
  readonly timelinePanel: HTMLElement;
  readonly cancel: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly header: HTMLElement;
  readonly feedback: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly error: HTMLElement;
  readonly settings: HTMLElement;
  readonly mappingPanel: HTMLElement;
  readonly mapHeading: HTMLElement;
  readonly browsePanel: HTMLElement;
  readonly channelTools: HTMLDivElement;
  readonly searchDetails: HTMLDetailsElement;
  readonly lastProgramFocus: HTMLElement | null;
  readonly rows: HTMLUListElement;
  readonly addSourcePanel: HTMLDivElement;
  readonly manageSourcePanel: HTMLDivElement;
  readonly previewPanel: HTMLDivElement;
  readonly previewSummary: HTMLElement;
  preview: GuidePreview | null;
  readonly busy: boolean;
  readonly automaticStatus: HTMLElement;
  readonly load: HTMLButtonElement;
  readonly pick: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  readonly discardButton: HTMLButtonElement;
  readonly mapSave: HTMLButtonElement;
  readonly mapSource: HTMLSelectElement;
  readonly mapChannel: HTMLSelectElement;
  readonly committing: boolean;
  readonly dayChoice: HTMLSelectElement;
  readonly managedSource: HTMLSelectElement;
  readonly sourceAction: HTMLSelectElement;
  readonly manageAction: HTMLButtonElement;
  readonly nextPage: HTMLButtonElement;
  readonly nextCursor: GuideCursor | null;
  readonly firstPage: HTMLButtonElement;
  readonly now: HTMLButtonElement;
  readonly programAction: HTMLSelectElement;
  readonly programActions: Map<string, HTMLButtonElement>;
  readonly programRun: HTMLButtonElement;
  readonly lookupNext: HTMLButtonElement;
  readonly nextId: GuideChannelCursor | null;
  readonly lookup: HTMLButtonElement;
  readonly sourceName: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly sourceUrl: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly grant: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly mapSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly catalogSelect: HTMLSelectElement;
  readonly searchPrograms: HTMLButtonElement;
  readonly discardTickets: Set<string>;
  readonly catalogSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly searchSource: HTMLSelectElement;
  readonly sources: GuideSource[];
  readonly sourceSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly sourceRows: HTMLUListElement;
  readonly text: (tag: string, value: string) => HTMLElement;
  afterId: GuideChannelCursor | null;
  readonly lookupChannels: ReturnType<typeof createGuideReload>['lookupChannels'];
}

/**
 * What the guide shows: its summary, timing, the selected program's detail,
 * the view choice, the controls and the source list. Part of mountGuide.
 */
export function createGuideView(env: GuideViewEnvironment) {
  function liveScope(): boolean {
    return env.day === 0 && env.programView === 'channel' && env.cursor === null;
  }
  function summaryChannel(): GuideCatalogChannel | null {
    return !env.detail.hidden && env.detailState ? env.detailState.channel : chosen();
  }
  function summaryActive(): boolean {
    return (!env.detail.hidden && !!env.detailState) || (!env.programsPanel.hidden && liveScope());
  }
  function canonicalKey(): string {
    const channel = chosen();
    return JSON.stringify([
      env.host.catalogRevision?.() ?? null,
      !!env.host.summary,
      channel?.sourceId,
      channel?.id,
      env.host
        .channels?.()
        .some((entry) => entry.id === channel?.id && entry.sourceId === channel.sourceId) ?? true,
    ]);
  }
  function scopeKey(): string {
    const channel = summaryChannel();
    return JSON.stringify([
      channel?.sourceId,
      channel?.id,
      env.host.catalogRevision?.() ?? null,
      !!env.host.summary,
    ]);
  }
  function syncSummary(force = false): Promise<void> {
    env.catalogKey = canonicalKey();
    const key = summaryActive() && env.foreground && env.dialog.open ? scopeKey() : '';
    if (!force && key === env.summaryKey) return Promise.resolve();
    env.summaryKey = key;
    ++env.summaryGeneration;
    const channel = summaryChannel(),
      revision = env.host.catalogRevision?.();
    env.current.textContent = '';
    if (!key || !channel || !revision || !env.host.summary) {
      return env.summaryOwner.setSelection(null).then(() => {
        renderComplete();
        updateDetail();
      });
    }
    return env.summaryOwner.setSelection({
      catalogSourceId: channel.sourceId,
      appChannelId: channel.id,
      catalogRevision: revision,
      selectionGeneration: env.summaryGeneration,
    });
  }
  function renderComplete(): void {
    if (env.disposed) return;
    if (!liveScope()) {
      env.current.textContent = `Schedule snapshot as of ${env.host.formatTime(env.pageAnchor?.instant ?? env.host.now())}. Current / next is not summarized for this page.`;
      return;
    }
    if (env.complete.status === 'ready' && env.complete.summary) {
      const value = channelGuideText(
        {
          catalogSourceId: env.complete.summary.catalogSourceId,
          appChannelId: env.complete.summary.appChannelId,
          status: 'ready',
          summary: env.complete.summary,
        },
        env.host.formatTime,
      );
      env.current.textContent = `${value.current}${value.next ? ' · ' + value.next : ''}`;
    } else
      env.current.textContent =
        env.complete.status === 'loading'
          ? 'Loading current / next listings…'
          : 'Current / next unavailable. Review the guide source and mapping, or retry Now.';
  }
  function timingLabel(
    program: MappedProgram,
    channel: GuideCatalogChannel,
    conflict: boolean,
    instant: number,
    live: boolean,
  ): string {
    const timing =
      program.stopMs === null
        ? 'End unknown'
        : program.stopMs <= instant
          ? 'Earlier listing'
          : program.startMs <= instant
            ? 'Scheduled now'
            : 'Upcoming';
    return `${env.host.formatTime(program.startMs)} · ${env.programView === 'search' ? channel.name + ' · ' : ''}${program.title} · ${conflict ? 'Overlap observed on this page · ' : ''}${live ? timing : 'As of ' + env.host.formatTime(instant) + ' · ' + timing}`;
  }
  function updateTiming(): void {
    if (env.disposed) return;
    for (const [control, value] of env.timingRows)
      control.textContent = timingLabel(
        value.program,
        value.channel,
        value.conflict,
        value.live ? env.host.now() : value.snapshot,
        value.live,
      );
  }
  function eligibleDetail(): boolean {
    if (
      !env.detailState ||
      !env.foreground ||
      env.complete.status !== 'ready' ||
      !env.complete.summary
    )
      return false;
    const { program, channel } = env.detailState;
    const summary = env.complete.summary,
      known = summary.current,
      instant = env.host.now();
    return (
      summary.catalogRevision === env.host.catalogRevision?.() &&
      (!env.host.channels ||
        env.host
          .channels()
          .some((entry) => entry.id === channel.id && entry.sourceId === channel.sourceId)) &&
      summary.currentStatus === 'current' &&
      summary.cacheStatus === 'current' &&
      !!known &&
      channel.id === summary.appChannelId &&
      channel.sourceId === summary.catalogSourceId &&
      summary.mapping?.guideSourceId === program.guideSourceId &&
      summary.mapping.xmltvChannelId === program.xmltvChannelId &&
      known.title === program.title &&
      known.startMs === program.startMs &&
      known.stopMs === program.stopMs &&
      program.stopMs !== null &&
      program.startMs <= instant &&
      instant < program.stopMs
    );
  }
  function updateDetail(): void {
    if (!env.detailState || env.disposed) return;
    const eligible = eligibleDetail(),
      { action, message, program } = env.detailState;
    const instant = env.host.now();
    if (eligible) env.detailState.wasVisible = true;
    action.hidden = !env.detailState.wasVisible;
    action.disabled = !eligible;
    message.textContent = eligible
      ? 'Current listing confirmed by the complete cached guide. Watch channel starts the live stream.'
      : program.stopMs !== null && program.stopMs <= instant
        ? 'This listing has ended. Return to the current channel guide.'
        : program.startMs > instant
          ? 'Scheduled listing only. Future programs cannot play early.'
          : 'Current listing is unconfirmed or ambiguous. Review the current channel guide.';
    if (!eligible && document.activeElement === action) env.back.focus({ preventScroll: true });
  }
  function chosen(): GuideCatalogChannel | null {
    return env.browsed ?? env.host.selectedChannel();
  }
  function setView(target: string): void {
    for (const option of env.view.querySelectorAll<HTMLElement>('[role="option"]'))
      option.hidden =
        !env.advancedMode && ['sources', 'mapping'].includes(option.dataset.value ?? '');
    const compactPage =
      env.host.presentation === 'page' &&
      !!env.timeline &&
      !env.advancedMode &&
      target === 'channel';
    env.view.hidden = compactPage || (!env.advancedMode && target === 'sources');
    env.sourceTask.hidden = !env.advancedMode;
    env.manualSource.hidden = !env.advancedMode;
    env.findGuides.hidden = env.advancedMode
      ? !env.host.discover
      : !env.host.discover && !env.host.buildForChannels;
    env.explanation.hidden = !env.advancedMode;
    env.returnGuide.hidden = !(env.advancedMode || target === 'sources' || target === 'mapping');
    env.findEmpty.hidden =
      target !== 'mapping' ||
      env.advancedMode ||
      (!env.host.discover && !env.host.buildForChannels);
    env.mapEmpty.hidden = true;
    if (target === 'channel' || target === 'search') env.programView = target;
    if (target !== 'detail') env.view.value = target;
    env.timelinePanel.hidden = !env.timeline || env.advancedMode || target !== 'channel';
    env.programsPanel.hidden =
      !env.timelinePanel.hidden || (target !== 'channel' && target !== 'search');
    env.dialog.classList.toggle('guide-with-timeline', !env.timelinePanel.hidden);
    env.dialog.classList.toggle('guide-compact-page', compactPage);
    const timelineToolbar = env.timelinePanel.querySelector('.gx-timeline-toolbar');
    if (compactPage && timelineToolbar) {
      timelineToolbar.append(env.findEmpty, env.mapEmpty, env.cancel, env.close);
    } else {
      env.header.append(env.mapEmpty, env.cancel, env.close);
      env.dialog.insertBefore(env.feedback, env.body);
      env.dialog.insertBefore(env.findEmpty, env.body);
    }
    if (env.timeline && env.timelinePanel.hidden)
      void env.timeline.suspend().catch(() => {
        if (!env.disposed)
          env.error.textContent = 'Guide timeline cleanup could not finish. Close Guide and retry.';
      });
    env.settings.hidden = target !== 'sources';
    env.mappingPanel.hidden = target !== 'mapping';
    if (target === 'mapping')
      env.mapHeading.textContent = `Map guide for ${chosen()?.name ?? 'your channel'}`;
    env.browsePanel.hidden = target !== 'choose';
    env.detail.hidden = target !== 'detail';
    env.channelTools.hidden = target !== 'choose';
    env.searchDetails.hidden = env.programView !== 'search';
    env.back.hidden = target !== 'detail';
    env.body.dataset.view = target;
    sourceViews();
    void syncSummary().catch(() => {
      if (!env.disposed)
        env.error.textContent = 'Current / next activity could not settle. Retry or close Guide.';
    });
  }
  function restoreProgramFocus(): void {
    const previous = env.lastProgramFocus?.isConnected
      ? env.lastProgramFocus
      : [...env.timingRows.entries()].find(
          ([, value]) =>
            env.detailState &&
            value.channel.id === env.detailState.channel.id &&
            value.channel.sourceId === env.detailState.channel.sourceId &&
            identity(value.program) === identity(env.detailState.program),
        )?.[0];
    (previous ?? env.rows.querySelector<HTMLButtonElement>('button') ?? env.close).focus({
      preventScroll: true,
    });
  }
  function sourceViews(): void {
    env.addSourcePanel.hidden = env.sourceTask.value !== 'add';
    env.manageSourcePanel.hidden = env.sourceTask.value !== 'manage';
    env.previewPanel.hidden = env.sourceTask.value !== 'preview';
  }
  function showPreview(): void {
    env.previewSummary.textContent = env.preview
      ? `${env.preview.channels} guide channels · ${env.preview.programs} programs. ${env.preview.firstStartMs === null || env.preview.lastKnownStopMs === null ? 'Coverage unknown.' : `${env.host.formatTime(env.preview.firstStartMs)} – ${env.host.formatTime(env.preview.lastKnownStopMs)}.`}`
      : 'No schedule preview. Choose Add source or Manage sources to prepare one.';
    if (env.preview) {
      env.sourceTask.value = 'preview';
      setView('sources');
    }
    sourceViews();
    controls();
  }
  function controls(): void {
    const toolbar = env.timelinePanel.querySelector('.gx-timeline-toolbar');
    if (env.dialog.classList.contains('guide-compact-page') && toolbar) {
      if (env.busy || env.automaticStatus.textContent || env.error.textContent)
        toolbar.after(env.feedback);
      else toolbar.insertBefore(env.feedback, env.findEmpty);
    }
    env.feedback.hidden =
      !env.busy &&
      !env.error.textContent &&
      !env.automaticStatus.textContent &&
      env.rows.children.length > 0 &&
      !env.programsPanel.hidden;
    env.load.disabled = env.busy;
    env.findGuides.disabled = env.busy;
    env.findEmpty.disabled = env.busy;
    env.pick.disabled = env.busy;
    env.save.disabled = env.busy || !env.preview;
    env.discardButton.disabled = env.busy || !env.preview;
    env.mapSave.disabled = env.busy || !env.mapSource.value || !env.mapChannel.value || !chosen();
    env.cancel.disabled = !env.busy || env.committing;
    env.close.disabled = env.committing;
    env.cancel.hidden = !env.busy;
    env.dayChoice.disabled = env.busy;
    env.dayChoice.value = String(env.day);
    env.view.disabled = env.busy;
    env.sourceTask.disabled = env.busy;
    env.managedSource.disabled = env.busy;
    env.sourceAction.disabled = env.busy;
    env.manageAction.disabled = env.busy || !env.managedSource.value;
    env.nextPage.disabled = env.busy || !env.nextCursor;
    env.firstPage.disabled = env.busy || !env.cursor;
    env.now.disabled = env.busy;
    for (const option of env.programAction.options)
      option.disabled = env.programActions.get(option.value)?.disabled ?? true;
    env.programAction.disabled = env.busy;
    env.programRun.disabled =
      env.busy || (env.programActions.get(env.programAction.value)?.disabled ?? true);
    env.lookupNext.disabled = env.busy || !env.nextId;
    env.lookup.disabled = env.busy || !env.mapSource.value;
    env.sourceName.field.disabled = env.busy;
    env.sourceUrl.field.disabled = env.busy;
    env.grant.field.disabled = env.busy;
    env.mapSource.disabled = env.busy;
    env.mapSearch.field.disabled = env.busy;
    env.mapChannel.disabled = env.busy;
    env.catalogSelect.disabled = env.busy;
    env.searchPrograms.disabled = env.busy;
  }
  async function discard(): Promise<void> {
    if (env.preview) env.discardTickets.add(env.preview.ticket);
    for (const ticket of env.discardTickets) {
      try {
        await env.host.discardPreview(ticket);
      } catch {
        throw new Error('Guide preview cleanup could not be confirmed.');
      }
      env.discardTickets.delete(ticket);
      if (env.preview?.ticket === ticket) env.preview = null;
    }
    showPreview();
  }
  async function acceptPreview(result: GuidePreview, signal: AbortSignal): Promise<void> {
    if (env.disposed || signal.aborted) {
      env.discardTickets.add(result.ticket);
      await env.host.discardPreview(result.ticket);
      env.discardTickets.delete(result.ticket);
      signal.throwIfAborted();
      return;
    }
    env.preview = result;
  }
  function renderChannels(): void {
    const selected = chosen();
    const query = env.catalogSearch.field.value.trim().toLowerCase();
    const list = env.host.channels?.() ?? (selected ? [selected] : []);
    const options = list
      .filter((channel) => channel.name.toLowerCase().includes(query))
      .slice(0, 50);
    env.catalogSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Browse channels · up to 50 matches`;
    env.catalogSelect.append(placeholder);
    for (const channel of options) {
      const option = document.createElement('option');
      option.value = JSON.stringify([channel.sourceId, channel.id]);
      option.textContent = channel.name;
      option.selected = selected?.id === channel.id && selected.sourceId === channel.sourceId;
      env.catalogSelect.append(option);
    }
  }
  function renderSources(): void {
    const searchRemembered = env.searchSource.value;
    env.searchSource.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All guides';
    env.searchSource.append(all);
    for (const source of env.sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      option.selected = source.id === searchRemembered;
      env.searchSource.append(option);
    }
    const remembered = env.mapSource.value;
    const managedRemembered = env.managedSource.value;
    const matches = env.sources.filter((source) =>
      source.name.toLowerCase().includes(env.sourceSearch.field.value.trim().toLowerCase()),
    );
    env.sourceRows.replaceChildren();
    env.managedSource.replaceChildren();
    env.mapSource.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Choose a guide source';
    env.mapSource.append(empty);
    for (const source of matches.slice(0, 50)) {
      const managedOption = document.createElement('option');
      managedOption.value = source.id;
      managedOption.textContent = source.name;
      managedOption.selected = source.id === managedRemembered;
      env.managedSource.append(managedOption);
    }
    // Mapping choices must not inherit a hidden Advanced source-management search.
    for (const source of env.sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      option.selected = source.id === remembered;
      env.mapSource.append(option);
    }
    env.sourceRows.prepend(env.text('li', `${matches.length} source matches; showing up to 50.`));
    if (
      !env.mappingPanel.hidden &&
      !env.advancedMode &&
      !env.mapSource.value &&
      env.sources.length === 1
    ) {
      env.mapSource.value = env.sources[0].id;
    }
    if (!env.mappingPanel.hidden && !env.advancedMode && env.mapSource.value) {
      env.afterId = null;
      env.lookupChannels();
    }
    controls();
  }
  return {
    chosen,
    controls,
    discard,
    eligibleDetail,
    renderChannels,
    renderComplete,
    renderSources,
    setView,
    syncSummary,
    timingLabel,
    updateDetail,
    acceptPreview,
    showPreview,
    restoreProgramFocus,
    summaryChannel,
    summaryActive,
    updateTiming,
    sourceViews,
    canonicalKey,
  };
}
