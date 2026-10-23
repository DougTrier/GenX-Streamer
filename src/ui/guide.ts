import {
  mappedGuideResultText,
  type MappedGuideHydrationResult,
} from '../application/mapped-guide-schedule';
import { GUIDE_SOURCE_LIMIT } from '../guide/limits';
import { describeChannelCoverage } from '../guide/coverage-presentation';
import { ChannelCoverageCleanupError } from '../guide/native';
import {
  validateChannelCoverageReply,
  type ChannelCoverageRequest,
  type ChannelCoverageReply,
} from '../guide/channel-coverage';
import type {
  GuideChannelPage,
  GuideChannelCursor,
  GuideCursor,
  GuideMapping,
  GuidePreview,
  GuideSource,
  MappedProgram,
  ProgramPage,
  ProgramQuery,
  SelectedGuideQuery,
  SelectedGuideSummary,
} from '../guide/native';
import { queryGuide, type GuideProgram } from '../guide/query';
import { guideCategoryKey, type GuideCategory } from '../guide/categories';
import {
  mountGuideTimeline,
  PANEL_AGENDA_WIDTH,
  type TimelineChannel,
  type TimelineHost,
} from './guide-timeline';
import {
  createSelectedGuideOwner,
  type SelectedGuideClock,
  type SelectedGuideSnapshot,
} from '../application/selected-guide';
import { channelGuideText } from './channel-guide';
import { SEARCH_WEEK_MS } from '../search/catalog-search';
import type {
  AutomaticGuideBuildProgress,
  AutomaticGuideBuildResult,
} from '../guide/automatic-build';
import type { GuideDiscoveryResult } from '../guide/discovery';
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
const identity = (program: {
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
let guideDropdownId = 0;
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
  const button = (label: string, action: () => void) => {
    const result = document.createElement('button');
    result.type = 'button';
    result.textContent = label;
    result.addEventListener('click', action);
    return result;
  };
  const dropdown = (label: string, choices: readonly (readonly [string, string])[]) => {
    const wrapper = document.createElement('div') as HTMLDivElement & {
      value: string;
      disabled: boolean;
    };
    wrapper.className = 'guide-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.id = `guide-choice-${++guideDropdownId}`;
    trigger.setAttribute('aria-controls', menu.id);
    menu.className = 'guide-dropdown-options';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label + ' choices');
    menu.hidden = true;
    let value = choices[0]![0];
    const close = (restore = false) => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restore) trigger.focus();
    };
    const options = choices.map(([key, name]) => {
      const option = button(name, () => {
        wrapper.value = key;
        close(true);
        wrapper.dispatchEvent(new Event('change'));
      });
      option.setAttribute('role', 'option');
      option.dataset.value = key;
      menu.append(option);
      return option;
    });
    const update = () => {
      trigger.textContent = choices.find(([key]) => key === value)?.[1] ?? label;
      options.forEach((option) =>
        option.setAttribute('aria-selected', String(option.dataset.value === value)),
      );
    };
    Object.defineProperties(wrapper, {
      value: {
        get: () => value,
        set: (next: string) => {
          if (choices.some(([key]) => key === next)) {
            value = next;
            close();
            update();
          }
        },
      },
      disabled: {
        get: () => trigger.disabled,
        set: (disabled: boolean) => {
          trigger.disabled = disabled;
          options.forEach((option) => (option.disabled = disabled));
          if (disabled) close();
        },
      },
    });
    const open = () => {
      if (trigger.disabled) return;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const available = options.filter((option) => !option.hidden);
      (available.find((option) => option.dataset.value === value) ?? available[0])?.focus();
    };
    trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      // Closed selectors are navigation controls. Only explicit OK/click opens choices.
      if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const available = options.filter((option) => !option.hidden);
      const current = available.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? available.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) %
              available.length;
      available[index]?.focus();
    });
    wrapper.addEventListener('focusout', (event) => {
      if (!wrapper.contains(event.relatedTarget as Node | null)) close();
    });
    wrapper.addEventListener('guide-dropdown-close', () => close(true));
    wrapper.append(trigger, menu);
    update();
    return wrapper;
  };
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
  const load = button('Save source and preview', () =>
    run(async (signal) => {
      if (!sourceName.field.value.trim()) throw new Error('Name required');
      await discard();
      const result = await host.preview(
        {
          name: sourceName.field.value.trim(),
          location: selectedFile?.location ?? sourceUrl.field.value.trim(),
          kind: selectedFile ? 'file' : 'url',
          allowHttp: grant.field.checked,
        },
        signal,
      );
      await acceptPreview(result, signal);
      showPreview();
      reload();
    }),
  );
  const pick = button('Choose XMLTV file', () =>
    run(async (signal) => {
      selectedFile = (await host.pickFile?.(signal)) ?? null;
      if (selectedFile) {
        sourceName.field.value = selectedFile.name;
        sourceUrl.field.value = '';
        status.textContent = 'Guide file selected. Preview it before saving schedule data.';
      }
    }),
  );
  pick.hidden = !host.pickFile;
  const findGuides = button('Find program guides', () =>
    run(async (signal) => {
      if (!advancedMode && host.buildForChannels) {
        automaticMessage('Finding program guides…', true);
        const result = await host.buildForChannels(signal);
        signal.throwIfAborted();
        if (disposed || !foreground) return;
        automaticResult(result);
        reload();
        return;
      }
      const result = await host.discover!(signal);
      signal.throwIfAborted();
      if (disposed || !foreground) return;
      if (result.candidates.length > GUIDE_SOURCE_LIMIT || result.outcomes.length > 100)
        throw new Error('Guide discovery limit');
      discoveryRows.replaceChildren();
      for (const candidate of result.candidates) {
        const row = document.createElement('li');
        row.append(
          button(`${candidate.name} · ${candidate.playlistNames.join(', ')}`, () => {
            if (disposed || busy || !foreground) return;
            selectedFile = null;
            sourceName.field.value = candidate.name;
            sourceUrl.field.value = candidate.location;
            grant.field.checked = false;
            manualSource.open = true;
            status.textContent = candidate.requiresHttpPermission
              ? 'Guide link selected. This link requires your explicit HTTP permission before preview.'
              : 'Guide link selected. Preview it, review the counts, then save its programs.';
            if (!advancedMode && !candidate.requiresHttpPermission) load.click();
            else {
              advancedMode = true;
              setView('sources');
              sourceName.field.focus();
            }
          }),
        );
        if (candidate.limitations) row.append(text('p', candidate.limitations));
        discoveryRows.append(row);
      }
      const failed = result.outcomes.filter((outcome) => outcome.status === 'failed').length;
      status.textContent = result.candidates.length
        ? `${result.candidates.length} possible program guides found.${failed ? ` ${failed} playlists could not be checked.` : ''} Choose one to preview.`
        : `Your saved playlists did not include a program-guide link.${failed ? ` ${failed} playlists could not be checked.` : ''} You can add a guide link or file below.`;
    }),
  );
  const findEmpty = button('Find program guides', () => {
    if (!advancedMode && host.buildForChannels) {
      findGuides.click();
      return;
    }
    sourceTask.value = 'add';
    setView('sources');
    findGuides.click();
  });
  findEmpty.hidden = true;
  const mapEmpty = button('Map guide', () => {
    browsed = chosen();
    mapSearch.field.value = browsed?.name.slice(0, 256) ?? '';
    setView('mapping');
    reload();
  });
  mapEmpty.hidden = true;
  const returnGuide = button('Go back to Guide', () => {
    advancedMode = false;
    setView('channel');
    reload();
  });
  returnGuide.hidden = true;
  findGuides.hidden = !host.discover && !host.buildForChannels;
  const save = button('Save reviewed schedule', () =>
    run(async (signal) => {
      if (!preview) return;
      const receipt = await host.commitPreview(preview.ticket, signal);
      if (receipt.committed !== true) throw new Error('Missing receipt');
      preview = null;
      showPreview();
      status.textContent =
        receipt.matched !== undefined && receipt.unmatched !== undefined
          ? `Programs saved. ${receipt.matched} channels connected; ${receipt.unmatched} still need a guide.`
          : 'Reviewed guide schedule saved.';
      reload();
    }, true),
  );
  const discardButton = button('Discard schedule preview', () =>
    run(async () => {
      await discard();
      status.textContent = 'Schedule preview discarded. Saved source configuration retained.';
    }),
  );
  const lookup = button('Find guide channels', () => {
    afterId = null;
    lookupChannels();
  });
  const lookupNext = button('More guide channels', () => {
    afterId = nextId;
    lookupChannels();
  });
  const mapSave = button('Map selected channel', () =>
    run(async (signal) => {
      const channel = browsed ?? host.selectedChannel();
      if (!channel || !mapSource.value || !mapChannel.value) throw new Error('Mapping missing');
      const mapping = Object.freeze({
        catalogSourceId: channel.sourceId,
        appChannelId: channel.id,
        guideSourceId: mapSource.value,
        xmltvChannelId: mapChannel.value,
      });
      let mappingSaved = false;
      try {
        if (host.mapAndHydrate) {
          const result = await host.mapAndHydrate(mapping, signal, () => {
            mappingSaved = true;
            committing = false;
            automaticMessage('Guide connection saved. Checking its schedule…', true);
            if (disposed || suspending || !foreground) actionController?.abort();
            controls();
          });
          if (!disposed && foreground && !signal.aborted)
            automaticMessage(mappedGuideResultText(result));
        } else {
          await host.setMapping(mapping, signal);
          mappingSaved = true;
          status.textContent = 'Program guide connected.';
        }
      } catch (failure) {
        if (mappingSaved && !disposed && foreground)
          automaticMessage(
            'Guide connection saved. Schedule cleanup could not be confirmed. Retry closing.',
          );
        throw failure;
      } finally {
        if (mappingSaved) {
          cursor = null;
          if (!disposed && foreground && !signal.aborted) {
            if (!advancedMode) setView('channel');
            reload();
          }
        }
      }
    }, true),
  );
  const manageAction = button('Run source action', () =>
    run(async (signal) => {
      if (!managedSource.value) throw new Error('Source missing');
      if (sourceAction.value === 'remove') {
        await host.removeSource(managedSource.value, signal);
        status.textContent = 'Guide source removed. Catalog channels retained.';
        reload();
      } else {
        await discard();
        await acceptPreview(await host.preview({ sourceId: managedSource.value }, signal), signal);
        showPreview();
      }
    }, sourceAction.value === 'remove'),
  );
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
  function liveScope(): boolean {
    return day === 0 && programView === 'channel' && cursor === null;
  }
  function summaryChannel(): GuideCatalogChannel | null {
    return !detail.hidden && detailState ? detailState.channel : chosen();
  }
  function summaryActive(): boolean {
    return (!detail.hidden && !!detailState) || (!programsPanel.hidden && liveScope());
  }
  function canonicalKey(): string {
    const channel = chosen();
    return JSON.stringify([
      host.catalogRevision?.() ?? null,
      !!host.summary,
      channel?.sourceId,
      channel?.id,
      host
        .channels?.()
        .some((entry) => entry.id === channel?.id && entry.sourceId === channel.sourceId) ?? true,
    ]);
  }
  function scopeKey(): string {
    const channel = summaryChannel();
    return JSON.stringify([
      channel?.sourceId,
      channel?.id,
      host.catalogRevision?.() ?? null,
      !!host.summary,
    ]);
  }
  function syncSummary(force = false): Promise<void> {
    catalogKey = canonicalKey();
    const key = summaryActive() && foreground && dialog.open ? scopeKey() : '';
    if (!force && key === summaryKey) return Promise.resolve();
    summaryKey = key;
    ++summaryGeneration;
    const channel = summaryChannel(),
      revision = host.catalogRevision?.();
    current.textContent = '';
    if (!key || !channel || !revision || !host.summary) {
      return summaryOwner.setSelection(null).then(() => {
        renderComplete();
        updateDetail();
      });
    }
    return summaryOwner.setSelection({
      catalogSourceId: channel.sourceId,
      appChannelId: channel.id,
      catalogRevision: revision,
      selectionGeneration: summaryGeneration,
    });
  }
  function renderComplete(): void {
    if (disposed) return;
    if (!liveScope()) {
      current.textContent = `Schedule snapshot as of ${host.formatTime(pageAnchor?.instant ?? host.now())}. Current / next is not summarized for this page.`;
      return;
    }
    if (complete.status === 'ready' && complete.summary) {
      const value = channelGuideText(
        {
          catalogSourceId: complete.summary.catalogSourceId,
          appChannelId: complete.summary.appChannelId,
          status: 'ready',
          summary: complete.summary,
        },
        host.formatTime,
      );
      current.textContent = `${value.current}${value.next ? ' · ' + value.next : ''}`;
    } else
      current.textContent =
        complete.status === 'loading'
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
    return `${host.formatTime(program.startMs)} · ${programView === 'search' ? channel.name + ' · ' : ''}${program.title} · ${conflict ? 'Overlap observed on this page · ' : ''}${live ? timing : 'As of ' + host.formatTime(instant) + ' · ' + timing}`;
  }
  function updateTiming(): void {
    if (disposed) return;
    for (const [control, value] of timingRows)
      control.textContent = timingLabel(
        value.program,
        value.channel,
        value.conflict,
        value.live ? host.now() : value.snapshot,
        value.live,
      );
  }
  function eligibleDetail(): boolean {
    if (!detailState || !foreground || complete.status !== 'ready' || !complete.summary)
      return false;
    const { program, channel } = detailState;
    const summary = complete.summary,
      known = summary.current,
      instant = host.now();
    return (
      summary.catalogRevision === host.catalogRevision?.() &&
      (!host.channels ||
        host
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
    if (!detailState || disposed) return;
    const eligible = eligibleDetail(),
      { action, message, program } = detailState;
    const instant = host.now();
    if (eligible) detailState.wasVisible = true;
    action.hidden = !detailState.wasVisible;
    action.disabled = !eligible;
    message.textContent = eligible
      ? 'Current listing confirmed by the complete cached guide. Watch channel starts the live stream.'
      : program.stopMs !== null && program.stopMs <= instant
        ? 'This listing has ended. Return to the current channel guide.'
        : program.startMs > instant
          ? 'Scheduled listing only. Future programs cannot play early.'
          : 'Current listing is unconfirmed or ambiguous. Review the current channel guide.';
    if (!eligible && document.activeElement === action) back.focus({ preventScroll: true });
  }
  function chosen(): GuideCatalogChannel | null {
    return browsed ?? host.selectedChannel();
  }
  function setView(target: string): void {
    for (const option of view.querySelectorAll<HTMLElement>('[role="option"]'))
      option.hidden = !advancedMode && ['sources', 'mapping'].includes(option.dataset.value ?? '');
    const compactPage =
      host.presentation === 'page' && !!timeline && !advancedMode && target === 'channel';
    view.hidden = compactPage || (!advancedMode && target === 'sources');
    sourceTask.hidden = !advancedMode;
    manualSource.hidden = !advancedMode;
    findGuides.hidden = advancedMode ? !host.discover : !host.discover && !host.buildForChannels;
    explanation.hidden = !advancedMode;
    returnGuide.hidden = !(advancedMode || target === 'sources' || target === 'mapping');
    findEmpty.hidden =
      target !== 'mapping' || advancedMode || (!host.discover && !host.buildForChannels);
    mapEmpty.hidden = true;
    if (target === 'channel' || target === 'search') programView = target;
    if (target !== 'detail') view.value = target;
    timelinePanel.hidden = !timeline || advancedMode || target !== 'channel';
    programsPanel.hidden = !timelinePanel.hidden || (target !== 'channel' && target !== 'search');
    dialog.classList.toggle('guide-with-timeline', !timelinePanel.hidden);
    dialog.classList.toggle('guide-compact-page', compactPage);
    const timelineToolbar = timelinePanel.querySelector('.gx-timeline-toolbar');
    if (compactPage && timelineToolbar) {
      timelineToolbar.append(findEmpty, mapEmpty, cancel, close);
    } else {
      header.append(mapEmpty, cancel, close);
      dialog.insertBefore(feedback, body);
      dialog.insertBefore(findEmpty, body);
    }
    if (timeline && timelinePanel.hidden)
      void timeline.suspend().catch(() => {
        if (!disposed)
          error.textContent = 'Guide timeline cleanup could not finish. Close Guide and retry.';
      });
    settings.hidden = target !== 'sources';
    mappingPanel.hidden = target !== 'mapping';
    if (target === 'mapping')
      mapHeading.textContent = `Map guide for ${chosen()?.name ?? 'your channel'}`;
    browsePanel.hidden = target !== 'choose';
    detail.hidden = target !== 'detail';
    channelTools.hidden = target !== 'choose';
    searchDetails.hidden = programView !== 'search';
    back.hidden = target !== 'detail';
    body.dataset.view = target;
    sourceViews();
    void syncSummary().catch(() => {
      if (!disposed)
        error.textContent = 'Current / next activity could not settle. Retry or close Guide.';
    });
  }
  function restoreProgramFocus(): void {
    const previous = lastProgramFocus?.isConnected
      ? lastProgramFocus
      : [...timingRows.entries()].find(
          ([, value]) =>
            detailState &&
            value.channel.id === detailState.channel.id &&
            value.channel.sourceId === detailState.channel.sourceId &&
            identity(value.program) === identity(detailState.program),
        )?.[0];
    (previous ?? rows.querySelector<HTMLButtonElement>('button') ?? close).focus({
      preventScroll: true,
    });
  }
  function sourceViews(): void {
    addSourcePanel.hidden = sourceTask.value !== 'add';
    manageSourcePanel.hidden = sourceTask.value !== 'manage';
    previewPanel.hidden = sourceTask.value !== 'preview';
  }
  function showPreview(): void {
    previewSummary.textContent = preview
      ? `${preview.channels} guide channels · ${preview.programs} programs. ${preview.firstStartMs === null || preview.lastKnownStopMs === null ? 'Coverage unknown.' : `${host.formatTime(preview.firstStartMs)} – ${host.formatTime(preview.lastKnownStopMs)}.`}`
      : 'No schedule preview. Choose Add source or Manage sources to prepare one.';
    if (preview) {
      sourceTask.value = 'preview';
      setView('sources');
    }
    sourceViews();
    controls();
  }
  function controls(): void {
    const toolbar = timelinePanel.querySelector('.gx-timeline-toolbar');
    if (dialog.classList.contains('guide-compact-page') && toolbar) {
      if (busy || automaticStatus.textContent || error.textContent) toolbar.after(feedback);
      else toolbar.insertBefore(feedback, findEmpty);
    }
    feedback.hidden =
      !busy &&
      !error.textContent &&
      !automaticStatus.textContent &&
      rows.children.length > 0 &&
      !programsPanel.hidden;
    load.disabled = busy;
    findGuides.disabled = busy;
    findEmpty.disabled = busy;
    pick.disabled = busy;
    save.disabled = busy || !preview;
    discardButton.disabled = busy || !preview;
    mapSave.disabled = busy || !mapSource.value || !mapChannel.value || !chosen();
    cancel.disabled = !busy || committing;
    close.disabled = committing;
    cancel.hidden = !busy;
    dayChoice.disabled = busy;
    dayChoice.value = String(day);
    view.disabled = busy;
    sourceTask.disabled = busy;
    managedSource.disabled = busy;
    sourceAction.disabled = busy;
    manageAction.disabled = busy || !managedSource.value;
    nextPage.disabled = busy || !nextCursor;
    firstPage.disabled = busy || !cursor;
    now.disabled = busy;
    for (const option of programAction.options)
      option.disabled = programActions.get(option.value)?.disabled ?? true;
    programAction.disabled = busy;
    programRun.disabled = busy || (programActions.get(programAction.value)?.disabled ?? true);
    lookupNext.disabled = busy || !nextId;
    lookup.disabled = busy || !mapSource.value;
    sourceName.field.disabled = busy;
    sourceUrl.field.disabled = busy;
    grant.field.disabled = busy;
    mapSource.disabled = busy;
    mapSearch.field.disabled = busy;
    mapChannel.disabled = busy;
    catalogSelect.disabled = busy;
    searchPrograms.disabled = busy;
  }
  async function discard(): Promise<void> {
    if (preview) discardTickets.add(preview.ticket);
    for (const ticket of discardTickets) {
      try {
        await host.discardPreview(ticket);
      } catch {
        throw new Error('Guide preview cleanup could not be confirmed.');
      }
      discardTickets.delete(ticket);
      if (preview?.ticket === ticket) preview = null;
    }
    showPreview();
  }
  async function acceptPreview(result: GuidePreview, signal: AbortSignal): Promise<void> {
    if (disposed || signal.aborted) {
      discardTickets.add(result.ticket);
      await host.discardPreview(result.ticket);
      discardTickets.delete(result.ticket);
      signal.throwIfAborted();
      return;
    }
    preview = result;
  }
  function renderChannels(): void {
    const selected = chosen();
    const query = catalogSearch.field.value.trim().toLowerCase();
    const list = host.channels?.() ?? (selected ? [selected] : []);
    const options = list
      .filter((channel) => channel.name.toLowerCase().includes(query))
      .slice(0, 50);
    catalogSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Browse channels · up to 50 matches`;
    catalogSelect.append(placeholder);
    for (const channel of options) {
      const option = document.createElement('option');
      option.value = JSON.stringify([channel.sourceId, channel.id]);
      option.textContent = channel.name;
      option.selected = selected?.id === channel.id && selected.sourceId === channel.sourceId;
      catalogSelect.append(option);
    }
  }
  function renderSources(): void {
    const searchRemembered = searchSource.value;
    searchSource.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All guides';
    searchSource.append(all);
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      option.selected = source.id === searchRemembered;
      searchSource.append(option);
    }
    const remembered = mapSource.value;
    const managedRemembered = managedSource.value;
    const matches = sources.filter((source) =>
      source.name.toLowerCase().includes(sourceSearch.field.value.trim().toLowerCase()),
    );
    sourceRows.replaceChildren();
    managedSource.replaceChildren();
    mapSource.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Choose a guide source';
    mapSource.append(empty);
    for (const source of matches.slice(0, 50)) {
      const managedOption = document.createElement('option');
      managedOption.value = source.id;
      managedOption.textContent = source.name;
      managedOption.selected = source.id === managedRemembered;
      managedSource.append(managedOption);
    }
    // Mapping choices must not inherit a hidden Advanced source-management search.
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      option.selected = source.id === remembered;
      mapSource.append(option);
    }
    sourceRows.prepend(text('li', `${matches.length} source matches; showing up to 50.`));
    if (!mappingPanel.hidden && !advancedMode && !mapSource.value && sources.length === 1) {
      mapSource.value = sources[0].id;
    }
    if (!mappingPanel.hidden && !advancedMode && mapSource.value) {
      afterId = null;
      lookupChannels();
    }
    controls();
  }
  function reload(continuation = false): void {
    if (disposed || suspending || !foreground || !dialog.open) return;
    if (!continuation) {
      cursor = null;
      pageAnchor = null;
    }
    void syncSummary(!continuation).catch(() => {
      if (!disposed)
        error.textContent = 'Current / next activity could not settle. Retry Now or close Guide.';
    });
    const captured = {
      searching: programView === 'search',
      channel: structuredClone(chosen()),
      fallbackChannel: structuredClone(host.channels?.()[0] ?? null),
      day,
      search: programSearch.field.value,
      searchSource: searchSource.value,
      cursor: structuredClone(cursor),
      anchor: pageAnchor,
      instant: host.now(),
    };
    const signature = JSON.stringify([
      captured.searching,
      captured.channel?.sourceId ?? null,
      captured.channel?.id ?? null,
      captured.day,
      captured.search,
      captured.searchSource,
    ]);
    viewController?.abort();
    const epoch = ++viewEpoch;
    const controller = new AbortController();
    viewController = controller;
    viewWork = viewWork
      .catch(() => {})
      .then(async () => {
        if (epoch !== viewEpoch || disposed || controller.signal.aborted) return;
        try {
          await timeline?.suspend();
          if (epoch !== viewEpoch || disposed || controller.signal.aborted) return;
          const fetched = await Promise.allSettled([
            host.sources(controller.signal),
            host.mappings(controller.signal),
          ]);
          if (fetched[0].status !== 'fulfilled' || fetched[1].status !== 'fulfilled')
            throw new Error('Guide configuration unavailable');
          if (epoch !== viewEpoch || disposed || controller.signal.aborted) return;
          sources = fetched[0].value;
          const allMappings = fetched[1].value;
          const selected = chosen();
          mapEmpty.hidden =
            advancedMode ||
            !selected ||
            !mappingPanel.hidden ||
            allMappings.some(
              (mapping) =>
                mapping.catalogSourceId === selected.sourceId &&
                mapping.appChannelId === selected.id &&
                sources.some((source) => source.id === mapping.guideSourceId),
            );
          renderSources();
          renderChannels();
          if (timeline && !timelinePanel.hidden) {
            // Links indexed once by channel: filtering every link for each of
            // ~9,000 channels took about 2 s on the Sansui TV per opening
            // (October 19, 2026). Same result: exactly one usable link counts.
            const revisions = new Map(sources.map((source) => [source.id, source.revision]));
            const links = new Map<string, (typeof allMappings)[number][]>();
            for (const entry of allMappings) {
              if (!revisions.has(entry.guideSourceId)) continue;
              const key = JSON.stringify([entry.catalogSourceId, entry.appChannelId]);
              const list = links.get(key);
              if (list) list.push(entry);
              else links.set(key, [entry]);
            }
            timelineChannels = (host.channels?.() ?? []).map((channel) => {
              const matches = links.get(JSON.stringify([channel.sourceId, channel.id])) ?? [];
              const mapping = matches.length === 1 ? matches[0] : null;
              return {
                ...channel,
                guideSourceId: mapping?.guideSourceId ?? null,
                xmltvChannelId: mapping?.xmltvChannelId ?? null,
                ...(mapping ? { guideRevision: revisions.get(mapping.guideSourceId)! } : {}),
              };
            });
            title.textContent = 'Program guide';
            const connected = timelineChannels.filter(
              (channel) => channel.guideSourceId !== null,
            ).length;
            const connectionStatus = connected
              ? `${connected} of ${timelineChannels.length} channels linked to program guides. Links do not confirm available schedules.`
              : 'No program guide connected yet.';
            status.textContent = host.listedChannels
              ? 'Checking saved listings…'
              : dialog.classList.contains('guide-compact-page')
                ? `${connected} of ${timelineChannels.length} linked`
                : connectionStatus;
            status.title = host.listedChannels ? status.textContent : connectionStatus;
            status.setAttribute('aria-label', status.title);
            findEmpty.hidden = !host.discover && !host.buildForChannels;
            await timeline.setForeground(true);
            return;
          }
          const searching = captured.searching;
          const channel = captured.channel ?? (searching ? captured.fallbackChannel : null);
          timingRows.clear();
          rows.replaceChildren();
          nextCursor = null;
          renderComplete();
          freshness.textContent = '';
          if (!sources.length) {
            status.textContent = 'No program guide saved yet.';
            findEmpty.hidden =
              (!host.discover && !host.buildForChannels) ||
              advancedMode ||
              (programsPanel.hidden && mappingPanel.hidden);
            return;
          }
          if (!channel) {
            status.textContent = 'Choose a channel to browse its guide.';
            return;
          }
          title.textContent = searching ? 'Program search' : `${channel.name} · Program guide`;
          const mappings = fetched[1].value.filter(
            (mapping) =>
              mapping.catalogSourceId === channel.sourceId && mapping.appChannelId === channel.id,
          );
          if (!searching && mappings.length !== 1) {
            status.textContent = mappings.length
              ? 'Channel mapping is ambiguous. Review its guide source.'
              : 'No program guide is connected to this channel yet.';
            if (advancedMode && !programsPanel.hidden) setView('mapping');
            else
              findEmpty.hidden =
                (!host.discover && !host.buildForChannels) ||
                (programsPanel.hidden && mappingPanel.hidden);
            return;
          }
          const mapping =
            mappings[0] ??
            allMappings.find((entry) =>
              sources.some((source) => source.id === entry.guideSourceId),
            );
          if (!mapping) {
            status.textContent =
              'No guide channels mapped. Map a catalog channel before searching programs.';
            if (advancedMode && !programsPanel.hidden) setView('mapping');
            else
              findEmpty.hidden =
                (!host.discover && !host.buildForChannels) ||
                (programsPanel.hidden && mappingPanel.hidden);
            return;
          }
          const source = sources.find((source) => source.id === mapping.guideSourceId);
          if (!source) {
            status.textContent = 'Mapped guide source is unavailable. Mapping retained.';
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
            pageAnchor = {
              signature,
              instant,
              start,
              end,
              mapping: mappingKey,
            };
          status.textContent = `Schedule: ${host.formatTime(start)} – ${host.formatTime(end)}`;
          const response = await host.query(
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
                    sources.some((source) => source.id === entry.guideSourceId) &&
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
            !searching && host.coverage ? await host.coverage(source.id, controller.signal) : null;
          let channelCoverage: ChannelCoverageReply | null = null;
          if (!searching && host.channelCoverage) {
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
                await host.channelCoverage(coverageQuery, controller.signal),
                coverageQuery,
              );
            } catch (failure) {
              if (failure instanceof ChannelCoverageCleanupError) throw failure;
              // Coverage is observational; unavailable assessment must not hide saved listings.
            }
          }
          if (epoch !== viewEpoch || disposed || controller.signal.aborted) return;
          nextCursor = response.nextCursor;
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
            ? describeChannelCoverage(channelCoverage, (instant) => host.formatTime(instant))
            : 'Channel schedule coverage not assessed. Listings do not confirm stream availability.';
          freshness.textContent = `${age}${updated !== null ? ` · ${host.formatTime(updated)}` : ''} · ${bounds}. ${channelBounds}`;
          if (searching)
            freshness.textContent = `${captured.searchSource ? 'Searching the selected guide' : 'Searching all configured guides'}. Feed freshness and time coverage may differ; a seven-day search does not guarantee complete listings or stream availability.`;
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
          renderComplete();
          if (!programs.length) rows.append(text('li', 'No schedule for this period.'));
          for (const [index, program] of programs.entries()) {
            const mapped = response.programs[index];
            const owner = (host.channels?.() ?? [channel]).find(
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
            const control = button('', () => showDetail(mapped, owner, conflict));
            timingRows.set(control, {
              program: mapped,
              channel: owner,
              conflict,
              snapshot: instant,
              live: !searching && captured.day === 0 && !captured.cursor,
            });
            control.textContent = timingLabel(
              mapped,
              owner,
              conflict,
              instant,
              !searching && captured.day === 0 && !captured.cursor,
            );
            item.append(control);
            rows.append(item);
          }
          error.textContent = '';
        } catch (failure) {
          if (failure instanceof ChannelCoverageCleanupError) throw failure;
          if (!disposed && epoch === viewEpoch && !controller.signal.aborted) {
            error.textContent =
              'Guide could not load. Retry Now or review the source and mapping; previous saved data is retained.';
          }
        } finally {
          if (!disposed && epoch === viewEpoch) controls();
        }
      });
    void viewWork.catch(() => {
      if (!disposed) error.textContent = 'Guide cleanup could not be confirmed. Retry closing.';
    });
  }
  function showDetail(
    program: MappedProgram,
    channel: GuideCatalogChannel,
    _conflict: boolean,
  ): void {
    detail.replaceChildren(
      text('h3', program.title),
      text('p', program.description ?? 'No description supplied.'),
      text(
        'p',
        `${host.formatTime(program.startMs)} – ${program.stopMs === null ? 'End unknown' : host.formatTime(program.stopMs)}`,
      ),
    );
    const message = text('p', '');
    const action = button('Watch channel', () => {
      if (!eligibleDetail()) {
        updateDetail();
        return;
      }
      run((signal) => {
        if (!eligibleDetail()) throw new Error('Current listing changed.');
        return host.watch(channel, signal);
      });
    });
    detailState = { program, channel, action, message, wasVisible: false };
    detail.append(message, action);
    updateDetail();
    lastProgramFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setView('detail');
    back.focus();
  }
  function lookupChannels(): void {
    if (disposed || suspending || !foreground || !mapSource.value) return;
    lookupController?.abort();
    const epoch = ++lookupEpoch;
    const controller = new AbortController();
    lookupController = controller;
    const sourceId = mapSource.value;
    const search = mapSearch.field.value;
    const after = afterId;
    lookupWork = lookupWork
      .catch(() => {})
      .then(async () => {
        if (disposed || epoch !== lookupEpoch || controller.signal.aborted) return;
        try {
          const page = await host.guideChannels(
            { guideSourceId: sourceId, search, afterId: after, pageSize: 50 },
            controller.signal,
          );
          if (page.channels.length > 50) throw new Error('Guide channel page limit');
          if (
            disposed ||
            epoch !== lookupEpoch ||
            controller.signal.aborted ||
            mapSource.value !== sourceId
          )
            return;
          mapChannel.replaceChildren();
          for (const channel of page.channels) {
            const option = document.createElement('option');
            option.value = channel.id;
            option.textContent = channel.names.join(' · ') || channel.id;
            mapChannel.append(option);
          }
          nextId = page.nextCursor;
          mapStatus.textContent = page.channels.length
            ? `${page.channels.length} guide channels shown${page.nextCursor ? '; more available' : ''}. Match the station and region before saving.`
            : 'No matching schedule found in this guide. Try the station name or another guide source.';
        } catch {
          if (!disposed && !controller.signal.aborted)
            mapStatus.textContent =
              'Guide channels unavailable. Refresh this source or choose another.';
        } finally {
          controls();
        }
      });
  }
  function automaticMessage(message: string, pending = false): void {
    automaticPending = pending;
    automaticStatus.textContent = message;
    automaticStatus.hidden = !message;
    controls();
  }
  function automaticResult(result: Readonly<AutomaticGuideBuildResult>): void {
    const maintenance =
      result.maintenance === 'reopen-required'
        ? ' Storage verification failed. Close and reopen the app before continuing.'
        : result.maintenance === 'failed' || result.maintenance === 'deferred'
          ? ' Storage optimization is pending; saved guide results remain available.'
          : '';
    automaticMessage(
      `Guide check finished${result.failed ? ` · ${result.failed} could not be checked` : ''}${result.discoveryFailed ? ` · ${result.discoveryFailed} playlists could not be checked` : ''}${result.skipped ? ` · ${result.skipped} skipped` : ''}.${result.failed || result.discoveryFailed || result.skipped ? ' Previous schedules retained; try Find again.' : ' Schedule availability is shown per channel.'}${maintenance}`,
    );
  }
  function presentAutomaticProgress(progress: Readonly<AutomaticGuideBuildProgress>): void {
    if (disposed || suspending || !foreground) return;
    if (
      ![progress.total, progress.attempted].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= GUIDE_SOURCE_LIMIT,
      ) ||
      progress.attempted > progress.total ||
      ![progress.failed, progress.skipped, progress.discoveryFailed ?? 0].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100_000,
      )
    )
      return;
    const phases: Record<AutomaticGuideBuildProgress['phase'], string> = {
      capturing: 'Preparing guide check',
      'reading-playlists': 'Reading playlist guide links',
      'checking-cache': 'Checking saved schedules',
      fetching: 'Fetching schedules',
      publishing: 'Saving checked schedules',
      connecting: 'Linking channel guides',
      optimizing: 'Optimizing saved guides',
      completed: 'Guide check finished',
    };
    if (!phases[progress.phase]) return;
    if (progress.phase === 'completed') {
      automaticResult(progress);
      return;
    }
    automaticMessage(
      `${phases[progress.phase]}${progress.total ? ` · ${progress.attempted} of ${progress.total} feeds settled` : ''}${progress.failed ? ` · ${progress.failed} could not be checked` : ''}${progress.discoveryFailed ? ` · ${progress.discoveryFailed} playlists could not be checked` : ''}${progress.skipped ? ` · ${progress.skipped} skipped` : ''}`,
      true,
    );
  }
  function run(
    operation: (signal: AbortSignal) => Promise<void>,
    commit = false,
    closeAfter = false,
  ): void {
    if (disposed || suspending || !foreground || busy) return;
    busy = true;
    committing = commit;
    error.textContent = '';
    const controller = new AbortController();
    actionController = controller;
    controls();
    actionWork = (async () => {
      try {
        await operation(controller.signal);
        if (closeAfter && !disposed && !controller.signal.aborted) await closeGuide(true);
      } catch {
        if (automaticPending) automaticMessage('');
        if (!disposed)
          error.textContent = controller.signal.aborted
            ? 'Operation canceled. Saved source configuration and previous schedule are retained.'
            : 'Guide action failed. Previous schedule retained; retry or review the source and mapping.';
      } finally {
        busy = false;
        committing = false;
        actionController = null;
        if (!disposed) controls();
      }
    })();
  }
  function suspend(): Promise<void> {
    // A second background signal must revoke a foreground intent even while
    // the first suspension is still joining the same actual operations.
    foreground = false;
    if (suspension) return suspension;
    if (disposed) return Promise.resolve();
    suspending = true;
    summaryKey = '';
    ++summaryGeneration;
    const summaryDrain = summaryOwner.suspend();
    const publication = committing;
    ++viewEpoch;
    ++lookupEpoch;
    viewController?.abort();
    lookupController?.abort();
    if (!publication) actionController?.abort();
    // A publication that already crossed its atomic boundary wins cancellation.
    // Keep the suspension gate until every owned promise settles so its reload
    // cannot silently restart activity in the background.
    suspension = Promise.allSettled([
      viewWork,
      lookupWork,
      actionWork,
      summaryDrain,
      timeline?.suspend(),
    ])
      .then(async (settled) => {
        await host.settleMappingHydration?.();
        const failures = settled.filter((result) => result.status === 'rejected');
        if (failures.length) throw new Error('Guide activity cleanup could not be confirmed.');
        if (!disposed && !publication && !foreground) {
          if (automaticPending) automaticMessage('');
          error.textContent = '';
          status.textContent = 'Guide activity paused in the background. Retry when ready.';
          controls();
        }
      })
      .finally(() => {
        suspending = false;
        suspension = null;
      });
    return suspension;
  }
  function closeGuide(skipAction = false): Promise<void> {
    if (!skipAction && closing) return closing;
    if (committing) return Promise.reject(new Error('Guide publication is still settling.'));
    ++presentationEpoch;
    const attempt = drainAndHide(skipAction);
    if (!skipAction) {
      closing = attempt;
      const settled = () => {
        if (closing === attempt) closing = null;
      };
      void attempt.then(settled, settled);
    }
    return attempt;
  }
  async function drainAndHide(skipAction: boolean, skipOpening = false): Promise<void> {
    if (!skipOpening) await opening;

    viewController?.abort();
    lookupController?.abort();
    if (!skipAction) actionController?.abort();
    summaryKey = '';
    ++summaryGeneration;
    const settled = await Promise.allSettled([
      viewWork,
      lookupWork,
      skipAction ? Promise.resolve() : actionWork,
      summaryOwner.setSelection(null),
      timeline?.suspend(),
    ]);
    if (settled.some((result) => result.status === 'rejected'))
      throw new Error('Guide activity cleanup could not be confirmed.');
    await host.settleMappingHydration?.();
    await discard();
    if (!disposed) {
      const wasOpen = dialog.open;
      dialog.close();
      dialog.removeAttribute('data-primary-page');
      if (pagePresented) {
        await host.closed?.();
        pagePresented = false;
      }
      if (wasOpen) returnFocus?.focus();
    }
  }
  function openPresentation(page: boolean, configure: () => void): Promise<void> {
    if (disposed) return Promise.resolve();
    const epoch = ++presentationEpoch;
    const prior = opening;
    const drain = closing;
    const attempt = (async () => {
      if (prior) await prior;
      if (drain) await drain;
      if (disposed || epoch !== presentationEpoch) return;
      if ((dialog.open && pagePresented !== page) || (!dialog.open && pagePresented)) {
        await drainAndHide(false, true);
        if (disposed || epoch !== presentationEpoch) return;
      }
      configure();
      if (!dialog.open) {
        if (page) {
          container.append(dialog);
          dialog.dataset.primaryPage = 'guide';
          dialog.show();
          pagePresented = true;
          await host.opened?.();
        } else {
          if (host.presentation === 'page') container.ownerDocument.body.append(dialog);
          dialog.removeAttribute('data-primary-page');
          dialog.showModal();
        }
      }
      if (!disposed && epoch === presentationEpoch && !closing && dialog.open) reload();
    })();
    opening = attempt;
    const settled = () => {
      if (opening === attempt) opening = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }
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
