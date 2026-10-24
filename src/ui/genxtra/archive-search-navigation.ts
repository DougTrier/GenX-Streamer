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

import { type ArchivePage } from '../../platform/archive-catalog';

/** What this part reads from, and writes back to, mountArchiveSearch. */
export interface ArchiveSearchNavigationEnvironment {
  readonly dismissEpisodes: () => boolean;
  readonly revealResultTitle: (title: HTMLButtonElement | null) => void;
  readonly root: HTMLElement;
  readonly list: HTMLDivElement;
  readonly page: ArchivePage | null;
  readonly abort: AbortController | null;
  readonly appendSavedTitles: () => Promise<void>;
  readonly doc: Document;
  readonly detailPane: HTMLElement;
}

/**
 * Moving through GenXtra search with the remote's arrow keys. Part of
 * mountArchiveSearch.
 */
export function createArchiveSearchNavigation(env: ArchiveSearchNavigationEnvironment) {
  const navigateControls: EventListener = (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    const source = event.target instanceof HTMLElement ? event.target : null;
    const row = source?.closest<HTMLElement>('.gx-archive-result-row');
    const inline = source?.closest<HTMLElement>('.gx-archive-inline-videos');
    const fileRow = source?.closest<HTMLElement>('.gx-archive-file-row');
    const playColumn = source?.matches('.gx-archive-file-button');
    const moreColumn = source?.matches('.gx-archive-file-details > summary');
    if (source && inline && row && fileRow && (playColumn || moreColumn)) {
      let target: HTMLElement | null | undefined;
      if (playColumn && event.key === 'ArrowRight')
        target = fileRow.querySelector<HTMLElement>('.gx-archive-file-details > summary');
      else if (moreColumn && event.key === 'ArrowLeft')
        target =
          fileRow.querySelector<HTMLButtonElement>('.gx-archive-file-button:not(:disabled)') ??
          row.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      else if (
        ['ArrowUp', 'ArrowDown'].includes(event.key) &&
        !(moreColumn && event.key === 'ArrowDown' && source.closest('details')?.open)
      ) {
        const fileRows = Array.from(inline.querySelectorAll<HTMLElement>('.gx-archive-file-row'));
        const step = event.key === 'ArrowDown' ? 1 : -1;
        for (
          let index = fileRows.indexOf(fileRow) + step;
          index >= 0 && index < fileRows.length;
          index += step
        ) {
          target = fileRows[index]?.querySelector<HTMLElement>(
            playColumn
              ? '.gx-archive-file-button:not(:disabled)'
              : '.gx-archive-file-details > summary',
          );
          if (target) break;
        }
        if (!target)
          target =
            step < 0
              ? row.querySelector<HTMLButtonElement>('.gx-archive-title-button')
              : (inline.querySelector<HTMLButtonElement>(
                  '.gx-archive-paging button:not(:disabled)',
                ) ??
                row.nextElementSibling?.querySelector<HTMLButtonElement>(
                  '.gx-archive-title-button',
                ));
        // The edge remains in the owned list; Left always returns to its title.
        event.preventDefault();
        event.stopPropagation();
        if (target) {
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        return;
      }
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
    }
    if (inline && row && ['ArrowLeft', 'Escape'].includes(event.key)) {
      const titleButton = row.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        env.dismissEpisodes();
      } else env.revealResultTitle(titleButton);
      return;
    }
    if (
      row &&
      source?.matches('.gx-archive-title-button,.gx-archive-favorite') &&
      env.root.contains(row) &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      let target: HTMLButtonElement | null | undefined;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const rowControls = Array.from(
          row.querySelectorAll<HTMLButtonElement>('.gx-archive-title-button,.gx-archive-favorite'),
        );
        target =
          rowControls[
            rowControls.indexOf(source as HTMLButtonElement) + (event.key === 'ArrowRight' ? 1 : -1)
          ];
      } else {
        if (event.key === 'ArrowDown' && source.matches('.gx-archive-title-button')) {
          const firstPlay = row.querySelector<HTMLButtonElement>(
            '.gx-archive-inline-videos:not([hidden]) :is(.gx-archive-file-button:not(:disabled),.gx-archive-file-details > summary)',
          );
          if (firstPlay) {
            event.preventDefault();
            event.stopPropagation();
            firstPlay.focus({ preventScroll: true });
            firstPlay.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            return;
          }
        }
        const rows = Array.from(env.list.querySelectorAll<HTMLElement>('.gx-archive-result-row'));
        const neighbor = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!neighbor && event.key === 'ArrowDown' && env.page?.more && env.abort === null) {
          const identity = source?.dataset.archiveRef;
          const count = rows.length;
          const favorite = source?.matches('.gx-archive-favorite');
          event.preventDefault();
          event.stopPropagation();
          void env.appendSavedTitles().then(() => {
            if (
              !(env.doc.activeElement instanceof HTMLElement) ||
              env.doc.activeElement.dataset.archiveRef !== identity
            )
              return;
            const nextRow = env.list.querySelectorAll<HTMLElement>('.gx-archive-result-row')[count];
            const action = nextRow?.querySelector<HTMLButtonElement>(
              favorite ? '.gx-archive-favorite' : '.gx-archive-title-button',
            );
            action?.focus({ preventScroll: true });
            action?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          });
          return;
        }
        target = neighbor?.querySelector<HTMLButtonElement>(
          source?.matches('.gx-archive-favorite')
            ? '.gx-archive-favorite'
            : '.gx-archive-title-button',
        );
      }
      if (target && !target.disabled) {
        event.preventDefault();
        event.stopPropagation();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (event.key === 'ArrowLeft' && source && env.detailPane.contains(source)) {
      const selected = env.list.querySelector<HTMLButtonElement>(
        '.gx-archive-title-button[aria-current="true"]',
      );
      if (selected) {
        event.preventDefault();
        event.stopPropagation();
        selected.focus({ preventScroll: true });
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const parent = inline ?? (event.currentTarget as HTMLElement);
    const controls = Array.from(parent.querySelectorAll<HTMLElement>('button, summary')).filter(
      (node) => {
        if (
          node.matches(':disabled, [aria-disabled="true"]') ||
          node.closest('[hidden], [inert]') ||
          !node.getClientRects().length
        )
          return false;
        const style = env.doc.defaultView!.getComputedStyle(node);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse'
        )
          return false;
        let ancestor = node.parentElement;
        while (ancestor) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
            const summary = Array.from(ancestor.children).find(
              (child) => child.tagName === 'SUMMARY',
            );
            if (!summary?.contains(node)) return false;
          }
          // The event owner can itself be a closed disclosure (Settings
          // management). Its hidden children must not consume boundary keys.
          if (ancestor === parent) break;
          ancestor = ancestor.parentElement;
        }
        return true;
      },
    );
    const index = controls.indexOf(env.doc.activeElement as HTMLElement);
    if (index < 0) return;
    const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (inline && row && nextIndex < 0) {
      event.preventDefault();
      event.stopPropagation();
      env.revealResultTitle(row.querySelector<HTMLButtonElement>('.gx-archive-title-button'));
      return;
    }
    if (inline && row && nextIndex === controls.length) {
      const nextRow = row.nextElementSibling;
      const nextTitle = nextRow?.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      if (nextTitle) {
        event.preventDefault();
        event.stopPropagation();
        nextTitle.focus({ preventScroll: true });
        nextTitle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (nextIndex >= 0 && nextIndex < controls.length) {
      event.preventDefault();
      event.stopPropagation();
      const target = controls[nextIndex]!;
      target.focus({ preventScroll: true });
      if (env.doc.activeElement === target)
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  return {
    navigateControls,
  };
}
