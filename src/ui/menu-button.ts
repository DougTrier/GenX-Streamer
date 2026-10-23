/**
 * A button that opens a short list of choices (Local's Favorites / APK sites,
 * the channel categories), usable with a TV remote, a keyboard, a mouse or a
 * finger (owner request, October 19, 2026: keep these rows to one line).
 *
 * OK (or a click) opens the list with focus on the current choice; Up and
 * Down move within it and never leave it; OK picks; Back closes it first
 * (GenX's Back owner looks for `data-popup-open` and sends `popup-close`),
 * as does Escape; focus moving elsewhere closes it. The list owns its items:
 * they keep their own click handlers, so choosing works exactly as before.
 */
export interface MenuButtonOptions {
  /** The items currently offered (hidden ones are left out). */
  readonly items: () => readonly HTMLElement[];
  /** The current choice, focused when the list opens. */
  readonly current?: () => HTMLElement | null | undefined;
}

export interface MenuButton {
  readonly open: boolean;
  set(open: boolean, refocus?: boolean): void;
  dispose(): void;
}

export function installMenuButton(
  trigger: HTMLElement,
  menu: HTMLElement,
  options: MenuButtonOptions,
): MenuButton {
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const visible = () => options.items().filter((item) => !item.hidden);
  let open = false;
  function set(next: boolean, refocus = true): void {
    if (open === next) return;
    open = next;
    menu.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
    if (next) {
      menu.dataset.popupOpen = 'true';
      const items = visible();
      (items.find((item) => item === options.current?.()) ?? items[0])?.focus();
    } else {
      delete menu.dataset.popupOpen;
      if (refocus) trigger.focus();
    }
  }
  const toggle = (event: Event) => {
    event.preventDefault();
    set(!open);
  };
  const keydown = (event: KeyboardEvent) => {
    const items = visible();
    const at = items.indexOf(event.target as HTMLElement);
    if (event.key === 'Escape') set(false);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      items[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // The list keeps the remote until a choice, Back or Escape.
    event.preventDefault();
    event.stopPropagation();
  };
  // Choosing an item (its own click handler runs first) closes the list.
  const chosen = (event: Event) => {
    if (visible().some((item) => item.contains(event.target as Node))) set(false);
  };
  const focusout = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && !menu.contains(next) && next !== trigger) set(false, false);
  };
  const close = () => set(false);
  trigger.addEventListener('click', toggle);
  menu.addEventListener('keydown', keydown);
  menu.addEventListener('click', chosen);
  menu.addEventListener('focusout', focusout);
  menu.addEventListener('popup-close', close);
  return {
    get open() {
      return open;
    },
    set,
    dispose() {
      set(false, false);
      trigger.removeEventListener('click', toggle);
      menu.removeEventListener('keydown', keydown);
      menu.removeEventListener('click', chosen);
      menu.removeEventListener('focusout', focusout);
      menu.removeEventListener('popup-close', close);
    },
  };
}
