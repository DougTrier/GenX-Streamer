/** Read-only capability enrichment of the existing, explicitly opened Import dialog. */
export interface ConfiguredImportEntryHost {
  root: Document;
  allowed(): boolean;
  foreground(): number;
  configured(): boolean;
  capability(): Promise<boolean>;
  own(work: Promise<void>): Promise<void>;
  run(work: Promise<void>): void;
  refreshFiles(): void;
  start(): void;
}

export function installConfiguredImportEntry(host: ConfiguredImportEntryHost) {
  const get = <T extends HTMLElement>(id: string) => {
    const node = host.root.getElementById(id);
    if (!node) throw new Error('Import controls are unavailable.');
    return node as T;
  };
  const trigger = get<HTMLButtonElement>('import-button');
  const settings = get<HTMLDialogElement>('settings-dialog');
  const dialog = get<HTMLDialogElement>('import-dialog');
  const scan = get<HTMLButtonElement>('automatic-scan-button');
  const manual = get<HTMLDetailsElement>('custom-source-options');
  let disposed = false;
  let pending: Promise<void> | null = null;
  let starting: Promise<void> | null = null;
  let intent: { foreground: number; manual: boolean; available: boolean } | null = null;
  const admitted = (captured: typeof intent) =>
    !!captured &&
    captured === intent &&
    !disposed &&
    dialog.open &&
    !host.root.hidden &&
    captured.foreground === host.foreground() &&
    host.allowed();
  const configured = () => {
    try {
      return host.configured();
    } catch {
      return false;
    }
  };
  const invalidate = () => {
    intent = null;
    scan.hidden = true;
  };
  const interacted = () => {
    if (intent) intent.manual = true;
  };
  const probe = () => {
    if (pending) return pending;
    // Defer the capability call so even a synchronous adapter refusal is joined.
    const work = Promise.resolve()
      .then(() => host.capability())
      .catch(() => false)
      .then((supported) => {
        const captured = intent;
        if (!admitted(captured) || captured!.manual) return;
        captured!.available = supported && configured();
        scan.hidden = !captured!.available;
      });
    const owned = host.own(work);
    pending = owned;
    void owned.then(
      () => {
        if (pending === owned) pending = null;
      },
      () => {
        if (pending === owned) pending = null;
      },
    );
    return owned;
  };
  const open = () => {
    if (disposed || dialog.open || host.root.hidden || !host.allowed()) return;
    settings.close();
    intent = { foreground: host.foreground(), manual: false, available: false };
    get('import-explanation').textContent =
      'Import a URL/file and review before saving, or scan your configured sources.';
    get('import-status').textContent = '';
    scan.hidden = true;
    scan.textContent = 'Scan configured sources';
    get<HTMLButtonElement>('rescan-automatic-button').hidden = true;
    manual.open = true;
    dialog.querySelector('h2')!.textContent = 'Import playlist';
    host.refreshFiles();
    dialog.showModal();
    host.run(probe());
  };
  const start = () => {
    if (starting) return;
    const captured = intent;
    if (!admitted(captured) || !captured!.available || !configured()) {
      invalidate();
      return;
    }
    const work = Promise.resolve().then(() => {
      if (!admitted(captured) || !configured()) {
        invalidate();
        return;
      }
      invalidate();
      dialog.close();
      // Preserve playbackAction's error observation for synchronous SourceScan admission failures.
      host.start();
    });
    const owned = host.own(work);
    starting = owned;
    void owned.then(
      () => {
        if (starting === owned) starting = null;
      },
      () => {
        if (starting === owned) starting = null;
      },
    );
    host.run(owned);
  };
  const hidden = () => {
    if (host.root.hidden) invalidate();
  };
  const activity = ['focusin', 'input', 'change', 'click', 'keydown'] as const;
  trigger.addEventListener('click', open);
  scan.addEventListener('click', start);
  dialog.addEventListener('close', invalidate);
  dialog.addEventListener('cancel', invalidate);
  host.root.addEventListener('visibilitychange', hidden);
  // This listener only revokes admission. Main's validated lifecycle owns foreground restoration.
  host.root.defaultView?.addEventListener('native-app-background', invalidate);
  for (const event of activity) manual.addEventListener(event, interacted);
  return {
    settled: () => Promise.all([pending, starting]).then(() => undefined),
    dispose() {
      disposed = true;
      invalidate();
      trigger.removeEventListener('click', open);
      scan.removeEventListener('click', start);
      dialog.removeEventListener('close', invalidate);
      dialog.removeEventListener('cancel', invalidate);
      host.root.removeEventListener('visibilitychange', hidden);
      host.root.defaultView?.removeEventListener('native-app-background', invalidate);
      for (const event of activity) manual.removeEventListener(event, interacted);
      return Promise.all([pending, starting]).then(() => undefined);
    },
  };
}
