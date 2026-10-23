import { prepareImportInWorker } from '../data-transfer/worker';
import type { BackupRecord, PreparedTransfer, PreparedLegacyTransfer } from '../data-transfer';
import { MAX_BACKUP_BYTES } from '../data-transfer';

export interface TransferActions {
  capture(): Promise<BackupRecord>;
  commit(prepared: PreparedTransfer): Promise<void>;
  busy(value: boolean): void;
  available(): boolean;
  notice(message: string): void;
}

export type DataTransferCleanup = (() => Promise<void>) & { suspend(): Promise<void> };
export function installDataTransfer(actions: TransferActions): DataTransferCleanup {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('transfer-dialog');
  const status = get('transfer-status');
  const apply = get<HTMLButtonElement>('transfer-apply');
  const cancel = get<HTMLButtonElement>('transfer-cancel');
  let owner: AbortController | null = null;
  let prepared: PreparedTransfer | PreparedLegacyTransfer | null = null;
  let committing = false;
  let locked = false;
  let stopped = false;
  let disposal: Promise<void> | null = null;
  let suspension: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  const bindings: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];
  const bind = (element: HTMLElement, type: string, listener: EventListener) => {
    element.addEventListener(type, listener);
    bindings.push({ element, type, listener });
  };
  const track = (operation: Promise<void>) => {
    pending.add(operation);
    void operation
      .finally(() => pending.delete(operation))
      .catch(() => {
        // The tracked promise remains the disposal receipt; no raw error escapes an event callback.
      });
  };
  const release = (expected?: AbortController) => {
    if (expected && owner !== expected) return;
    owner?.abort();
    owner = null;
    prepared = null;
    if (locked) actions.busy(false);
    locked = false;
  };
  const begin = () => {
    if (stopped || suspension) return null;
    if (!actions.available() || locked) {
      actions.notice('Finish the current import before transferring your channels.');
      return null;
    }
    locked = true;
    actions.busy(true);
    owner = new AbortController();
    return owner;
  };
  const showPreview = (value: PreparedTransfer | PreparedLegacyTransfer) => {
    const p = value.preview;
    status.textContent = `${p.sources} sources · ${p.channels} channels · ${p.favorites} favorites · ${p.removedChannels} removed channels. ${p.httpSourceGrants} sources permit HTTP.`;
    if ('legacyPreview' in value) {
      const legacy = value.legacyPreview;
      // Counts remain redacted; provider URLs and unknown metadata never appear in this summary.
      status.textContent += ` ${legacy.unresolvedPreferenceIdentities} unresolved preferences remain recoverable. ${legacy.unselectedSourceEntries} old source entries were not added.`;
    }
    prepared = value;
    apply.disabled = false;
  };
  const selectFile = async (kind: 'backup' | 'legacy', input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!file) return;
    const operation = begin();
    if (!operation) {
      input.value = '';
      return;
    }
    apply.disabled = true;
    status.textContent = 'Checking your file… Saved channels are unchanged.';
    dialog.showModal();
    try {
      const limit = kind === 'backup' ? MAX_BACKUP_BYTES : 20 * 1024 * 1024;
      if (file.size > limit)
        throw new Error(
          kind === 'backup'
            ? 'Backup exceeds the 60 MiB + 4 KiB limit.'
            : 'File exceeds the 20 MiB limit.',
        );
      const text = await file.text();
      operation.signal.throwIfAborted();
      const base = kind === 'legacy' ? await actions.capture() : null;
      const value = await prepareImportInWorker(
        kind === 'backup'
          ? { kind, text }
          : {
              kind,
              text,
              options: {
                base: base!,
                source: {
                  id:
                    base!.catalog.sources.find(
                      (source) => source.kind === 'file' && source.location === file.name,
                    )?.id ?? crypto.randomUUID(),
                  name: get<HTMLInputElement>('legacy-source-name').value.trim() || file.name,
                  location: file.name,
                  kind: 'file',
                  allowHttp: get<HTMLInputElement>('legacy-allow-http').checked,
                },
              },
            },
        operation.signal,
      );
      if (owner !== operation || operation.signal.aborted) return;
      showPreview(value);
    } catch (error) {
      if (owner === operation && !operation.signal.aborted) {
        status.textContent = error instanceof Error ? error.message : 'File could not be checked.';
      }
    } finally {
      input.value = '';
    }
  };
  bind(get('backup-file'), 'change', () => {
    track(selectFile('backup', get('backup-file')));
  });
  bind(get('legacy-file'), 'change', () => {
    track(selectFile('legacy', get('legacy-file')));
  });
  const exportBackup = async () => {
    const operation = begin();
    if (!operation) return;
    try {
      const result = await prepareImportInWorker(
        { kind: 'export', record: await actions.capture() },
        operation.signal,
      );
      operation.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([result.backupText], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'genx-streamer-backup.json';
      downloads.set(
        url,
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
            downloads.delete(url);
          } catch {
            // Retain the URL for explicit disposal retry.
          }
        }, 1000),
      );
      link.click();
    } catch (error) {
      if (!operation.signal.aborted)
        actions.notice(error instanceof Error ? error.message : 'Backup could not be prepared.');
    } finally {
      release(operation);
    }
  };
  bind(get('backup-export'), 'click', () => track(exportBackup()));
  const commit = async () => {
    if (stopped || suspension || !prepared || !owner || committing) return;
    committing = true;
    apply.disabled = cancel.disabled = true;
    status.textContent = 'Saving your channels and preferences together…';
    try {
      await actions.commit(prepared);
      actions.notice('Channels and preferences imported.');
      dialog.close();
    } catch {
      status.textContent =
        'Import was not saved. Your previous data remains available. Check storage and retry.';
      apply.disabled = false;
    } finally {
      committing = false;
      cancel.disabled = false;
      if (!dialog.open) release();
    }
  };
  bind(apply, 'click', () => track(commit()));
  bind(cancel, 'click', () => {
    if (!committing) dialog.close();
  });
  bind(dialog, 'cancel', (event) => {
    if (committing) event.preventDefault();
  });
  bind(dialog, 'close', () => {
    if (!committing) release();
  });
  const cleanup = () => {
    if (disposal) return disposal;
    stopped = true;
    // Once commit has crossed admission it owns its durable outcome; do not abort it.
    if (!committing) owner?.abort();
    disposal = (async () => {
      const failures: Error[] = [];
      for (const binding of [...bindings]) {
        try {
          binding.element.removeEventListener(binding.type, binding.listener);
          bindings.splice(bindings.indexOf(binding), 1);
        } catch {
          failures.push(new Error('Transfer listener cleanup did not finish.'));
        }
      }
      const results = await Promise.allSettled([...pending]);
      if (results.some((result) => result.status === 'rejected'))
        failures.push(new Error('Transfer operation did not settle successfully.'));
      for (const [url, timer] of downloads) {
        clearTimeout(timer);
        try {
          URL.revokeObjectURL(url);
          downloads.delete(url);
        } catch {
          failures.push(new Error('Transfer download cleanup did not finish.'));
        }
      }
      try {
        release();
        dialog.close();
      } catch {
        failures.push(new Error('Transfer dialog cleanup did not finish.'));
      }
      if (failures.length)
        throw new AggregateError(failures, 'Transfer cleanup did not finish. Retry closing.');
    })().finally(() => {
      disposal = null;
    });
    return disposal;
  };
  cleanup.suspend = () => {
    if (suspension) return suspension;
    if (stopped || !pending.size) return Promise.resolve();
    const writing = committing;
    const operation = owner;
    if (!writing) operation?.abort();
    suspension = (async () => {
      const results = await Promise.allSettled([...pending]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Transfer background cleanup did not finish. Retry when ready.');
      if (stopped || writing) return;
      if (operation) release(operation);
      status.textContent =
        'Transfer preparation canceled while the app was in the background. Saved data is retained; retry when ready.';
      actions.notice('Transfer preparation canceled in the background. Retry when ready.');
    })().finally(() => {
      suspension = null;
    });
    return suspension;
  };
  return cleanup;
}
