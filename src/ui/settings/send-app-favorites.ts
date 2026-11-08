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

import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { FavoriteTransfer } from '../../application/sharing/favorite-transfer';
import {
  decodeFavorites,
  encodeFavorites,
  FAVORITES_FILE,
  MAX_FAVORITES_BYTES,
  type SharedFavorite,
} from '../../sharing/favorites';

interface Receiver {
  name: string;
  address: string;
}
type Status =
  | { phase: 'idle' | 'waiting' | 'transferring' | 'received' | 'sent' }
  | { phase: 'pairing'; code: string }
  | { phase: 'failed'; reason: string };
type Operation = { controller: AbortController; id?: string; savingFile?: boolean };

function message(error: unknown): string {
  const reason = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  switch (reason) {
    case 'favorites-session-expired':
      return 'Pairing timed out. Start a new transfer.';
    case 'favorites-invalid-address':
      return 'Enter the local address and port shown on the receiving device.';
    case 'favorites-disconnected':
      return 'The devices could not finish connecting. Try again or use a favorites file.';
    case 'favorites-network-unavailable':
      return 'Nearby sharing is unavailable on this network. You can use a favorites file.';
    case 'favorites-list-too-large':
      return 'Choose a smaller set of favorites to share.';
    case 'favorites-session-active':
      return 'A favorites transfer is still active. Try again in a moment.';
    default:
      return /^[A-Z][a-z ]{2,30} /.test(reason) && reason.length <= 160 && !reason.includes('://')
        ? reason
        : 'Favorites could not be transferred. Try again or use a favorites file.';
  }
}

async function saveFile(text: string, signal: AbortSignal): Promise<boolean> {
  if (isTauri()) {
    const destination = await save({
      title: 'Export favorites',
      defaultPath: FAVORITES_FILE,
      filters: [{ name: 'GenX favorites', extensions: ['json'] }],
    });
    signal.throwIfAborted();
    if (!destination) return false;
    await writeTextFile(destination, text);
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = FAVORITES_FILE;
    document.body.append(link);
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

export function mountFavoriteShare(
  root: HTMLElement,
  dialog: HTMLDialogElement,
  actions: FavoriteTransfer,
): () => void {
  root.innerHTML = `
    <h3>Share Favorites</h3>
    <p class="send-app-detail">Copy Free TV favorites to another GenX device on this network or use a favorites file. The receiving device matches channels already saved there.</p>
    <div class="send-app-buttons">
      <button type="button" data-favs="send">Send favorites</button>
      <button type="button" data-favs="receive">Receive favorites</button>
      <button type="button" data-favs="export">Export favorites</button>
      <button type="button" data-favs="import">Import favorites</button>
      <input type="file" data-favs="file" accept=".json,application/json" hidden />
    </div>
    <div data-favs="workspace" hidden>
      <div data-favs="sender" hidden>
        <details data-favs="selection">
          <summary>Choose channels to send</summary>
          <div class="send-app-buttons">
            <button type="button" data-favs="all">Select all</button>
            <button type="button" data-favs="none">Clear selection</button>
          </div>
          <div class="send-app-favorite-list" data-favs="choices"></div>
        </details>
        <div class="send-app-buttons" data-favs="receivers"></div>
        <div class="send-app-buttons">
          <button type="button" data-favs="refresh">Find nearby devices</button>
          <label>Receiver address <input data-favs="address" type="text" inputmode="url" maxlength="21" autocomplete="off" placeholder="192.168.1.20:12345" /></label>
          <button type="button" data-favs="connect">Connect by address</button>
        </div>
      </div>
      <p data-favs="pair-code" hidden></p>
      <details data-favs="preview" hidden>
        <summary>Review received channels</summary>
        <ul class="send-app-favorite-list" data-favs="preview-list" tabindex="0"></ul>
      </details>
      <div class="send-app-buttons">
        <button type="button" data-favs="approve" hidden>Codes match</button>
        <button type="button" class="primary" data-favs="apply" hidden>Add favorites</button>
        <button type="button" data-favs="cancel">Cancel favorites transfer</button>
      </div>
    </div>
    <p class="send-app-detail" data-favs="status" role="status" aria-live="polite"></p>
  `;
  const element = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-favs="${name}"]`)!;
  const workspace = element('workspace');
  const sender = element('sender');
  const file = element<HTMLInputElement>('file');
  const status = element('status');
  const pairCode = element('pair-code');
  const approve = element<HTMLButtonElement>('approve');
  const apply = element<HTMLButtonElement>('apply');
  const cancel = element<HTMLButtonElement>('cancel');
  const receivers = element('receivers');
  const choices = element('choices');
  const review = element<HTMLDetailsElement>('preview');
  const reviewList = element('preview-list');
  const refresh = element<HTMLButtonElement>('refresh');
  const buttons = ['send', 'receive', 'export', 'import'].map((name) =>
    element<HTMLButtonElement>(name),
  );
  const native = isTauri();
  buttons[0].hidden = buttons[1].hidden = !native;
  const events = new AbortController();
  let operation: Operation | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selection: SharedFavorite[] = [];
  let preview: SharedFavorite[] = [];
  let pairing = '';
  let approved = '';
  let opener: HTMLButtonElement | undefined;
  let busy = false;

  const say = (text: string) => {
    if (status.textContent !== text) status.textContent = text;
  };
  const current = (op: Operation) =>
    operation === op && !op.controller.signal.aborted && dialog.open;
  const stopNative = (id: string) => invoke('favorites_stop', { id }).catch(() => undefined);
  function reset(restoreFocus = false) {
    clearTimeout(timer);
    operation?.controller.abort();
    if (operation?.id) void stopNative(operation.id);
    operation = undefined;
    preview = [];
    selection = [];
    pairing = approved = '';
    workspace.hidden = sender.hidden = pairCode.hidden = approve.hidden = apply.hidden = true;
    apply.disabled = approve.disabled = false;
    element<HTMLDetailsElement>('selection').open = false;
    review.open = false;
    review.hidden = true;
    reviewList.replaceChildren();
    element<HTMLInputElement>('address').value = '';
    receivers.replaceChildren();
    choices.replaceChildren();
    buttons.forEach((button) => {
      button.disabled = false;
    });
    refresh.disabled = false;
    busy = false;
    if (restoreFocus && dialog.open) opener?.focus();
    opener = undefined;
  }

  function start(button: HTMLButtonElement) {
    reset();
    const op: Operation = { controller: new AbortController() };
    operation = op;
    opener = button;
    buttons.forEach((entry) => {
      entry.disabled = true;
    });
    workspace.hidden = false;
    say('');
    return op;
  }

  function finish(op: Operation, text: string) {
    if (!current(op)) return;
    reset(true);
    say(text);
  }

  function error(op: Operation, failure: unknown) {
    finish(op, message(failure));
  }

  async function showPreview(op: Operation, text: string) {
    if (!current(op)) return;
    const items = decodeFavorites(text);
    say('Matching favorites to channels on this device…');
    const plan = await actions.preview(items, op.controller.signal);
    if (!current(op)) return;
    preview = items;
    pairCode.hidden = approve.hidden = true;
    review.hidden = !plan.names.length;
    review.open = !review.hidden;
    for (const name of plan.names) {
      const row = document.createElement('li');
      row.textContent = name;
      reviewList.append(row);
    }
    const additions = plan.names.length;
    say(
      `${additions} to add to favorites · ${plan.alreadySaved} already saved${plan.unmatched ? ` · ${plan.unmatched} missing from this device’s channel list` : ''}${plan.previouslyRemoved ? ` · ${plan.previouslyRemoved} previously removed and kept hidden` : ''}.`,
    );
    apply.hidden = additions === 0;
    (additions ? apply : cancel).focus();
  }

  function poll(op: Operation) {
    if (!current(op) || !op.id) return;
    timer = setTimeout(() => {
      void (async () => {
        const state = await invoke<Status>('favorites_status', { id: op.id });
        if (!current(op)) return;
        switch (state.phase) {
          case 'pairing':
            if (pairing !== state.code) {
              pairing = state.code;
              pairCode.textContent = `Pairing code ${state.code.slice(0, 4)} ${state.code.slice(4)}`;
              pairCode.hidden = false;
              approve.hidden = false;
              approve.disabled = false;
              approve.focus();
            }
            if (approved !== state.code)
              say('Compare the codes on both devices, then choose Codes match on each.');
            break;
          case 'transferring':
            approve.hidden = true;
            say('Waiting for both devices to confirm…');
            break;
          case 'sent':
            finish(
              op,
              'Favorites sent. On the receiving device, review the list and choose Add favorites.',
            );
            return;
          case 'received': {
            const text = await invoke<string | null>('favorites_take', { id: op.id });
            if (!current(op)) return;
            void stopNative(op.id!);
            delete op.id;
            if (text === null)
              throw new Error('The receiving session ended. Start a new transfer.');
            await showPreview(op, text);
            return;
          }
          case 'failed':
            error(op, state.reason);
            return;
          case 'idle':
            error(op, 'favorites-disconnected');
            return;
        }
        poll(op);
      })().catch((failure: unknown) => error(op, failure));
    }, 250);
  }

  async function beginNetwork(
    op: Operation,
    command: 'favorites_receive' | 'favorites_send',
    args: Record<string, string> = {},
  ) {
    const id = crypto.randomUUID();
    op.id = id;
    try {
      const receiver = await invoke<Receiver | void>(command, { ...args, id });
      if (!current(op)) return;
      if (receiver)
        say(
          `Waiting as ${receiver.name}. On the sending device, find it nearby or enter ${receiver.address}.`,
        );
      poll(op);
    } finally {
      // A panel can close before the native listen/connect command has returned.
      if (!current(op)) await stopNative(id);
    }
  }

  function sendTo(address: string) {
    const op = operation;
    if (!op || !current(op) || busy || op.id) return;
    const selected = [...choices.querySelectorAll<HTMLInputElement>('input')].flatMap(
      (checkbox, index) => (checkbox.checked ? [selection[index]!] : []),
    );
    try {
      if (!selected.length) {
        say('Choose at least one favorite to send.');
        return;
      }
      const payload = encodeFavorites(selected);
      busy = true;
      sender.hidden = true;
      cancel.focus();
      say('Connecting to the receiving device…');
      void beginNetwork(op, 'favorites_send', { address, payload }).catch((failure: unknown) =>
        error(op, failure),
      );
    } catch (failure) {
      say(message(failure));
    }
  }

  function discover(op: Operation) {
    if (!current(op) || refresh.disabled) return;
    if (document.activeElement === refresh) cancel.focus();
    refresh.disabled = true;
    receivers.replaceChildren();
    say('Looking for devices that opened Receive favorites…');
    void invoke<Receiver[]>('favorites_discover')
      .then(
        (found) => {
          if (!current(op) || op.id) return;
          for (const device of found) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = device.name;
            button.addEventListener('click', () => sendTo(device.address));
            receivers.append(button);
          }
          if (document.activeElement === cancel && found.length)
            receivers.querySelector('button')?.focus();
          say(
            found.length
              ? 'Choose a nearby device.'
              : 'No devices found. Open Receive favorites on the other device, or enter its address.',
          );
        },
        (failure: unknown) => {
          if (current(op) && !op.id) say(message(failure));
        },
      )
      .finally(() => {
        if (current(op)) refresh.disabled = false;
      });
  }

  function listen(button: HTMLElement, handler: () => void) {
    button.addEventListener('click', handler, { signal: events.signal });
  }

  listen(buttons[0], () => {
    const op = start(buttons[0]);
    cancel.focus();
    say('Preparing shareable favorites…');
    void (async () => {
      const result = await actions.capture(op.controller.signal);
      if (!current(op)) return;
      selection = result.items.slice(0, 1000);
      if (!selection.length) {
        finish(op, 'There are no shareable Free TV favorites.');
        return;
      }
      for (const item of selection) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = true;
        label.append(check, document.createTextNode(item.name));
        choices.append(label);
      }
      sender.hidden = false;
      element('selection').querySelector('summary')!.textContent =
        `Choose channels to send (${selection.length}${result.items.length > selection.length ? ' of ' + result.items.length : ''})`;
      refresh.focus();
      discover(op);
    })().catch((failure: unknown) => error(op, failure));
  });
  listen(element('all'), () =>
    choices.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.checked = true;
    }),
  );
  listen(element('none'), () =>
    choices.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.checked = false;
    }),
  );
  listen(refresh, () => {
    if (operation) discover(operation);
  });
  listen(element('connect'), () => sendTo(element<HTMLInputElement>('address').value.trim()));
  listen(buttons[1], () => {
    const op = start(buttons[1]);
    cancel.focus();
    say('Opening a local receiving session…');
    void beginNetwork(op, 'favorites_receive').catch((failure: unknown) => error(op, failure));
  });
  listen(approve, () => {
    const op = operation;
    if (!op?.id || !current(op) || !pairing || approved === pairing) return;
    approved = pairing;
    approve.disabled = true;
    cancel.focus();
    say('Waiting for the other device to confirm…');
    void invoke('favorites_approve', { id: op.id, code: pairing }).catch((failure: unknown) =>
      error(op, failure),
    );
  });
  listen(buttons[2], () => {
    const op = start(buttons[2]);
    cancel.focus();
    void (async () => {
      const { items, skipped } = await actions.capture(op.controller.signal);
      if (!current(op)) return;
      if (!items.length) {
        finish(op, 'There are no shareable Free TV favorites.');
        return;
      }
      say('Choose where to save the favorites file.');
      // Android's document picker temporarily backgrounds the app.
      op.savingFile = true;
      const saved = await saveFile(encodeFavorites(items), op.controller.signal);
      finish(
        op,
        saved
          ? `Exported ${items.length} ${items.length === 1 ? 'favorite' : 'favorites'}.${skipped ? ` Skipped ${skipped} unavailable, duplicate or private entries.` : ''}`
          : 'Export canceled.',
      );
    })().catch((failure: unknown) => error(op, failure));
  });
  listen(buttons[3], () => file.click());
  file.addEventListener(
    'change',
    () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked || !dialog.open) return;
      const op = start(buttons[3]);
      cancel.focus();
      say('Reading the favorites file…');
      void (async () => {
        if (picked.size > MAX_FAVORITES_BYTES)
          throw new Error('This favorites file exceeds 1 MiB.');
        await showPreview(op, await picked.text());
      })().catch((failure: unknown) => error(op, failure));
    },
    { signal: events.signal },
  );
  listen(apply, () => {
    const op = operation;
    if (!op || !current(op) || apply.disabled) return;
    apply.disabled = true;
    cancel.focus();
    say('Saving favorites…');
    void actions.apply(preview, op.controller.signal).then(
      ({ added, unmatched, previouslyRemoved }) => {
        finish(
          op,
          `Added ${added} ${added === 1 ? 'favorite' : 'favorites'}.${unmatched ? ` Skipped ${unmatched} channels missing from this device’s channel list.` : ''}${previouslyRemoved ? ` Kept ${previouslyRemoved} previously removed channels hidden.` : ''}`,
        );
      },
      (failure: unknown) => error(op, failure),
    );
  });
  listen(cancel, () => {
    reset(true);
    say('Favorites transfer canceled.');
  });
  dialog.addEventListener(
    'close',
    () => {
      reset();
      say('');
    },
    { signal: events.signal },
  );
  const leaveForeground = () => {
    if (!operation || operation.savingFile) return;
    reset();
    say('Favorites transfer ended when the app left the foreground.');
  };
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) leaveForeground();
    },
    { signal: events.signal },
  );
  window.addEventListener('native-app-background', leaveForeground, { signal: events.signal });
  window.addEventListener('pagehide', () => reset(), { signal: events.signal });

  return () => {
    events.abort();
    reset();
  };
}
