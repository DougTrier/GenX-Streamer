interface NativeImeInsets {
  schemaVersion: 1;
  visible: boolean;
  bottomPx: number;
  overlapPx: number;
  webViewHeightPx: number;
  sequence: number;
}
function nativeIme(value: unknown): NativeImeInsets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.visible !== 'boolean' ||
    ![row.bottomPx, row.overlapPx, row.webViewHeightPx, row.sequence].every(
      (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
    ) ||
    (row.webViewHeightPx as number) <= 0 ||
    (row.webViewHeightPx as number) > 1_000_000 ||
    (row.overlapPx as number) > (row.webViewHeightPx as number) ||
    (row.bottomPx as number) > 1_000_000 ||
    (row.sequence as number) <= 0
  )
    return null;
  return row as unknown as NativeImeInsets;
}

/** Visual viewport and actual native IME overlap for adjustNothing editing. */
export function installViewport(root: HTMLElement): () => void {
  const viewport = window.visualViewport;
  const height = () => viewport?.height ?? window.innerHeight;
  const top = () => viewport?.offsetTop ?? 0;
  const documentRoot = document.documentElement;
  const styleProperties = [
    '--viewport-top',
    '--visible-viewport-height',
    '--modal-viewport-top',
    '--modal-visible-viewport-height',
    '--native-ime-height',
  ] as const;
  const originalStyles = [root, documentRoot].map((node) => ({
    node,
    values: styleProperties.map((name) => ({
      name,
      value: node.style.getPropertyValue(name),
      priority: node.style.getPropertyPriority(name),
    })),
  }));
  const originalHeight = root.style.height;
  const originalClasses = {
    keyboard: root.classList.contains('keyboard-open'),
    compact: root.classList.contains('compact-content'),
    documentKeyboard: documentRoot.classList.contains('viewport-keyboard-open'),
  };
  let disposed = false;
  let frame = 0;
  let focusFrame = 0;
  let unobstructedHeight = Math.max(window.innerHeight, height());
  let measuredWidth = window.innerWidth;
  let keyboardOpen = false;
  let nativeInsets = nativeIme((window as Window & { __genxImeInsets?: unknown }).__genxImeInsets);
  let keyboardDialog: HTMLDialogElement | null = null;
  const scrollPositions = new Map<HTMLElement, number>();
  const restoreModal = (): void => {
    cancelAnimationFrame(focusFrame);
    focusFrame = 0;
    for (const [node, scrollTop] of scrollPositions)
      if (node.isConnected) node.scrollTop = scrollTop;
    scrollPositions.clear();
    keyboardDialog = null;
  };
  const rememberScroll = (node: HTMLElement): void => {
    if (!scrollPositions.has(node)) scrollPositions.set(node, node.scrollTop);
  };
  const revealModalFocus = (): void => {
    focusFrame = 0;
    const dialog = keyboardDialog;
    const focused = document.activeElement;
    if (disposed || !dialog?.open || !(focused instanceof HTMLElement) || !dialog.contains(focused))
      return;
    const field = focused.closest<HTMLElement>('label') ?? focused;
    for (let node = focused.parentElement; node; node = node.parentElement) {
      if (node !== dialog && !dialog.contains(node)) break;
      if (
        /auto|scroll/u.test(getComputedStyle(node).overflowY) &&
        node.scrollHeight > node.clientHeight
      ) {
        rememberScroll(node);
        const bounds = node.getBoundingClientRect();
        const modal = dialog.getBoundingClientRect();
        const target = field.getBoundingClientRect();
        const visibleTop = Math.max(bounds.top, modal.top) + 12;
        const visibleBottom = Math.min(bounds.bottom, modal.bottom) - 12;
        if (target.bottom > visibleBottom) node.scrollTop += target.bottom - visibleBottom;
        else if (target.top < visibleTop) node.scrollTop -= visibleTop - target.top;
      }
      if (node === dialog) break;
    }
  };
  const measureCompact = (): void => {
    if (window.innerWidth > 650) {
      root.classList.remove('compact-content');
      return;
    }

    // Measure the ordinary split layout synchronously before deciding whether it fits.
    root.classList.remove('compact-content');
    const browser = root.querySelector<HTMLElement>('.browser')!;
    const view = root.querySelector<HTMLElement>('.view')!;
    const top = root.querySelector<HTMLElement>('.topbar')!;
    const outerHeight = (node: HTMLElement): number => {
      const style = getComputedStyle(node);
      return (
        node.getBoundingClientRect().height +
        parseFloat(style.marginTop) +
        parseFloat(style.marginBottom)
      );
    };
    const padding = (node: HTMLElement): number => {
      const style = getComputedStyle(node);
      return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    };
    const available = height() - top.getBoundingClientRect().height;
    const landscape = window.innerWidth > window.innerHeight;
    // Phones held upright keep one screen, the picture on top and the channels
    // below (responsive.css), whenever the channel panel still fits with at
    // least one channel row; otherwise (large text, short windows) they use the
    // separate Watch and Channels screens.
    if (!landscape) {
      // The Guide covers the panels on phones: decide again once it closes.
      if (root.dataset.guidePanel === 'open') return;
      // Search, the category row, the footer and one channel row must fit; the
      // first-scan tip and the scan panel may push the list down, since the
      // channel side scrolls (responsive.css).
      const fixed = ['.search-controls', '.browse-options', '.sidefoot']
        .map((selector) => browser.querySelector<HTMLElement>(selector))
        .filter((node): node is HTMLElement => !!node && node.getClientRects().length > 0)
        .reduce((sum, node) => sum + outerHeight(node), padding(browser) + 72);
      const fits =
        fixed <= browser.getBoundingClientRect().height + 1 &&
        browser.getBoundingClientRect().bottom <= height() + 1;
      root.classList.toggle('compact-content', !fits);
      return;
    }
    const browserNeed = [...browser.children]
      .filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && !node.classList.contains('channel-list'),
      )
      .reduce((sum, node) => sum + outerHeight(node), padding(browser) + 48);
    const viewNeed =
      outerHeight(view.querySelector<HTMLElement>('.watchhead')!) +
      outerHeight(view.querySelector<HTMLElement>('.dock')!) +
      padding(view) +
      100;
    root.classList.toggle(
      'compact-content',
      browserNeed > available * (landscape ? 1 : 0.53) ||
        viewNeed > available * (landscape ? 1 : 0.47),
    );
  };
  const update = (): void => {
    frame = 0;
    const mobile = window.innerWidth <= 650;
    const editing =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.matches(
        'textarea,[contenteditable="true"],input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="file"])',
      );
    if (measuredWidth !== window.innerWidth) {
      measuredWidth = window.innerWidth;
      unobstructedHeight = Math.max(window.innerHeight, height());
    }
    if (!editing && !keyboardOpen) unobstructedHeight = Math.max(window.innerHeight, height());
    const contracted = Math.max(unobstructedHeight, window.innerHeight) - height() > 100;
    const dialogs = [
      ...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-primary-page])'),
    ];
    const activeModal =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.closest<HTMLDialogElement>(
            'dialog[open]:not([data-primary-page])',
          ) ??
          dialogs[dialogs.length - 1] ??
          null)
        : (dialogs[dialogs.length - 1] ?? null);
    const dpr =
      Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const nativeVisible = nativeInsets?.visible === true && nativeInsets.overlapPx > 0;
    const keyboard =
      (contracted && (editing || keyboardOpen)) ||
      (nativeVisible && (editing || keyboardOpen || !!activeModal));
    const modalKeyboard = keyboard && !!activeModal;
    const mainKeyboard = keyboard && !activeModal;
    const nativeBottom =
      nativeVisible && nativeInsets
        ? (nativeInsets.webViewHeightPx - nativeInsets.overlapPx) / dpr
        : height() + top();
    // Native pixels and visual contraction describe the same obstruction.
    // Choose the smaller available interval instead of subtracting twice.
    const usableHeight = Math.max(1, Math.min(height(), nativeBottom - top()));
    const mainHeight = mainKeyboard ? usableHeight : height();
    if (keyboardDialog !== (modalKeyboard ? activeModal : null)) {
      restoreModal();
      keyboardDialog = modalKeyboard ? activeModal : null;
      if (keyboardDialog) {
        rememberScroll(keyboardDialog);
        for (const node of keyboardDialog.querySelectorAll<HTMLElement>(
          '.dialog-body,.guide-body,.scan-body,.website-body,[data-settings-panel],#geography-controls',
        ))
          rememberScroll(node);
      }
    }
    keyboardOpen = keyboard;
    // A modal's native overlay does not shrink/rearrange the underlying TV player.
    root.classList.toggle('keyboard-open', mainKeyboard);
    documentRoot.classList.toggle('viewport-keyboard-open', keyboard);
    root.style.height = mobile || mainKeyboard ? `${mainHeight}px` : '';
    root.style.setProperty('--viewport-top', mobile || mainKeyboard ? `${top()}px` : '0px');
    root.style.setProperty('--visible-viewport-height', `${mainHeight}px`);
    documentRoot.style.setProperty('--viewport-top', `${top()}px`);
    documentRoot.style.setProperty('--visible-viewport-height', `${mainHeight}px`);
    const modalHeight = modalKeyboard ? usableHeight : height();
    documentRoot.style.setProperty('--modal-viewport-top', `${top()}px`);
    documentRoot.style.setProperty('--modal-visible-viewport-height', `${modalHeight}px`);
    documentRoot.style.setProperty(
      '--native-ime-height',
      `${nativeVisible && nativeInsets ? nativeInsets.bottomPx / dpr : 0}px`,
    );
    measureCompact();
    if (modalKeyboard) {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(revealModalFocus);
    }
  };
  const schedule = (): void => {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  };
  const ime = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const measured = nativeIme(event.detail);
    if (!measured || (nativeInsets && measured.sequence <= nativeInsets.sequence)) return;
    nativeInsets = measured;
    schedule();
  };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('native-ime-insets', ime);
  window.addEventListener('resize', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('close', schedule, true);
  const controls = new ResizeObserver(schedule);
  for (const selector of [
    '.topbar',
    '.sidehead',
    '.search-controls',
    '.filters',
    '.browse-options',
    '.location-trigger',
    '.sidefoot',
    '.watchhead',
    '.dock',
  ]) {
    const node = root.querySelector(selector);
    if (node) controls.observe(node);
  }
  const search = document.getElementById('search')!;
  const enter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.defaultPrevented) {
      event.preventDefault();
      search.blur();
    }
  };
  search.addEventListener('keydown', enter);
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    restoreModal();
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    window.removeEventListener('native-ime-insets', ime);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    document.removeEventListener('close', schedule, true);
    controls.disconnect();
    search.removeEventListener('keydown', enter);
    root.style.height = originalHeight;
    root.classList.toggle('keyboard-open', originalClasses.keyboard);
    root.classList.toggle('compact-content', originalClasses.compact);
    documentRoot.classList.toggle('viewport-keyboard-open', originalClasses.documentKeyboard);
    for (const { node, values } of originalStyles)
      for (const { name, value, priority } of values) {
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
  };
}
