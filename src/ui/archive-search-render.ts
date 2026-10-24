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

import { archiveFavoriteEmptyState } from './archive-empty-state';
import {
  archiveCompactYearLabel,
  archiveItemDateFacts,
  archiveTitleYearLabel,
} from './archive-date';
import { archiveLanguageSummary } from './archive-language';
import { publicArchiveProviderName } from '../platform/archive-public-providers';
import {
  type ArchiveFile,
  type ArchiveFileProgressPage,
  type ArchiveFilesPage,
  type ArchiveLanguageMode,
  type ArchivePage,
  type ArchiveRemovalTarget,
  type ArchiveSelection,
  type ArchiveTitle,
} from '../platform/archive-catalog';
import { type createArchiveSearchActions } from './archive-search-actions';
import { type ArchiveSearchHost } from './archive-search';
import { type ArchiveContentType } from '../platform/archive-catalog';
import { type ArchiveDecade } from '../platform/archive-catalog';

function fileLabel(file: ArchiveFile, fallback: string): string {
  const stem = file.fileName
    .split('/')
    .at(-1)!
    .replace(/\.[^.]+$/u, '');
  const providerTitle = file.title.trim();
  if (providerTitle && providerTitle !== file.fileName && providerTitle !== stem)
    return providerTitle;

  // Present only words actually supplied by the file name; no episode identity inference.
  const label = stem.replace(/_+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /\p{L}{2}/u.test(label) &&
    !/^[a-f\d-]{24,}$/iu.test(label) &&
    !/^(?:video|movie|file|clip|track|part)[ .-]*\d*$/iu.test(label)
    ? label
    : fallback;
}

function titleType(title: ArchiveTitle): string {
  if (title.contentTypeProvenance !== 'provider-item') return 'Video';
  return title.contentType === 'tv'
    ? 'TV show'
    : title.contentType === 'movie'
      ? 'Movie'
      : title.contentType === 'short'
        ? 'Short video'
        : 'Video';
}

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchRenderEnvironment {
  readonly browseOptions: () => {
    languageMode: ArchiveLanguageMode;
    decade?: ArchiveDecade | null;
    favoritesOnly?: boolean;
    contentType?: ArchiveContentType | 'all';
  };
  readonly page: ArchivePage | null;
  readonly savedQuery: string;
  pendingPage: ArchiveFileProgressPage | null;
  readonly clearFilters: HTMLButtonElement;
  readonly host: ArchiveSearchHost;
  readonly syncArtworkContext: () => Promise<void>;
  readonly artworkObserver: IntersectionObserver | null;
  readonly resultSummary: HTMLParagraphElement;
  readonly managementActions: HTMLDivElement;
  readonly removalControls: (
    target: ArchiveRemovalTarget,
    label: string,
    identity: string,
  ) => HTMLElement;
  readonly selectedFocus: () => string | null;
  readonly list: HTMLDivElement;
  readonly detailPane: HTMLElement;
  readonly syncDetailsHost: () => void;
  readonly paging: HTMLElement;
  readonly position: HTMLSpanElement;
  readonly doc: Document;
  readonly expanded: string | null;
  readonly button: (label: string, action: () => void, identity?: string) => HTMLButtonElement;
  readonly files: ArchiveFilesPage | null;
  readonly abort: AbortController | null;
  episodesOpen: boolean;
  readonly filesAt: ReturnType<typeof createArchiveSearchActions>['filesAt'];
  readonly observeArtwork: (node: HTMLElement, title: ArchiveTitle) => void;
  readonly favorite: ReturnType<typeof createArchiveSearchActions>['favorite'];
  readonly favoriteBusy: boolean;
  readonly confirmation: string | null;
  readonly choose: ReturnType<typeof createArchiveSearchActions>['choose'];
  readonly selecting: Promise<void> | null;
  readonly selectionIdentity: ArchiveSelection | null;
  readonly revision: string | null;
  readonly duration: (seconds: number | null) => string;
  readonly fileSize: (value: string | null) => string;
  readonly downloadsView: {
    root: HTMLElement;
    fileControls(
      fileRef: string,
      expectedCatalogRevision: string,
      eligible?: boolean,
    ): HTMLDivElement;
    suspend(preserveSelection?: boolean): Promise<void>;
    dispose(): Promise<void>;
  } | null;
  readonly closed: boolean;
  readonly enabled: boolean;
  readonly artworkBindings: Map<string, Map<HTMLElement, ArchiveTitle>>;
  readonly releaseArtworkBinding: (node: HTMLElement, title: ArchiveTitle) => void;
  readonly artworkVisible: Set<HTMLElement>;
  readonly restoreFocus: (identity: string | null) => void;
  readonly pendingContent: HTMLDivElement;
  readonly pending: HTMLDetailsElement;
  readonly pendingSummary: HTMLElement;
  readonly loadPendingFiles: ReturnType<typeof createArchiveSearchActions>['loadPendingFiles'];
  readonly run: ReturnType<typeof createArchiveSearchActions>['run'];
  readonly current: (owner: number, scope: string, signal: AbortSignal) => boolean;
}

/**
 * Drawing GenXtra search results and the pending downloads. Part of
 * mountArchiveSearch.
 */
export function createArchiveSearchRender(env: ArchiveSearchRenderEnvironment) {
  function render(preserveDetailDOM = false) {
    const view = env.browseOptions();
    const empty =
      env.page &&
      archiveFavoriteEmptyState({
        ...view,
        query: env.savedQuery,
        totalCount: env.page.totalCount,
        pendingCount: env.pendingPage?.totalCount,
      });
    env.clearFilters.hidden = !(empty?.filtered && env.host.clearFilters);

    void env.syncArtworkContext();
    env.artworkObserver?.disconnect();
    env.resultSummary.textContent = [
      env.savedQuery.trim()
        ? `Results for “${env.savedQuery}”`
        : view.favoritesOnly
          ? 'Favorites'
          : 'Saved titles',
      env.page
        ? `${env.page.totalCount} ${view.favoritesOnly ? (env.page.totalCount === 1 ? 'match' : 'matches') : 'saved'}`
        : null,
    ]
      .filter((value) => value !== null)
      .join(' · ');
    env.resultSummary.title = env.resultSummary.textContent;
    env.managementActions.replaceChildren();

    if (env.host.onRemove)
      env.managementActions.append(
        env.removalControls({ kind: 'library' }, 'your GenXtra library', 'archive-clear'),
      );

    renderPending();

    const focus = env.selectedFocus();
    const scrollTop = env.list.scrollTop;

    env.list.replaceChildren();
    if (!preserveDetailDOM) {
      env.detailPane.replaceChildren();
      env.detailPane.hidden = true;
      env.syncDetailsHost();
    }

    if (!env.page) {
      env.paging.hidden = true;

      return;
    }

    env.paging.hidden = env.page.totalCount === 0;

    env.position.textContent = env.page.totalCount
      ? `${env.page.items.length} of ${env.page.totalCount} loaded`
      : '';

    for (const [titleIndex, title] of env.page.items.entries()) {
      const article = env.doc.createElement('article');

      article.className = 'gx-archive-title';
      article.classList.add('gx-archive-result-row');
      article.dataset.selected = String(env.expanded === title.titleRef);

      const toggle = env.button(
        title.title,

        () => {
          env.host.onTitleSelected?.();
          if (
            env.expanded === title.titleRef &&
            (env.files?.titleRef === title.titleRef || env.abort !== null)
          ) {
            env.episodesOpen = !env.episodesOpen;
            render();
          } else void env.filesAt(title, 0);
        },

        title.titleRef,
      );

      toggle.className = 'gx-archive-title-button';

      const inlineId = `genxtra-inline-videos-${titleIndex}`;
      toggle.setAttribute(
        'aria-expanded',
        String(env.expanded === title.titleRef && env.episodesOpen),
      );
      toggle.setAttribute('aria-controls', inlineId);
      toggle.setAttribute('aria-current', String(env.expanded === title.titleRef));
      toggle.setAttribute('aria-label', `Show videos for ${title.title}`);
      toggle.title = title.title;

      const tile = env.doc.createElement('span');
      tile.className = 'gx-archive-result-artwork';
      tile.dataset.artwork = 'fallback';
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase();
      env.observeArtwork(tile, title);
      const copy = env.doc.createElement('span');
      copy.className = 'gx-archive-result-copy';
      const name = env.doc.createElement('strong');
      name.className = 'gx-archive-result-name';
      name.textContent = title.title;
      const subtitle = env.doc.createElement('small');
      subtitle.className = 'gx-archive-result-subtitle';
      subtitle.textContent = [
        archiveCompactYearLabel(title),
        titleType(title),
        `${title.fileCount} ${title.providerId ? (title.fileCount === 1 ? 'file' : 'files') : title.fileCount === 1 ? 'video' : 'videos'}`,
      ]
        .filter((value) => value !== null)
        .join(' · ');
      copy.append(name, subtitle);
      toggle.replaceChildren(tile, copy);
      article.append(toggle);
      const inline = env.doc.createElement('section');
      inline.className = 'gx-archive-inline-videos';
      inline.id = inlineId;
      inline.hidden = env.expanded !== title.titleRef || !env.episodesOpen;
      inline.setAttribute('aria-label', `${title.title} videos`);

      const detail = env.doc.createElement('section');
      detail.className = 'gx-archive-selected-title';
      const hero = env.doc.createElement('div');
      hero.className = 'gx-archive-detail-hero';
      const artwork = env.doc.createElement('div');
      artwork.className = 'gx-archive-detail-artwork';
      artwork.dataset.artwork = 'fallback';
      artwork.setAttribute('aria-label', 'Artwork not available');
      artwork.textContent = Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase();
      if (env.expanded === title.titleRef && !preserveDetailDOM) env.observeArtwork(artwork, title);
      const overview = env.doc.createElement('div');
      overview.className = 'gx-archive-detail-overview';
      const detailActions = env.doc.createElement('div');
      detailActions.className = 'gx-archive-detail-actions';
      hero.append(artwork, overview, detailActions);
      detail.append(hero);
      const detailHeading = env.doc.createElement('h3');
      detailHeading.className = 'gx-archive-detail-title';
      detailHeading.textContent = title.title;
      overview.append(detailHeading);
      const about = env.doc.createElement('details');
      about.className = 'gx-archive-title-info';
      const aboutSummary = env.doc.createElement('summary');
      aboutSummary.textContent = 'More info';
      about.append(aboutSummary);

      const metadata = env.doc.createElement('p');

      metadata.className = 'gx-archive-metadata';

      metadata.textContent = `${titleType(title)} · ${archiveTitleYearLabel(title)} · ${title.fileCount} ${title.providerId ? (title.fileCount === 1 ? 'file' : 'files') : title.fileCount === 1 ? 'video' : 'videos'}`;

      overview.append(metadata);
      detailActions.append(about);

      const context = env.doc.createElement('p');
      context.className = 'gx-archive-context';
      const language = archiveLanguageSummary(title.providerLanguages);
      const basis = title.matchBasis;
      const match =
        basis === 'series'
          ? 'Series match'
          : basis === 'genre'
            ? 'Animation category'
            : basis === 'subject'
              ? 'Subject match'
              : basis === 'file'
                ? 'Video filename match'
                : basis === 'legacy-metadata'
                  ? 'Older metadata match'
                  : null;
      context.textContent = [language, match].filter(Boolean).join(' · ');
      context.title =
        'Language is reported by the source and has not been verified from the audio.';
      about.append(context);
      for (const [label, value] of archiveItemDateFacts(title)) {
        const claim = env.doc.createElement('p');
        claim.textContent = `${label}: ${value}`;
        about.append(claim);
      }
      if (title.providerSeries) {
        const series = env.doc.createElement('p');
        series.className = 'gx-archive-series';
        series.textContent = `Provider series: ${title.providerSeries}`;
        about.append(series);
      }

      if (title.providerSubjects?.length) {
        const subjects = env.doc.createElement('p');
        subjects.className = 'gx-archive-subjects';
        subjects.textContent = title.providerSubjects.slice(0, 3).join(' · ');
        about.append(subjects);
      }
      if (title.providerDescription) {
        const synopsis = env.doc.createElement('p');
        synopsis.className = 'gx-archive-synopsis';
        synopsis.textContent = title.providerDescription;
        overview.append(synopsis);
        const fullSynopsis = env.doc.createElement('p');
        fullSynopsis.className = 'gx-archive-full-synopsis';
        fullSynopsis.textContent = title.providerDescription;
        about.append(fullSynopsis);
      }

      if (env.host.onFavorite) {
        const heart = env.button(
          title.favorite ? '★' : '☆',

          () => {
            void env.favorite(title);
          },

          `${title.titleRef}-favorite`,
        );

        heart.className = 'gx-archive-favorite';

        heart.setAttribute(
          'aria-label',

          `${title.favorite ? 'Unfavorite' : 'Favorite'} ${title.title}`,
        );

        heart.setAttribute('aria-pressed', String(title.favorite));

        heart.disabled = env.favoriteBusy;

        article.append(heart);
        const detailHeart = env.button(
          title.favorite ? '★ Favorited' : '☆ Favorite',
          () => {
            void env.favorite(title);
          },
          `${title.titleRef}-detail-favorite`,
        );
        detailHeart.className = 'gx-archive-detail-favorite';
        detailHeart.setAttribute(
          'aria-label',
          `${title.favorite ? 'Unfavorite' : 'Favorite'} ${title.title}`,
        );
        detailHeart.setAttribute('aria-pressed', String(title.favorite));
        detailHeart.disabled = env.favoriteBusy;
        detailActions.insertBefore(detailHeart, about);
      }

      if (env.host.onRemove) {
        const manageTitle = env.doc.createElement('details');

        manageTitle.className = 'gx-archive-title-management';

        manageTitle.open = env.confirmation === `${title.titleRef}-remove`;

        const summary = env.doc.createElement('summary');
        summary.textContent = 'Manage title';

        manageTitle.append(
          summary,
          env.removalControls(
            { kind: 'title', titleRef: title.titleRef },
            title.title,
            `${title.titleRef}-remove`,
          ),
        );

        about.append(manageTitle);
      }

      if (env.expanded === title.titleRef) {
        const choices = env.doc.createElement('div');

        choices.className = 'gx-archive-files';

        choices.setAttribute('aria-label', `${title.title} videos to choose from`);
        const videosHeading = env.doc.createElement('h4');
        videosHeading.className = 'gx-archive-videos-heading';
        videosHeading.textContent = title.providerId ? 'Available files' : 'Available videos';
        inline.append(videosHeading, choices);

        if (title.rights) {
          const rights = env.doc.createElement('p');

          rights.className = 'gx-archive-rights';

          rights.textContent = `${title.providerId ? 'Source' : 'Uploader'} rights statement: ${title.rights}`;

          about.append(rights);
        }

        if (env.files?.titleRef === title.titleRef) {
          for (const file of env.files.files) {
            const fileName = fileLabel(
              file,
              title.fileCount === 1
                ? 'Video'
                : `Video ${env.files.offset + env.files.files.indexOf(file) + 1}`,
            );
            const fileRow = env.doc.createElement('div');
            fileRow.className = 'gx-archive-file-row';
            const fileCopy = env.doc.createElement('div');
            fileCopy.className = 'gx-archive-file-copy';
            const fileHeading = env.doc.createElement('strong');
            fileHeading.className = 'gx-archive-file-name';
            fileHeading.textContent = fileName;
            const row = env.button(
              'Play',

              () => {
                void env.choose(title, file);
              },

              file.fileRef,
            );

            row.className = 'gx-archive-file-button';
            row.setAttribute('aria-label', `Play ${fileName}`);

            // The active command coalesces repeat Play. Keep its logical opener
            // eligible while Resume closes ahead of a slow native handoff.
            const activePlay =
              env.selecting !== null &&
              env.selectionIdentity?.titleRef === title.titleRef &&
              env.selectionIdentity.fileRef === file.fileRef &&
              env.selectionIdentity.expectedRevision === env.revision &&
              env.files.revision === env.revision;
            row.disabled =
              file.availability === 'dead' ||
              file.providerFacts?.playbackCandidate === false ||
              (env.selecting !== null && !activePlay);
            row.setAttribute('aria-busy', String(activePlay));

            const info = env.doc.createElement('span');

            info.className = 'gx-archive-file-metadata';

            info.textContent = env.duration(file.durationSeconds);

            if (file.availability === 'dead') info.textContent += ' · Unavailable';
            else if (file.providerFacts?.playbackCandidate === false)
              info.textContent += ' · Details only';

            fileCopy.append(fileHeading, info);

            const details = env.doc.createElement('details');

            details.className = 'gx-archive-file-details';

            details.open = env.confirmation === `${file.fileRef}-remove`;

            const summary = env.doc.createElement('summary');

            summary.textContent = '⌄';
            summary.setAttribute('aria-label', `Video details for ${fileName}`);
            summary.dataset.archiveRef = `${file.fileRef}-details`;

            const facts = env.doc.createElement('dl');
            facts.className = 'gx-archive-file-facts';
            const fact = (label: string, value: string) => {
              const term = env.doc.createElement('dt'),
                description = env.doc.createElement('dd');
              term.textContent = label;
              description.textContent = value;
              facts.append(term, description);
            };
            fact('Title label', file.title.trim() || 'Not listed');
            fact('Filename', file.fileName);
            fact('Listed format', file.format === 'h.264' ? 'H.264' : file.format || 'Not listed');
            fact(
              'Listed duration',
              file.durationSeconds !== null &&
                Number.isFinite(file.durationSeconds) &&
                file.durationSeconds > 0
                ? env.duration(file.durationSeconds)
                : 'Not listed',
            );
            fact('Listed size', env.fileSize(file.sizeBytes));
            fact(
              'Source item',
              `${file.providerFacts ? publicArchiveProviderName(file.providerFacts.providerId) : 'Internet Archive'} · ${file.itemId}`,
            );
            fact('Episode / edition', 'Not verified');
            fact('Resolution', 'Not yet inspected');
            fact('Audio tracks', 'Not yet inspected');
            if (!file.providerFacts) {
              for (const [label, value] of archiveItemDateFacts(title)) fact(label, value);
            }
            if (file.providerFacts) {
              const f = file.providerFacts;
              fact('Source record', f.sourceUrl);
              if (f.providerId === 'nasa') {
                fact('Original release year', 'Unknown');
                fact(
                  'NASA provider-created date',
                  f.dateClaims?.providerCreated.value ?? 'Not listed',
                );
                if (f.dateClaims) fact('Date provenance', 'NASA search record · date_created');
              }
              fact('Listed media type', f.mimeType ?? 'Not listed');
              fact('Listed video codec', f.videoCodec ?? 'Not listed');
              fact('Listed audio codec', f.audioCodec ?? 'Not listed');
              fact(
                'Listed resolution',
                f.width && f.height ? `${f.width} × ${f.height}` : 'Not listed',
              );
              fact('Representation', f.representationRole ?? 'Not listed');
              fact('Content role', f.contentRole ?? 'Not verified');
              fact(
                'Playback',
                f.playbackCandidate
                  ? 'Format and availability checked when you select Play'
                  : (f.unsupportedReason ?? 'This file cannot be played by this app'),
              );
              fact(
                'Source access',
                f.accessRestricted === null
                  ? 'Not listed'
                  : f.accessRestricted
                    ? 'Restricted by source'
                    : 'Public access listed',
              );
              fact(
                'Source download offering',
                f.downloadAllowed === null
                  ? 'Not listed'
                  : f.downloadAllowed
                    ? 'Offered by source'
                    : 'Restricted by source',
              );
              fact('Download in GenXtra', 'Not available for this source yet');
              fact('Rights statement', f.rights ?? 'Not listed');
              fact('License', f.licenseUrl ?? 'Not listed');
              fact('Attribution', f.attribution ?? 'Not listed');
            }
            fact(
              'Past check',
              file.availability === 'played'
                ? 'Previously played'
                : file.availability === 'reachable'
                  ? 'Previously reachable'
                  : file.availability === 'dead'
                    ? 'Unavailable'
                    : 'Not checked',
            );
            details.append(summary);
            if (env.downloadsView && env.revision !== null && !file.providerFacts)
              details.append(
                env.downloadsView.fileControls(
                  file.fileRef,
                  env.revision,
                  file.availability !== 'dead',
                ),
              );
            details.append(facts);
            let revealAfterToggle = false;
            summary.addEventListener('click', () => {
              revealAfterToggle = true;
            });
            details.addEventListener('toggle', () => {
              // Observe the settled native toggle, not a click microtask (which
              // can run before the browser's default action). Reveal only this
              // file's action in our list; keep focus and playback unchanged.
              if (!revealAfterToggle) return;
              revealAfterToggle = false;
              if (env.closed || !env.enabled || !details.isConnected || !details.open) return;
              const action = details.querySelector<HTMLButtonElement>(
                '.gx-archive-file-downloads button:not([hidden]):not(:disabled)',
              );
              if (!action) return;
              const viewport = env.list.getBoundingClientRect(),
                button = action.getBoundingClientRect(),
                opener = summary.getBoundingClientRect();
              const top = Math.max(0, viewport.top + env.list.clientTop) + 4,
                bottom =
                  Math.min(innerHeight, viewport.top + env.list.clientTop + env.list.clientHeight) -
                  4;
              const pairTop = button.bottom - opener.top <= bottom - top ? opener.top : button.top;
              if (button.bottom > bottom) env.list.scrollTop += button.bottom - bottom;
              else if (pairTop < top) env.list.scrollTop += pairTop - top;
            });

            if (env.host.onRemove)
              details.append(
                env.removalControls(
                  { kind: 'file', titleRef: title.titleRef, fileRef: file.fileRef },
                  file.title,
                  `${file.fileRef}-remove`,
                ),
              );

            fileRow.append(fileCopy, row, details);
            choices.append(fileRow);
          }

          if (env.files.totalCount > env.files.files.length) {
            const filePaging = env.doc.createElement('nav');

            filePaging.className = 'gx-archive-paging';

            filePaging.setAttribute('aria-label', `${title.title} file pages`);

            const back = env.button('Previous files', () => {
              if (env.files) void env.filesAt(title, Math.max(0, env.files.offset - 50));
            });

            const forward = env.button('More files', () => {
              if (env.files) void env.filesAt(title, env.files.offset + env.files.files.length);
            });

            back.disabled = env.files.offset === 0;

            forward.disabled = !env.files.more;

            filePaging.append(back, forward);

            choices.append(filePaging);
          }

          if (env.files.totalCount === 0) {
            const empty = env.doc.createElement('p');

            empty.textContent = 'No selectable files are saved for this title.';

            choices.append(empty);
          }
        } else {
          const loading = env.doc.createElement('p');

          loading.textContent = 'Loading saved videos…';

          choices.append(loading);
        }

        if (!preserveDetailDOM) {
          env.detailPane.append(detail);
          env.detailPane.hidden = !env.enabled;
        }
      }

      article.append(inline);
      env.list.append(article);
    }

    env.list.scrollTop = scrollTop;
    for (const bindings of [...env.artworkBindings.values()])
      for (const [node, title] of [...bindings])
        if (!node.isConnected) env.releaseArtworkBinding(node, title);
    for (const node of env.artworkVisible) if (!node.isConnected) env.artworkVisible.delete(node);
    if (preserveDetailDOM) {
      const selected = env.page.items.find((title) => title.titleRef === env.expanded);
      const hero = env.detailPane.querySelector<HTMLElement>('.gx-archive-detail-artwork');
      if (selected && hero) env.observeArtwork(hero, selected);
    }
    env.syncDetailsHost();
    env.restoreFocus(focus);
  }
  function renderPending(): void {
    const focus = env.selectedFocus();

    env.pendingContent.replaceChildren();

    env.pending.hidden = !env.pendingPage?.items.length;

    if (!env.pendingPage || env.pending.hidden) {
      env.pending.open = false;
      return;
    }

    env.pendingSummary.textContent = `More to explore · ${env.pendingPage.totalCount} ${env.pendingPage.totalCount === 1 ? 'title' : 'titles'}`;

    for (const progress of env.pendingPage.items) {
      const row = env.doc.createElement('div');

      row.className = 'gx-archive-pending-row';

      const label = env.doc.createElement('span');

      label.textContent = `${progress.title}${progress.originalYear === null ? '' : ` · ${progress.originalYear}`}`;

      const note = env.doc.createElement('small');

      note.textContent = progress.capacityReached
        ? 'A saved limit was reached; other files may exist.'
        : progress.complete
          ? 'All listed files were checked; playback is unverified.'
          : progress.availableFileCount
            ? `${progress.availableFileCount} saved · ${progress.nextOffset}/${progress.providerFileCount} listed files checked`
            : 'More files have not been checked yet.';

      const load = env.button(
        progress.kind === 'tv' ? 'Find episodes' : 'Load more',

        () => {
          void env.loadPendingFiles(progress);
        },

        `${progress.titleRef}-more-files`,
      );

      load.disabled = progress.complete || progress.capacityReached || !env.host.loadFiles;

      row.append(label, note, load);

      if (env.host.onRemove) {
        const manage = env.doc.createElement('details');
        manage.className = 'gx-archive-title-management';
        manage.open = env.confirmation === `${progress.titleRef}-pending-remove`;
        const summary = env.doc.createElement('summary');
        summary.textContent = 'Manage title';
        manage.append(
          summary,
          env.removalControls(
            { kind: 'title', titleRef: progress.titleRef },
            progress.title,
            `${progress.titleRef}-pending-remove`,
          ),
        );
        row.append(manage);
      }

      env.pendingContent.append(row);
    }

    const nav = env.doc.createElement('nav');

    nav.className = 'gx-archive-pending-pages';

    const previousPending = env.button('Previous', () => {
      void pendingAt(Math.max(0, env.pendingPage!.offset - 5));
    });

    previousPending.disabled = env.pendingPage.offset === 0;

    const nextPending = env.button('More', () => {
      void pendingAt(env.pendingPage!.offset + 5);
    });

    nextPending.disabled = !env.pendingPage.more;

    nav.append(previousPending, nextPending);

    env.pendingContent.append(nav);

    env.restoreFocus(focus);
  }
  function pendingAt(offset: number): Promise<void> {
    if (!env.host.pendingFiles || env.pendingPage === null) return Promise.resolve();

    const expectedRevision = env.pendingPage.revision;

    return env.run(async (signal, owner, scope) => {
      const result = await env.host.pendingFiles!(
        expectedRevision,
        offset,
        env.savedQuery,
        signal,
        env.browseOptions().languageMode,
        env.browseOptions().contentType,
      );

      if (!env.current(owner, scope, signal)) return;

      env.pendingPage = result;

      render();
    }, 'Loading saved suggestions…');
  }
  return {
    render,
  };
}
