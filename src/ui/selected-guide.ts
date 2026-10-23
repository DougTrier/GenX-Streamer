import type { SelectedGuideSummary } from '../guide/native';

export interface SelectedGuideSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  summary: SelectedGuideSummary | null;
}
/** One selected channel's metadata. This renderer never fetches, tunes or changes layout. */
export function mountSelectedGuide(
  container: HTMLElement,
  options: {
    formatTime(milliseconds: number): string;
    mapGuide?(): void;
    statusContainer?: HTMLElement;
  },
): { render(snapshot: SelectedGuideSnapshot): void; dispose(): void } {
  if (options.statusContainer)
    return mountSplitSelectedGuide(container, options.statusContainer, options);
  const document = container.ownerDocument;
  const region = document.createElement('div');
  region.className = 'selected-guide';
  region.setAttribute('aria-label', 'Selected channel programs');
  const current = document.createElement('span');
  current.className = 'selected-guide-current';
  const next = document.createElement('span');
  next.className = 'selected-guide-next';
  const freshness = document.createElement('span');
  freshness.className = 'selected-guide-freshness';
  const map = options.mapGuide ? document.createElement('button') : null;
  if (map) {
    map.type = 'button';
    map.textContent = 'Map guide';
    map.className = 'selected-guide-map';
    map.hidden = true;
    map.addEventListener('click', () => {
      if (!disposed && !map.hidden) options.mapGuide?.();
    });
  }
  region.append(current, next, freshness);
  if (map) region.append(map);
  container.append(region);
  let disposed = false;
  return {
    render(snapshot) {
      if (disposed) return;
      region.hidden = snapshot.status === 'idle';
      current.textContent = '';
      next.textContent = '';
      freshness.textContent = '';
      if (map) map.hidden = true;
      region.title = '';
      if (snapshot.status === 'idle') return;
      if (snapshot.status !== 'ready' || !snapshot.summary) {
        current.textContent =
          snapshot.status === 'loading'
            ? 'Checking program guide…'
            : snapshot.status === 'error'
              ? 'Program guide could not refresh. Open Guide to review the source.'
              : 'Program guide unavailable. Open Guide to configure listings.';
        return;
      }
      const summary = snapshot.summary;
      if (summary.mappingStatus !== 'mapped') {
        if (map) map.hidden = summary.mappingStatus === 'channel-unavailable';
        current.textContent =
          summary.mappingStatus === 'unmapped'
            ? options.mapGuide
              ? 'No program guide is connected yet. Choose Map guide to find this channel’s schedule.'
              : 'No program guide is connected yet.'
            : summary.mappingStatus === 'source-unavailable'
              ? options.mapGuide
                ? 'The saved guide is unavailable. Choose Map guide to connect another schedule.'
                : 'The saved guide is unavailable. Open Guide to connect another schedule.'
              : 'This channel is no longer in the saved catalog.';
        return;
      }
      current.textContent =
        summary.current && summary.currentStatus === 'current'
          ? `Now: ${summary.current.title}`
          : summary.currentStatus === 'overlap'
            ? 'Current listings overlap; no single program confirmed.'
            : summary.currentStatus === 'unknown-end'
              ? summary.current
                ? `Last listing: ${summary.current.title} · end unknown`
                : 'Current program end is unknown.'
              : 'No current listing.';
      next.textContent = summary.next
        ? `Next: ${options.formatTime(summary.next.startMs)} · ${summary.next.title}`
        : summary.nextStatus === 'overlap'
          ? 'Next listings overlap; review Guide.'
          : 'No next listing in the seven-day window.';
      freshness.textContent =
        summary.cacheStatus === 'stale'
          ? 'Saved guide may be out of date.'
          : summary.cacheStatus === 'unavailable'
            ? 'No saved schedule available.'
            : summary.updatedMs === null
              ? 'Guide update time unknown.'
              : `Guide updated ${options.formatTime(summary.updatedMs)}.`;
      // Full text remains available to assistive technology and pointer users if CSS clamps it.
      region.title = [current.textContent, next.textContent, freshness.textContent].join(' ');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      region.remove();
    },
  };
}

/** Separate confirmed program metadata from configuration and uncertainty notices. */
function mountSplitSelectedGuide(
  container: HTMLElement,
  statusContainer: HTMLElement,
  options: { formatTime(milliseconds: number): string; mapGuide?(): void },
): { render(snapshot: SelectedGuideSnapshot): void; dispose(): void } {
  const document = container.ownerDocument;
  const details = document.createElement('div');
  details.className = 'selected-guide selected-guide-details';
  details.setAttribute('aria-label', 'Selected channel programs');
  const makeProgram = (className: string, label: string) => {
    const group = document.createElement('div');
    group.className = className;
    const heading = document.createElement('span');
    heading.className = 'selected-guide-program-label';
    heading.textContent = label;
    const title = document.createElement('span');
    title.className = 'selected-guide-program-title';
    const time = document.createElement('span');
    time.className = 'selected-guide-program-time';
    group.append(heading, title, time);
    details.append(group);
    return { group, title, time };
  };
  const current = makeProgram('selected-guide-current', 'Now');
  const next = makeProgram('selected-guide-next', 'Up Next');
  const status = document.createElement('div');
  status.className = 'selected-guide selected-guide-status';
  status.setAttribute('aria-label', 'Selected channel guide status');
  const notice = document.createElement('span');
  notice.className = 'selected-guide-notice';
  const freshness = document.createElement('span');
  freshness.className = 'selected-guide-freshness';
  status.append(notice, freshness);
  const map = options.mapGuide ? document.createElement('button') : null;
  let disposed = false;
  if (map) {
    map.type = 'button';
    map.className = 'selected-guide-map';
    map.textContent = 'Map guide';
    map.hidden = true;
    map.addEventListener('click', () => {
      if (!disposed && !map.hidden) options.mapGuide?.();
    });
    status.append(map);
  }
  container.append(details);
  statusContainer.append(status);
  const program = (
    view: typeof current,
    value: NonNullable<SelectedGuideSummary['current']> | null,
  ) => {
    view.group.hidden = !value;
    view.title.textContent = value?.title ?? '';
    view.time.textContent = value
      ? `${options.formatTime(value.startMs)}${value.stopMs === null ? ' · end unknown' : `–${options.formatTime(value.stopMs)}`}`
      : '';
  };
  return {
    render(snapshot) {
      if (disposed) return;
      program(current, null);
      program(next, null);
      details.hidden = true;
      status.hidden = snapshot.status === 'idle';
      notice.textContent = freshness.textContent = '';
      details.title = status.title = '';
      if (map) map.hidden = true;
      if (snapshot.status === 'idle') return;
      if (snapshot.status !== 'ready' || !snapshot.summary) {
        notice.textContent =
          snapshot.status === 'loading'
            ? 'Checking program guide…'
            : snapshot.status === 'error'
              ? 'Program guide could not refresh. Open Guide to review the source.'
              : 'Program guide unavailable. Open Guide to configure listings.';
        return;
      }
      const summary = snapshot.summary;
      if (summary.mappingStatus !== 'mapped') {
        if (map) map.hidden = summary.mappingStatus === 'channel-unavailable';
        notice.textContent =
          summary.mappingStatus === 'unmapped'
            ? options.mapGuide
              ? 'No program guide is connected yet. Choose Map guide to find this channel’s schedule.'
              : 'No program guide is connected yet.'
            : summary.mappingStatus === 'source-unavailable'
              ? options.mapGuide
                ? 'The saved guide is unavailable. Choose Map guide to connect another schedule.'
                : 'The saved guide is unavailable. Open Guide to connect another schedule.'
              : 'This channel is no longer in the saved catalog.';
        return;
      }
      program(current, summary.currentStatus === 'current' ? summary.current : null);
      program(next, summary.nextStatus === 'next' ? summary.next : null);
      details.hidden = current.group.hidden && next.group.hidden;
      const notices: string[] = [];
      if (current.group.hidden)
        notices.push(
          summary.currentStatus === 'overlap'
            ? 'Current listings overlap; no single program confirmed.'
            : summary.currentStatus === 'unknown-end'
              ? 'Current program end is unknown.'
              : 'No current listing.',
        );
      if (next.group.hidden)
        notices.push(
          summary.nextStatus === 'overlap'
            ? 'Next listings overlap; review Guide.'
            : 'No next listing in the seven-day window.',
        );
      notice.textContent = notices.join(' ');
      freshness.textContent =
        summary.cacheStatus === 'stale'
          ? 'Saved guide may be out of date.'
          : summary.cacheStatus === 'unavailable'
            ? 'No saved schedule available.'
            : summary.updatedMs === null
              ? 'Guide update time unknown.'
              : `Guide updated ${options.formatTime(summary.updatedMs)}.`;
      details.title = [
        current.title.textContent,
        current.time.textContent,
        next.title.textContent,
        next.time.textContent,
      ]
        .filter(Boolean)
        .join(' ');
      status.title = [notice.textContent, freshness.textContent].filter(Boolean).join(' ');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      details.remove();
      status.remove();
    },
  };
}
