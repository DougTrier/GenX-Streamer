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

export type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
export interface FocusBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function directionalIndex(
  origin: FocusBox,
  candidates: readonly FocusBox[],
  key: Direction,
): number {
  let index = -1,
    distance = Infinity;
  const ox = origin.x + origin.width / 2,
    oy = origin.y + origin.height / 2;
  candidates.forEach((box, candidate) => {
    const dx = box.x + box.width / 2 - ox,
      dy = box.y + box.height / 2 - oy;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const ahead =
      key === 'ArrowRight'
        ? dx > 1
        : key === 'ArrowLeft'
          ? dx < -1
          : key === 'ArrowDown'
            ? dy > 1
            : dy < -1;
    const verticalOverlap =
      Math.min(origin.y + origin.height, box.y + box.height) - Math.max(origin.y, box.y);
    // Unequal-height neighbours on one row are horizontal choices, even when
    // their centres differ. Keep vertical routes out of that same-row overlap.
    if (!ahead || (!horizontal && verticalOverlap > Math.min(origin.height, box.height) / 2))
      return;
    const verticalGap = Math.max(origin.x - box.x - box.width, box.x - origin.x - origin.width, 0);
    const score =
      (horizontal ? Math.abs(dx) : Math.abs(dy)) + (horizontal ? Math.abs(dy) : verticalGap) * 3;
    if (score < distance) {
      index = candidate;
      distance = score;
    }
  });
  return index;
}
export interface RemoteEditMode {
  navigate(field: HTMLElement): void;
  begin(field: HTMLElement): void;
  isNavigation(field: HTMLElement): boolean;
  isEditing(field: HTMLElement): boolean;
  exit(): boolean;
  clear(): void;
}
export function createRemoteInputOrigin() {
  let directional = false;
  let activated = false;
  return {
    directional() {
      directional = true;
      activated = false;
    },
    activate() {
      activated = directional;
    },
    clear() {
      directional = activated = false;
    },
    autofocus(sameField: boolean, inDialog: boolean) {
      // Modal/action autofocus belongs to remote navigation. A main search
      // focus returned by speech is intentionally editable, not evidence of
      // a newly opened remote form.
      return activated && !sameField && inDialog;
    },
  };
}
/** Pointer/Tab fields remain native; only explicit D-pad arrivals enter navigation mode. */
export function createRemoteEditMode(
  active: () => Element | null = () => document.activeElement,
): RemoteEditMode {
  let field: HTMLElement | null = null,
    editing = false;
  let original: { readonly: string | null; inputmode: string | null } | null = null;
  const restore = () => {
    if (!field || !original) return;
    for (const [name, value] of [
      ['readonly', original.readonly],
      ['inputmode', original.inputmode],
    ] as const) {
      if (value === null) field.removeAttribute(name);
      else field.setAttribute(name, value);
    }
  };
  const suppress = () => {
    if (!field || !original) return;
    // Apply before focus: Android otherwise opens its native editor on arrival.
    field.setAttribute('readonly', '');
    field.setAttribute('inputmode', 'none');
  };
  const clear = () => {
    restore();
    field = null;
    original = null;
    editing = false;
  };
  return {
    navigate(next) {
      if (field !== next) {
        clear();
        field = next;
        // Select retains native choice semantics; textarea still restores its
        // original multiline editing behavior when explicitly activated.
        if (typeof next.matches === 'function' && next.matches('input,textarea'))
          original = {
            readonly: next.getAttribute('readonly'),
            inputmode: next.getAttribute('inputmode'),
          };
      }
      editing = false;
      suppress();
    },
    begin(next) {
      if (field === next) {
        const reopenEditor = original !== null && original.readonly === null && active() === next;
        restore();
        editing = true;
        // Removing readonly on an already-focused Android WebView field does
        // not guarantee a new input connection. Explicit OK re-enters focus.
        if (reopenEditor) {
          next.blur();
          next.focus({ preventScroll: true });
        }
      }
    },
    isNavigation(next) {
      return field === next && !editing;
    },
    isEditing(next) {
      return field !== next || editing;
    },
    exit() {
      if (!field || active() !== field) {
        clear();
        return false;
      }
      if (!editing) return false;
      editing = false;
      suppress();
      return true;
    },
    clear,
  };
}

const focusSelector =
  'button,input,textarea,select,summary,[contenteditable="true"],[tabindex="0"]';
function editField(element: HTMLElement): boolean {
  return (
    element.matches('textarea,select') ||
    (element.matches('input') &&
      ['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'].includes(
        element.getAttribute('type')?.toLowerCase() ?? '',
      ))
  );
}
/**
 * Inside something that cannot be shown: inert or hidden, a closed dialog, or
 * anything but the summary of a closed disclosure (at any depth). One native
 * selector match, before any style or layout is read: reading the style of
 * the ~600 controls in closed dialogs and the closed country list cost the
 * Sansui TV about 400 ms per arrow press (October 19, 2026).
 */
const unshown = '[inert],[hidden],dialog:not([open]),details:not([open]) > :not(summary)';
const modal = () =>
  [...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-primary-page])')].at(
    -1,
  ) ?? null;
function eligible(
  element: HTMLElement | null,
  scope: Document | HTMLElement,
): element is HTMLElement {
  if (
    !element ||
    !element.isConnected ||
    !scope.contains(element) ||
    !element.matches(focusSelector) ||
    element.matches(':disabled,[aria-disabled="true"]') ||
    // Chromium can retain layout boxes for descendants of a closed disclosure;
    // only its direct summary remains eligible, including through nested details.
    element.closest(unshown)
  )
    return false;
  // Size first: style is read only for controls that have a box.
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
  );
}
function candidates(scope: Document | HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(focusSelector)].filter(
    (element) => !element.closest(unshown) && eligible(element, scope),
  );
}
/**
 * A control cut off by a scrolling area that focus is not in (the channel
 * list keeps rows rendered beyond its visible part, behind the categories
 * and header). Directional moves never pick it: on the Google TV Streamer
 * such rows outscored News, Sports, Loc & Sort and Guide (October 19, 2026).
 * Inside the same scrolling area, clipped controls stay reachable so focus
 * can scroll it.
 */
function clippedAway(candidate: HTMLElement, focused: HTMLElement): boolean {
  const box = candidate.getBoundingClientRect();
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  for (
    let area = candidate.parentElement;
    area && area !== document.body;
    area = area.parentElement
  ) {
    if (area.contains(focused)) return false;
    const style = getComputedStyle(area);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) continue;
    const view = area.getBoundingClientRect();
    if (x < view.left || x > view.right || y < view.top || y > view.bottom) return true;
  }
  return false;
}
/**
 * Fully inside every scrolling area around it and not under another layer
 * (a dialog's footer). Left and Right only go to such controls: in Settings
 * they reached an account's Remove scrolled out of view and Exit app in the
 * footer (Streamer, October 19, 2026).
 */
function shownWhole(candidate: HTMLElement): boolean {
  const box = candidate.getBoundingClientRect();
  for (
    let area = candidate.parentElement;
    area && area !== document.body;
    area = area.parentElement
  ) {
    const style = getComputedStyle(area);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) continue;
    const view = area.getBoundingClientRect();
    if (
      box.top < view.top - 1 ||
      box.bottom > view.bottom + 1 ||
      box.left < view.left - 1 ||
      box.right > view.right + 1
    )
      return false;
  }
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return !hit || candidate.contains(hit) || hit.contains(candidate);
}
/** Live controls between the category row and the channel list (the channel row, scan actions). */
function liveMiddleControls(scope: Document | HTMLElement): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '.sidehead summary, .sidehead button, #inline-source-scan button',
    ),
  ].filter((control) => eligible(control, scope));
}
/** The nearest middle control in the key's direction, else the edge one for that direction. */
function nearestMiddle(focused: HTMLElement, middle: HTMLElement[], key: Direction) {
  const index = directionalIndex(
    focused.getBoundingClientRect(),
    middle.map((control) => control.getBoundingClientRect()),
    key,
  );
  return middle[index] ?? (key === 'ArrowDown' ? middle[0] : middle.at(-1)) ?? null;
}
/** Restore only a live eligible control within the top modal, otherwise a safe current fallback. */
export function restoreRemoteFocus(
  preferred: HTMLElement | null,
  fallback: HTMLElement | null = null,
): boolean {
  const scope = modal() ?? document;
  const target = [
    preferred,
    fallback,
    scope.querySelector<HTMLElement>('#channel-list'),
    ...candidates(scope),
  ].find((element) => eligible(element, scope));
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
let installedEditMode: RemoteEditMode | undefined;
/**
 * Call before moving focus to a control on a remote arrow from code outside
 * this navigator (the guide's toolbar): a text field arrives in navigation
 * mode, so Android's keyboard waits for OK.
 */
export function prepareRemoteFocus(target: HTMLElement): void {
  if (installedEditMode && editField(target) && !installedEditMode.isNavigation(target))
    installedEditMode.navigate(target);
}
export interface RemoteNavigationOptions {
  editMode?: RemoteEditMode;
  initialFocus?: () => HTMLElement | null;
}
/** Directional remotes move focus only; activation/media/Back remain their existing owners. */
export function installRemoteNavigation(options: RemoteNavigationOptions = {}): () => void {
  const editMode = options.editMode;
  installedEditMode = editMode;
  const inputOrigin = createRemoteInputOrigin();
  let entryHeld = false;
  let previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let lastChannelId: string | null = null;
  let lastTopAction: HTMLElement | null = null;
  let lastDockControl: HTMLElement | null = null;
  let lastCategoryFilter: HTMLElement | null = null;
  const openers = new WeakMap<HTMLDialogElement, HTMLElement | null>();
  const settingsPanelFocus = new WeakMap<HTMLElement, HTMLElement>();
  let arrowInFlight = false;
  const focusin = (event: FocusEvent): void => {
    const next = event.target instanceof HTMLElement ? event.target : null;
    const channel = next?.closest<HTMLElement>('#channel-list [data-channel]');
    if (channel?.dataset.channel) lastChannelId = channel.dataset.channel;
    if (next?.closest('.top-actions')) lastTopAction = next;
    if (next?.closest('.controls')) lastDockControl = next;
    if (next?.matches('.filters button')) lastCategoryFilter = next;
    const settingsPanel = next?.closest<HTMLElement>('#settings-dialog [data-settings-panel]');
    if (settingsPanel && next) settingsPanelFocus.set(settingsPanel, next);
    const dialog = next?.closest<HTMLDialogElement>('dialog[open]');
    if (next && editField(next) && inputOrigin.autofocus(next === previousFocus, !!dialog))
      editMode?.navigate(next);
    // Any code moving focus on an arrow (the guide's toolbar, a list's own
    // handler) lands a text field in navigation mode, so Android's keyboard
    // waits for OK instead of opening and capturing the remote (guide search
    // on the Streamer, October 19, 2026).
    else if (
      next &&
      editField(next) &&
      arrowInFlight &&
      editMode &&
      next !== previousFocus &&
      !editMode.isNavigation(next)
    )
      editMode.navigate(next);
    if (dialog && !openers.has(dialog) && !dialog.contains(previousFocus))
      openers.set(dialog, previousFocus);
    previousFocus = next;
  };
  const focusout = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement && editMode?.isNavigation(event.target))
      editMode.clear();
  };
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      const dialog = change.target;
      if (!(dialog instanceof HTMLDialogElement) || dialog.open) continue;
      const scope = modal() ?? document;
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!eligible(current, scope)) restoreRemoteFocus(openers.get(dialog) ?? null);
      openers.delete(dialog);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  const entryCapture = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const entering = document.activeElement;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      // Focus moved by any handler of this same key press (cleared once the press is handled).
      arrowInFlight = true;
      setTimeout(() => (arrowInFlight = false), 0);
      if (
        entering instanceof HTMLElement &&
        editField(entering) &&
        (!editMode || editMode.isEditing(entering))
      )
        inputOrigin.clear();
      else inputOrigin.directional();
    }
    if (
      event.key === 'Enter' &&
      event.repeat &&
      (entryHeld || !(entering instanceof HTMLElement) || !entering.matches('textarea'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Tab') {
      inputOrigin.clear();
      editMode?.clear();
      return;
    }
    if (event.key === 'Escape') inputOrigin.clear();
    if (event.key === 'Escape' && editMode?.exit()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const focused = document.activeElement;
    if (event.key === 'Enter') inputOrigin.activate();
    else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey)
      inputOrigin.clear();
    // TV OK is Enter. Checkbox/radio native keyboard activation otherwise uses
    // Space, so activate only the current eligible control once per key press.
    if (
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      focused instanceof HTMLInputElement &&
      focused.matches('input[type=checkbox],input[type=radio]') &&
      eligible(focused, modal() ?? document)
    ) {
      event.preventDefault();
      event.stopPropagation();
      focused.click();
      return;
    }
    if (!(focused instanceof HTMLElement) || !editMode?.isNavigation(focused)) return;
    if (event.key === 'Enter') {
      entryHeld = true;
      inputOrigin.clear();
      editMode.begin(focused);
      if (!focused.matches('select')) {
        event.preventDefault();
        event.stopPropagation();
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey)
      editMode.begin(focused);
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.key === 'Enter') entryHeld = false;
  };
  const pointer = () => {
    entryHeld = false;
    inputOrigin.clear();
    editMode?.clear();
  };
  const focus = (target: HTMLElement) => {
    if (editField(target)) editMode?.navigate(target);
    else editMode?.clear();
    target.focus();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    const scope = modal() ?? document;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!eligible(focused, scope)) {
      // A focused control that became disabled or hidden (for example Find while
      // it runs) hands focus to the nearest usable control, not the screen start.
      const prior: HTMLElement | null = previousFocus;
      const priorBox = prior?.getBoundingClientRect() ?? null;
      const lost =
        prior &&
        prior !== document.body &&
        prior.isConnected &&
        scope.contains(prior) &&
        prior.matches(focusSelector) &&
        !eligible(prior, scope)
          ? priorBox
          : null;
      if (lost && (lost.width > 0 || lost.height > 0)) {
        const centre = (box: DOMRect) => [box.x + box.width / 2, box.y + box.height / 2];
        const [lx, ly] = centre(lost);
        const nearest = candidates(scope)
          .map((control) => {
            const [x, y] = centre(control.getBoundingClientRect());
            return { control, distance: Math.hypot(x - lx, (y - ly) * 2) };
          })
          .sort((a, b) => a.distance - b.distance)[0]?.control;
        if (nearest) {
          event.preventDefault();
          focus(nearest);
          return;
        }
      }
      const primaryGuide = document.querySelector<HTMLElement>(
        'dialog[open][data-primary-page] .gx-timeline, .paid-guide:not([hidden]) .gx-timeline',
      );
      const guideEntry =
        primaryGuide &&
        ([...primaryGuide.querySelectorAll<HTMLElement>('.gx-timeline-channel')].find((control) =>
          eligible(control, scope),
        ) ??
          [...primaryGuide.querySelectorAll<HTMLElement>('.gx-timeline-toolbar button')].find(
            (control) => eligible(control, scope),
          ));
      const initial =
        guideEntry ??
        options.initialFocus?.() ??
        (scope === document
          ? (document.querySelector<HTMLElement>('.channel') ??
            document.querySelector<HTMLElement>('#search-programs'))
          : null);
      const target = eligible(initial, scope) ? initial : candidates(scope)[0];
      if (target) {
        event.preventDefault();
        focus(target);
      }
      return;
    }
    if (focused.matches('input[type="range"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key))
      return;
    if (
      focused.matches('[contenteditable="true"]') ||
      (editField(focused) && (!editMode || editMode.isEditing(focused)))
    )
      return;
    if (editMode?.isNavigation(focused)) event.preventDefault();
    if (scope instanceof HTMLElement && scope.id === 'import-dialog') {
      const close = scope.querySelector<HTMLElement>('[data-close="import-dialog"]');
      const body = scope.querySelector<HTMLElement>('.dialog-body');
      const first = body ? candidates(body)[0] : null;
      const target =
        focused === close && event.key === 'ArrowDown'
          ? first
          : focused === first && event.key === 'ArrowUp'
            ? close
            : null;
      if (eligible(target, scope)) {
        event.preventDefault();
        focus(target!);
        return;
      }
    }
    if (scope instanceof HTMLElement && scope.id === 'settings-dialog') {
      const chooser = scope.querySelector<HTMLElement>('#settings-section');
      const close = scope.querySelector<HTMLElement>('[data-close="settings-dialog"]');
      const panel = scope.querySelector<HTMLElement>('[data-settings-panel]:not([hidden])');
      const panelControls = panel ? candidates(panel) : [];
      const first = panelControls[0];
      const footer = scope.querySelector<HTMLElement>('.settings-footer');
      let target: HTMLElement | null | undefined;
      if (focused === close && event.key === 'ArrowDown') target = chooser;
      else if (focused === chooser && chooser?.getAttribute('aria-expanded') !== 'true') {
        if (event.key === 'ArrowUp') target = close;
        if (event.key === 'ArrowDown') target = first;
      } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && panel?.contains(focused)) {
        const choices = panelControls.filter((control) => control !== focused);
        const next = directionalIndex(
          focused.getBoundingClientRect(),
          choices.map((control) => control.getBoundingClientRect()),
          event.key as Direction,
        );
        target =
          next >= 0
            ? choices[next]
            : event.key === 'ArrowUp'
              ? chooser
              : footer
                ? candidates(footer)[0]
                : null;
        event.preventDefault();
        if (eligible(target ?? null, scope)) focus(target!);
        return;
      } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && footer?.contains(focused)) {
        const remembered = panel ? settingsPanelFocus.get(panel) : null;
        target =
          event.key === 'ArrowUp'
            ? panel && eligible(remembered ?? null, panel)
              ? remembered
              : (panelControls.at(-1) ?? chooser)
            : focused;
        event.preventDefault();
        if (target !== focused && eligible(target ?? null, scope)) focus(target!);
        return;
      }
      if (eligible(target ?? null, scope)) {
        event.preventDefault();
        focus(target!);
        return;
      }
    }

    // Main-screen regions have deliberate exits; geometric proximity must not
    // send a channel viewer through the resize separator to reach playback.
    if (scope === document) {
      const searchControls = focused.closest<HTMLElement>('.search-controls');
      if (searchControls && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        // Treat the field, clear action and microphone as one ordered row.
        // Navigation mode must reach Clear without activating or editing text.
        const controls = candidates(searchControls);
        const index = controls.indexOf(focused);
        const target = controls[index + (event.key === 'ArrowRight' ? 1 : -1)];
        if (index >= 0 && eligible(target ?? null, scope)) {
          event.preventDefault();
          focus(target);
          return;
        }
      }
      if (focused.closest('#channel-list') && event.key === 'ArrowUp') {
        // The list's own handler consumes movement between rows. Its upper
        // boundary, including an empty list, returns to Location and sort or
        // the scan actions when shown, otherwise to the category row.
        const middle = liveMiddleControls(scope);
        if (middle.length) {
          const target = nearestMiddle(focused, middle, 'ArrowUp');
          if (eligible(target, scope)) {
            event.preventDefault();
            focus(target);
            return;
          }
        }
        const filters = [...document.querySelectorAll<HTMLElement>('.filters button')].filter(
          (button) => eligible(button, scope),
        );
        const target =
          filters.find((button) => button === lastCategoryFilter) ??
          filters.find((button) => button.getAttribute('aria-pressed') === 'true') ??
          filters[0] ??
          // With the Guide open the preview sits above the list instead.
          document.querySelector<HTMLElement>('#screen[role="button"]');
        if (eligible(target ?? null, scope)) {
          event.preventDefault();
          focus(target);
          return;
        }
      }
      if (focused.closest('.filters') && event.key === 'ArrowDown') {
        // Location and sort and the scan actions sit between the categories and the list.
        const middle = liveMiddleControls(scope);
        const between = middle.length ? nearestMiddle(focused, middle, 'ArrowDown') : null;
        if (eligible(between, scope)) {
          event.preventDefault();
          focus(between);
          return;
        }
        const channel = document.querySelector<HTMLElement>('#channel-list .channel');
        if (eligible(channel, scope)) {
          event.preventDefault();
          focus(channel);
          return;
        }
      }
      const television = document.getElementById('app')?.dataset.deviceKind === 'tv';
      const controls = document.querySelector<HTMLElement>('.controls');
      const firstControl = controls
        ? [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
            eligible(button, scope),
          )
        : null;
      if (focused.id === 'divider' && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        // A full-height separator overlaps both regions, so centre-distance
        // routing cannot supply a vertical exit. Resizing retains Left/Right.
        const target =
          event.key === 'ArrowUp' ? document.getElementById('search') : (firstControl ?? null);
        if (eligible(target, scope)) {
          event.preventDefault();
          focus(target);
          return;
        }
      }
      // TV regions have stable vertical routes instead of a detour through
      // the resize separator. Native editors and fullscreen retain their owners.
      if (television && !document.querySelector('.viewing-fullscreen')) {
        let target: HTMLElement | null = null;
        if (focused.id === 'search' && event.key === 'ArrowUp') {
          target = eligible(lastTopAction, scope)
            ? lastTopAction
            : (document.querySelector<HTMLElement>('.top-actions button[aria-pressed="true"]') ??
              document.getElementById('live-tv-button'));
        } else if (focused.id === 'search' && event.key === 'ArrowDown') {
          const filters = [...document.querySelectorAll<HTMLElement>('.filters button')].filter(
            (button) => eligible(button, scope),
          );
          target =
            filters.find((button) => button === lastCategoryFilter) ??
            filters.find((button) => button.getAttribute('aria-pressed') === 'true') ??
            filters[0] ??
            null;
        } else if (focused.closest('.filters') && event.key === 'ArrowUp')
          target = document.getElementById('search');
        // The channel row (Category ▾ | Favs | Loc & Sort | Guide) sits under the search field.
        else if (
          focused.closest('.sidehead') &&
          event.key === 'ArrowUp' &&
          !document.querySelector('.filters:not([hidden])')?.getClientRects().length
        )
          target = document.getElementById('search');
        else if (focused.closest('.controls') && event.key === 'ArrowUp') {
          // The picture above the controls comes first when it is a control
          // itself (an open website, the Guide's preview): skipping to the
          // header left a website one OK away from closing (Streamer, October 19).
          const stage =
            document.querySelector<HTMLElement>('#screen > .local-stage-enter') ??
            document.querySelector<HTMLElement>('#screen[role="button"]');
          target = eligible(stage, scope)
            ? stage
            : eligible(lastTopAction, scope)
              ? lastTopAction
              : (document.querySelector<HTMLElement>('.top-actions button[aria-pressed="true"]') ??
                document.getElementById('live-tv-button'));
        } else if (focused.closest('.top-actions') && event.key === 'ArrowDown')
          target = ['import-button', 'live-tv-button', 'paid-tv-button'].includes(focused.id)
            ? document.getElementById('search')
            : eligible(lastDockControl, scope)
              ? lastDockControl
              : (firstControl ?? null);
        if (eligible(target, scope)) {
          event.preventDefault();
          focus(target);
          return;
        }
      }
      if (event.key === 'ArrowRight' && focused.closest('#channel-list') && firstControl) {
        event.preventDefault();
        focus(firstControl);
        return;
      }
      if (event.key === 'ArrowLeft' && focused === firstControl) {
        const divider = document.getElementById('divider');
        if (!television && eligible(divider, scope)) {
          event.preventDefault();
          focus(divider);
          return;
        }
        const list = document.querySelector<HTMLElement>('#channel-list');
        const remembered = list
          ? [...list.querySelectorAll<HTMLElement>('[data-channel]')].find(
              (channel) => channel.dataset.channel === lastChannelId && eligible(channel, scope),
            )
          : null;
        const target = remembered ?? list;
        if (eligible(target, scope)) {
          event.preventDefault();
          focus(target);
          return;
        }
      }
    }
    // List/default control handlers run first; only unprevented boundary keys reach here.
    const television = document.getElementById('app')?.dataset.deviceKind === 'tv';
    const choices = candidates(scope).filter(
      (candidate) =>
        candidate !== focused &&
        !(scope === document && television && candidate.id === 'divider') &&
        !clippedAway(candidate, focused),
    );
    // TV: Left and Right stay on the row (a control sharing some height with
    // this one); at a row's end nothing moves. Diagonal jumps (the dock's last
    // button up to Settings, All up to Find channels online) lost the viewer's
    // place on the Streamer.
    const origin = focused.getBoundingClientRect();
    const rowChoices =
      television && ['ArrowLeft', 'ArrowRight'].includes(event.key)
        ? choices.filter((candidate) => {
            const box = candidate.getBoundingClientRect();
            return (
              Math.min(origin.bottom, box.bottom) - Math.max(origin.top, box.top) > 0 &&
              shownWhole(candidate)
            );
          })
        : choices;
    if (rowChoices !== choices) choices.splice(0, choices.length, ...rowChoices);
    const next = directionalIndex(
      focused.getBoundingClientRect(),
      choices.map((candidate) => candidate.getBoundingClientRect()),
      event.key as Direction,
    );
    if (next >= 0) {
      event.preventDefault();
      focus(choices[next]);
    } else if (television) {
      // Nothing that way: stay put. Left unhandled, Android's own spatial
      // navigation moved focus to the resize divider, and inside a dialog it
      // could pick the controls excluded above (Streamer, October 19).
      event.preventDefault();
    }
  };
  document.addEventListener('focusin', focusin);
  document.addEventListener('focusout', focusout);
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', entryCapture, true);
  document.addEventListener('keyup', keyup, true);
  document.addEventListener('keydown', keydown);
  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', focusin);
    document.removeEventListener('focusout', focusout);
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('keydown', entryCapture, true);
    document.removeEventListener('keyup', keyup, true);
    document.removeEventListener('keydown', keydown);
    editMode?.clear();
    inputOrigin.clear();
    if (installedEditMode === editMode) installedEditMode = undefined;
  };
}
