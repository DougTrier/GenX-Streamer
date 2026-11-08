// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

/** Phone browsing owns its space; an overflowing filter row must not select Watch. */
export interface PhoneLayoutOptions {
  clearFilters?(): void;
}

export function installPhoneLayout(root: HTMLElement, host: PhoneLayoutOptions = {}) {
  const browser = root.querySelector<HTMLElement>('.browser');
  const options = root.querySelector<HTMLElement>('.browse-options');
  const view = root.querySelector<HTMLElement>('.view');
  const guide = root.querySelector<HTMLButtonElement>('#guide-button');
  if (!browser || !options || !view || !guide) return { sync: () => false, dispose: () => {} };
  const doc = root.ownerDocument;
  const shortLandscape = matchMedia(
    '(min-width: 500px) and (max-width: 1100px) and (max-height: 540px)',
  );
  let unobstructedHeight = innerHeight;
  const makeButton = (id: string, text: string) => {
    const button = doc.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = text;
    return button;
  };
  const bar = doc.createElement('div');
  bar.className = 'phone-browse-bar';
  const filters = makeButton('phone-filter-button', 'Search & Filters');
  filters.setAttribute('aria-haspopup', 'dialog');
  filters.setAttribute('aria-controls', 'phone-filter-dialog');
  filters.setAttribute('aria-expanded', 'false');
  const summary = doc.createElement('span');
  summary.id = 'phone-filter-summary';
  const filterLabel = doc.createElement('span');
  filterLabel.textContent = 'Search & Filters';
  filters.replaceChildren(filterLabel, summary);
  const guidePlace = doc.createComment('phone Guide return');
  guide.before(guidePlace);
  bar.append(filters);
  const clearFilters = makeButton('phone-clear-filters', 'Clear');
  clearFilters.setAttribute('aria-label', 'Clear filters');
  clearFilters.hidden = !host.clearFilters;
  bar.append(clearFilters);
  options.before(bar);
  const dialog = doc.createElement('dialog');
  dialog.id = 'phone-filter-dialog';
  dialog.setAttribute('aria-labelledby', 'phone-filter-heading');
  const heading = doc.createElement('h2');
  heading.id = 'phone-filter-heading';
  heading.textContent = 'Search & Filters';
  const close = makeButton('phone-filter-close', 'Show channels');
  const head = doc.createElement('div');
  head.className = 'dialog-head';
  head.append(heading, close);
  const body = doc.createElement('div');
  body.className = 'phone-filter-body';
  const guideHelp = doc.createElement('p');
  guideHelp.className = 'phone-search-help';
  guideHelp.textContent = 'Programme names are searched only in connected, saved guides.';
  dialog.append(head, body);
  root.append(dialog);
  const optionPlace = doc.createComment('phone filters return');
  const searchControls = browser.querySelector<HTMLElement>('.search-controls');
  const searchPlace = doc.createComment('phone search return');
  searchControls?.before(searchPlace);
  const foot = browser.querySelector<HTMLElement>('.sidefoot');
  const footPlace = doc.createComment('phone source actions return');
  const archiveFilters = browser.querySelector<HTMLElement>('#genxtra-browse-filters');
  const archivePlace = doc.createComment('phone GenXtra filters return');
  options.before(optionPlace);
  foot?.before(footPlace);
  archiveFilters?.before(archivePlace);
  const watchRow = doc.createElement('div');
  watchRow.className = 'phone-watch-row';
  const watch = makeButton('phone-watch-button', 'Watch');
  const browse = makeButton('phone-browse-button', 'Back to channels');
  const pause = makeButton('phone-pause-button', 'Pause');
  const stop = makeButton('phone-stop-button', 'Stop');
  watchRow.append(watch, browse, pause, stop);
  const watchPlace = doc.createComment('phone Watch return');
  view.prepend(watchPlace);
  view.prepend(watchRow);
  let enabled = false;
  let disposed = false;
  let previous: HTMLElement | null = null;
  const arrangeWatch = () => {
    if (
      enabled &&
      innerWidth >= 500 &&
      innerWidth <= 650 &&
      unobstructedHeight < innerWidth &&
      root.dataset.phoneView === 'browse'
    ) {
      if (watchRow.parentElement !== bar) bar.append(watchRow);
    } else if (watchPlace.nextSibling !== watchRow) watchPlace.after(watchRow);
  };
  const visible = (node: HTMLElement | null): node is HTMLElement =>
    !!node?.isConnected && node.checkVisibility() && !node.closest('[inert],[hidden]');
  const returnControls = () => {
    optionPlace.after(options);
    if (searchControls) searchPlace.after(searchControls);
    if (foot) footPlace.after(foot);
    if (archiveFilters) archivePlace.after(archiveFilters);
  };
  const dismissed = () => {
    const ownedFocus = dialog.contains(doc.activeElement);
    returnControls();
    filters.setAttribute('aria-expanded', 'false');
    if (
      !disposed &&
      enabled &&
      visible(filters) &&
      (ownedFocus || doc.activeElement === doc.body || doc.activeElement === filters)
    )
      filters.focus({ preventScroll: true });
  };
  const dismiss = () => {
    if (dialog.open) dialog.close();
  };
  const open = () => {
    if (!enabled || disposed || dialog.open) return;
    if (searchControls) body.append(searchControls);
    body.append(guideHelp);
    body.append(options);
    if (archiveFilters) body.append(archiveFilters);
    if (foot) body.append(foot);
    dialog.showModal();
    filters.setAttribute('aria-expanded', 'true');
    close.focus({ preventScroll: true });
  };
  const setPane = (pane: 'browse' | 'watch') => {
    if (!enabled) return;
    if (pane === 'watch') {
      previous = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      root.dataset.phoneView = 'watch';
      arrangeWatch();
      browse.focus({ preventScroll: true });
    } else {
      root.dataset.phoneView = 'browse';
      arrangeWatch();
      (visible(previous) ? previous : watch).focus({ preventScroll: true });
    }
  };
  const watchClick = () => setPane('watch');
  const browseClick = () => setPane('browse');
  const pauseClick = () => root.querySelector<HTMLButtonElement>('#pause-button')?.click();
  const stopClick = () => root.querySelector<HTMLButtonElement>('#vod-stop')?.click();
  const text = (node: HTMLElement, value: string) => {
    if (node.textContent !== value) node.textContent = value;
  };
  const update = () => {
    if (disposed) return;
    const archive = root.dataset.contentLibrary === 'genxtra';
    guideHelp.hidden = archive || root.dataset.vodBrowsing === 'true';
    const selected = archive
      ? root.querySelector<HTMLSelectElement>('#genxtra-kind-select')
      : options.querySelector<HTMLSelectElement>('#compact-filter');
    const query = root.querySelector<HTMLInputElement>('#search')?.value.trim() ?? '';
    const pieces = [
      ...(query ? ['“' + (query.length > 48 ? query.slice(0, 48) + '…' : query) + '”'] : []),
      selected?.selectedOptions[0]?.textContent?.replace(' channels', '') ?? 'All',
    ];
    for (const label of archive ? [] : ['Sport', 'League']) {
      const field = options.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
      if (field?.value) pieces.push(field.selectedOptions[0]?.textContent ?? '');
    }
    const inclusion = options.querySelector<HTMLElement>('.sports-inclusion-status');
    if (!archive && inclusion && !inclusion.hidden) pieces.push('Matching PPV included');
    if (archive) {
      const decade = root.querySelector<HTMLSelectElement>('#genxtra-decade-select');
      if (decade) pieces.push(decade.selectedOptions[0]?.textContent ?? 'All years');
    }
    text(summary, pieces.filter(Boolean).join(' · '));
    const originalPause = root.querySelector<HTMLButtonElement>('#pause-button');
    const originalStop = root.querySelector<HTMLButtonElement>('#vod-stop');
    text(pause, originalPause?.textContent?.trim() || 'Pause');
    pause.disabled = !originalPause || originalPause.disabled;
    stop.disabled = !originalStop || originalStop.disabled;
    stop.hidden = !originalStop || originalStop.hidden;
  };
  const sync = (keyboard = root.classList.contains('keyboard-open'), height?: number) => {
    if (height !== undefined) unobstructedHeight = height;
    const portrait =
      innerWidth <= 650 &&
      (innerHeight > innerWidth || (keyboard && unobstructedHeight > innerWidth));
    // The wide-short Guide already owns a full-width grid and visible mini.
    const guideOwnsLandscape = innerWidth > 650 && root.dataset.guidePanel === 'open';
    const next =
      (portrait || shortLandscape.matches) &&
      root.dataset.deviceKind !== 'tv' &&
      !guideOwnsLandscape;
    if (next !== enabled) {
      enabled = next;
      if (enabled) {
        root.dataset.phonePortrait = 'true';
        root.dataset.phoneView = 'browse';
        bar.append(guide);
      } else {
        dismiss();
        returnControls();
        guidePlace.after(guide);
        delete root.dataset.phonePortrait;
        delete root.dataset.phoneView;
      }
    }
    arrangeWatch();
    update();
    return enabled;
  };
  const nativeBack = (event: Event) => {
    if (!enabled || event.defaultPrevented) return;
    const modal = [...doc.querySelectorAll('dialog[open]:not([data-primary-page])')].at(-1);
    if (modal === dialog) {
      // Leave acknowledgement to the application; prevent only its second navigation.
      event.preventDefault();
      dismiss();
    } else if (
      !modal &&
      root.dataset.phoneView === 'watch' &&
      root.dataset.guidePanel !== 'open' &&
      !root.classList.contains('viewing-fullscreen') &&
      !root.classList.contains('expanded') &&
      !doc.querySelector(
        '[data-popup-open="true"],[data-video-quality-open="true"],[data-audio-tracks-open="true"]',
      )
    ) {
      event.preventDefault();
      setPane('browse');
    }
  };
  const cancel = (event: Event) => {
    event.preventDefault();
    dismiss();
  };
  const submitSearch = (event: KeyboardEvent) => {
    if (
      dialog.open &&
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement &&
      event.target.id === 'search'
    ) {
      event.stopPropagation();
      if (!event.isComposing) {
        event.preventDefault();
        // Use the same online action as the magnifier and keep the dialog's return focus.
        if (
          !event.repeat &&
          event.target.value.trim() &&
          root.dataset.contentLibrary === 'live' &&
          root.querySelector('#live-tv-button[aria-pressed="true"]')
        )
          searchControls?.querySelector<HTMLButtonElement>('#search-programs')?.click();
        dismiss();
      }
    }
  };
  const openFilterDestination = (event: Event) => {
    if (
      dialog.open &&
      event.target instanceof HTMLElement &&
      event.target.closest('#search-programs, #vod-button')
    )
      dismiss();
  };
  const clear = () => {
    host.clearFilters?.();
    update();
  };
  const backKey = (event: KeyboardEvent) => {
    if (
      event.key === 'Escape' &&
      root.dataset.phoneView === 'watch' &&
      !(
        event.target instanceof HTMLElement &&
        event.target.matches('input,textarea,select,[contenteditable="true"]')
      )
    )
      nativeBack(event);
  };
  const browseKey = (event: KeyboardEvent) => {
    const source = event.target;
    const list = root.querySelector<HTMLElement>('#channel-list');
    if (
      !enabled ||
      event.defaultPrevented ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) ||
      !(source instanceof HTMLElement) ||
      source.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') ||
      root.dataset.phoneView !== 'browse' ||
      root.dataset.contentLibrary !== 'live' ||
      root.dataset.vodBrowsing === 'true' ||
      root.dataset.guidePanel === 'open' ||
      root.matches('.viewing-fullscreen,.expanded') ||
      doc.fullscreenElement ||
      doc.querySelector(
        'dialog[open],[data-popup-open="true"],[data-video-quality-open="true"],[data-audio-tracks-open="true"],.in-app-select-menu',
      ) ||
      !visible(list)
    )
      return;
    let next: HTMLElement | null = null;
    if (event.key === 'ArrowDown' && source.closest('.top-actions')) next = filters;
    else if (source === watch && event.key === 'ArrowRight') next = filters;
    else if (
      ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
      (source === filters || source === clearFilters || source === guide)
    ) {
      const controls = [filters, clearFilters, guide].filter(
        (control) => visible(control) && !control.matches(':disabled,[aria-disabled="true"]'),
      );
      const index = controls.indexOf(source as HTMLButtonElement);
      next =
        controls[index + (event.key === 'ArrowRight' ? 1 : -1)] ??
        (source === filters && event.key === 'ArrowLeft' ? watch : null);
    } else if (source === filters && event.key === 'ArrowDown') {
      // Enter the current viewport, not index zero or an overscan row. Keeping
      // focus scrolling off preserves the list's measured pitch and anchor.
      const frame = list.getBoundingClientRect();
      const owner = browser.getBoundingClientRect();
      const top = Math.max(frame.top + list.clientTop, owner.top, 0);
      const bottom = Math.min(
        frame.top + list.clientTop + list.clientHeight,
        owner.bottom,
        innerHeight,
      );
      const rows = [...list.querySelectorAll<HTMLButtonElement>('button.channel[data-channel]')]
        .filter(
          (row) => visible(row) && !row.disabled && row.getAttribute('aria-disabled') !== 'true',
        )
        .map((row) => ({ row, box: row.getBoundingClientRect() }));
      next =
        (
          rows.find(({ box }) => box.top >= top && box.bottom <= bottom) ??
          rows.find(({ box }) => box.bottom > top && box.top < bottom)
        )?.row ?? null;
    } else if (source.matches('button.channel[data-channel]') && list.contains(source)) {
      // ChannelBrowser already consumed row/action movement and oversized-card
      // paging. Only its unhandled pane/list boundaries reach this owner.
      if (event.key === 'ArrowLeft') next = watch;
      else if (
        event.key === 'ArrowUp' &&
        Number(source.querySelector('.channel-number')?.textContent) === 1
      )
        next = filters;
    }
    if (visible(next) && !next.matches(':disabled,[aria-disabled="true"]')) {
      event.preventDefault();
      next.focus({ preventScroll: true });
    }
  };
  const railFocus = (event: FocusEvent) => {
    if (!enabled || !(event.target instanceof HTMLElement)) return;
    const rail = event.target.closest<HTMLElement>('.dock,.top-actions');
    if (!rail || !root.contains(rail)) return;
    const box = event.target.getBoundingClientRect();
    const frame = rail.getBoundingClientRect();
    if (box.right > frame.left + rail.clientWidth)
      rail.scrollLeft += box.right - frame.left - rail.clientWidth;
    else if (box.left < frame.left) rail.scrollLeft -= frame.left - box.left;
  };
  filters.addEventListener('click', open);
  clearFilters.addEventListener('click', clear);
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', dismissed);
  watch.addEventListener('click', watchClick);
  browse.addEventListener('click', browseClick);
  pause.addEventListener('click', pauseClick);
  stop.addEventListener('click', stopClick);
  root.addEventListener('change', update);
  root.addEventListener('input', update);
  root.addEventListener('focusin', railFocus);
  root.addEventListener('keydown', backKey);
  root.addEventListener('keydown', browseKey);
  dialog.addEventListener('keydown', submitSearch, true);
  dialog.addEventListener('click', openFilterDestination, true);
  window.addEventListener('native-back-requested', nativeBack, true);
  const observer = new MutationObserver(update);
  observer.observe(options, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-pressed'],
  });
  for (const id of ['pause-button', 'vod-stop']) {
    const node = root.querySelector('#' + id);
    if (node)
      observer.observe(node, {
        childList: true,
        attributes: true,
        attributeFilter: ['disabled', 'hidden'],
      });
  }
  const layoutObserver = new MutationObserver(() => {
    sync();
    if (
      root.dataset.phoneView === 'watch' &&
      (root.dataset.vodBrowsing === 'true' ||
        (root.dataset.contentLibrary === 'genxtra' && root.dataset.playerIdle === 'true')) &&
      !root.classList.contains('viewing-fullscreen')
    )
      setPane('browse');
  });
  layoutObserver.observe(root, {
    attributes: true,
    attributeFilter: [
      'data-guide-panel',
      'data-device-kind',
      'data-content-library',
      'data-player-idle',
      'data-vod-browsing',
    ],
  });
  sync();
  return {
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      layoutObserver.disconnect();
      dismiss();
      returnControls();
      guidePlace.after(guide);
      window.removeEventListener('native-back-requested', nativeBack, true);
      root.removeEventListener('change', update);
      root.removeEventListener('input', update);
      root.removeEventListener('focusin', railFocus);
      root.removeEventListener('keydown', backKey);
      root.removeEventListener('keydown', browseKey);
      dialog.removeEventListener('keydown', submitSearch, true);
      dialog.removeEventListener('click', openFilterDestination, true);
      bar.remove();
      dialog.remove();
      watchRow.remove();
      watchPlace.remove();
      guidePlace.remove();
      optionPlace.remove();
      searchPlace.remove();
      footPlace.remove();
      archivePlace.remove();
      delete root.dataset.phonePortrait;
      delete root.dataset.phoneView;
    },
  };
}
