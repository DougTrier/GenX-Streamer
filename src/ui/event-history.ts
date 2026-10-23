import {
  describeDiagnosticEvent,
  validateDiagnosticPage,
  type DiagnosticPage,
} from '../diagnostics/events';
export interface EventHistoryHost {
  read(signal: AbortSignal): Promise<DiagnosticPage>;
  clear(signal: AbortSignal): Promise<void>;
  formatTime(timestampMs: number): string;
}
/** No polling: each user action owns and joins one actual read/clear chain. */
export function mountEventHistory(container: HTMLElement, host: EventHistoryHost) {
  const doc = container.ownerDocument;
  const dialog = doc.createElement('dialog');
  dialog.className = 'gx-event-history';
  dialog.setAttribute('aria-label', 'Event history');
  const header = doc.createElement('header'),
    title = doc.createElement('h2');
  title.textContent = 'Event history';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const list = doc.createElement('ol');
  list.tabIndex = 0;
  list.setAttribute('aria-label', 'Recent events');
  list.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const limit = Math.max(0, list.scrollHeight - list.clientHeight);
    if (event.key === 'ArrowUp' && list.scrollTop <= 0) return;
    const rowStep = Math.max(44, list.firstElementChild?.getBoundingClientRect().height ?? 44);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = list.scrollTop + rowStep;
        break;
      case 'ArrowUp':
        next = list.scrollTop - rowStep;
        break;
      case 'PageDown':
        next = list.scrollTop + list.clientHeight;
        break;
      case 'PageUp':
        next = list.scrollTop - list.clientHeight;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = limit;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    list.scrollTop = Math.min(limit, Math.max(0, next));
  });
  const makeButton = (label: string, action: () => void) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  };
  const refresh = makeButton('Refresh history', () => start(false));
  const clear = makeButton('Clear history', () => start(true));
  const closeButton = makeButton('Close history', () => {
    void close();
  });
  header.append(title, refresh, clear, closeButton);
  dialog.append(header, status, list);
  doc.body.append(dialog);
  let generation = 0,
    disposed = false,
    disposing = false,
    foreground = false;
  let controller: AbortController | null = null,
    operation: Promise<void> = Promise.resolve(),
    closing: Promise<void> | null = null;
  let opener: HTMLElement | null = null;
  function active(signal: AbortSignal, version: number) {
    return foreground && !disposed && !signal.aborted && generation === version;
  }
  function render(page: DiagnosticPage) {
    const fragment = doc.createDocumentFragment();
    for (const event of page.events) {
      const row = doc.createElement('li');
      row.dataset.level = event.level;
      const time = doc.createElement('time');
      time.dateTime = new Date(event.timestampMs).toISOString();
      time.textContent = host.formatTime(event.timestampMs);
      const description = doc.createElement('span');
      description.textContent = describeDiagnosticEvent(event);
      const code = doc.createElement('small');
      code.className = 'gx-event-code';
      code.textContent = event.code;
      row.append(time, description, code);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    status.textContent = page.events.length
      ? `${page.events.length} recent events. Latest 300 retained.`
      : 'No recent events.';
  }
  function start(remove: boolean) {
    if (!foreground || disposed || disposing || closing) return;
    controller?.abort();
    const owner = new AbortController();
    controller = owner;
    const version = ++generation;
    const previous = operation;
    refresh.disabled = clear.disabled = true;
    status.textContent = remove ? 'Clearing event history…' : 'Reading event history…';
    operation = (async () => {
      await previous;
      if (!active(owner.signal, version)) return;
      try {
        if (remove) await host.clear(owner.signal);
        if (!active(owner.signal, version)) return;
        const page = validateDiagnosticPage(await host.read(owner.signal));
        if (active(owner.signal, version)) render(page);
      } catch {
        if (active(owner.signal, version))
          status.textContent = remove
            ? 'Event history could not be cleared. Retry Clear.'
            : 'Event history could not be read. Retry Refresh.';
      } finally {
        if (active(owner.signal, version)) refresh.disabled = clear.disabled = false;
      }
    })();
  }
  function close(): Promise<void> {
    if (closing) return closing;
    foreground = false;
    ++generation;
    controller?.abort();
    closing = (async () => {
      await operation;
      dialog.close();
      if (opener?.isConnected && !opener.closest('[hidden],[inert]'))
        opener.focus({ preventScroll: true });
    })().finally(() => {
      closing = null;
    });
    return closing;
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void close();
  });
  return {
    open() {
      if (disposed || disposing || closing) return;
      if (!dialog.open) {
        opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
        dialog.showModal();
      }
      foreground = true;
      start(false);
      closeButton.focus({ preventScroll: true });
    },
    close,
    suspend: close,
    async dispose() {
      if (disposed) return;
      disposing = true;
      await close();
      disposed = true;
      dialog.remove();
    },
  };
}
