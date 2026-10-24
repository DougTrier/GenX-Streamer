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

interface SelectOwner {
  select: HTMLSelectElement;
  wrapper: HTMLDivElement;
  trigger: HTMLButtonElement;
  originalClass: boolean;
  change: () => void;
}
/** Explicit TV installation only. Native controls remain the canonical value/event source. */
export function installInAppSelects(root: HTMLElement): { refresh(): void; dispose(): void } {
  const owners = new Map<HTMLSelectElement, SelectOwner>();
  let disposed = false,
    refreshing = false;
  let opened: SelectOwner | null = null;
  let menu: HTMLDivElement | null = null;
  let query = '',
    page = 0,
    menuSequence = 0;
  const button = (text: string, action: () => void) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.addEventListener('click', action);
    return node;
  };
  function close(restore = false): void {
    const previous = opened;
    menu?.remove();
    menu = null;
    opened = null;
    previous?.trigger.setAttribute('aria-expanded', 'false');
    previous?.trigger.removeAttribute('aria-controls');
    if (
      restore &&
      previous?.trigger.isConnected &&
      !previous.trigger.disabled &&
      previous.trigger.checkVisibility()
    )
      previous.trigger.focus({ preventScroll: true });
  }
  function admitted(owner: SelectOwner): boolean {
    return (
      owner.select.isConnected &&
      !owner.select.disabled &&
      !owner.select.hidden &&
      owner.trigger.checkVisibility() &&
      !owner.wrapper.closest('[inert],[hidden],dialog:not([open])')
    );
  }
  function synchronize(owner: SelectOwner): void {
    if (owner.select.nextElementSibling !== owner.wrapper) owner.select.after(owner.wrapper);
    if (owner.wrapper.hidden !== owner.select.hidden) owner.wrapper.hidden = owner.select.hidden;
    owner.wrapper.dataset.nativeSelectId = owner.select.id;
    owner.trigger.disabled = owner.select.disabled;
    const labels = [...(owner.select.labels ?? [])]
      .map((label) =>
        [...label.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(' ')
          .trim(),
      )
      .filter(Boolean);
    const label = owner.select.getAttribute('aria-label') || labels.join(' ') || 'Choose an option';
    owner.trigger.setAttribute('aria-label', label);
    owner.trigger.textContent = owner.select.selectedOptions[0]?.label || label;
    if (opened === owner && !admitted(owner)) close();
  }
  function draw(): void {
    const owner = opened;
    if (!owner || !menu) return;
    const list = menu.querySelector<HTMLElement>('[role="listbox"]')!;
    const ownedFocus = list.contains(document.activeElement);
    const focusedIndex =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.optionIndex
        : undefined;
    list.replaceChildren();
    const availableOptions = [...owner.select.options].filter(
      (option) =>
        !option.hidden &&
        !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.hidden),
    );
    const country =
      owner.select.dataset.inAppSelectMode === 'continuous-country' ||
      ['country', 'region country'].includes(
        (owner.trigger.getAttribute('aria-label') ?? '').trim().toLowerCase(),
      );
    const compact = availableOptions.length <= 10 || country;
    menu.dataset.compact = String(compact);
    for (const controls of menu.querySelectorAll<HTMLElement>(
      '.in-app-select-header,.in-app-select-pages',
    ))
      if (controls.hidden !== compact) controls.hidden = compact;
    if (compact) query = '';
    const options = availableOptions.filter((option) =>
      option.label.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase()),
    );
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(options.length / 50) - 1)));
    const visible = country ? options : options.slice(page * 50, page * 50 + 50);
    for (const option of visible) {
      const group =
        option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '';
      const item = button(group ? `${group} \u00b7 ${option.label}` : option.label, () => {
        if (
          !item.isConnected ||
          !admitted(owner) ||
          !option.isConnected ||
          !owner.select.contains(option) ||
          item.disabled
        )
          return;
        owner.select.selectedIndex = option.index;
        close(true);
        synchronize(owner);
        owner.select.dispatchEvent(new Event('input', { bubbles: true }));
        owner.select.dispatchEvent(new Event('change', { bubbles: true }));
        refresh();
      });
      item.dataset.optionIndex = String(option.index);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled =
        option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
      if (option.parentElement instanceof HTMLOptGroupElement)
        item.title = option.parentElement.label;
      list.append(item);
    }
    if (ownedFocus)
      (
        list.querySelector<HTMLElement>(`[data-option-index="${focusedIndex}"]:not(:disabled)`) ??
        list.querySelector<HTMLElement>('button:not(:disabled)') ??
        (compact ? owner.trigger : menu.querySelector<HTMLElement>('input'))
      )?.focus({ preventScroll: true });
    if (ownedFocus && list.contains(document.activeElement))
      (document.activeElement as HTMLElement).scrollIntoView({
        block: 'nearest',
        behavior: 'instant',
      });
    menu.querySelector<HTMLElement>('[role="status"]')!.textContent = options.length
      ? `${page * 50 + 1}\u2013${page * 50 + visible.length} of ${options.length}`
      : 'No matching options';
    (menu.querySelector('[data-page="previous"]') as HTMLButtonElement).disabled = page === 0;
    (menu.querySelector('[data-page="next"]') as HTMLButtonElement).disabled =
      (page + 1) * 50 >= options.length;
  }
  function open(owner: SelectOwner): void {
    if (opened === owner) {
      close(true);
      return;
    }
    close();
    synchronize(owner);
    if (!admitted(owner)) return;
    opened = owner;
    query = '';
    page = Math.max(
      0,
      Math.floor(
        [...owner.select.options]
          .filter((option) => !option.hidden)
          .indexOf(owner.select.selectedOptions[0]!) / 50,
      ),
    );
    menu = document.createElement('div');
    menu.className = 'in-app-select-menu';
    menu.id = `in-app-select-${++menuSequence}`;
    owner.trigger.setAttribute('aria-controls', menu.id);
    owner.trigger.setAttribute('aria-expanded', 'true');
    const header = document.createElement('div');
    header.className = 'in-app-select-header';
    const search = document.createElement('input');
    search.type = 'search';
    search.setAttribute('aria-label', `Search ${owner.trigger.getAttribute('aria-label')}`);
    search.placeholder = 'Find an option';
    search.addEventListener('input', () => {
      query = search.value;
      page = 0;
      draw();
    });
    header.append(
      search,
      button('Close choices', () => close(true)),
    );
    const list = document.createElement('div');
    list.className = 'in-app-select-options';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', owner.trigger.getAttribute('aria-label')! + ' choices');
    const footer = document.createElement('div');
    footer.className = 'in-app-select-pages';
    const previous = button('Previous choices', () => {
      page--;
      draw();
    });
    previous.dataset.page = 'previous';
    const next = button('Next choices', () => {
      page++;
      draw();
    });
    next.dataset.page = 'next';
    const count = document.createElement('span');
    count.setAttribute('role', 'status');
    footer.append(previous, count, next);
    menu.append(header, list, footer);
    const topDialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
    (topDialog && topDialog.contains(owner.select) ? topDialog : root).append(menu);
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth,
      height = viewport?.height ?? innerHeight;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0;
    const box = owner.trigger.getBoundingClientRect();
    const below = top + height - box.bottom - 8,
      above = box.top - top - 8;
    const available = Math.max(88, Math.max(below, above));
    menu.style.width = `${Math.max(0, Math.min(Math.max(box.width, 300), width - 16))}px`;
    menu.style.maxHeight = `${Math.min(height - 16, available < 260 ? height - 16 : available)}px`;
    menu.style.left = `${Math.max(left + 8, Math.min(box.left, left + width - parseFloat(menu.style.width) - 8))}px`;
    if (available < 260) menu.style.top = `${top + 8}px`;
    else if (below >= above) menu.style.top = `${Math.max(top + 8, box.bottom + 4)}px`;
    else menu.style.bottom = `${Math.max(8, innerHeight - box.top + 4)}px`;
    draw();
    const initial =
      list.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ??
      list.querySelector<HTMLElement>('button:not(:disabled)') ??
      (search.hidden || header.hidden ? owner.trigger : search);
    initial.focus({ preventScroll: true });
    if (list.contains(initial)) initial.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  function remove(owner: SelectOwner): void {
    if (opened === owner) close();
    owner.select.removeEventListener('change', owner.change);
    if (!owner.originalClass) owner.select.classList.remove('in-app-select-native');
    owner.wrapper.remove();
    owners.delete(owner.select);
  }
  function refresh(): void {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      for (const owner of owners.values())
        if (!root.contains(owner.select) || owner.select.multiple) remove(owner);
      for (const select of root.querySelectorAll<HTMLSelectElement>('select:not([multiple])')) {
        if (owners.has(select)) {
          synchronize(owners.get(select)!);
          continue;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'in-app-select';
        const trigger = button('', () => open(owner));
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        wrapper.append(trigger);
        const owner: SelectOwner = {
          select,
          wrapper,
          trigger,
          originalClass: select.classList.contains('in-app-select-native'),
          change: () => {
            synchronize(owner);
            if (opened === owner) draw();
          },
        };
        owners.set(select, owner);
        select.after(wrapper);
        select.classList.add('in-app-select-native');
        select.addEventListener('change', owner.change);
        synchronize(owner);
      }
      if (opened) draw();
    } finally {
      refreshing = false;
    }
  }
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          (record.type === 'characterData' &&
            record.target.parentElement instanceof HTMLOptionElement) ||
          (record.type === 'attributes' &&
            (record.target instanceof HTMLSelectElement ||
              record.target instanceof HTMLOptionElement ||
              record.target instanceof HTMLOptGroupElement ||
              ['hidden', 'open', 'inert'].includes(record.attributeName ?? ''))) ||
          (record.type === 'childList' &&
            (record.target instanceof HTMLSelectElement ||
              record.target instanceof HTMLOptionElement ||
              record.target instanceof HTMLOptGroupElement)) ||
          (record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches('select,option,optgroup') || !!node.querySelector('select')),
            )),
      )
    )
      refresh();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeFilter: [
      'disabled',
      'hidden',
      'selected',
      'label',
      'value',
      'multiple',
      'open',
      'inert',
      'aria-label',
    ],
  });
  const key = (event: KeyboardEvent) => {
    if (
      event.repeat &&
      ['Enter', ' '].includes(event.key) &&
      (opened || (event.target instanceof Element && event.target.closest('.in-app-select')))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!opened || !menu) return;
    if (event.key === 'Escape' || event.key === 'BrowserBack') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
      return;
    }
    if (event.repeat && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!menu.contains(event.target as Node) || event.target instanceof HTMLInputElement) return;
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    items[target]?.focus({ preventScroll: true });
    items[target]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  };
  const cancel = (event: Event) => {
    if (opened) {
      event.preventDefault();
      if (event.type === 'cancel') event.stopImmediatePropagation();
      close(true);
    }
  };
  const outside = (event: Event) => {
    if (
      opened &&
      event.target instanceof Node &&
      !menu?.contains(event.target) &&
      !opened.wrapper.contains(event.target)
    )
      close();
  };
  const dismiss = () => close();
  const visibility = () => {
    if (document.hidden) close();
  };
  document.addEventListener('keydown', key, true);
  document.addEventListener('cancel', cancel, true);
  window.addEventListener('native-back-requested', cancel, true);
  window.addEventListener('native-app-background', dismiss);
  window.addEventListener('resize', dismiss);
  window.visualViewport?.addEventListener('resize', dismiss);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside);
  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      close();
      for (const owner of owners.values()) remove(owner);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('cancel', cancel, true);
      window.removeEventListener('native-back-requested', cancel, true);
      window.removeEventListener('native-app-background', dismiss);
      window.removeEventListener('resize', dismiss);
      window.visualViewport?.removeEventListener('resize', dismiss);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    },
  };
}
