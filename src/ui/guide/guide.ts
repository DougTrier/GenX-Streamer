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

import type {
  GuideChannelCursor,
  GuideCursor,
  GuidePreview,
  GuideSource,
  MappedProgram,
} from '../../guide/native';

import { mountGuideTimeline } from './guide-timeline';
import { PANEL_AGENDA_WIDTH, type TimelineChannel } from './guide-timeline-model';
import {
  createSelectedGuideOwner,
  type SelectedGuideSnapshot,
} from '../../application/guide/selected-guide';

import type { AutomaticGuideBuildProgress } from '../../guide/automatic-build';

import { createGuidePresentation } from './guide-presentation';
import { createSharedContext } from '../../application/shell/shared-context';
import { createGuideReload } from './guide-reload';
import { createGuideView } from './guide-view';
import { createGuideDropdown } from './guide-dropdown';
import { type GuideHost, type GuideCatalogChannel } from './guide-model';
import { createGuideSources } from './guide-sources';
export {
  type GuideCatalogChannel,
  type GuideCoverage,
  type GuideHost,
  identity,
} from './guide-model';
export function mountGuide(
  container: HTMLElement,
  host: GuideHost,
): {
  open(query?: string): Promise<void>;
  openMapping(channel?: GuideCatalogChannel): Promise<void>;
  openAdvanced(): Promise<void>;
  close(): Promise<void>;
  buildForChannels(): Promise<void>;
  presentAutomaticProgress(progress: Readonly<AutomaticGuideBuildProgress>): void;
  refreshArtwork(): void;
  selectedChannelChanged(): void;
  catalogChanged(force?: boolean): void;
  setForeground(active: boolean): Promise<void>;
  suspend(): Promise<void>;
  dispose(): Promise<void>;
} {
  // What the parts of mountGuide in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      acceptPreview: () => acceptPreview,
      actionController: () => actionController,
      actionWork: () => actionWork,
      addSourcePanel: () => addSourcePanel,
      advancedMode: () => advancedMode,
      afterId: () => afterId,
      automaticMessage: () => automaticMessage,
      automaticPending: () => automaticPending,
      automaticResult: () => automaticResult,
      automaticStatus: () => automaticStatus,
      back: () => back,
      body: () => body,
      browsed: () => browsed,
      browsePanel: () => browsePanel,
      busy: () => busy,
      button: () => button,
      cancel: () => cancel,
      catalogKey: () => catalogKey,
      catalogSearch: () => catalogSearch,
      catalogSelect: () => catalogSelect,
      channelTools: () => channelTools,
      chosen: () => chosen,
      close: () => close,
      closing: () => closing,
      committing: () => committing,
      complete: () => complete,
      container: () => container,
      controls: () => controls,
      current: () => current,
      cursor: () => cursor,
      day: () => day,
      dayChoice: () => dayChoice,
      detail: () => detail,
      detailState: () => detailState,
      dialog: () => dialog,
      discard: () => discard,
      discardButton: () => discardButton,
      discardTickets: () => discardTickets,
      discoveryRows: () => discoveryRows,
      disposed: () => disposed,
      eligibleDetail: () => eligibleDetail,
      error: () => error,
      explanation: () => explanation,
      feedback: () => feedback,
      findEmpty: () => findEmpty,
      findGuides: () => findGuides,
      firstPage: () => firstPage,
      foreground: () => foreground,
      freshness: () => freshness,
      grant: () => grant,
      header: () => header,
      host: () => host,
      lastProgramFocus: () => lastProgramFocus,
      load: () => load,
      lookup: () => lookup,
      lookupChannels: () => lookupChannels,
      lookupController: () => lookupController,
      lookupEpoch: () => lookupEpoch,
      lookupNext: () => lookupNext,
      lookupWork: () => lookupWork,
      manageAction: () => manageAction,
      managedSource: () => managedSource,
      manageSourcePanel: () => manageSourcePanel,
      manualSource: () => manualSource,
      mapChannel: () => mapChannel,
      mapEmpty: () => mapEmpty,
      mapHeading: () => mapHeading,
      mappingPanel: () => mappingPanel,
      mapSave: () => mapSave,
      mapSearch: () => mapSearch,
      mapSource: () => mapSource,
      mapStatus: () => mapStatus,
      nextCursor: () => nextCursor,
      nextId: () => nextId,
      nextPage: () => nextPage,
      now: () => now,
      opening: () => opening,
      pageAnchor: () => pageAnchor,
      pagePresented: () => pagePresented,
      pick: () => pick,
      presentationEpoch: () => presentationEpoch,
      preview: () => preview,
      previewPanel: () => previewPanel,
      previewSummary: () => previewSummary,
      programAction: () => programAction,
      programActions: () => programActions,
      programRun: () => programRun,
      programSearch: () => programSearch,
      programsPanel: () => programsPanel,
      programView: () => programView,
      reload: () => reload,
      renderChannels: () => renderChannels,
      renderComplete: () => renderComplete,
      renderSources: () => renderSources,
      returnFocus: () => returnFocus,
      returnGuide: () => returnGuide,
      rows: () => rows,
      run: () => run,
      save: () => save,
      searchDetails: () => searchDetails,
      searchPrograms: () => searchPrograms,
      searchSource: () => searchSource,
      selectedFile: () => selectedFile,
      settings: () => settings,
      setView: () => setView,
      showPreview: () => showPreview,
      sourceAction: () => sourceAction,
      sourceName: () => sourceName,
      sourceRows: () => sourceRows,
      sources: () => sources,
      sourceSearch: () => sourceSearch,
      sourceTask: () => sourceTask,
      sourceUrl: () => sourceUrl,
      status: () => status,
      summaryGeneration: () => summaryGeneration,
      summaryKey: () => summaryKey,
      summaryOwner: () => summaryOwner,
      suspending: () => suspending,
      suspension: () => suspension,
      syncSummary: () => syncSummary,
      text: () => text,
      timeline: () => timeline,
      timelineChannels: () => timelineChannels,
      timelinePanel: () => timelinePanel,
      timingLabel: () => timingLabel,
      timingRows: () => timingRows,
      title: () => title,
      updateDetail: () => updateDetail,
      view: () => view,
      viewController: () => viewController,
      viewEpoch: () => viewEpoch,
      viewWork: () => viewWork,
    },
    {
      actionController: (value: typeof actionController) => (actionController = value),
      actionWork: (value: typeof actionWork) => (actionWork = value),
      advancedMode: (value: typeof advancedMode) => (advancedMode = value),
      afterId: (value: typeof afterId) => (afterId = value),
      automaticPending: (value: typeof automaticPending) => (automaticPending = value),
      browsed: (value: typeof browsed) => (browsed = value),
      busy: (value: typeof busy) => (busy = value),
      catalogKey: (value: typeof catalogKey) => (catalogKey = value),
      closing: (value: typeof closing) => (closing = value),
      committing: (value: typeof committing) => (committing = value),
      cursor: (value: typeof cursor) => (cursor = value),
      detailState: (value: typeof detailState) => (detailState = value),
      foreground: (value: typeof foreground) => (foreground = value),
      lastProgramFocus: (value: typeof lastProgramFocus) => (lastProgramFocus = value),
      lookupController: (value: typeof lookupController) => (lookupController = value),
      lookupEpoch: (value: typeof lookupEpoch) => (lookupEpoch = value),
      lookupWork: (value: typeof lookupWork) => (lookupWork = value),
      nextCursor: (value: typeof nextCursor) => (nextCursor = value),
      nextId: (value: typeof nextId) => (nextId = value),
      opening: (value: typeof opening) => (opening = value),
      pageAnchor: (value: typeof pageAnchor) => (pageAnchor = value),
      pagePresented: (value: typeof pagePresented) => (pagePresented = value),
      presentationEpoch: (value: typeof presentationEpoch) => (presentationEpoch = value),
      preview: (value: typeof preview) => (preview = value),
      programView: (value: typeof programView) => (programView = value),
      selectedFile: (value: typeof selectedFile) => (selectedFile = value),
      sources: (value: typeof sources) => (sources = value),
      summaryGeneration: (value: typeof summaryGeneration) => (summaryGeneration = value),
      summaryKey: (value: typeof summaryKey) => (summaryKey = value),
      suspending: (value: typeof suspending) => (suspending = value),
      suspension: (value: typeof suspension) => (suspension = value),
      timelineChannels: (value: typeof timelineChannels) => (timelineChannels = value),
      viewController: (value: typeof viewController) => (viewController = value),
      viewEpoch: (value: typeof viewEpoch) => (viewEpoch = value),
      viewWork: (value: typeof viewWork) => (viewWork = value),
    },
  );
  const guideView = createGuideView(shared);
  const {
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
  } = guideView;
  const guideReload = createGuideReload(shared);
  const { reload, lookupChannels } = guideReload;
  const guidePresentation = createGuidePresentation(shared);
  const {
    closeGuide,
    run,
    automaticMessage,
    automaticResult,
    suspend,
    openPresentation,
    presentAutomaticProgress,
  } = guidePresentation;

  const button = (label: string, action: () => void) => {
    const result = document.createElement('button');
    result.type = 'button';
    result.textContent = label;
    result.addEventListener('click', action);
    return result;
  };
  const guideDropdown = createGuideDropdown(shared);
  const { dropdown } = guideDropdown;
  const text = (tag: string, value: string) => {
    const result = document.createElement(tag);
    result.textContent = value;
    return result;
  };
  const input = (label: string, type = 'text') => {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement('input');
    field.type = type;
    wrapper.append(field);
    return { wrapper, field };
  };
  const dialog = document.createElement('dialog');
  dialog.className = 'guide-dialog';
  dialog.setAttribute('aria-label', 'Program guide');
  const title = text('h2', 'Program guide');
  const status = text('p', '');
  status.setAttribute('role', 'status');
  const automaticStatus = text('p', '');
  automaticStatus.setAttribute('role', 'status');
  automaticStatus.setAttribute('aria-label', 'Guide update');
  automaticStatus.hidden = true;
  const error = text('p', '');
  error.setAttribute('role', 'alert');
  const current = text('p', '');
  const freshness = text('p', '');
  const catalogSearch = input('Find a channel');
  const catalogSelect = document.createElement('select');
  catalogSelect.setAttribute('aria-label', 'Browse channel guide');
  const programSearch = input('Find a program', 'search');
  const searchSource = document.createElement('select');
  searchSource.setAttribute('aria-label', 'Search guide source');
  programSearch.field.maxLength = 256;
  const rows = document.createElement('ul');
  rows.setAttribute('aria-label', 'Guide programs');
  const detail = document.createElement('article');
  detail.hidden = true;
  let advancedMode = false;
  const view = dropdown('Guide view', [
    ['channel', 'Channel guide'],
    ['choose', 'Choose channel / day'],
    ['search', 'Search programs'],
    ['sources', 'Program guide setup'],
    ['mapping', 'Channel mapping'],
  ]);
  const body = document.createElement('div');
  body.className = 'guide-body';
  const programsPanel = document.createElement('section');
  programsPanel.className = 'guide-panel guide-programs-panel';
  const settings = document.createElement('section');
  settings.className = 'guide-panel guide-sources-panel';
  const mappingPanel = document.createElement('section');
  mappingPanel.className = 'guide-panel guide-mapping-panel';
  const browsePanel = document.createElement('section');
  browsePanel.className = 'guide-panel guide-browse-panel';
  const channelTools = document.createElement('div');
  channelTools.className = 'guide-toolbar';
  const searchTools = document.createElement('div');
  searchTools.className = 'guide-toolbar';
  const dayChoice = document.createElement('select');
  dayChoice.setAttribute('aria-label', 'Guide day');
  for (let index = 0; index < 7; index++) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : `Day ${index + 1}`;
    dayChoice.append(option);
  }
  const sourceTask = dropdown('Guide source task', [
    ['add', 'Add source'],
    ['manage', 'Manage sources'],
    ['preview', 'Review schedule preview'],
  ]);
  const addSourcePanel = document.createElement('div');
  addSourcePanel.className = 'guide-source-form';
  const manualSource = document.createElement('details');
  manualSource.className = 'guide-manual-source';
  manualSource.append(text('summary', 'Add guide link or file'));
  const discoveryRows = document.createElement('ul');
  discoveryRows.setAttribute('aria-label', 'Program guides found');
  const manageSourcePanel = document.createElement('div');
  manageSourcePanel.className = 'guide-source-form';
  const previewPanel = document.createElement('div');
  previewPanel.className = 'guide-source-form';
  const managedSource = document.createElement('select');
  managedSource.setAttribute('aria-label', 'Managed guide source');
  const sourceAction = document.createElement('select');
  sourceAction.setAttribute('aria-label', 'Guide source action');
  for (const [value, label] of [
    ['refresh', 'Preview refresh'],
    ['remove', 'Remove guide source'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sourceAction.append(option);
  }
  let lastProgramFocus: HTMLElement | null = null;
  let programView = 'channel';
  const sourceName = input('Guide source name');
  const sourceUrl = input('Online XMLTV URL', 'url');
  const grant = input('Allow HTTP for this guide source', 'checkbox');
  const explanation = text(
    'p',
    'Use a program-guide link (XMLTV) or choose a guide file. Preview it, review the program counts, then save. Finally connect its listings to your channels. Preview saves the link settings; programs change only when you save the reviewed preview.',
  );
  const sourceRows = document.createElement('ul');
  sourceRows.setAttribute('aria-label', 'Configured guide sources');
  const sourceSearch = input('Find a guide source', 'search');
  const previewSummary = text('p', '');
  const mapSource = document.createElement('select');
  mapSource.setAttribute('aria-label', 'Mapping guide source');
  const mapSearch = input('Find the guide channel', 'search');
  const mapChannel = document.createElement('select');
  mapChannel.setAttribute('aria-label', 'Mapping guide channel');
  const mapStatus = text('p', '');
  const mapHeading = text('h3', 'Connect a program guide');
  const mapHelp = text(
    'p',
    'Choose the schedule for this channel. Check the station and region before saving. This does not change playback.',
  );
  let disposed = false;
  let busy = false;
  let automaticPending = false;
  let committing = false;
  let suspending = false;
  let suspension: Promise<void> | null = null;
  let foregroundResume: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  let opening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let presentationEpoch = 0;
  let pagePresented = false;
  const discardTickets = new Set<string>();
  let day = 0;
  let cursor: GuideCursor | null = null;
  let nextCursor: GuideCursor | null = null;
  let pageAnchor: {
    signature: string;
    instant: number;
    start: number;
    end: number;
    mapping: string;
  } | null = null;
  let afterId: GuideChannelCursor | null = null;
  let nextId: GuideChannelCursor | null = null;
  let browsed: GuideCatalogChannel | null = null;
  let sources: GuideSource[] = [];
  let preview: GuidePreview | null = null;
  let selectedFile: { name: string; location: string } | null = null;
  let returnFocus: HTMLElement | null = null;
  let foreground = true;
  let summaryGeneration = 0;
  let summaryKey = '';
  let catalogKey = '';
  let complete: SelectedGuideSnapshot = { status: 'idle', summary: null };
  const timingRows = new Map<
    HTMLButtonElement,
    {
      program: MappedProgram;
      channel: GuideCatalogChannel;
      conflict: boolean;
      snapshot: number;
      live: boolean;
    }
  >();
  let detailState: {
    program: MappedProgram;
    channel: GuideCatalogChannel;
    action: HTMLButtonElement;
    message: HTMLElement;
    wasVisible: boolean;
  } | null = null;
  let viewEpoch = 0;
  let lookupEpoch = 0;
  let viewController: AbortController | null = null;
  let lookupController: AbortController | null = null;
  let actionController: AbortController | null = null;
  let viewWork: Promise<void> = Promise.resolve();
  let lookupWork: Promise<void> = Promise.resolve();
  let actionWork: Promise<void> = Promise.resolve();
  const now = button('Now', () => {
    day = 0;
    cursor = null;
    reload();
  });
  const searchPrograms = button('Search programs', () => {
    cursor = null;
    reload();
  });
  const nextPage = button('More programs', () => {
    cursor = nextCursor;
    reload(true);
  });
  const firstPage = button('First programs', () => {
    cursor = null;
    reload();
  });
  const close = button('Close guide', () => {
    void closeGuide().catch(() => {
      if (!disposed) error.textContent = 'Guide cleanup could not be confirmed. Retry closing.';
    });
  });
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close guide');
  const cancel = button('Cancel guide operation', () => {
    if (!committing) actionController?.abort();
  });
  const guideSources = createGuideSources(shared);
  const {
    discardButton,
    findEmpty,
    findGuides,
    load,
    lookup,
    lookupNext,
    manageAction,
    mapEmpty,
    mapSave,
    pick,
    returnGuide,
    save,
  } = guideSources;
  const back = button('Back to programs', () => {
    setView(programView);
    restoreProgramFocus();
  });
  detail.className = 'guide-panel guide-detail-panel';
  rows.className = 'guide-program-list';
  const header = document.createElement('header');
  header.className = 'guide-header';
  header.append(title, close, cancel);
  header.append(back);
  const feedback = document.createElement('div');
  feedback.className = 'guide-feedback';
  feedback.append(status, automaticStatus, error);
  const pagination = document.createElement('footer');
  pagination.className = 'guide-pagination';
  const programAction = document.createElement('select');
  programAction.setAttribute('aria-label', 'Program navigation');
  const programActions = new Map([
    ['now', now],
    ['first', firstPage],
    ['more', nextPage],
  ]);
  for (const [value, control] of programActions) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = control.textContent;
    programAction.append(option);
  }
  const programRun = button('Run program action', () =>
    programActions.get(programAction.value)?.click(),
  );
  programRun.textContent = 'Go';
  programRun.setAttribute('aria-label', 'Run program action');
  pagination.append(programAction, programRun);
  programAction.addEventListener('change', () => controls());
  channelTools.append(catalogSearch.wrapper, catalogSelect, dayChoice);
  browsePanel.append(channelTools);
  searchTools.append(programSearch.wrapper, searchSource, searchPrograms);
  const coverageDetails = document.createElement('details');
  coverageDetails.className = 'guide-coverage';
  coverageDetails.append(text('summary', 'Current / next and feed coverage'), current, freshness);
  const searchDetails = document.createElement('details');
  searchDetails.className = 'guide-coverage guide-search-options';
  searchDetails.append(text('summary', 'Change program search'), searchTools);
  programsPanel.append(searchDetails, coverageDetails, rows, pagination);
  manualSource.append(
    explanation,
    sourceName.wrapper,
    sourceUrl.wrapper,
    grant.wrapper,
    pick,
    load,
  );
  addSourcePanel.append(
    text(
      'p',
      'Find guide links included by your saved channel playlists. Nothing is added until you preview and save.',
    ),
    findGuides,
    discoveryRows,
    manualSource,
  );
  previewPanel.append(previewSummary, save, discardButton);
  manageSourcePanel.append(
    sourceSearch.wrapper,
    managedSource,
    sourceAction,
    manageAction,
    sourceRows,
  );
  settings.append(sourceTask, addSourcePanel, manageSourcePanel, previewPanel);
  mappingPanel.append(
    mapHeading,
    mapHelp,
    mapSource,
    mapSearch.wrapper,
    lookup,
    mapChannel,
    lookupNext,
    mapStatus,
    mapSave,
  );
  const timelinePanel = document.createElement('section');
  timelinePanel.className = 'guide-panel guide-timeline-panel';
  timelinePanel.hidden = true;
  let timelineChannels: readonly TimelineChannel[] = [];
  const timeline = host.enableTimeline
    ? mountGuideTimeline(timelinePanel, {
        logos: host.logos,
        // The page Guide sits in the right panel beside the channel list.
        agendaWidth: host.presentation === 'page' ? PANEL_AGENDA_WIDTH : undefined,
        initiallyForeground: false,
        listedChannels: host.listedChannels
          ? (start, end, signal, search) => host.listedChannels!(start, end, signal, search)
          : undefined,
        listedCount: (count, start, end, failed) => {
          if (disposed || !foreground || suspending || timelinePanel.hidden) return;
          status.textContent =
            count === null
              ? failed
                ? 'Saved listings unavailable. Retry Now.'
                : 'Checking saved listings…'
              : `${count} ${count === 1 ? 'channel' : 'channels'} with listings`;
          const description =
            count === null
              ? status.textContent
              : `${count} saved channels have listings from ${host.formatTime(start)} to ${host.formatTime(end)}. This counts saved listings for the selected time.`;
          status.title = description;
          status.setAttribute('aria-label', description);
        },
        channels: () => timelineChannels,
        catalogRevision: () => host.catalogRevision?.() ?? '',
        query: (query, signal) => host.query(query, signal),
        channelCoverage: host.channelCoverage
          ? (query, signal) => host.channelCoverage!(query, signal)
          : undefined,
        summary: async (channel, atMs, signal) => {
          if (!host.summary) throw new Error('Current listing is unavailable.');
          return host.summary(
            {
              catalogSourceId: channel.sourceId,
              appChannelId: channel.id,
              atMs,
              requestId: crypto.randomUUID(),
            },
            signal,
          );
        },
        watch: (channel, signal) => host.watch(channel, signal),
        mapChannel: (channel) => {
          const current = host
            .channels?.()
            .find((entry) => entry.id === channel.id && entry.sourceId === channel.sourceId);
          if (disposed || !foreground || suspending || busy || !current)
            throw new Error('Channel is no longer available.');
          browsed = { ...current };
          mapSearch.field.value = current.name.slice(0, 256);
          setView('mapping');
          reload();
        },
        channelActivate: (channel) => {
          run(
            async (signal) => {
              const current = host
                .channels?.()
                .find((entry) => entry.id === channel.id && entry.sourceId === channel.sourceId);
              if (!current) throw new Error('Channel is no longer available.');
              await host.watch({ ...current }, signal);
            },
            false,
            true,
          );
        },
        now: () => host.now(),
        formatTime: (ms) => host.formatTime(ms),
        formatAxisTime: (ms) =>
          new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          }).format(ms),
      })
    : null;
  body.append(timelinePanel, programsPanel, browsePanel, settings, mappingPanel, detail);
  header.append(mapEmpty);
  dialog.append(header, view, returnGuide, feedback, findEmpty, body);
  container.append(dialog);
  const summaryOwner = createSelectedGuideOwner({
    fetch: (query, signal) => host.summary!(query, signal),
    cancel: host.cancelSummary,
    available: () =>
      !!host.summary && host.catalogRevision?.() !== null && host.catalogRevision?.() !== undefined,
    clock: host.summaryClock ?? {
      now: () => host.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    isCurrent: (scope) => {
      const channel = summaryChannel();
      return (
        !disposed &&
        foreground &&
        dialog.open &&
        summaryActive() &&
        scope.selectionGeneration === summaryGeneration &&
        scope.catalogRevision === host.catalogRevision?.() &&
        scope.catalogSourceId === channel?.sourceId &&
        scope.appChannelId === channel.id
      );
    },
  });
  summaryOwner.subscribe((value) => {
    complete = value;
    renderComplete();
    updateTiming();
    updateDetail();
  });
  catalogSearch.field.addEventListener('input', renderChannels);
  view.addEventListener('change', () => {
    if (view.value === 'channel') {
      programSearch.field.value = '';
      day = 0;
      cursor = null;
    }
    if (view.value === 'search') {
      day = 0;
      cursor = null;
    }
    setView(view.value);
    if (view.value === 'channel' || view.value === 'search') reload();
  });
  sourceTask.addEventListener('change', sourceViews);
  dayChoice.addEventListener('change', () => {
    day = Number(dayChoice.value);
    cursor = null;
    programSearch.field.value = '';
    setView('channel');
    reload();
  });
  managedSource.addEventListener('change', controls);
  catalogSelect.addEventListener('change', () => {
    const key = catalogSelect.value;
    browsed =
      (host.channels?.() ?? []).find(
        (channel) => JSON.stringify([channel.sourceId, channel.id]) === key,
      ) ?? null;
    day = 0;
    cursor = null;
    programSearch.field.value = '';
    setView('channel');
    reload();
  });
  programSearch.field.addEventListener('change', () => {
    cursor = null;
    reload();
  });
  searchSource.addEventListener('change', () => {
    cursor = null;
    reload();
  });
  sourceSearch.field.addEventListener('input', renderSources);
  sourceUrl.field.addEventListener('input', () => {
    selectedFile = null;
  });
  mapSource.addEventListener('change', () => {
    mapChannel.replaceChildren();
    nextId = null;
    afterId = null;
    lookupChannels();
  });
  dialog.addEventListener(
    'cancel',
    (event) => {
      const openDropdown = dialog.querySelector(
        '.guide-dropdown > button[aria-expanded="true"]',
      )?.parentElement;
      if (!openDropdown) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openDropdown.dispatchEvent(new Event('guide-dropdown-close'));
    },
    { capture: true },
  );
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!timelinePanel.hidden && timeline?.closeDetails()) return;
    if (!detail.hidden) {
      setView(programView);
      restoreProgramFocus();
    } else
      void closeGuide().catch(() => {
        if (!disposed) error.textContent = 'Guide cleanup could not be confirmed. Retry closing.';
      });
  });
  controls();
  setView('channel');
  return {
    setForeground(active: boolean): Promise<void> {
      if (!active) return suspend();
      if (disposed) return Promise.resolve();
      if (foregroundResume) {
        foreground = true;
        return foregroundResume;
      }
      if (foreground && !suspension) return Promise.resolve();
      foreground = true;
      const barrier = suspension;
      const attempt = (async () => {
        await barrier;
        if (disposed || !foreground || suspending) return;
        if (dialog.open) reload();
        await syncSummary(true);
        if (!disposed && foreground && !suspending) await summaryOwner.setForeground(true);
      })();
      foregroundResume = attempt;
      const settled = () => {
        if (foregroundResume === attempt) foregroundResume = null;
      };
      void attempt.then(settled, settled);
      return attempt;
    },
    catalogChanged(force = false): void {
      const key = canonicalKey();
      if (!force && key === catalogKey) return;
      catalogKey = key;
      if (dialog.open && !disposed) {
        reload();
      }
    },
    close: () => closeGuide(),
    open(query?: string) {
      return openPresentation(host.presentation === 'page', () => {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        advancedMode = false;
        browsed = host.selectedChannel();
        catalogKey = canonicalKey();
        if (query !== undefined) programSearch.field.value = query.slice(0, 256);
        setView(query?.trim() ? 'search' : 'channel');
        day = 0;
        cursor = null;
      });
    },
    openMapping(channel?: GuideCatalogChannel) {
      return openPresentation(false, () => {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        advancedMode = false;
        browsed = channel ?? host.selectedChannel();
        catalogKey = canonicalKey();
        setView('mapping');
        mapSearch.field.value = browsed?.name.slice(0, 256) ?? '';
      });
    },
    buildForChannels() {
      if (disposed || suspending || !foreground)
        return Promise.reject(new DOMException('Program guide build canceled.', 'AbortError'));
      if (!host.buildForChannels) return Promise.resolve();
      run(async (signal) => {
        automaticMessage('Finding program guides…', true);
        const result = await host.buildForChannels!(signal);
        signal.throwIfAborted();
        if (disposed || !foreground) return;
        automaticResult(result);
        reload();
      });
      return actionWork;
    },
    presentAutomaticProgress,
    refreshArtwork() {
      timeline?.refreshArtwork();
    },
    openAdvanced() {
      return openPresentation(false, () => {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        advancedMode = true;
        browsed = host.selectedChannel();
        catalogKey = canonicalKey();
        sourceTask.value = 'add';
        setView('sources');
      });
    },
    selectedChannelChanged() {
      if (disposed) return;
      browsed = host.selectedChannel();
      setView('channel');
      programSearch.field.value = '';
      day = 0;
      cursor = null;
      reload();
    },
    suspend,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      ++presentationEpoch;
      viewController?.abort();
      lookupController?.abort();
      if (!committing) actionController?.abort();
      const attempt = Promise.allSettled([
        viewWork,
        lookupWork,
        actionWork,
        foregroundResume,
        opening,
        closing,
        summaryOwner.dispose(),
        timeline?.dispose(),
      ]).then(async (settled) => {
        await host.settleMappingHydration?.();
        if (settled.some((result) => result.status === 'rejected'))
          throw new Error('Guide activity cleanup could not be confirmed.');
        await discard();
        dialog.close();
        dialog.removeAttribute('data-primary-page');
        if (pagePresented) {
          await host.closed?.();
          pagePresented = false;
        }
        dialog.remove();
      });
      disposal = attempt;
      void attempt.catch(() => {
        if (disposal === attempt) disposal = null;
      });
      return attempt;
    },
  };
}
