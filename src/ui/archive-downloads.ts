import { archivePlayerFailureGuidance } from '../application/archive-player';
import type { ArchiveDownloads } from '../application/archive-downloads';
import { ArchiveDownloadError, type ArchiveDownloadEntry } from '../platform/archive-downloads';
export interface ArchiveDownloadsViewHost {
  downloads: ArchiveDownloads;
  play(entry: ArchiveDownloadEntry, revision: string, signal: AbortSignal): Promise<void>;
  /** Compact GenXtra footer only; standalone download surfaces keep their empty-state help. */
  compactSummary?: boolean;
  emptyFocusTarget?(): HTMLElement | null;
}
/** Metadata controls only; all bytes, paths, publication and decoder allocation remain native/owned. */
export function mountArchiveDownloads(container: HTMLElement, host: ArchiveDownloadsViewHost) {
  const doc = container.ownerDocument,
    root = doc.createElement('section');
  root.className = 'gx-archive-downloads';
  if (host.compactSummary) root.dataset.compact = 'true';
  root.setAttribute('aria-label', 'Downloads on this device');
  const progress = doc.createElement('p');
  progress.className = 'gx-archive-download-progress';
  progress.setAttribute('role', 'status');
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel download';
  const saved = doc.createElement('details'),
    heading = doc.createElement('summary'),
    list = doc.createElement('div'),
    help = doc.createElement('p');
  heading.textContent = 'Saved on this device';
  help.textContent =
    'Downloads use this app’s storage and may be removed when the app is uninstalled.';
  const panel = doc.createElement('div');
  panel.className = 'gx-archive-saved-panel';
  panel.append(help, list);
  saved.append(heading, panel);
  root.append(progress, cancel, saved);
  container.append(root);
  const bindings = new Set<{
    node: HTMLElement;
    fileRef: string;
    eligible: boolean;
    download: HTMLButtonElement;
    play: HTMLButtonElement;
    remove: HTMLButtonElement;
    label: HTMLElement;
  }>();
  let closed = false,
    offset = 0,
    lastList = '',
    playOwner: AbortController | null = null,
    playWork: Promise<void> | null = null;
  const showError = (error: unknown) => {
    if (host.compactSummary) root.hidden = false;
    progress.hidden = false;
    progress.textContent =
      error instanceof ArchiveDownloadError ? error.message : archivePlayerFailureGuidance(error);
  };
  const run = (work: Promise<unknown>) => {
    void work.catch(showError);
  };
  function play(entry: ArchiveDownloadEntry) {
    if (playWork || closed) return;
    const revision = host.downloads.snapshot.revision;
    if (revision === null) return;
    const owner = new AbortController();
    playOwner = owner;
    const work = Promise.resolve()
      .then(() => host.play({ ...entry }, revision, owner.signal))
      .finally(() => {
        if (playOwner === owner) {
          playOwner = null;
          playWork = null;
        }
      });
    playWork = work;
    void work.catch((error: unknown) => {
      if (!owner.signal.aborted) showError(error);
    });
  }
  function button(label: string, action: () => void) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  }
  cancel.addEventListener('click', () => run(host.downloads.cancel()));
  function render() {
    if (closed) return;
    const s = host.downloads.snapshot;
    let text = s.message;
    if (s.activeFileRef) {
      const bytes = s.progress?.receivedBytes,
        total = s.progress?.totalBytes;
      text =
        s.state === 'canceling'
          ? 'Canceling download…'
          : s.state === 'saving'
            ? 'Saving download…'
            : s.state === 'verifying'
              ? 'Checking downloaded video…'
              : s.state === 'preparing'
                ? 'Preparing download…'
                : bytes && total
                  ? `Downloading · ${Math.floor(Number((BigInt(bytes) * 100n) / BigInt(total)))}%`
                  : 'Downloading…';
    }
    if (
      host.compactSummary &&
      !text &&
      !s.activeFileRef &&
      (s.state === 'reading' || s.revision === null)
    )
      text = s.state === 'reading' ? 'Loading saved videos…' : 'Saved videos not loaded.';
    progress.textContent = text ?? '';
    progress.hidden = !text;
    cancel.hidden = s.activeFileRef === null && !s.cleanupPending;
    cancel.disabled = s.state === 'canceling';
    cancel.textContent = s.cleanupPending ? 'Retry download cleanup' : 'Cancel download';
    heading.textContent = host.compactSummary
      ? `Saved · ${s.entries.length}`
      : `Saved on this device · ${s.entries.length}`;
    if (host.compactSummary) {
      heading.setAttribute('aria-label', `Saved on this device · ${s.entries.length}`);
      const hide =
        s.revision !== null &&
        s.entries.length === 0 &&
        !s.activeFileRef &&
        !s.cleanupPending &&
        !text &&
        s.state === 'idle';
      if (hide && root.contains(doc.activeElement))
        host.emptyFocusTarget?.()?.focus({ preventScroll: true });
      root.hidden = hide;
      saved.hidden = s.entries.length === 0;
      if (saved.hidden) saved.open = false;
    }
    for (const b of bindings) {
      if (!b.node.isConnected) {
        bindings.delete(b);
        continue;
      }
      const entry = s.entries.find((e) => e.fileRef === b.fileRef);
      b.download.hidden = !!entry;
      b.download.disabled =
        !b.eligible || s.activeFileRef !== null || s.cleanupPending || s.state === 'removing';
      b.play.hidden = !entry || entry.cleanupPending === true;
      b.remove.hidden = !entry;
      b.remove.textContent = entry?.cleanupPending ? 'Retry removal' : 'Remove download';
      b.play.disabled = !entry?.available;
      b.remove.disabled =
        s.activeFileRef !== null ||
        (s.cleanupPending && !entry?.cleanupPending) ||
        s.state === 'removing';
      b.label.textContent = entry
        ? entry.cleanupPending
          ? 'Removal cleanup pending'
          : entry.available
            ? 'Saved on this device'
            : 'Saved copy unavailable'
        : s.activeFileRef === b.fileRef
          ? (text ?? 'Preparing download…')
          : '';
    }
    const key = JSON.stringify([
      s.revision,
      s.entries,
      s.activeFileRef !== null,
      s.cleanupPending,
      s.state === 'removing',
    ]);
    if (key === lastList) return;
    lastList = key;
    offset = Math.min(offset, Math.max(0, Math.floor((s.entries.length - 1) / 25) * 25));
    const focused =
      doc.activeElement instanceof HTMLElement
        ? doc.activeElement.dataset.downloadAction
        : undefined;
    const hadFocus = list.contains(doc.activeElement);
    list.replaceChildren();
    if (!s.entries.length) {
      const empty = doc.createElement('p');
      empty.textContent = 'No videos downloaded yet. Choose a video’s details to download it.';
      list.append(empty);
    }
    for (const entry of s.entries.slice(offset, offset + 25)) {
      const row = doc.createElement('div');
      row.className = 'gx-archive-saved-row';
      const title = doc.createElement('strong');
      title.textContent = entry.fileTitle || entry.title;
      const meta = doc.createElement('span');
      meta.textContent = entry.cleanupPending
        ? 'Removal cleanup pending'
        : entry.available
          ? `${entry.sizeBytes} bytes · Saved on this device`
          : 'Saved copy unavailable';
      const start = button('Play saved', () => play(entry));
      start.disabled = !entry.available;
      start.hidden = entry.cleanupPending === true;
      start.dataset.downloadAction = `${entry.downloadRef}-play`;
      const remove = button(entry.cleanupPending ? 'Retry removal' : 'Remove download', () => {
        const rev = host.downloads.snapshot.revision;
        if (rev !== null) run(host.downloads.remove(entry.downloadRef, rev));
      });
      remove.disabled =
        s.activeFileRef !== null ||
        (s.cleanupPending && !entry.cleanupPending) ||
        s.state === 'removing';
      remove.dataset.downloadAction = `${entry.downloadRef}-remove`;
      row.append(title, meta, start, remove);
      list.append(row);
    }
    if (s.entries.length > 25) {
      const paging = doc.createElement('nav');
      paging.setAttribute('aria-label', 'Downloaded video pages');
      const previous = button('Previous saved videos', () => {
          offset = Math.max(0, offset - 25);
          lastList = '';
          render();
        }),
        next = button('More saved videos', () => {
          offset += 25;
          lastList = '';
          render();
        });
      previous.disabled = offset === 0;
      next.disabled = offset + 25 >= s.entries.length;
      paging.append(previous, next);
      list.append(paging);
    }
    if (hadFocus && focused) {
      const target = [...list.querySelectorAll<HTMLElement>('[data-download-action]')].find(
        (n) => n.dataset.downloadAction === focused,
      );
      (target ?? heading).focus({ preventScroll: true });
    }
  }
  const unsubscribe = host.downloads.subscribe(render);
  return {
    root,
    fileControls(fileRef: string, expectedCatalogRevision: string, eligible = true) {
      const node = doc.createElement('div');
      node.className = 'gx-archive-file-downloads';
      const label = doc.createElement('p');
      label.setAttribute('role', 'status');
      const download = button('Download', () =>
        run(host.downloads.download(fileRef, expectedCatalogRevision)),
      );
      const start = button('Play saved', () => {
        const entry = host.downloads.snapshot.entries.find((e) => e.fileRef === fileRef);
        if (entry) play(entry);
      });
      const remove = button('Remove download', () => {
        const s = host.downloads.snapshot,
          entry = s.entries.find((e) => e.fileRef === fileRef);
        if (entry && s.revision !== null) run(host.downloads.remove(entry.downloadRef, s.revision));
      });
      node.append(label, download, start, remove);
      bindings.add({ node, fileRef, eligible, download, play: start, remove, label });
      // Bindings are attached by the caller after return; schedule a single owned microtask.
      queueMicrotask(() => {
        if (!closed) render();
      });
      return node;
    },
    async suspend(preserveSelection = false) {
      if (preserveSelection) return;
      playOwner?.abort();
      await playWork;
    },
    async dispose() {
      playOwner?.abort();
      await playWork;
      closed = true;
      unsubscribe();
      bindings.clear();
      root.remove();
    },
  };
}
