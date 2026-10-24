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

import { installMenuButton, type MenuButton } from './menu-button';

/**
 * TV and Windows: the categories (All, Movies, News, Sports) fold into one
 * button at the start of the channel row, "All · 8,588 ▾", so the two rows
 * above the channel list become one (owner request, October 19, 2026). The
 * button opens the category buttons as a short list; choosing one works
 * exactly as before (their own click handlers). Where the layout already shows
 * the "All channels" menu instead (phones, handhelds, short windows), nothing
 * changes: the count stays where it was and there is no extra button.
 */
export interface CategoryMenu {
  /** Re-decides the layout; call after the library changes (GenXtra hides the categories). */
  sync(): void;
  dispose(): void;
}

export function installCategoryMenu(root: HTMLElement): CategoryMenu | null {
  const options = root.querySelector<HTMLElement>('.browse-options');
  const filters = options?.querySelector<HTMLElement>('.filters');
  const sidehead = options?.querySelector<HTMLElement>('.sidehead');
  const count = root.querySelector<HTMLElement>('#channel-count');
  if (!options || !filters || !sidehead || !count) return null;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'category-button';
  trigger.className = 'category-trigger';
  const current = document.createElement('span');
  current.className = 'category-current';
  const total = document.createElement('span');
  total.className = 'category-count';
  trigger.append(current, total);
  sidehead.prepend(trigger);
  const items = () => [...filters.querySelectorAll<HTMLElement>('button[data-filter]')];
  const menu: MenuButton = installMenuButton(trigger, filters, {
    items,
    current: () => items().find((item) => item.getAttribute('aria-pressed') === 'true'),
  });
  const compact = () =>
    [
      root.querySelector<HTMLElement>('#compact-filter'),
      root.querySelector<HTMLElement>(".in-app-select[data-native-select-id='compact-filter']"),
    ].some((select) => !!select && select.checkVisibility());
  let folded = false;
  function label(): void {
    const chosen = items().find((item) => item.getAttribute('aria-pressed') === 'true');
    const name = chosen?.textContent?.trim() || 'All';
    // A count, or nothing while the list is still loading ("Loading channels…").
    const number = /^[\d.,\s]+channels?$/i.test((count!.textContent ?? '').trim())
      ? (count!.textContent ?? '').replace(/\s*channels?$/i, '').trim()
      : '';
    current.textContent = name;
    // Large libraries read as 19.4K so the row keeps one line (Paid TV adds VOD).
    const value = Number(number.replace(/[^\d]/g, ''));
    const short =
      value >= 10_000
        ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`
        : number;
    total.textContent = number ? ` · ${short}` : '';
    // A count that can't fit whole is left out ("All ▾"), never shown cut.
    total.hidden = false;
    if (folded && total.scrollWidth > total.clientWidth + 1) total.hidden = true;
    trigger.setAttribute(
      'aria-label',
      `Channel category: ${name}${number ? `, ${count!.textContent!.trim()}` : ''}`,
    );
  }
  function sync(): void {
    const libraryHidden = filters!.dataset.libraryHidden === 'true';
    const next = !compact();
    if (next !== folded) {
      folded = next;
      options!.toggleAttribute('data-category-menu', folded);
      if (!folded) menu.set(false, false);
    }
    // Closed lists stay hidden; GenXtra hides the categories whatever the layout.
    filters!.hidden = libraryHidden || (folded && !menu.open);
    trigger.hidden = !folded || libraryHidden;
    if (!folded) filters!.removeAttribute('role');
    else filters!.setAttribute('role', 'menu');
    label();
  }
  const watch = new MutationObserver(() => {
    label();
    // An open list closes when something else changes it (a library switch).
    if (folded && !menu.open && !filters.hidden) filters.hidden = true;
  });
  watch.observe(filters, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'hidden'],
  });
  watch.observe(count, { childList: true, characterData: true, subtree: true });
  const resize = new ResizeObserver(() => sync());
  resize.observe(options);
  // The list opens and closes through the menu button; keep the hidden state in step.
  const opened = () => queueMicrotask(sync);
  trigger.addEventListener('click', opened);
  filters.addEventListener('click', opened);
  filters.addEventListener('popup-close', opened);
  sync();
  return {
    sync,
    dispose() {
      watch.disconnect();
      resize.disconnect();
      trigger.removeEventListener('click', opened);
      filters.removeEventListener('click', opened);
      filters.removeEventListener('popup-close', opened);
      menu.dispose();
      trigger.remove();
      options.removeAttribute('data-category-menu');
      filters.hidden = filters.dataset.libraryHidden === 'true';
    },
  };
}
