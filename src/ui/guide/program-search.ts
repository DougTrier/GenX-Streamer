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

import type { SearchChannel } from '../../search/catalog-search';
import { SEARCH_WEEK_MS } from '../../search/catalog-search';
import '../program-search-inline.css';
import type {
  GuideCursor,
  GuideMapping,
  MappedProgram,
  ProgramPage,
  ProgramQuery,
  SelectedGuideQuery,
  SelectedGuideSummary,
} from '../../guide/native';

export interface ProgramSearchSnapshot {
  revision: string;
  catalogRevision: string;
  channels: readonly SearchChannel[];
  mappings: readonly GuideMapping[];
}
export interface ProgramSearchHost {
  presentation?: 'modal' | 'page' | 'inline';
  /** Inline presentation reuses this input in place; it never reparents it. */
  input?: HTMLInputElement;
  /** Indexed channel browsing can own channel matches without a second full scan. */
  includeChannelResults?: boolean;
  snapshot(signal: AbortSignal): Promise<ProgramSearchSnapshot>;
  current(snapshot: ProgramSearchSnapshot): boolean;
  query(query: ProgramQuery, signal: AbortSignal): Promise<ProgramPage>;
  summary(query: SelectedGuideQuery, signal: AbortSignal): Promise<SelectedGuideSummary>;
  watch(channel: SearchChannel, signal: AbortSignal): Promise<void>;
  voice?(input: HTMLInputElement, signal: AbortSignal): Promise<void>;
  opened?(view: { input: HTMLInputElement; voiceSlot: HTMLElement }): Promise<void>;
  closed?(): Promise<void>;
  cancelVoice?(): Promise<void>;
  retryCleanup?(): Promise<void>;
  now(): number;
  formatTime(milliseconds: number): string;
}
export interface SearchProgram {
  program: MappedProgram;
  channel: SearchChannel;
  timing: 'now' | 'upcoming' | 'unknown';
}
const key = (source: string, channel: string) => JSON.stringify([source, channel]);
const normalized = (value: string) => value.normalize('NFKC').toLowerCase();

/** Names/categories follow the existing normalized all-token channel search. */
export function matchedSearchChannels(
  channels: readonly SearchChannel[],
  query: string,
): SearchChannel[] {
  if (channels.length > 100000 || query.length > 256)
    throw new Error('Search exceeds its supported limits.');
  const tokens = normalized(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return channels.filter((channel) =>
    tokens.every((token) =>
      normalized(`${channel.name} ${channel.category ?? ''}`).includes(token),
    ),
  );
}
/** A listing is shown only beside its exact saved channel and reviewed mapping. */
export function groupSearchPrograms(
  programs: readonly MappedProgram[],
  snapshot: ProgramSearchSnapshot,
  atMs: number,
): SearchProgram[] {
  if (
    programs.length > 50 ||
    snapshot.channels.length > 100000 ||
    snapshot.mappings.length > 100000 ||
    !Number.isSafeInteger(atMs)
  )
    throw new Error('Search response exceeds its supported limits.');
  const channels = new Map(
    snapshot.channels.map((channel) => [key(channel.sourceId, channel.id), channel]),
  );
  const admittedMappings = snapshot.mappings.filter((mapping) =>
    channels.has(key(mapping.catalogSourceId, mapping.appChannelId)),
  );
  const mappings = new Map(
    admittedMappings.map((mapping) => [
      key(mapping.catalogSourceId, mapping.appChannelId),
      mapping,
    ]),
  );
  if (channels.size !== snapshot.channels.length || mappings.size !== admittedMappings.length)
    throw new Error('Search identities are ambiguous.');
  return programs.flatMap((program) => {
    const identity = key(program.catalogSourceId, program.appChannelId);
    const channel = channels.get(identity),
      mapping = mappings.get(identity);
    // A native page may include a channel removed since its cached mapping was saved.
    if (!channel) return [];
    if (
      !mapping ||
      mapping.guideSourceId !== program.guideSourceId ||
      mapping.xmltvChannelId !== program.xmltvChannelId ||
      !Number.isSafeInteger(program.startMs) ||
      (program.stopMs !== null &&
        (!Number.isSafeInteger(program.stopMs) || program.stopMs <= program.startMs)) ||
      typeof program.title !== 'string' ||
      program.title.length > 16384
    )
      throw new Error('Search listing identity changed.');
    const timing =
      program.startMs > atMs
        ? 'upcoming'
        : program.stopMs === null
          ? 'unknown'
          : program.stopMs > atMs
            ? 'now'
            : null;
    if (!timing || program.startMs >= atMs + SEARCH_WEEK_MS)
      throw new Error('Search listing is outside its requested window.');
    return [{ channel: { ...channel }, program: structuredClone(program), timing }];
  });
}
export function searchProgramWatchable(
  entry: SearchProgram,
  summary: SelectedGuideSummary,
  snapshot: ProgramSearchSnapshot,
  now: number,
): boolean {
  const p = entry.program,
    c = entry.channel,
    current = summary.current;
  return (
    Number.isSafeInteger(now) &&
    summary.catalogRevision === snapshot.catalogRevision &&
    summary.catalogSourceId === c.sourceId &&
    summary.appChannelId === c.id &&
    summary.mappingStatus === 'mapped' &&
    summary.cacheStatus === 'current' &&
    summary.currentStatus === 'current' &&
    summary.mapping?.guideSourceId === p.guideSourceId &&
    summary.mapping.xmltvChannelId === p.xmltvChannelId &&
    !!current &&
    current.title === p.title &&
    current.startMs === p.startMs &&
    current.stopMs === p.stopMs &&
    p.stopMs !== null &&
    p.startMs <= now &&
    now < p.stopMs
  );
}

/** Cached-only search. One serialized operation owner; no decoder, fetch, or clock timer. */
export function mountProgramSearch(container: HTMLElement, host: ProgramSearchHost) {
  const doc = container.ownerDocument;
  const inline = host.presentation === 'inline';
  if (inline && !host.input)
    throw new Error('Inline program search requires the shared search input.');
  const modal = inline ? null : doc.createElement('dialog');
  const dialog = modal ?? doc.createElement('section');
  dialog.className = 'gx-program-search';
  if (inline) {
    dialog.classList.add('gx-program-search-inline');
    dialog.hidden = true;
  }
  if (host.presentation === 'page') dialog.dataset.primaryPage = 'search';
  dialog.setAttribute(
    'aria-label',
    inline ? 'Matching cached programs' : 'Search channels and programs',
  );
  const header = doc.createElement('header'),
    heading = doc.createElement('h2');
  heading.textContent = 'Search';
  const button = (label: string, action: () => void) => {
    const control = doc.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
  };
  const closeButton = button('Close search', () => {
    void close().catch(() => {
      status.textContent = 'Search cleanup could not finish. Retry Close.';
    });
  });
  let expanded = true;
  const collapse = button('Programs', () => {
    expanded = !expanded;
    collapse.setAttribute('aria-expanded', String(expanded));
    body.hidden = status.hidden = !expanded;
  });
  collapse.className = 'gx-program-search-collapse';
  collapse.setAttribute('aria-expanded', 'true');
  if (inline) header.append(collapse);
  else header.append(heading, closeButton);
  const searchBar = doc.createElement('form');
  searchBar.className = 'gx-program-search-query';
  const input = inline ? host.input! : doc.createElement('input');
  if (!inline) {
    input.type = 'search';
    input.maxLength = 256;
    input.placeholder = 'Channel, program, or sport';
    input.setAttribute('aria-label', 'Search channels and programs');
  }
  const clear = button('Clear search', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    request(false);
    input.focus({ preventScroll: true });
  });
  const voiceSlot = doc.createElement('span');
  voiceSlot.className = 'gx-program-search-voice';
  const voiceButton = button('Voice search', () => {
    if (host.voice) voice();
  });
  voiceButton.hidden = !host.voice;
  voiceSlot.append(voiceButton);
  const submit = doc.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Search';
  if (!inline) searchBar.append(input, clear, voiceSlot, submit);
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const body = doc.createElement('div');
  body.className = 'gx-program-search-body';
  const results = doc.createElement('div');
  results.className = 'gx-program-search-groups';
  const details = doc.createElement('section');
  details.className = 'gx-program-search-detail';
  details.hidden = true;
  details.setAttribute('aria-label', 'Search result details');
  body.append(results, details);
  if (inline) dialog.append(header, status, body);
  else dialog.append(header, searchBar, status, body);
  (inline || host.presentation === 'page' ? container : doc.body).append(dialog);
  let disposed = false,
    disposing = false,
    foreground = false,
    generation = 0,
    controller: AbortController | null = null;
  let closing: Promise<void> | null = null;
  let presented = false;
  let closedAcknowledgment: Promise<void> | null = null;
  let operation: Promise<void> = Promise.resolve(),
    cleanupFailed = false,
    opener: HTMLElement | null = null;
  let snapshot: ProgramSearchSnapshot | null = null,
    entries: SearchProgram[] = [],
    channelMatches: SearchChannel[] = [],
    channelOffset = 0,
    cursor: GuideCursor | null = null,
    nextCursor: GuideCursor | null = null,
    anchor = 0,
    pageRevision: number | null = null;
  let renderedQuery: string | null = null;
  let resultScroll: number | null = null;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  const clearInputTimer = () => {
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = null;
  };
  let detail: { channel: SearchChannel; entry?: SearchProgram; opener: HTMLElement } | null = null;
  const active = (signal: AbortSignal, version: number, captured?: ProgramSearchSnapshot) =>
    !disposed &&
    foreground &&
    (inline || modal!.open) &&
    !signal.aborted &&
    version === generation &&
    (!captured || host.current(captured));
  function closeDetails(cancelWork = true): boolean {
    if (!detail) return false;
    if (cancelWork) controller?.abort();
    generation++;
    const previous = detail.opener;
    detail = null;
    details.hidden = true;
    details.replaceChildren();
    if (inline && resultScroll !== null) {
      body.scrollTop = resultScroll;
      resultScroll = null;
    }
    if (previous.isConnected) previous.focus({ preventScroll: true });
    return true;
  }
  function enqueue(job: (signal: AbortSignal, version: number) => Promise<void>): void {
    controller?.abort();
    const abort = new AbortController(),
      version = ++generation;
    controller = abort;
    const previous = operation;
    operation = (async () => {
      await previous;
      if (!active(abort.signal, version)) return;
      try {
        await job(abort.signal, version);
      } catch (error) {
        if (abort.signal.aborted) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) cleanupFailed = true;
        } else if (active(abort.signal, version))
          status.textContent =
            'Search could not finish. Check your saved program guides and try Search again.';
      }
    })();
  }
  function showDetail(
    channel: SearchChannel,
    entry: SearchProgram | undefined,
    control: HTMLElement,
  ) {
    if (!foreground || !control.isConnected || !snapshot || !host.current(snapshot)) return;
    if (inline && resultScroll === null) resultScroll = body.scrollTop;
    detail = { channel, entry, opener: control };
    details.hidden = false;
    details.replaceChildren();
    const name = doc.createElement('h3');
    name.textContent = entry?.program.title ?? channel.name;
    const metadata = doc.createElement('p');
    metadata.textContent = entry
      ? `${channel.name} · ${host.formatTime(entry.program.startMs)}${entry.program.stopMs === null ? ' · End time unavailable' : ' – ' + host.formatTime(entry.program.stopMs)}`
      : `${channel.name}${channel.category ? ' · ' + channel.category : ''}`;
    const description = doc.createElement('p');
    description.textContent = entry?.program.description ?? '';
    const note = doc.createElement('p');
    note.textContent = entry
      ? 'Watch is available after the current listing is confirmed.'
      : 'Watch this saved channel.';
    const watch = button('Watch channel', () => {
      const selected = detail,
        captured = snapshot;
      if (!selected || !captured) return;
      enqueue(async (signal, version) => {
        if (!host.current(captured)) throw new Error('Search changed');
        if (selected.entry) {
          const query = {
            catalogSourceId: selected.channel.sourceId,
            appChannelId: selected.channel.id,
            atMs: host.now(),
            requestId: crypto.randomUUID(),
          };
          const summary = await host.summary(query, signal);
          if (!active(signal, version, captured)) return;
          if (
            summary.requestId !== query.requestId ||
            summary.atMs !== query.atMs ||
            !searchProgramWatchable(selected.entry, summary, captured, host.now())
          ) {
            note.textContent =
              'This listing is not confirmed as current. Watch the channel from Channels, or refresh Search.';
            return;
          }
        }
        if (!active(signal, version, captured)) return;
        await host.watch(structuredClone(selected.channel), signal);
        if (!active(signal, version, captured)) return;
        if (inline) {
          closeDetails(false);
          return;
        }
        await acknowledgeClosed();
        if (active(signal, version, captured)) {
          foreground = false;
          modal!.close();
          restoreFocus();
        }
      });
    });
    watch.disabled = !!entry && entry.timing !== 'now';
    const back = button('Back to results', closeDetails);
    details.append(name, metadata, description, note, watch, back);
    (watch.disabled ? back : watch).focus({ preventScroll: true });
  }
  function render() {
    results.replaceChildren();
    const section = (title: string, count: string) => {
      const region = doc.createElement('section'),
        h = doc.createElement('h3'),
        caption = doc.createElement('p');
      h.textContent = title;
      caption.textContent = count;
      region.append(h, caption);
      results.append(region);
      return region;
    };
    if (host.includeChannelResults !== false) {
      const channels = section('Channels', `${channelMatches.length} matching saved channels`);
      for (const channel of channelMatches.slice(channelOffset, channelOffset + 50)) {
        const control = button(channel.name, () => showDetail(channel, undefined, control));
        channels.append(control);
      }
      if (channelMatches.length > 50) {
        const previous = button('Previous channels', () => {
          channelOffset = Math.max(0, channelOffset - 50);
          closeDetails();
          render();
        });
        previous.disabled = channelOffset === 0;
        const next = button('More channels', () => {
          channelOffset += 50;
          closeDetails();
          render();
        });
        next.disabled = channelOffset + 50 >= channelMatches.length;
        channels.append(previous, next);
      }
    }
    for (const [timing, title] of [
      ['now', 'Currently airing'],
      ['upcoming', 'Upcoming · next 7 days'],
      ['unknown', 'End time unavailable'],
    ] as const) {
      const matched = entries.filter((entry) => entry.timing === timing);
      if (inline && !matched.length) continue;
      const region = section(title, `${matched.length} loaded listings`);
      for (const entry of matched) {
        const control = button(
          `${entry.program.title} · ${entry.channel.name} · ${host.formatTime(entry.program.startMs)}`,
          () => showDetail(entry.channel, entry, control),
        );
        region.append(control);
      }
    }
    const navigation = doc.createElement('nav');
    navigation.setAttribute('aria-label', 'Program result pages');
    const first = button('First listings', () => request(false)),
      more = button('More listings', () => request(true));
    first.disabled = cursor === null;
    more.disabled = nextCursor === null;
    navigation.append(first, more);
    if (!inline || cursor !== null || nextCursor !== null) results.append(navigation);
    if (inline) {
      collapse.textContent = `Programs · ${entries.length}${nextCursor ? '+' : ''}`;
      collapse.setAttribute('aria-expanded', String(expanded));
      body.hidden = status.hidden = !expanded;
      dialog.hidden = !foreground || entries.length === 0;
    }
  }
  function request(more: boolean) {
    if (!foreground || disposed) return;
    clearInputTimer();
    const text = input.value.trim(),
      savedCursor = more ? nextCursor : null,
      previousSnapshot = snapshot;
    if (more && !savedCursor) return;
    closeDetails();
    if (inline && !text) {
      controller?.abort();
      generation++;
      cursor = nextCursor = null;
      entries = [];
      channelMatches = [];
      renderedQuery = null;
      results.replaceChildren();
      dialog.hidden = true;
      return;
    }
    if (!more) {
      results.replaceChildren();
      if (inline) {
        if (text !== renderedQuery) expanded = true;
        entries = [];
        dialog.hidden = true;
      }
      channelOffset = 0;
      pageRevision = null;
      anchor = host.now();
    }
    const instant = anchor;
    status.textContent = 'Searching saved channels and cached program guides…';
    enqueue(async (signal, version) => {
      const captured = more ? previousSnapshot : structuredClone(await host.snapshot(signal));
      if (!captured || !active(signal, version, captured)) return;
      const page = await host.query(
        {
          guideSourceId: '',
          appChannelIds: [],
          windowStartMs: instant,
          windowEndMs: instant + SEARCH_WEEK_MS,
          search: text,
          pageSize: 50,
          cursor: savedCursor,
        },
        signal,
      );
      if (!active(signal, version, captured)) return;
      if (more && page.databaseRevision !== pageRevision) throw new Error('Search cache changed');
      const grouped = groupSearchPrograms(page.programs, captured, instant);
      snapshot = captured;
      channelMatches =
        host.includeChannelResults === false ? [] : matchedSearchChannels(captured.channels, text);
      entries = grouped;
      cursor = savedCursor;
      nextCursor = page.nextCursor;
      pageRevision = page.databaseRevision;
      renderedQuery = text;
      render();
      status.textContent = `Cached listings as of ${host.formatTime(instant)}. ${page.programs.length} listings loaded; ${grouped.length} for saved channels.${page.nextCursor ? ' More available.' : ''} Seven-day coverage depends on your saved guides.`;
    });
  }
  function voice() {
    enqueue(async (signal, version) => {
      await host.voice!(input, signal);
      if (active(signal, version)) request(false);
    });
  }
  const inputChanged = () => {
    clearInputTimer();
    controller?.abort();
    generation++;
    closeDetails();
    cursor = nextCursor = null;
    results.replaceChildren();
    entries = [];
    renderedQuery = null;
    if (inline) {
      dialog.hidden = true;
      if (foreground && !disposed && !disposing && !closing && input.value.trim())
        inputTimer = setTimeout(() => {
          inputTimer = null;
          request(false);
        }, 250);
    }
    clear.hidden = !input.value;
    status.textContent = 'Press Search to find saved channels and programs.';
  };
  const speechFinal = () => request(false);
  input.addEventListener('input', inputChanged);
  input.addEventListener('speech-search-final', speechFinal);
  const inlineFocus = (event: FocusEvent) => {
    if (!inline || !(event.target instanceof HTMLElement) || !body.contains(event.target)) return;
    const visible = body.getBoundingClientRect(),
      focused = event.target.getBoundingClientRect();
    if (focused.bottom > visible.bottom) body.scrollTop += focused.bottom - visible.bottom;
    else if (focused.top < visible.top) body.scrollTop -= visible.top - focused.top;
  };
  body.addEventListener('focusin', inlineFocus);
  searchBar.addEventListener('submit', (event) => {
    event.preventDefault();
    request(false);
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!closeDetails())
      void close().catch(() => {
        status.textContent = 'Search cleanup could not finish. Retry Close.';
      });
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && detail) {
      event.preventDefault();
      event.stopPropagation();
      closeDetails();
    }
  });
  function restoreFocus() {
    if (opener?.isConnected && !opener.closest('[hidden],[inert]'))
      opener.focus({ preventScroll: true });
  }
  function acknowledgeClosed(): Promise<void> {
    if (closedAcknowledgment) return closedAcknowledgment;
    if (!presented) return Promise.resolve();
    const attempt = (async () => {
      if (!inline) await host.closed?.();
      // A failed acknowledgment remains owned and retryable. An idle close
      // must not retarget the unrelated global speech owner.
      presented = false;
    })();
    closedAcknowledgment = attempt;
    const settled = () => {
      if (closedAcknowledgment === attempt) closedAcknowledgment = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }
  async function drain() {
    clearInputTimer();
    foreground = false;
    generation++;
    controller?.abort();
    const settled = await Promise.allSettled([
      operation,
      Promise.resolve().then(() => host.cancelVoice?.()),
    ]);
    if (settled.some((entry) => entry.status === 'rejected') || cleanupFailed) {
      if (!host.retryCleanup) throw new Error('Search cleanup could not finish. Retry closing.');
      await host.retryCleanup();
      cleanupFailed = false;
    }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      await drain();
      await acknowledgeClosed();
      closeDetails();
      if (inline) dialog.hidden = true;
      else {
        modal!.close();
        restoreFocus();
      }
    })().finally(() => {
      closing = null;
    });
    return closing;
  }
  return {
    input,
    voiceSlot,
    search: () => request(false),
    /** Reactivate the inline owner's input debounce without launching a query. */
    resume() {
      if (!inline || disposed || disposing || closing || closedAcknowledgment) return;
      presented = true;
      foreground = true;
      if (renderedQuery === input.value.trim() && snapshot && host.current(snapshot)) render();
      else dialog.hidden = true;
    },
    open(initialQuery = inline ? input.value : '') {
      if (disposed || disposing || closing || closedAcknowledgment) return;
      if (!inline && !modal!.open) {
        opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
        if (host.presentation === 'page') modal!.show();
        else modal!.showModal();
      }
      presented = true;
      foreground = true;
      input.value = initialQuery.slice(0, 256);
      clear.hidden = !input.value;
      if (inline && renderedQuery === input.value.trim() && snapshot && host.current(snapshot)) {
        render();
        return;
      }
      enqueue(async (signal, version) => {
        if (!inline) await host.opened?.({ input, voiceSlot });
        if (active(signal, version)) request(false);
      });
    },
    close,
    suspend: close,
    back: () => closeDetails(),
    async dispose() {
      if (disposed) return;
      disposing = true;
      await close();
      disposed = true;
      input.removeEventListener('input', inputChanged);
      input.removeEventListener('speech-search-final', speechFinal);
      body.removeEventListener('focusin', inlineFocus);
      dialog.remove();
    },
  };
}
