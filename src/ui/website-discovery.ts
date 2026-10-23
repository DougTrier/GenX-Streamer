import type { DiscoveryCandidate, DiscoveryResult } from '../discovery/candidates';
import { pageInputErrorMessage } from '../discovery/page-input';
export interface WebsiteDiscoveryHost {
  inspect(url: string, allowHttp: boolean, signal: AbortSignal): Promise<DiscoveryResult>;
  /** Explicit source draft only. Existing source scan owns channel review and publication. */
  reviewSource(
    url: string,
    label: string,
    allowHttp: boolean,
    signal?: AbortSignal,
  ): void | Promise<void>;
}
export function mountWebsiteDiscovery(
  container: HTMLElement,
  host: WebsiteDiscoveryHost,
): {
  open(initialUrl?: string): void;
  suspend(): Promise<void>;
  dispose(): Promise<void>;
} {
  const button = (label: string, action: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  };
  const trigger = button('Find sources', () => open());
  const dialog = document.createElement('dialog');
  dialog.className = 'website-discovery-dialog';
  dialog.setAttribute('aria-label', 'Find sources on a website');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = 'Find sources';
  const explanation = document.createElement('p');
  explanation.textContent =
    'Paste a website or GitHub page URL, then Scan. Select a source, review its channels, and Save the channels you want. Only this page is scanned; linked pages are not crawled.';
  const urlLabel = document.createElement('label');
  urlLabel.textContent = 'Website URL';
  const url = document.createElement('input');
  url.type = 'url';
  url.maxLength = 16_384;
  url.placeholder = 'Paste a website or GitHub page URL';
  urlLabel.append(url);
  const httpLabel = document.createElement('label');
  const allowHttp = document.createElement('input');
  allowHttp.type = 'checkbox';
  httpLabel.append(allowHttp, ' Allow unencrypted HTTP for this website and selected source');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const list = document.createElement('ul');
  list.className = 'website-references';
  list.setAttribute('aria-label', 'Possible sources');
  const footer = document.createElement('footer');
  const count = document.createElement('p');
  const actions = document.createElement('select');
  actions.setAttribute('aria-label', 'Source finding action');
  for (const [value, label] of [
    ['close', 'Close source finder'],
    ['previous', 'Previous page'],
    ['next', 'Next page'],
    ['cancel', 'Cancel scan'],
    ['rescan', 'Change website'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    actions.append(option);
  }
  const run = button('Run action', () => {
    void secondary();
  });
  run.textContent = 'Run';
  run.setAttribute('aria-label', 'Run action');
  const scan = button('Scan website', () => {
    void inspect();
  });
  const review = button('Review selected source', () => {
    void handoff();
  });
  review.textContent = 'Review source';
  review.setAttribute('aria-label', 'Review selected source');
  const close = button('Close source finder', () => {
    actions.value = 'close';
    void secondary();
  });
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close source finder');
  header.append(title, close);
  const setup = document.createElement('section');
  setup.className = 'website-setup';
  setup.append(explanation, urlLabel, httpLabel, scan);
  const feedback = document.createElement('section');
  feedback.className = 'website-feedback';
  feedback.append(status, error, count);
  const body = document.createElement('section');
  body.className = 'website-body';
  body.append(setup, list);
  footer.append(review, actions, run);
  dialog.append(header, feedback, body, footer);
  container.append(trigger);
  container.ownerDocument.body.append(dialog);
  let disposed = false,
    busy = false,
    generation = 0,
    page = 0;
  let selected: DiscoveryCandidate | null = null;
  let candidates: DiscoveryCandidate[] = [];
  let capture: { url: string; allowHttp: boolean } | null = null;
  let controller: AbortController | null = null;
  let work: Promise<void> = Promise.resolve();
  let suspension: Promise<void> | null = null;
  let restoreSuspendedReview: (() => void) | null = null;
  let editing = true;
  let returnFocus: HTMLElement | null = null;
  function closeAndRestoreFocus() {
    dialog.close();
    if (
      returnFocus?.isConnected &&
      !returnFocus.matches(':disabled') &&
      !returnFocus.closest('[inert]') &&
      returnFocus.checkVisibility()
    )
      returnFocus.focus();
    returnFocus = null;
  }
  function render() {
    setup.hidden = !editing;
    list.hidden = editing;
    review.hidden = editing;
    title.textContent = 'Find sources';
    url.disabled = busy;
    allowHttp.disabled = busy;
    scan.disabled = busy;
    review.disabled = busy || !selected || !capture;
    list.replaceChildren();
    for (const candidate of candidates.slice(page * 50, (page + 1) * 50)) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'website-reference';
      radio.checked = selected?.key === candidate.key;
      radio.disabled = busy;
      radio.setAttribute(
        'aria-label',
        `Select source ${candidate.label || new URL(candidate.url).hostname}`,
      );
      radio.addEventListener('change', () => {
        selected = candidate;
        render();
      });
      const name = document.createElement('strong');
      name.textContent = candidate.label || new URL(candidate.url).hostname;
      const origin = document.createElement('span');
      origin.textContent = ` ${new URL(candidate.url).hostname} · ${candidate.role === 'link' ? 'Link' : 'Media reference'}`;
      label.append(radio, name, origin);
      item.append(label);
      list.append(item);
    }
    count.textContent = candidates.length
      ? `${candidates.length} possible sources · Page ${page + 1} of ${Math.ceil(candidates.length / 50)}`
      : 'No sources found yet';
    for (const option of actions.options)
      option.disabled =
        option.value === 'previous'
          ? busy || page === 0
          : option.value === 'next'
            ? busy || (page + 1) * 50 >= candidates.length
            : option.value === 'cancel'
              ? !busy
              : false;
  }
  async function cancel() {
    generation++;
    controller?.abort();
    await work;
    controller = null;
    busy = false;
    render();
  }
  function open(initialUrl?: string) {
    if (disposed || suspension) return;
    if (initialUrl !== undefined && !busy) {
      editing = true;
      url.value = initialUrl;
      invalidate();
    }
    if (!dialog.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    url.focus();
  }
  function inspect(): Promise<void> {
    if (disposed || busy || suspension) return Promise.resolve();
    const prior = { candidates, selected, capture, page, editing };
    restoreSuspendedReview = () => {
      candidates = prior.candidates;
      selected = prior.selected;
      capture = prior.capture;
      page = prior.page;
      editing = prior.editing;
    };
    const id = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    capture = { url: url.value.trim(), allowHttp: allowHttp.checked };
    const captured = capture;
    candidates = [];
    selected = null;
    page = 0;
    busy = true;
    error.textContent = '';
    status.textContent = 'Reading this page…';
    render();
    work = Promise.resolve().then(async () => {
      try {
        const result = await host.inspect(captured.url, captured.allowHttp, signal);
        if (disposed || signal.aborted || generation !== id) return;
        candidates = result.candidates;
        editing = candidates.length === 0;
        status.textContent =
          result.unsupportedReason ||
          `${candidates.length} possible sources found. Choose one to review.`;
      } catch (cause) {
        if (!disposed && !signal.aborted && generation === id) {
          error.textContent = pageInputErrorMessage(cause);
          status.textContent = 'Scan failed.';
        }
      } finally {
        if (!disposed && generation === id) {
          busy = false;
          controller = null;
          render();
        }
      }
    });
    return work;
  }
  function handoff(): Promise<void> {
    if (disposed || busy || suspension || !selected || !capture) return Promise.resolve();
    restoreSuspendedReview = null;
    const candidate = structuredClone(selected);
    const allow = capture.allowHttp;
    const id = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    busy = true;
    error.textContent = '';
    render();
    work = Promise.resolve().then(async () => {
      try {
        if (signal.aborted || disposed || generation !== id) return;
        // Close this modal before opening the source review so focus ownership transfers cleanly.
        dialog.close();
        await host.reviewSource(
          candidate.url,
          candidate.label || new URL(candidate.url).hostname,
          allow,
          signal,
        );
        if (!signal.aborted && !disposed && generation === id) {
          dialog.close();
          status.textContent = 'Source draft opened for channel review.';
        }
      } catch {
        if (!disposed && !signal.aborted && generation === id) {
          error.textContent = 'The selected source could not be opened for review.';
          if (!dialog.open) dialog.showModal();
        }
      } finally {
        if (!disposed && generation === id) {
          busy = false;
          controller = null;
          render();
        }
      }
    });
    return work;
  }
  async function secondary() {
    if (actions.value === 'rescan') {
      if (busy) return;
      editing = true;
      render();
      url.focus();
      return;
    }
    if (actions.value === 'previous') {
      page = Math.max(0, page - 1);
      render();
    } else if (actions.value === 'next') {
      page = Math.min(Math.ceil(candidates.length / 50) - 1, page + 1);
      render();
    } else if (actions.value === 'cancel') {
      await cancel();
      status.textContent = 'Scan canceled.';
    } else {
      await cancel();
      closeAndRestoreFocus();
    }
  }
  const onCancel = (event: Event) => {
    event.preventDefault();
    void cancel().then(() => {
      if (!disposed) closeAndRestoreFocus();
    });
  };
  dialog.addEventListener('cancel', onCancel);
  const invalidate = () => {
    if (!busy) {
      generation++;
      candidates = [];
      selected = null;
      capture = null;
      page = 0;
      status.textContent = 'Scan this page to find possible sources.';
      render();
    }
  };
  url.addEventListener('input', invalidate);
  allowHttp.addEventListener('change', invalidate);
  render();
  return {
    open,
    suspend() {
      if (suspension) return suspension;
      if (disposed || !busy) return Promise.resolve();
      const restore = restoreSuspendedReview;
      suspension = cancel()
        .then(() => {
          if (disposed) return;
          restore?.();
          status.textContent =
            'Website operation canceled while the app was in the background. Reviewed sources retained; retry when ready.';
          error.textContent = '';
          render();
        })
        .finally(() => {
          suspension = null;
        });
      return suspension;
    },
    async dispose() {
      disposed = true;
      await cancel();
      dialog.removeEventListener('cancel', onCancel);
      dialog.remove();
      trigger.remove();
    },
  };
}
