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
/**
 * Remote and keyboard navigation inside GenXtra, the public archive library:
 * how the arrow keys move between the search row, filters and title posters.
 * Moved out of main.ts.
 */
import { type createFullscreenOwner } from '../ui/fullscreen-owner';
import { type createRemoteEditMode } from '../ui/remote-navigation';
import { type ContentLibrary } from './content-library';
import { type PrimaryPage } from './primary-page';

/** What this area reads from, and writes back to, the rest of the application. */
export interface GenxtraNavigationEnvironment {
  readonly contentLibrary: ContentLibrary;
  readonly primaryPage: PrimaryPage;
  readonly fullscreenOwner: ReturnType<typeof createFullscreenOwner>;
  readonly remoteEditMode: ReturnType<typeof createRemoteEditMode>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
}

export function createGenxtraNavigation(env: GenxtraNavigationEnvironment) {
  function genxtraNavigation(event: KeyboardEvent): void {
    if (
      env.contentLibrary !== 'genxtra' ||
      event.defaultPrevented ||
      env.primaryPage !== 'watch' ||
      document.querySelector('dialog[open]') ||
      env.fullscreenOwner.active
    )
      return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    if (focused.id === 'search' && env.remoteEditMode.isEditing(focused)) return;
    const firstFile =
      [
        ...env
          .element('genxtra-library')
          .querySelectorAll<HTMLElement>('.gx-archive-filter-toggle, .gx-archive-title-button'),
      ].find(
        (control) =>
          !control.matches(':disabled') &&
          !control.closest('[hidden],[inert]') &&
          control.getClientRects().length > 0,
      ) ?? null;
    const firstDetail =
      [
        ...env
          .element('archive-details')
          .querySelectorAll<HTMLElement>('button:not(:disabled), summary'),
      ].find((control) => control.checkVisibility() && !control.closest('[hidden],[inert]')) ??
      null;
    const selectedResult = env
      .element('genxtra-library')
      .querySelector<HTMLButtonElement>('.gx-archive-title-button[aria-current="true"]');
    const filterControl = (id: string): HTMLElement =>
      env
        .element('genxtra-browse-filters')
        .querySelector<HTMLElement>(`.in-app-select[data-native-select-id="${id}"] > button`) ??
      env.element(id);
    const firstKind = filterControl('genxtra-kind-select');
    const firstFilter = filterControl('genxtra-decade-select');
    // TV seek and playback buttons share one visual row. Pause is not its left
    // boundary while an earlier seek action is visible and enabled.
    const dockSelector =
      env.element('app').dataset.deviceKind === 'tv'
        ? '#vod-transport button,.controls button'
        : '.controls button';
    const dock = [...document.querySelectorAll<HTMLButtonElement>(dockSelector)].find(
      (button) =>
        !button.disabled && button.checkVisibility() && !button.closest('[hidden],[inert]'),
    );
    const searchRow = focused.closest('.search-controls');
    const lastSearchAction = searchRow
      ? [...searchRow.querySelectorAll<HTMLElement>('button,input')]
          .filter(
            (control) =>
              !control.matches(':disabled,[aria-disabled="true"]') &&
              control.checkVisibility({ visibilityProperty: true }) &&
              !control.closest('[hidden],[inert]'),
          )
          .at(-1)
      : null;
    let target: HTMLElement | null = null;
    if (focused.id === 'genxtra-button' && event.key === 'ArrowDown')
      target = env.element('search');
    else if (focused.id === 'search' && event.key === 'ArrowDown')
      target = firstKind ?? firstFilter;
    // Shared search-row navigation owns the field, Clear and microphone. Only
    // the row's right edge leaves for the dock; capture must not skip its actions.
    else if (focused === lastSearchAction && event.key === 'ArrowRight') target = dock ?? null;
    else if (focused.closest('#genxtra-browse-filters') && event.key === 'ArrowDown')
      target = firstFile ?? dock ?? null;
    else if (focused.closest('#genxtra-browse-filters') && event.key === 'ArrowUp')
      target = env.element('search');
    else if (
      focused.closest('#genxtra-browse-filters') &&
      event.key === 'ArrowLeft' &&
      focused !== firstKind
    )
      target = firstKind;
    else if (
      focused.closest('#genxtra-browse-filters') &&
      event.key === 'ArrowRight' &&
      focused !== firstFilter
    )
      target = firstFilter;
    else if (focused.matches('.gx-archive-favorite') && event.key === 'ArrowRight')
      target = firstDetail ?? dock ?? null;
    else if (focused.closest('#archive-details') && event.key === 'ArrowLeft')
      target = selectedResult ?? firstFile;
    else if (focused === dock && event.key === 'ArrowLeft')
      target = selectedResult ?? firstFile ?? firstFilter;
    else if (focused.closest('.controls') && event.key === 'ArrowUp')
      target = env.element('genxtra-button');
    if (target && target.getClientRects().length && !target.closest('[hidden],[inert]')) {
      event.preventDefault();
      event.stopPropagation();
      if (target.id === 'search') env.remoteEditMode.navigate(target);
      target.focus({ preventScroll: true });
    }
  }
  return {
    genxtraNavigation,
  };
}
