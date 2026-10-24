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

import {
  validateScanCheckpointSummary,
  type ScanCheckpointSummary,
} from '../platform/scan-checkpoint-summary';

import {
  isScanPreparationFailureCode,
  type ScanPreparationFailureCode,
} from '../discovery/selection-failure';

import type { Source } from '../catalog/parser';
import { type HealthObservation } from '../discovery/health';

import type { SavedHealthPage } from '../application/health/health-history';
import { type GuideEnrichment, type PipelineReview } from '../discovery/pipeline';
import {
  scanConfiguredSources,
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
} from '../discovery/scan';
import { createAutomaticScanRuns } from './source-scan-automatic';
import { createSharedContext } from '../application/shell/shared-context';
import { createScanChecks } from './source-scan-checks';
import { createScanRuns } from './source-scan-runs';
import {
  type SourceScanHost,
  type AutomaticScanEntry,
  type AutomaticScanOptions,
  type SourceScanSnapshot,
  type AutomaticScanProgress,
  type ScanFailure,
  classifyScanFailure,
  scanFailureCode,
  type ScanResumeRefusal,
  normalizedScanQuery,
  type HealthCheckBudgetMs,
  type BoundedSourceScanResume,
} from './source-scan-model';

// The scan screen's types and errors are part of this module's interface too.
export * from './source-scan-model';

export function mountSourceScan(
  container: HTMLElement,
  host: SourceScanHost,
  _options: Record<string, never> = {},
): {
  open(sources?: readonly ScanSource[]): void;
  start(sources?: readonly ScanSource[]): void;
  reviewFile(source: Source, file: File): Promise<void>;
  prepareAutomaticEntry(): Promise<AutomaticScanEntry>;
  presentSavedSummary(summary: ScanCheckpointSummary, expectedGeneration: number): boolean;
  startAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): void;
  refreshAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): Promise<void>;
  rescanAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): void;
  continueAutomatic(options?: Pick<AutomaticScanOptions, 'presentation'>): Promise<void>;
  stopAutomatic(): Promise<void>;
  readonly automaticQuery: string;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): Readonly<SourceScanSnapshot>;
} {
  // What the parts of mountSourceScan in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      actionButtons: () => actionButtons,
      actions: () => actions,
      activeAutomaticQuery: () => activeAutomaticQuery,
      automaticChecksComplete: () => automaticChecksComplete,
      automaticMode: () => automaticMode,
      automaticPresentation: () => automaticPresentation,
      backgroundPaused: () => backgroundPaused,
      begin: () => begin,
      body: () => body,
      boundedCleanupRefusal: () => boundedCleanupRefusal,
      boundedResume: () => boundedResume,
      boundedSaved: () => boundedSaved,
      busy: () => busy,
      button: () => button,
      cancel: () => cancel,
      capturedSources: () => capturedSources,
      check: () => check,
      checkBudget: () => checkBudget,
      checkCaptured: () => checkCaptured,
      checkpoint: () => checkpoint,
      checkpointAdmissionLoaded: () => checkpointAdmissionLoaded,
      checkpointRestoreRefused: () => checkpointRestoreRefused,
      checkpointRevision: () => checkpointRevision,
      choose: () => choose,
      clear: () => clear,
      close: () => close,
      closed: () => closed,
      continueWork: () => continueWork,
      controller: () => controller,
      count: () => count,
      dialog: () => dialog,
      disposed: () => disposed,
      draftSources: () => draftSources,
      durableCheckpointAvailable: () => durableCheckpointAvailable,
      editOptions: () => editOptions,
      error: () => error,
      fileReview: () => fileReview,
      finish: () => finish,
      footer: () => footer,
      guideSuggestions: () => guideSuggestions,
      heading: () => heading,
      health: () => health,
      healthScope: () => healthScope,
      historyMode: () => historyMode,
      historyOffset: () => historyOffset,
      historyPage: () => historyPage,
      host: () => host,
      indexSuggestions: () => indexSuggestions,
      inputs: () => inputs,
      introduction: () => introduction,
      lastFailure: () => lastFailure,
      lastFailureCode: () => lastFailureCode,
      loadedHistoryOffset: () => loadedHistoryOffset,
      matches: () => matches,
      next: () => next,
      notifiedGeneration: () => notifiedGeneration,
      notifyProgress: () => notifyProgress,
      open: () => open,
      optionsPanel: () => optionsPanel,
      owner: () => owner,
      page: () => page,
      pendingPublications: () => pendingPublications,
      persistCheckpoint: () => persistCheckpoint,
      pipelineReview: () => pipelineReview,
      preparationFailure: () => preparationFailure,
      previous: () => previous,
      publish: () => publish,
      query: () => query,
      queryLabel: () => queryLabel,
      queryMatches: () => queryMatches,
      recordFailure: () => recordFailure,
      render: () => render,
      restoreSuspendedReview: () => restoreSuspendedReview,
      results: () => results,
      resumeRefusal: () => resumeRefusal,
      returnReview: () => returnReview,
      review: () => review,
      runAction: () => runAction,
      runScan: () => runScan,
      save: () => save,
      savedChecks: () => savedChecks,
      savedSummary: () => savedSummary,
      saving: () => saving,
      scan: () => scan,
      scanChecked: () => scanChecked,
      scanKind: () => scanKind,
      scanPhase: () => scanPhase,
      scanPublished: () => scanPublished,
      scanResponded: () => scanResponded,
      scanTotal: () => scanTotal,
      scopeRefusal: () => scopeRefusal,
      search: () => search,
      selected: () => selected,
      setup: () => setup,
      showAll: () => showAll,
      showAutomatic: () => showAutomatic,
      showOptions: () => showOptions,
      slowPass: () => slowPass,
      sourceLabels: () => sourceLabels,
      sourceNext: () => sourceNext,
      sourcePage: () => sourcePage,
      sourcePrevious: () => sourcePrevious,
      sourceResults: () => sourceResults,
      sourceSummary: () => sourceSummary,
      status: () => status,
      stopWork: () => stopWork,
      storedJobId: () => storedJobId,
      suggest: () => suggest,
      summaryCheckpointRevision: () => summaryCheckpointRevision,
      suspension: () => suspension,
      windowRetryLimit: () => windowRetryLimit,
      work: () => work,
    },
    {
      activeAutomaticQuery: (value: typeof activeAutomaticQuery) => (activeAutomaticQuery = value),
      automaticChecksComplete: (value: typeof automaticChecksComplete) =>
        (automaticChecksComplete = value),
      automaticMode: (value: typeof automaticMode) => (automaticMode = value),
      automaticPresentation: (value: typeof automaticPresentation) =>
        (automaticPresentation = value),
      backgroundPaused: (value: typeof backgroundPaused) => (backgroundPaused = value),
      boundedCleanupRefusal: (value: typeof boundedCleanupRefusal) =>
        (boundedCleanupRefusal = value),
      boundedResume: (value: typeof boundedResume) => (boundedResume = value),
      boundedSaved: (value: typeof boundedSaved) => (boundedSaved = value),
      busy: (value: typeof busy) => (busy = value),
      capturedSources: (value: typeof capturedSources) => (capturedSources = value),
      checkpoint: (value: typeof checkpoint) => (checkpoint = value),
      checkpointAdmissionLoaded: (value: typeof checkpointAdmissionLoaded) =>
        (checkpointAdmissionLoaded = value),
      checkpointRestoreRefused: (value: typeof checkpointRestoreRefused) =>
        (checkpointRestoreRefused = value),
      checkpointRevision: (value: typeof checkpointRevision) => (checkpointRevision = value),
      continueWork: (value: typeof continueWork) => (continueWork = value),
      controller: (value: typeof controller) => (controller = value),
      durableCheckpointAvailable: (value: typeof durableCheckpointAvailable) =>
        (durableCheckpointAvailable = value),
      fileReview: (value: typeof fileReview) => (fileReview = value),
      healthScope: (value: typeof healthScope) => (healthScope = value),
      historyMode: (value: typeof historyMode) => (historyMode = value),
      historyOffset: (value: typeof historyOffset) => (historyOffset = value),
      historyPage: (value: typeof historyPage) => (historyPage = value),
      lastFailure: (value: typeof lastFailure) => (lastFailure = value),
      lastFailureCode: (value: typeof lastFailureCode) => (lastFailureCode = value),
      loadedHistoryOffset: (value: typeof loadedHistoryOffset) => (loadedHistoryOffset = value),
      notifiedGeneration: (value: typeof notifiedGeneration) => (notifiedGeneration = value),
      owner: (value: typeof owner) => (owner = value),
      page: (value: typeof page) => (page = value),
      pendingPublications: (value: typeof pendingPublications) => (pendingPublications = value),
      pipelineReview: (value: typeof pipelineReview) => (pipelineReview = value),
      preparationFailure: (value: typeof preparationFailure) => (preparationFailure = value),
      restoreSuspendedReview: (value: typeof restoreSuspendedReview) =>
        (restoreSuspendedReview = value),
      resumeRefusal: (value: typeof resumeRefusal) => (resumeRefusal = value),
      review: (value: typeof review) => (review = value),
      savedSummary: (value: typeof savedSummary) => (savedSummary = value),
      saving: (value: typeof saving) => (saving = value),
      scanChecked: (value: typeof scanChecked) => (scanChecked = value),
      scanKind: (value: typeof scanKind) => (scanKind = value),
      scanPhase: (value: typeof scanPhase) => (scanPhase = value),
      scanPublished: (value: typeof scanPublished) => (scanPublished = value),
      scanResponded: (value: typeof scanResponded) => (scanResponded = value),
      scanTotal: (value: typeof scanTotal) => (scanTotal = value),
      scopeRefusal: (value: typeof scopeRefusal) => (scopeRefusal = value),
      showOptions: (value: typeof showOptions) => (showOptions = value),
      slowPass: (value: typeof slowPass) => (slowPass = value),
      sourceLabels: (value: typeof sourceLabels) => (sourceLabels = value),
      sourcePage: (value: typeof sourcePage) => (sourcePage = value),
      stopWork: (value: typeof stopWork) => (stopWork = value),
      storedJobId: (value: typeof storedJobId) => (storedJobId = value),
      summaryCheckpointRevision: (value: typeof summaryCheckpointRevision) =>
        (summaryCheckpointRevision = value),
      windowRetryLimit: (value: typeof windowRetryLimit) => (windowRetryLimit = value),
      work: (value: typeof work) => (work = value),
    },
  );
  const scanRuns = createScanRuns(shared);
  const { begin, finish, render, runScan, snapshot, runHistory, runSave } = scanRuns;
  const scanChecks = createScanChecks(shared);
  const { checkCaptured, persistCheckpoint, runCheck, runGuideReview, indexSuggestions } =
    scanChecks;

  const button = (label: string, action: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  };
  const trigger = button('Scan sources', () => open());
  const dialog = document.createElement('dialog');
  dialog.className = 'source-scan-dialog';
  dialog.setAttribute('aria-label', 'Review source scan');
  const heading = document.createElement('h2');
  heading.textContent = 'Find channels';
  const queryLabel = document.createElement('label');
  queryLabel.textContent = 'Channel or category';
  const query = document.createElement('input');
  query.type = 'search';
  query.maxLength = 256;
  queryLabel.append(query);
  const checkBudgetLabel = document.createElement('label');
  checkBudgetLabel.textContent = 'Channel check time';
  const checkBudget = document.createElement('select');
  checkBudget.setAttribute('aria-label', 'Channel check time');
  for (const [value, label] of [
    ['20000', '20 seconds'],
    ['45000', '45 seconds'],
    ['60000', '60 seconds'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    checkBudget.append(option);
  }
  checkBudgetLabel.append(checkBudget);
  checkBudgetLabel.hidden = !host.probe;
  const checkHint = document.createElement('p');
  checkHint.textContent =
    'Maximum wait for each channel. Scan checks every collected channel; Cancel keeps your saved channels. A response check does not confirm decoded playback.';
  checkHint.hidden = !host.probe;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const sourceResults = document.createElement('ul');
  sourceResults.setAttribute('aria-label', 'Source results');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Channel, category or source';
  search.setAttribute('aria-label', 'Search scan results');
  const results = document.createElement('ul');
  results.className = 'scan-candidates';
  results.setAttribute('aria-label', 'Candidate channels');
  const count = document.createElement('p');
  let closed = false;
  let disposed = false;
  let busy = false;
  let saving = false;
  let scanPhase: SourceScanSnapshot['phase'] = 'idle';
  // The Slow list check, the full time limit for streams the triage left.
  let slowPass = false;
  let scanKind: AutomaticScanProgress['scanKind'];
  let scanTotal = 0,
    scanChecked = 0,
    scanResponded = 0,
    scanPublished = 0;
  let pendingPublications = 0;
  let windowRetryLimit: 64 | 256 = 256;
  let lastFailure: ScanFailure = 'none';
  let lastFailureCode: string | undefined;
  let preparationFailure: ScanPreparationFailureCode | undefined;
  let notifiedGeneration = 0;
  const recordFailure = (failure: unknown, publication = false) => {
    if (closed) return;
    const code = failure instanceof Error ? failure.message : failure;
    if (isScanPreparationFailureCode(code)) preparationFailure = code;
    const category = classifyScanFailure(failure, publication);
    if ((category !== 'other' && category !== 'canceled') || lastFailure === 'none') {
      lastFailure = category;
      lastFailureCode = scanFailureCode(failure);
    }
    scanPhase = lastFailure === 'canceled' ? 'paused' : 'failed';
  };
  const publish = async (...args: Parameters<SourceScanHost['commit']>) => {
    pendingPublications++;
    try {
      return await host.commit(...args);
    } catch (failure) {
      recordFailure(failure, true);
      throw failure;
    } finally {
      pendingPublications--;
    }
  };
  let automaticMode = false;
  let automaticPresentation: 'inline' | 'dialog' = 'dialog';
  let activeAutomaticQuery = '';
  let savedSummary: AutomaticScanProgress['savedSummary'];
  let summaryCheckpointRevision: string | undefined;
  let resumeRefusal: ScanResumeRefusal | undefined;
  let continueWork: Promise<void> | null = null;
  let scopeRefusal: 'query-changed' | null = null;
  function showAutomatic(): void {
    if (automaticPresentation === 'inline') {
      if (dialog.open) dialog.close();
    } else if (!dialog.open) dialog.showModal();
  }
  function notifyProgress(): void {
    if (!automaticMode || closed) return;
    try {
      host.onProgress?.(
        Object.freeze({
          ...snapshot(),
          canContinue:
            resumeRefusal === undefined &&
            (savedSummary === 'unfinished' ||
              (checkpoint !== null && scanPhase !== 'completed') ||
              (boundedSaved !== null && !boundedSaved.completed)),
          query: activeAutomaticQuery,
          presentation: automaticPresentation,
          status: (status.textContent ?? '').slice(0, 512),
          error: (error.textContent ?? '').slice(0, 512),
          scopeRefusal,
          ...(savedSummary === undefined ? {} : { savedSummary }),
          ...(resumeRefusal === undefined ? {} : { resumeRefusal }),
          ...(slowPass ? { slowPass: true as const } : {}),
          ...(scanKind ? { scanKind } : {}),
        }),
      );
    } catch {
      /* Observational callbacks cannot change actual scan ownership. */
    }
  }
  function queryMatches(requested: string | undefined): boolean {
    // A cold-restored bounded job carries its own query before any review is loaded.
    const captured = checkpoint?.review.query ?? boundedSaved?.query ?? activeAutomaticQuery;
    if (
      requested === undefined ||
      requested.toLowerCase() === normalizedScanQuery(captured).toLowerCase()
    )
      return true;
    scopeRefusal = 'query-changed';
    error.textContent =
      'Scan query changed. Use Rescan to start a new query; saved channels were retained.';
    notifyProgress();
    return false;
  }

  let checkpoint: {
    review: ScanReview;
    expectedRevision: string;
    observations: Map<string, HealthObservation>;
    published: Set<string>;
    platform: string | null;
    profile: string | undefined;
    jobId: string;
    createdAtMs: number;
    budgetMs: HealthCheckBudgetMs;
  } | null = null;
  let checkpointRevision = '0';
  let boundedResume: BoundedSourceScanResume | null = null;
  let boundedCleanupRefusal: { service: BoundedSourceScanResume; error: unknown } | null = null;
  let boundedSaved: { jobId: string; query: string; completed: boolean } | null = null;
  let storedJobId: string | null = null;
  let checkpointAdmissionLoaded = false;
  let checkpointRestoreRefused = false;
  let durableCheckpointAvailable = true;
  let backgroundPaused = false;
  let suspension: Promise<void> | null = null;
  let stopWork: Promise<void> | null = null;
  let restoreSuspendedReview: (() => void) | null = null;
  let owner = 0;
  let controller: AbortController | null = null;
  let work: Promise<void> = Promise.resolve();
  let review: ScanReview | null = null;
  let pipelineReview: PipelineReview | null = null;
  const guideSuggestions = new Map<string, GuideEnrichment[]>();
  let capturedSources: readonly ScanSource[] = [];
  let draftSources: readonly ScanSource[] | undefined;
  let page = 0;
  let sourcePage = 0;
  let sourceLabels = new Map<string, string>();
  let showOptions = false;
  const selected = new Set<string>();
  const health = new Map<string, HealthObservation>();
  let healthScope: {
    platform: string;
    observerProfile: string;
    budgetMs: HealthCheckBudgetMs;
  } | null = null;
  let historyMode = false;
  let automaticChecksComplete = !host.probe;
  let fileReview = false;
  const showAllLabel = document.createElement('label');
  const showAll = document.createElement('input');
  showAll.type = 'checkbox';
  showAllLabel.append(showAll, document.createTextNode('Show all collected channels'));
  showAll.addEventListener('change', () => {
    page = 0;
    render();
  });
  let historyPage: SavedHealthPage | null = null;
  let historyOffset = 0;
  let loadedHistoryOffset = 0;
  let scanSearch = '';
  const savedChecks = button('Saved checks', () => {
    if (busy) return;
    if (!historyMode) {
      scanSearch = search.value;
      search.value = '';
    }
    historyMode = true;
    historyPage = null;
    historyOffset = 0;
    runHistory();
  });
  const returnReview = button('Return to scan review', () => {
    if (busy) return;
    historyMode = false;
    search.value = scanSearch;
    status.textContent = '';
    error.textContent = '';
    render();
  });
  const scan = button('Scan', () => {
    if (automaticMode) {
      rescanAutomatic();
      return;
    }
    runScan();
  });
  scan.setAttribute('aria-label', 'Scan configured sources');
  const cancel = button('Cancel operation', () => {
    if (automaticMode) {
      void stopAutomatic().catch(() => undefined);
      return;
    }
    backgroundPaused = false;
    if (!saving) controller?.abort();
    host.activity?.(false);
  });
  const save = button('Save selected channels', () => runSave());
  const close = button('Close scan review', () => {
    void closeDialog();
  });
  close.setAttribute('aria-label', 'Close scan review');
  close.textContent = 'Close';
  save.setAttribute('aria-label', 'Save selected channels');
  save.textContent = 'Save';
  const previous = button('Previous results', () => {
    if (historyMode) {
      historyOffset = Math.max(0, historyOffset - 50);
      runHistory();
      return;
    }
    page--;
    render();
  });
  previous.setAttribute('aria-label', 'Previous results');
  previous.textContent = '‹';
  const next = button('Next results', () => {
    if (historyMode) {
      historyOffset += 50;
      runHistory();
      return;
    }
    page++;
    render();
  });
  next.setAttribute('aria-label', 'Next results');
  next.textContent = '›';
  const choose = button('Select all matching results', () => {
    for (const candidate of matches()) selected.add(candidate.key);
    render();
  });
  const clear = button('Clear selection', () => {
    selected.clear();
    render();
  });
  const check = button('Check selected channels', () => runCheck());
  const suggest = button('Find guide suggestions for selected channels', () => runGuideReview());
  const editOptions = button('Scan/check options', () => {
    optionsPanel.open = true;
    render();
  });
  check.hidden = !host.probe;
  const actions = document.createElement('select');
  actions.setAttribute('aria-label', 'Scan review action');
  const actionButtons = new Map([
    ['choose', choose],
    ['clear', clear],
    ['cancel', cancel],
    ['close', close],
    ['previous', previous],
    ['next', next],
    ['rescan', scan],
    ['options', editOptions],
    ...(host.savedHealth
      ? [['history', savedChecks] as const, ['review', returnReview] as const]
      : []),
    ...(host.probe ? [['check', check] as const] : []),
    ...(host.guides && host.enrich ? [['guides', suggest] as const] : []),
  ]);
  for (const [value, control] of actionButtons) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = control.getAttribute('aria-label') ?? control.textContent;
    actions.append(option);
  }
  const runAction = button('Run action', () => actionButtons.get(actions.value)?.click());
  runAction.setAttribute('aria-label', 'Run action');
  runAction.textContent = 'Run';
  actions.addEventListener('change', () => render());
  const sourceDetails = document.createElement('details');
  const sourceSummary = document.createElement('summary');
  const sourcePrevious = button('Previous sources', () => {
    sourcePage--;
    render();
  });
  const sourceNext = button('Next sources', () => {
    sourcePage++;
    render();
  });
  sourceDetails.append(sourceSummary, sourceResults, sourcePrevious, sourceNext);
  const optionsPanel = document.createElement('details');
  const optionsSummary = document.createElement('summary');
  optionsSummary.textContent = 'Advanced';
  optionsPanel.className = 'scan-options';
  optionsPanel.addEventListener('toggle', () => render());
  optionsPanel.append(
    optionsSummary,
    queryLabel,
    checkBudgetLabel,
    checkHint,
    showAllLabel,
    sourceDetails,
    actions,
    runAction,
  );
  const inputs = document.createElement('div');
  inputs.className = 'scan-inputs';
  inputs.append(search, previous, next);
  const feedback = document.createElement('div');
  feedback.className = 'scan-feedback';
  feedback.append(status, error, count);
  const footer = document.createElement('div');
  footer.className = 'scan-footer';
  footer.append(scan, save);
  const header = document.createElement('header');
  header.className = 'scan-header';
  header.append(heading, cancel, close);
  const setup = document.createElement('section');
  setup.className = 'scan-setup';
  const introduction = document.createElement('p');
  introduction.className = 'scan-introduction';
  introduction.textContent =
    'Scan your sources to find channels that respond. Save the results when the scan finishes.';
  setup.append(introduction, optionsPanel);
  const body = document.createElement('section');
  body.className = 'scan-body';
  body.append(setup, inputs, results);
  dialog.append(header, feedback, body, footer);
  container.append(trigger);
  // A settings dialog may be closed while the review modal is open.
  // Mount outside hidden/inert settings ancestors so the review stays usable.
  container.ownerDocument.body.append(dialog);
  function matches(): ReviewCandidate[] {
    const token = search.value.trim().normalize('NFKC').toLowerCase();
    return (
      review?.candidates.filter(
        (candidate) =>
          (fileReview ||
            !host.probe ||
            showAll.checked ||
            ['Reachable', 'PlayedHere'].includes(health.get(candidate.key)?.verdict ?? '')) &&
          `${candidate.channel.name} ${candidate.channel.category}`
            .normalize('NFKC')
            .toLowerCase()
            .includes(token),
      ) ?? []
    );
  }
  async function closeDialog(): Promise<void> {
    if (automaticMode && (busy || stopWork)) {
      dialog.close();
      return;
    }
    if (saving) return;
    controller?.abort();
    await work;
    if (!closed) dialog.close();
  }
  function open(
    sources?: readonly ScanSource[],
    presentation: 'inline' | 'dialog' = 'dialog',
  ): void {
    if (closed || busy || stopWork || suspension) return;
    savedSummary = undefined;
    automaticMode = false;
    if (sources) fileReview = false;
    draftSources = sources?.map((entry) => ({ ...entry, source: { ...entry.source } }));
    if (sources) {
      historyMode = false;
      review = null;
      pipelineReview = null;
      guideSuggestions.clear();
      selected.clear();
      health.clear();
      healthScope = null;
      sourceResults.replaceChildren();
    }
    automaticPresentation = presentation;
    showAutomatic();
    render();
  }
  search.addEventListener('input', () => {
    if (historyMode) {
      historyOffset = 0;
      historyPage = null;
      runHistory();
      return;
    }
    page = 0;
    render();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeDialog();
  });
  render();
  const automaticScanRuns = createAutomaticScanRuns(shared);
  const {
    rescanAutomatic,
    stopAutomatic,
    prepareAutomaticEntry,
    startAutomatic,
    continueAutomatic,
  } = automaticScanRuns;
  return {
    snapshot,
    prepareAutomaticEntry,
    presentSavedSummary(raw, expectedGeneration) {
      if (
        closed ||
        disposed ||
        busy ||
        saving ||
        stopWork ||
        suspension ||
        automaticScanRuns.entryWork ||
        pendingPublications ||
        owner !== expectedGeneration ||
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration < 0 ||
        checkpointAdmissionLoaded ||
        checkpoint ||
        review ||
        pipelineReview ||
        dialog.open ||
        savedSummary !== undefined
      )
        return false;
      let summary: ScanCheckpointSummary;
      try {
        summary = validateScanCheckpointSummary(raw);
      } catch {
        return false;
      }
      if (summary.checkpointStatus === 'absent') return true;
      automaticMode = true;
      automaticPresentation = 'inline';
      summaryCheckpointRevision = summary.checkpointRevision;
      savedSummary =
        summary.checkpointStatus === 'invalid'
          ? 'invalid'
          : summary.unfinished
            ? 'unfinished'
            : 'completed';
      scanPhase =
        savedSummary === 'invalid'
          ? 'failed'
          : savedSummary === 'unfinished'
            ? 'paused'
            : 'completed';
      scanTotal = summary.total;
      scanChecked = summary.checked;
      scanResponded = summary.responded;
      scanPublished = summary.published;
      status.textContent =
        savedSummary === 'invalid'
          ? 'Saved scan progress is unavailable. Existing channels are retained. Select Rescan to check sources again.'
          : savedSummary === 'completed'
            ? `Saved scan finished | ${summary.checked} of ${summary.total} checked | ${summary.published} saved. Select Refresh to look for new channels, or Rescan to check everything again.`
            : `Saved scan | ${summary.checked} of ${summary.total} checked | ${summary.published} saved. Finish scan checks whether this progress can safely resume.`;
      error.textContent = savedSummary === 'invalid' ? 'Saved scan progress is unavailable.' : '';
      notifyProgress();
      return true;
    },
    open,
    reviewFile(source, file) {
      if (closed || busy || stopWork || suspension) return Promise.resolve();
      const definition = { source: structuredClone(source), fingerprint: crypto.randomUUID() };
      open([definition]);
      fileReview = true;
      historyMode = false;
      page = 0;
      search.value = '';
      query.value = '';
      automaticChecksComplete = true;
      const task = begin();
      status.textContent = 'Reading your playlist file…';
      work = (async () => {
        try {
          if (source.kind !== 'file' || !host.readFileSnapshot)
            throw new Error('Local playlist review is unavailable.');
          if (file.size > 20 * 1024 * 1024) throw new Error('Playlist exceeds the 20 MiB limit.');
          // Capture the catalog/source revision before the noncancelable File read starts.
          const snapshot = host.capture([definition]);
          capturedSources = structuredClone(snapshot.sources);
          sourceLabels = new Map(snapshot.sources.map(({ source }) => [source.id, source.name]));
          const parsed = await host.readFileSnapshot(file, definition.source, task.signal);
          task.signal.throwIfAborted();
          if (snapshot.revision !== host.revision())
            throw new Error('Saved channels changed. Choose the file again.');
          const result = await scanConfiguredSources(snapshot.sources, async () => parsed, {
            sessionRevision: snapshot.revision,
            query: '',
            signal: task.signal,
          });
          task.signal.throwIfAborted();
          if (closed || task.generation !== owner) return;
          review = result;
          scanTotal = result.candidates.length;
          pipelineReview = null;
          health.clear();
          healthScope = null;
          selected.clear();
          for (const candidate of result.candidates) selected.add(candidate.key);
          status.textContent = `${result.candidates.length} channels ready for review. Streams have not been checked. Save to add the selected channels.`;
        } catch (failure) {
          if (task.generation === owner) recordFailure(failure);
          if (!closed && task.generation === owner) {
            status.textContent = 'File was not saved.';
            error.textContent = task.signal.aborted
              ? 'File review canceled. Choose the file again when ready.'
              : failure instanceof Error && !/https?:\/\//i.test(failure.message)
                ? failure.message
                : 'Playlist file could not be read. Choose a valid playlist file.';
          }
        } finally {
          finish(task.generation);
        }
      })();
      return work;
    },
    start(sources) {
      open(sources);
      runScan();
    },
    get automaticQuery() {
      return checkpoint?.review.query ?? activeAutomaticQuery;
    },
    startAutomatic,
    async refreshAutomatic(sources, options = {}) {
      startAutomatic(sources, options);
      await work;
    },
    continueAutomatic,
    rescanAutomatic,
    stopAutomatic,
    async resume() {
      await suspension;
      if (closed || !backgroundPaused || busy) return;
      backgroundPaused = false;
      const visible = dialog.open;
      if (boundedSaved) await continueAutomatic({ presentation: automaticPresentation });
      else startAutomatic();
      if (!visible && dialog.open) dialog.close();
    },
    suspend() {
      if (stopWork) return stopWork;
      if (suspension) return suspension;
      if (closed || !busy) return Promise.resolve();
      backgroundPaused = automaticMode;
      host.activity?.(false);
      const pending = work;
      const writing = saving;
      const restore = restoreSuspendedReview;
      if (!writing) controller?.abort();
      suspension = Promise.resolve()
        .then(async () => {
          await boundedResume?.suspend();
          await pending;
        })
        .then(async () => {
          if (automaticMode) await persistCheckpoint();
          if (closed || writing) return;
          restore?.();
          status.textContent =
            'Operation canceled while the app was in the background. Reviewed choices retained; retry when ready.';
          error.textContent = '';
          render();
        })
        .finally(() => {
          suspension = null;
        });
      return suspension;
    },
    async dispose() {
      if (disposed) return;
      closed = true;
      backgroundPaused = false;
      host.activity?.(false);
      if (!saving) controller?.abort();
      const retained = boundedResume;
      if (retained) await retained.dispose();
      async function join(pending: Promise<void> | null): Promise<void> {
        try {
          await pending;
        } catch (error) {
          // Ignore only this exact historical cleanup refusal, after its retained
          // native owner has now confirmed close. Other operation failures remain errors.
          if (
            !retained ||
            boundedCleanupRefusal?.service !== retained ||
            boundedCleanupRefusal.error !== error
          )
            throw error;
        }
      }
      await join(suspension);
      await join(work);
      await join(stopWork);
      if (boundedResume === retained) boundedResume = null;
      boundedCleanupRefusal = null;
      dialog.close();
      dialog.remove();
      trigger.remove();
      disposed = true;
    },
  };
}
