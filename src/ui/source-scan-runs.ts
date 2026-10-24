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
  scanConfiguredSources,
  stageScanSelection,
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
  type StagedScanSelection,
} from '../discovery/scan';
import {
  stagePipelineSelection,
  type GuideEnrichment,
  type PipelineReview,
} from '../discovery/pipeline';
import { type SavedHealthPage, type SavedHealthRow } from '../application/health-history';
import { type createScanChecks } from './source-scan-checks';
import { type HealthObservation } from '../discovery/health';
import { type ScanPreparationFailureCode } from '../discovery/selection-failure';
import { type ReviewedScanHealthContext } from '../discovery/prepare-selection';
import {
  freezeCapture,
  type AutomaticScanProgress,
  type HealthCheckBudgetMs,
  type ScanCheckpointCommitContext,
  type ScanFailure,
  type SourceScanHost,
  type SourceScanSnapshot,
} from './source-scan-model';

function checkEvidence(evidence: SavedHealthRow['evidence']): string {
  switch (evidence.kind) {
    case 'http':
      return `HTTP ${evidence.status}. ${evidence.contentRecognized ? 'Recognized response content; playback was not tested.' : 'Response received; playback was not tested.'}`;
    case 'recognized-media-response':
      return 'Recognized media response; playback was not tested.';
    case 'decoded':
      return `Decoded frames ${evidence.before.decodedFrames} → ${evidence.after.decodedFrames}; ${evidence.after.width} × ${evidence.after.height}; observed for ${evidence.elapsedMilliseconds} ms.`;
    case 'timeout':
      return 'The check reached its time limit; this does not prove the stream is broken.';
    case 'slow':
      return 'No answer within 3 seconds; checked again later in the background.';
    case 'host-down':
      return 'Not requested: earlier checks in this scan could not reach this site. Checked again on a later day.';
    case 'unsupported':
      return 'This device could not support the checked response.';
    case 'canceled':
      return 'The check was canceled.';
    case 'local-network-unavailable':
      return 'The local network was unavailable.';
    case 'network-failure':
      return 'The network request did not finish successfully.';
    case 'not-checked':
      return 'No check was performed.';
  }
}

/** What this part reads from, and writes back to, mountSourceScan. */
export interface ScanRunsEnvironment {
  busy: boolean;
  readonly stopWork: Promise<void> | null;
  readonly closed: boolean;
  readonly results: HTMLUListElement;
  readonly historyMode: boolean;
  readonly search: HTMLInputElement;
  readonly heading: HTMLHeadingElement;
  review: ScanReview | null;
  readonly dialog: HTMLDialogElement;
  readonly optionsPanel: HTMLDetailsElement;
  readonly introduction: HTMLParagraphElement;
  readonly count: HTMLParagraphElement;
  readonly setup: HTMLElement;
  readonly inputs: HTMLDivElement;
  readonly save: HTMLButtonElement;
  readonly scan: HTMLButtonElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly queryLabel: HTMLLabelElement;
  sourcePage: number;
  readonly sourceSummary: HTMLElement;
  readonly sourceResults: HTMLUListElement;
  sourceLabels: Map<string, string>;
  readonly sourcePrevious: HTMLButtonElement;
  readonly sourceNext: HTMLButtonElement;
  readonly matches: () => ReviewCandidate[];
  page: number;
  readonly host: SourceScanHost;
  fileReview: boolean;
  readonly showAll: HTMLInputElement;
  readonly selected: Set<string>;
  readonly health: Map<string, HealthObservation>;
  readonly guideSuggestions: Map<string, GuideEnrichment[]>;
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  historyPage: SavedHealthPage | null;
  historyOffset: number;
  readonly query: HTMLInputElement;
  readonly checkBudget: HTMLSelectElement;
  readonly choose: HTMLButtonElement;
  readonly clear: HTMLButtonElement;
  pipelineReview: PipelineReview | null;
  automaticChecksComplete: boolean;
  readonly check: HTMLButtonElement;
  readonly suggest: HTMLButtonElement;
  readonly savedChecks: HTMLButtonElement;
  readonly returnReview: HTMLButtonElement;
  readonly editOptions: HTMLButtonElement;
  saving: boolean;
  readonly close: HTMLButtonElement;
  readonly actions: HTMLSelectElement;
  readonly actionButtons: Map<string, HTMLButtonElement>;
  readonly runAction: HTMLButtonElement;
  readonly automaticMode: boolean;
  readonly body: HTMLElement;
  readonly footer: HTMLDivElement;
  checkpoint: {
    review: ScanReview;
    expectedRevision: string;
    observations: Map<string, HealthObservation>;
    published: Set<string>;
    platform: string | null;
    profile: string | undefined;
    jobId: string;
    createdAtMs: number;
    budgetMs: HealthCheckBudgetMs;
  } | null;
  readonly boundedSaved: { jobId: string; query: string; completed: boolean } | null;
  readonly checkpointRestoreRefused: boolean;
  readonly notifyProgress: () => void;
  readonly disposed: boolean;
  readonly pendingPublications: number;
  scanPhase: SourceScanSnapshot['phase'];
  scanTotal: number;
  scanChecked: number;
  scanResponded: number;
  scanPublished: number;
  lastFailure: ScanFailure;
  lastFailureCode: string | undefined;
  preparationFailure: ScanPreparationFailureCode | undefined;
  owner: number;
  savedSummary: AutomaticScanProgress['savedSummary'];
  controller: AbortController | null;
  readonly error: HTMLParagraphElement;
  restoreSuspendedReview: (() => void) | null;
  notifiedGeneration: number;
  readonly suspension: Promise<void> | null;
  readonly status: HTMLParagraphElement;
  work: Promise<void>;
  loadedHistoryOffset: number;
  readonly recordFailure: (failure: unknown, publication?: boolean) => void;
  capturedSources: readonly ScanSource[];
  showOptions: boolean;
  healthScope: {
    platform: string;
    observerProfile: string;
    budgetMs: HealthCheckBudgetMs;
  } | null;
  readonly indexSuggestions: ReturnType<typeof createScanChecks>['indexSuggestions'];
  readonly activeAutomaticQuery: string;
  readonly draftSources: readonly ScanSource[] | undefined;
  readonly checkCaptured: ReturnType<typeof createScanChecks>['checkCaptured'];
  readonly publish: (
    staged: StagedScanSelection,
    revision: string,
    signal: AbortSignal,
    health?: ReviewedScanHealthContext | undefined,
    checkpoint?: ScanCheckpointCommitContext | undefined,
    episodeId?: string | undefined,
  ) => Promise<{ committed: true; revision: string; checkpointRevision?: string }>;
}

/**
 * The scan screen's state and its runs: rendering it, beginning and finishing
 * a run, scan history, the scan itself and saving its results. Part of
 * mountSourceScan.
 */
export function createScanRuns(env: ScanRunsEnvironment) {
  function render(): void {
    const uiBusy = env.busy || env.stopWork !== null;
    if (env.closed) return;
    env.results.setAttribute('aria-label', env.historyMode ? 'Saved checks' : 'Candidate channels');
    env.search.setAttribute(
      'aria-label',
      env.historyMode ? 'Search saved checks' : 'Search scan results',
    );
    env.heading.textContent = uiBusy ? 'Scanning' : env.review ? 'Channels' : 'Scan channels';
    const initial = !uiBusy && !env.review && !env.historyMode;
    env.dialog.dataset.scanState = initial && !env.optionsPanel.open ? 'start' : 'results';
    env.introduction.hidden = !initial;
    env.count.hidden = !env.review && !env.historyMode;
    env.setup.hidden = false;
    env.inputs.hidden = env.review === null;
    env.results.hidden = env.review === null;
    env.save.hidden = env.review === null;
    env.scan.textContent = env.review ? 'Rescan' : 'Scan';
    env.previous.hidden = env.next.hidden = env.review === null;
    env.cancel.hidden = !uiBusy;
    if (env.historyMode) {
      env.heading.textContent = 'Saved checks';
      env.setup.hidden = false;
      env.inputs.hidden = false;
      env.results.hidden = false;
      env.save.hidden = true;
    }
    env.queryLabel.hidden = env.review !== null;
    const sources = env.review?.sources ?? [];
    env.sourcePage = Math.max(
      0,
      Math.min(env.sourcePage, Math.max(0, Math.ceil(sources.length / 50) - 1)),
    );
    env.sourceSummary.textContent = `Source outcomes: ${sources.length}. Showing ${sources.length ? env.sourcePage * 50 + 1 : 0}–${Math.min((env.sourcePage + 1) * 50, sources.length)}.`;
    env.sourceResults.replaceChildren();
    for (const source of sources.slice(env.sourcePage * 50, env.sourcePage * 50 + 50)) {
      const item = document.createElement('li');
      item.textContent = `${env.sourceLabels.get(source.sourceId) ?? 'Source'}: ${source.status} · ${source.matched} matches${source.status === 'failed' ? ' · Previous channels retained.' : ''}`;
      if (source.warnings) {
        const messages = source.warningMessages ?? [];
        const shown =
          messages.length <= 4
            ? messages
            : [...messages.slice(0, 3), messages[messages.length - 1]!];
        item.textContent += ` · ${source.warnings} source warnings. ${shown.join(' ')}${messages.length > shown.length ? ` ${messages.length - shown.length} additional warnings.` : ''}`;
      }
      env.sourceResults.append(item);
    }
    env.sourcePrevious.disabled = uiBusy || env.sourcePage === 0;
    env.sourceNext.disabled = uiBusy || (env.sourcePage + 1) * 50 >= sources.length;
    const matched = env.matches();
    env.page = Math.max(0, Math.min(env.page, Math.max(0, Math.ceil(matched.length / 50) - 1)));
    env.count.textContent = `${matched.length} ${env.host.probe && !env.fileReview && !env.showAll.checked ? 'responded' : 'matches'}. ${env.selected.size} selected. Showing ${matched.length ? env.page * 50 + 1 : 0}–${Math.min((env.page + 1) * 50, matched.length)}.`;
    env.results.replaceChildren();
    for (const candidate of env.historyMode
      ? []
      : matched.slice(env.page * 50, env.page * 50 + 50)) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = env.selected.has(candidate.key);
      checkbox.hidden = !env.optionsPanel.open;
      checkbox.disabled = uiBusy;
      checkbox.setAttribute('aria-label', `Select ${candidate.channel.name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) env.selected.add(candidate.key);
        else env.selected.delete(candidate.key);
        render();
      });
      const observed = env.health.get(candidate.key);
      const verdict = observed?.verdict ?? 'NotChecked';
      const verdictLabels: Record<string, string> = {
        Reachable: 'Responded',
        PlayedHere: 'Played on this device',
        NotChecked: 'Not checked',
        TimedOut: 'Did not respond in time',
        AccessDenied: 'Access denied',
        UnsupportedHere: 'Unsupported on this device',
        TemporaryUnavailable: 'Temporarily unavailable',
        Canceled: 'Check canceled',
      };
      label.append(
        checkbox,
        document.createTextNode(
          `${candidate.channel.name} · ${candidate.channel.category} · ${env.sourceLabels.get(candidate.sourceId) ?? 'Source'} · ${verdictLabels[verdict] ?? 'Not checked'}`,
        ),
      );
      item.append(label);
      if (observed && env.optionsPanel.open) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Check details';
        const information = document.createElement('p');
        information.textContent = `${observed.platform} · ${new Date(observed.observedAt).toLocaleString()} · ${checkEvidence(observed.evidence)}`;
        details.append(summary, information);
        item.append(details);
      }
      const suggestions = env.guideSuggestions.get(candidate.key) ?? [];
      if (suggestions.length) {
        const note = document.createElement('p');
        const counts = new Map<string, number>();
        for (const value of suggestions)
          counts.set(value.status, (counts.get(value.status) ?? 0) + 1);
        note.textContent = `Guide matches: ${[...counts].map(([state, total]) => `${total} ${state}`).join(' · ')}. Review and confirm the regional channel in Guide; no mapping saved.`;
        item.append(note);
      }
      if (env.host.openGuide && env.optionsPanel.open) {
        const guide = env.button('Review guide mapping', () => env.host.openGuide!(candidate));
        guide.disabled = uiBusy;
        item.append(guide);
      }
      env.results.append(item);
    }
    env.previous.disabled = uiBusy || env.page === 0;
    env.next.disabled = uiBusy || (env.page + 1) * 50 >= matched.length;
    if (env.historyMode) {
      const total = env.historyPage?.total ?? 0;
      env.count.textContent = `${total} saved checks. Showing ${env.historyPage?.rows.length ? env.historyOffset + 1 : 0}–${env.historyOffset + (env.historyPage?.rows.length ?? 0)}.`;
      for (const row of uiBusy ? [] : (env.historyPage?.rows ?? [])) {
        const item = document.createElement('li');
        const timestamp = new Date(row.observedAt);
        const name = document.createElement('strong');
        name.textContent = row.name;
        const summary = document.createElement('p');
        const verdicts = {
          NotChecked: 'Not checked',
          Reachable: 'Stream responded',
          PlayedHere: 'Playback observed',
          TimedOut: 'Check timed out',
          AccessDenied: 'Access denied',
          UnsupportedHere: 'Unsupported on this device',
          TemporaryUnavailable: 'Temporarily unavailable',
          Canceled: 'Check canceled',
        };
        const freshness = {
          current: 'Recent check',
          stale: 'Older check',
          'different-platform': 'Checked on another platform',
          'different-profile': 'Different check settings',
        };
        summary.textContent = `${verdicts[row.verdict]} · ${freshness[row.freshness]}${row.origin === 'imported' ? ' · Imported historical check' : ''}`;
        const time = document.createElement('time');
        const validTime = !Number.isNaN(timestamp.getTime());
        if (validTime) {
          time.dateTime = timestamp.toISOString();
          time.textContent = new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(timestamp);
        } else time.textContent = 'Unknown check time';
        const platform = document.createElement('span');
        const platformNames: Record<string, string> = {
          windows: 'Windows',
          android: 'Android',
          browser: 'Browser',
          'browser-preview': 'Browser',
          'browser-local': 'Browser',
        };
        platform.textContent = ` · ${platformNames[row.platform.toLowerCase()] ?? 'Other platform'}`;
        const details = document.createElement('details');
        const toggle = document.createElement('summary');
        toggle.textContent = 'Check details';
        const metadata = document.createElement('dl');
        for (const [label, value] of [
          ['Category', row.category || 'Uncategorized'],
          ['Source', row.sourceName],
          [
            'Stream',
            row.checkedUrlOrdinal === 0
              ? 'Primary stream'
              : `Alternate stream ${row.checkedUrlOrdinal + 1}`,
          ],
          ['Check settings', row.observerProfile],
          ['Platform', row.platform],
          ['Origin', row.origin === 'imported' ? 'Imported historical check' : 'Local check'],
          ['Exact check time', validTime ? timestamp.toISOString() : 'Unknown'],
          ['Evidence', checkEvidence(row.evidence)],
        ]) {
          const term = document.createElement('dt');
          term.textContent = label;
          const valueNode = document.createElement('dd');
          valueNode.textContent = value;
          metadata.append(term, valueNode);
        }
        details.append(toggle, metadata);
        item.append(name, summary, time, platform, details);
        env.results.append(item);
      }
      env.previous.disabled = uiBusy || env.historyOffset === 0;
      env.next.disabled = uiBusy || env.historyOffset + 50 >= total;
    }
    env.scan.disabled = uiBusy || env.fileReview;
    env.query.disabled = uiBusy;
    env.checkBudget.disabled = uiBusy;
    env.search.disabled = uiBusy;
    env.choose.disabled = uiBusy || !matched.length;
    env.clear.disabled = uiBusy || !env.selected.size;
    env.save.disabled =
      uiBusy ||
      !env.selected.size ||
      env.review?.status !== 'completed' ||
      (env.pipelineReview !== null && !env.pipelineReview.publishable);
    if (env.host.probe && !env.automaticChecksComplete) env.save.disabled = true;
    env.check.disabled = uiBusy || env.fileReview || !env.selected.size;
    env.suggest.disabled = uiBusy || env.fileReview || !env.selected.size;
    env.savedChecks.disabled = uiBusy;
    env.returnReview.disabled = uiBusy || !env.historyMode;
    if (env.historyMode) {
      for (const control of [env.choose, env.clear, env.scan, env.editOptions, env.check])
        control.disabled = true;
    }
    env.cancel.disabled = !uiBusy || env.saving;
    env.close.disabled = env.saving;
    env.showAll.disabled = uiBusy;
    env.actions.disabled = env.saving;
    for (const option of env.actions.options)
      option.disabled = env.actionButtons.get(option.value)?.disabled ?? false;
    env.runAction.disabled =
      env.saving || (env.actionButtons.get(env.actions.value)?.disabled ?? true);
    if (env.automaticMode) {
      env.dialog.dataset.scanState = 'start';
      env.body.hidden = true;
      env.footer.hidden =
        uiBusy || (!env.checkpoint && !env.boundedSaved && !env.checkpointRestoreRefused);
      env.setup.hidden = env.inputs.hidden = env.results.hidden = env.count.hidden = true;
      env.save.hidden = true;
      env.scan.hidden =
        uiBusy || (!env.checkpoint && !env.boundedSaved && !env.checkpointRestoreRefused);
      env.scan.textContent = 'Rescan';
      env.close.textContent = uiBusy ? 'Close' : 'Done';
    } else {
      env.body.hidden = env.footer.hidden = false;
      env.scan.hidden = false;
      env.close.textContent = 'Close';
    }
    env.notifyProgress();
  }
  function snapshot(): Readonly<SourceScanSnapshot> {
    return Object.freeze({
      schemaVersion: 1,
      phase: env.disposed ? 'disposed' : env.pendingPublications ? 'publishing' : env.scanPhase,
      total: env.scanTotal,
      checked: env.scanChecked,
      responded: env.scanResponded,
      published: env.scanPublished,
      lastFailure: env.lastFailure,
      ...(env.lastFailureCode === undefined ? {} : { lastFailureCode: env.lastFailureCode }),
      ...(env.preparationFailure === undefined
        ? {}
        : { preparationFailure: env.preparationFailure }),
      generation: env.owner,
      busy: (env.busy || env.stopWork !== null) && !env.disposed,
      pendingPublications: env.pendingPublications,
    });
  }
  function begin(
    admissionOnly = false,
    preserveCounts = false,
  ): { signal: AbortSignal; generation: number } {
    env.savedSummary = undefined;
    env.busy = true;
    env.scanPhase = 'collecting';
    env.lastFailure = 'none';
    env.lastFailureCode = undefined;
    env.preparationFailure = undefined;
    if (!preserveCounts) {
      env.scanTotal = env.review?.candidates.length ?? 0;
      env.scanChecked = env.checkpoint?.observations.size ?? 0;
      env.scanResponded = env.checkpoint
        ? [...env.checkpoint.observations.values()].filter((observation) =>
            ['Reachable', 'PlayedHere'].includes(observation.verdict),
          ).length
        : 0;
      env.scanPublished = env.checkpoint?.published.size ?? 0;
    }
    if (!admissionOnly && env.automaticMode && !env.historyMode) env.host.activity?.(true);
    env.controller = new AbortController();
    const generation = ++env.owner;
    env.error.textContent = '';
    env.actions.value = 'cancel';
    render();
    return { signal: env.controller.signal, generation };
  }
  function finish(generation: number, admissionOnly = false): void {
    if (generation !== env.owner || env.closed) return;
    if (env.scanPhase === 'collecting' || env.scanPhase === 'checking')
      env.scanPhase = env.controller?.signal.aborted ? 'paused' : 'completed';
    if (
      !admissionOnly &&
      env.scanPhase === 'paused' &&
      env.lastFailure === 'none' &&
      env.controller?.signal.aborted
    )
      env.lastFailure = 'canceled';
    env.busy = false;
    if (!admissionOnly && !env.stopWork) env.host.activity?.(false);
    env.saving = false;
    env.restoreSuspendedReview = null;
    env.controller = null;
    env.actions.value = env.historyMode
      ? 'review'
      : env.host.probe && env.selected.size
        ? 'check'
        : 'choose';
    render();
    if (env.scanPhase === 'failed' && env.notifiedGeneration !== generation) {
      env.notifiedGeneration = generation;
      try {
        env.host.onDiagnostic?.(snapshot());
      } catch {
        /* A diagnostic sink is observational and cannot fail the scan. */
      }
    }
  }
  function runHistory(): void {
    if (env.busy || env.stopWork || env.suspension || env.closed || !env.host.savedHealth) return;
    const budgetMs = Number(env.checkBudget.value) as HealthCheckBudgetMs;
    if (![20000, 45000, 60000].includes(budgetMs)) {
      env.error.textContent = 'Choose a supported channel check time.';
      return;
    }
    const task = begin();
    const requested = {
      offset: env.historyOffset,
      pageSize: 50 as const,
      query: env.search.value,
      ...(env.historyPage ? { revision: env.historyPage.revision } : {}),
      signal: task.signal,
      budgetMs,
    };
    env.status.textContent = 'Loading saved checks…';
    env.work = (async () => {
      try {
        const result = await env.host.savedHealth!(requested);
        if (env.closed || task.signal.aborted || task.generation !== env.owner) {
          if (task.signal.aborted) env.historyOffset = env.loadedHistoryOffset;
          return;
        }
        if (result.rows.length > 50 || result.total < result.rows.length || !result.revision)
          throw new Error('Invalid saved check page.');
        env.historyPage = result;
        env.loadedHistoryOffset = requested.offset;
        env.status.textContent =
          'Saved observations describe the recorded platform and time; reachability does not prove playback.';
      } catch (failure) {
        if (task.generation === env.owner) env.recordFailure(failure);
        if (task.signal.aborted) env.historyOffset = env.loadedHistoryOffset;
        if (!env.closed && !task.signal.aborted && task.generation === env.owner) {
          env.historyPage = null;
          env.historyOffset = 0;
          env.error.textContent =
            failure instanceof Error &&
            failure.message === 'Saved checks changed. Start from the first page.'
              ? failure.message
              : 'Saved checks could not load. Retry from the first page; your library is retained.';
          env.status.textContent = '';
        }
      } finally {
        finish(task.generation);
      }
    })();
  }
  function runScan(): void {
    if (env.busy || env.stopWork || env.suspension || env.closed) return;
    env.fileReview = false;
    const prior = {
      review: env.review,
      pipelineReview: env.pipelineReview,
      capturedSources: env.capturedSources,
      sourceLabels: env.sourceLabels,
      page: env.page,
      sourcePage: env.sourcePage,
      showOptions: env.showOptions,
      selected: [...env.selected],
      health: [...env.health],
      healthScope: env.healthScope,
      automaticChecksComplete: env.automaticChecksComplete,
    };
    env.restoreSuspendedReview = () => {
      env.review = prior.review;
      env.pipelineReview = prior.pipelineReview;
      env.capturedSources = prior.capturedSources;
      env.sourceLabels = prior.sourceLabels;
      env.page = prior.page;
      env.sourcePage = prior.sourcePage;
      env.showOptions = prior.showOptions;
      env.selected.clear();
      for (const key of prior.selected) env.selected.add(key);
      env.health.clear();
      for (const [key, value] of prior.health) env.health.set(key, value);
      env.healthScope = prior.healthScope;
      env.automaticChecksComplete = prior.automaticChecksComplete;
      env.indexSuggestions();
    };
    if (env.automaticMode) env.checkpoint = null;
    const task = begin();
    env.review = null;
    env.showOptions = false;
    env.pipelineReview = null;
    env.guideSuggestions.clear();
    env.selected.clear();
    env.health.clear();
    env.healthScope = null;
    env.sourceResults.replaceChildren();
    render();
    env.automaticChecksComplete = !env.host.probe;
    env.status.textContent = 'Finding channels in your saved sources…';
    env.notifyProgress();
    const capturedQuery = env.automaticMode ? env.activeAutomaticQuery : env.query.value;
    env.work = (async () => {
      try {
        if (env.automaticMode && !env.host.probe) throw new Error('Channel checks unavailable');
        const snapshot = env.host.capture(env.draftSources);
        env.capturedSources = structuredClone(snapshot.sources);
        const labels = new Map(
          snapshot.sources.map(({ source }) => [source.id, source.name.slice(0, 160)]),
        );
        env.sourceLabels = labels;
        env.sourcePage = 0;
        const pipelineResult = null;
        const collected = await (async () => {
          try {
            return await scanConfiguredSources(
              snapshot.sources,
              (source, signal) => env.host.collect(source, signal),
              {
                sessionRevision: snapshot.revision,
                query: capturedQuery,
                signal: task.signal,
                ...(env.host.aliases ? { aliases: env.host.aliases } : {}),
                progress: (event) => {
                  if (!env.closed && !task.signal.aborted)
                    env.status.textContent = `Finding channels · ${event.settled} of ${event.total} sources checked`;
                },
              },
            );
          } finally {
            env.host.onCollectionSettled?.();
          }
        })();
        if (env.closed || task.generation !== env.owner) return;
        const prioritized = env.host.prioritize ? env.host.prioritize(collected) : collected;
        // Collection already owns its channel copies; detach small warning arrays too.
        const result = env.automaticMode
          ? freezeCapture({
              ...prioritized,
              sources: prioritized.sources.map((source) => ({
                ...source,
                ...(source.warningMessages ? { warningMessages: [...source.warningMessages] } : {}),
              })),
            })
          : prioritized;
        if (env.automaticMode && result.status === 'completed')
          env.checkpoint = {
            review: result,
            expectedRevision: result.sessionRevision,
            observations: new Map(),
            published: new Set(),
            platform: null,
            profile: undefined,
            jobId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join(''),
            createdAtMs: env.host.now?.() ?? Date.now(),
            budgetMs: Number(env.checkBudget.value) as HealthCheckBudgetMs,
          };
        env.review = result;
        env.scanTotal = result.candidates.length;
        env.pipelineReview = pipelineResult;
        env.indexSuggestions();
        if (result.status === 'completed' && env.host.probe) {
          await env.checkCaptured(result, task, true);
          return;
        }
        env.status.textContent =
          result.status === 'canceled'
            ? 'Scan canceled. Existing channels retained.'
            : `${result.counts.matched} candidates ready for review. ${result.counts.failedSources} sources failed; previous channels retained.`;
      } catch (failure) {
        env.recordFailure(failure);
        if (!env.closed) {
          env.status.textContent = 'Review retained.';
          env.error.textContent =
            env.lastFailure === 'publish-failed'
              ? 'Channels could not be saved. Saved channels are safe; Finish scan retries from the last saved progress.'
              : task.signal.aborted && env.lastFailure === 'canceled'
                ? 'Scan canceled. Existing channels retained.'
                : env.automaticMode && env.lastFailure === 'configuration-changed'
                  ? 'Scan paused because your sources, location or check settings changed. Select Rescan to check the current setup. Saved channels retained.'
                  : env.automaticMode && env.lastFailure === 'catalog-cas'
                    ? 'Saved channels changed while scanning. Select Rescan to continue safely. Saved channels retained.'
                    : 'Scan could not finish. Check configured source availability and supported limits; existing channels retained.';
        }
      } finally {
        finish(task.generation);
      }
    })();
  }
  function runSave(): Promise<void> {
    if (
      env.busy ||
      env.stopWork ||
      env.suspension ||
      !env.review ||
      env.closed ||
      (env.host.probe && !env.automaticChecksComplete)
    )
      return Promise.resolve();
    const captured = env.review;
    env.saving = true;
    const task = begin();
    env.status.textContent = 'Saving reviewed selection…';
    env.work = (async () => {
      try {
        const revision = env.host.revision();
        const staged = env.pipelineReview
          ? stagePipelineSelection(env.pipelineReview, [...env.selected], revision)
          : stageScanSelection(captured, [...env.selected], revision);
        task.signal.throwIfAborted();
        const checkedCandidates = captured.candidates.filter(
          (candidate) => env.selected.has(candidate.key) && env.health.has(candidate.key),
        );
        if (
          env.healthScope &&
          (env.host.platform?.() !== env.healthScope.platform ||
            env.host.observerProfile?.(env.healthScope.budgetMs) !==
              env.healthScope.observerProfile)
        )
          throw new Error('The health observer changed. Check the selection again.');
        const healthContext = env.healthScope
          ? structuredClone({
              ...env.healthScope,
              candidates: checkedCandidates,
              observations: checkedCandidates.map((candidate) => env.health.get(candidate.key)!),
            })
          : undefined;
        const receipt = await env.publish(staged, revision, task.signal, healthContext);
        if (receipt.committed !== true || !receipt.revision.trim())
          throw new Error('Missing durable receipt.');
        env.scanPublished += env.selected.size;
        if (!env.closed) {
          env.status.textContent = env.automaticMode
            ? `${env.selected.size} ${env.selected.size === 1 ? 'channel' : 'channels'} saved.`
            : 'Selected channels saved.';
          env.selected.clear();
        }
      } catch (failure) {
        env.recordFailure(failure);
        if (!env.closed) {
          env.status.textContent = 'Review retained.';
          env.error.textContent = task.signal.aborted
            ? 'Save canceled. Review remains available.'
            : 'Selection was not saved. The catalog may have changed; scan again or retry. Review remains available.';
        }
      } finally {
        finish(task.generation);
      }
    })();
    return env.work;
  }
  return {
    begin,
    finish,
    render,
    runScan,
    snapshot,
    runHistory,
    runSave,
  };
}
