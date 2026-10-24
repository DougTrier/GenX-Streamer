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

import {
  createAccountVault,
  type AccountMetadata,
  type AccountSaveRequest,
} from '../../platform/account-vault';
import { viewingSettings, type PlaybackBuffer } from '../../platform/viewing-settings';

export interface AccountManagementHost {
  vault?: Pick<ReturnType<typeof createAccountVault>, 'list' | 'save' | 'remove'>;
  available?(): boolean;
  /** Own authenticated acquisition natively; return only after its actual work has joined. */
  /** Resolves with the number of unusable provider entries left out, when known. */
  refresh?(account: AccountMetadata, signal: AbortSignal): Promise<{ skipped?: number } | void>;
  /** Show metadata-only account channels; join canceled work before returning. */
  browse?(account: AccountMetadata, signal: AbortSignal): Promise<void>;
  /** Reload the host picker from authoritative account metadata after successful changes. */
  changed?(): Promise<void>;
  /** A message outside Settings (a channel import that finished after Settings closed). */
  notice?(message: string): void;
}

/** Inline settings workflow. Secrets exist only in the transient form/save request. */
export function mountAccountManagement(container: HTMLElement, host: AccountManagementHost = {}) {
  const vault = host.vault ?? createAccountVault();
  const root = document.createElement('section');
  root.className = 'account-management';
  root.setAttribute('aria-label', 'Your IPTV accounts');
  const heading = document.createElement('h3');
  heading.textContent = 'Your IPTV accounts';
  const help = document.createElement('p');
  help.textContent =
    'Keep your sign-in on this device. Add an Xtream login or a private playlist link, then refresh its channels.';
  const list = document.createElement('div');
  list.setAttribute('aria-label', 'Saved IPTV accounts');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const button = (label: string, action: string) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.dataset.accountAction = action;
    node.style.minHeight = '44px';
    node.style.minWidth = '44px';
    return node;
  };
  const add = button('Add account', 'add');
  add.className = 'primary';
  const reload = button('Reload accounts', 'reload');
  const cancelActivity = button('Cancel request', 'cancel');
  cancelActivity.hidden = true;
  const toolbar = document.createElement('div');
  toolbar.className = 'dialog-actions';
  toolbar.append(add, reload, cancelActivity);
  const form = document.createElement('form');
  form.hidden = true;
  form.style.display = 'none';
  form.style.gap = '12px';
  form.setAttribute('aria-label', 'Account sign-in');
  const formHeading = document.createElement('h4');
  const field = (label: string, type: string, autocomplete: 'off' | 'new-password') => {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    wrapper.style.display = 'grid';
    wrapper.style.gap = '6px';
    const input = document.createElement('input');
    input.type = type;
    input.autocomplete = autocomplete;
    input.style.minHeight = '44px';
    input.style.width = '100%';
    input.style.padding = '12px';
    input.style.border = '1px solid var(--line)';
    input.style.borderRadius = '9px';
    input.style.background = 'var(--panel)';
    input.style.color = 'inherit';
    input.required = true;
    wrapper.append(input);
    return { wrapper, input };
  };
  const name = field('Account name', 'text', 'off');
  name.input.maxLength = 160;
  const kindLabel = document.createElement('label');
  kindLabel.textContent = 'Account type';
  kindLabel.style.display = 'grid';
  kindLabel.style.gap = '6px';
  const kind = document.createElement('select');
  kind.style.minHeight = '44px';
  kind.style.width = '100%';
  kind.style.padding = '12px';
  kind.style.border = '1px solid var(--line)';
  kind.style.borderRadius = '9px';
  kind.style.background = 'var(--panel)';
  kind.style.color = 'inherit';
  kind.style.font = 'inherit';
  for (const [value, label] of [
    ['xtream', 'Xtream login'],
    ['playlist', 'Private playlist link'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kind.append(option);
  }
  kindLabel.append(kind);
  const address = field('Server address', 'url', 'off');
  address.input.maxLength = 12 * 1024;
  address.input.spellcheck = false;
  address.input.autocapitalize = 'none';
  const username = field('Username', 'text', 'off');
  username.input.maxLength = 2048;
  username.input.spellcheck = false;
  username.input.autocapitalize = 'none';
  const password = field('Password', 'password', 'new-password');
  password.input.maxLength = 2048;
  // Many paid providers only offer plain HTTP. Sending a sign-in that way is
  // readable on the network, so it is this account's own explicit choice.
  const plainLabel = document.createElement('label');
  plainLabel.className = 'check';
  const plain = document.createElement('input');
  plain.type = 'checkbox';
  plainLabel.append(
    plain,
    'This provider only works over HTTP (not encrypted). Your sign-in is sent unprotected.',
  );
  const checkTransport = () => {
    const insecure = /^http:\/\//iu.test(address.input.value.trim());
    address.input.setCustomValidity(
      insecure && !plain.checked
        ? 'This address uses HTTP. Tick the HTTP box below to allow this provider.'
        : '',
    );
  };
  const formHelp = document.createElement('p');
  const linkHint = document.createElement('p');
  linkHint.setAttribute('role', 'status');
  linkHint.textContent =
    'This looks like a playlist link. Choose "Private playlist" above; your link is kept.';
  linkHint.hidden = true;
  const save = button('Save sign-in', 'save');
  save.className = 'primary';
  save.type = 'submit';
  const cancel = button('Cancel', 'cancel');
  const formActions = document.createElement('div');
  formActions.className = 'dialog-actions';
  formActions.append(save, cancel);
  form.append(
    formHeading,
    name.wrapper,
    kindLabel,
    address.wrapper,
    linkHint,
    username.wrapper,
    password.wrapper,
    plainLabel,
    formHelp,
    formActions,
  );
  root.append(heading, help, toolbar, list, form, status);
  container.append(root);

  let accounts: AccountMetadata[] = [];
  let editing: AccountMetadata | null = null;
  let removing: string | null = null;
  let disposed = false;
  let work: Promise<void> | null = null;
  let owner: AbortController | null = null;
  let suspension: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  let focusAfterWork: HTMLButtonElement | null = null;
  /** A channel import keeps running when Settings closes (not when the app is hidden). */
  let importing = false;
  const available = () => !disposed && !suspension && host.available?.() !== false;
  const live = (owned: AbortController) => !disposed && !owned.signal.aborted && owner === owned;
  const clearSecrets = () => {
    address.input.value = username.input.value = password.input.value = '';
    address.input.setCustomValidity('');
  };
  function closeForm() {
    clearSecrets();
    name.input.value = '';
    editing = null;
    form.hidden = true;
    form.style.display = 'none';
    removing = null;
  }
  /** `reset` clears entries when the form opens; switching the account type
   *  keeps what was typed (the address field serves both types, and a playlist
   *  save never reads the hidden username/password). */
  function showFields(reset = true) {
    if (reset) clearSecrets();
    const xtream = kind.value === 'xtream';
    address.wrapper.firstChild!.textContent = xtream ? 'Server address' : 'Private playlist URL';
    address.input.placeholder = xtream
      ? 'http://provider.example:8080'
      : 'https://provider.example/playlist';
    username.wrapper.hidden = password.wrapper.hidden = !xtream;
    username.wrapper.style.display = password.wrapper.style.display = xtream ? 'grid' : 'none';
    username.input.required = password.input.required = xtream;
    formHelp.textContent = editing
      ? 'Re-enter the complete sign-in to update this account. Saved credentials are never shown.'
      : 'Enter the address exactly as your provider gave it, including any port. Saving does not import channels; use Refresh channels next.';
    hintLinkType();
  }
  /** A whole get.php link typed under Xtream: say which type fits, and that
   *  switching keeps it. */
  function hintLinkType() {
    const link =
      /get\.php\?/iu.test(address.input.value) && /username=/iu.test(address.input.value);
    linkHint.hidden = !(kind.value === 'xtream' && link);
  }
  function busy() {
    const blocked = !!work || !available();
    for (const node of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button, input, select'))
      node.disabled = blocked && node !== cancel && node !== cancelActivity;
    cancelActivity.hidden = !work;
    cancel.textContent = work ? 'Cancel request' : 'Cancel';
    root.setAttribute('aria-busy', String(!!work));
  }
  /** The account's live buffering, saved natively and used from the next channel start. */
  function bufferChoice(accountId: string): HTMLElement {
    const label = document.createElement('label');
    label.textContent = 'Live buffer';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Live buffer');
    select.dataset.bufferAccount = accountId;
    for (const [value, text] of [
      ['fast', 'Fast start (quick channel changes)'],
      ['balanced', 'Balanced (default)'],
      ['smooth', 'Extra smooth (unsteady connections)'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = viewingSettings.bufferFor(accountId);
    const note = document.createElement('small');
    note.textContent = 'Applies from the next channel you start.';
    select.addEventListener('change', () => {
      note.textContent = 'Saving…';
      viewingSettings.setBuffer(accountId, select.value as PlaybackBuffer).then(
        () => {
          note.textContent = 'Saved. Applies from the next channel you start.';
        },
        (error: unknown) => {
          select.value = viewingSettings.bufferFor(accountId);
          note.textContent = error instanceof Error ? error.message : 'This could not be saved.';
        },
      );
    });
    label.append(select, note);
    label.style.display = 'grid';
    label.style.gap = '4px';
    return label;
  }
  function render() {
    if (disposed) return;
    const fragment = document.createDocumentFragment();
    for (const account of accounts) {
      const row = document.createElement('article');
      row.dataset.accountId = account.id;
      row.style.padding = '14px 0';
      const title = document.createElement('h4');
      title.textContent = account.name;
      const detail = document.createElement('p');
      detail.textContent = `${account.kind === 'xtream' ? 'Xtream login' : 'Private playlist'} · ${account.requiresSignIn ? 'Sign-in needed on this device' : 'Sign-in saved on this device'}${account.allowHttp ? ' · Unencrypted HTTP' : ''}`;
      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      if (removing === account.id) {
        const explanation = document.createElement('p');
        explanation.textContent =
          'Remove this saved sign-in? Existing channels remain in your library.';
        actions.append(button('Remove sign-in', 'confirm-remove'), button('Keep account', 'keep'));
        row.append(title, detail, explanation, actions);
      } else {
        actions.append(button(account.requiresSignIn ? 'Sign in again' : 'Edit sign-in', 'edit'));
        if (host.refresh && !account.requiresSignIn)
          actions.append(button('Refresh channels', 'refresh'));
        if (host.browse && !account.requiresSignIn)
          actions.append(button('Watch channels', 'browse'));
        actions.append(button('Remove', 'remove'));
        row.append(title, detail, bufferChoice(account.id), actions);
      }
      fragment.append(row);
    }
    if (!accounts.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No saved accounts. Add your provider sign-in or private playlist link.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    busy();
  }
  function start(
    message: string,
    operation: (owned: AbortController) => Promise<void>,
    failure = 'This account request could not finish. Check the sign-in and HTTPS address, then try again.',
  ): Promise<void> {
    if (work || !available()) return work ?? Promise.resolve();
    const owned = new AbortController();
    const previouslyFocused = document.activeElement;
    const wasInAccountUi =
      previouslyFocused instanceof HTMLElement && root.contains(previouslyFocused);
    owner = owned;
    status.textContent = message;
    const task = Promise.resolve()
      .then(() => {
        owned.signal.throwIfAborted();
        return operation(owned);
      })
      .catch(() => {
        if (live(owned)) status.textContent = failure;
      })
      .finally(() => {
        if (work !== task) return;
        work = null;
        owner = null;
        if (!disposed) {
          render();
          busy();
          if (focusAfterWork && !focusAfterWork.disabled && document.visibilityState === 'visible')
            focusAfterWork.focus({ preventScroll: true });
          else if (
            wasInAccountUi &&
            previouslyFocused &&
            !previouslyFocused.isConnected &&
            document.activeElement === document.body &&
            document.visibilityState === 'visible' &&
            !add.disabled
          )
            add.focus({ preventScroll: true });
        }
        focusAfterWork = null;
      });
    work = task;
    busy();
    return task;
  }
  async function update(): Promise<void> {
    await start(
      'Loading saved accounts…',
      async (owned) => {
        const rows = await vault.list(owned.signal);
        if (!live(owned)) return;
        accounts = rows;
        status.textContent =
          'Saved sign-ins are stored on this device. Refresh channels when you are ready.';
        await notifyChanged(owned);
      },
      'Saved accounts could not be loaded. Reload accounts and try again.',
    );
  }
  async function notifyChanged(owned: AbortController): Promise<void> {
    if (!host.changed || disposed) return;
    try {
      await host.changed();
    } catch {
      // A host refresh failure cannot turn an already committed account write
      // into an alleged save/remove failure or reflect an arbitrary error string.
      if (live(owned))
        status.textContent =
          'Saved accounts changed. Reload accounts to update the channel picker.';
    }
  }
  function openForm(account: AccountMetadata | null) {
    if (work || !available()) return;
    closeForm();
    editing = account;
    name.input.value = account?.name ?? '';
    kind.value = account?.kind ?? 'xtream';
    plain.checked = account?.allowHttp ?? false;
    formHeading.textContent = account ? 'Update sign-in' : 'Add an account';
    showFields();
    form.hidden = false;
    form.style.display = 'grid';
    render();
    name.input.focus();
  }
  async function suspend(): Promise<void> {
    if (suspension) return suspension;
    owner?.abort();
    closeForm();
    const pending = work;
    const joined = Promise.resolve(pending)
      .then(() => {
        if (!disposed)
          status.textContent = 'Request closed. Reload accounts to review saved sign-ins.';
      })
      .finally(() => {
        if (suspension === joined) suspension = null;
        if (!disposed) {
          render();
          busy();
          if (
            document.visibilityState === 'visible' &&
            (!dialog || dialog.open) &&
            (form.contains(document.activeElement) || document.activeElement === cancelActivity) &&
            !add.disabled
          )
            add.focus({ preventScroll: true });
        }
      });
    suspension = joined;
    busy();
    return joined;
  }
  const click = (event: MouseEvent) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('button[data-account-action]')
        : null;
    if (!target || !root.contains(target)) return;
    const action = target.dataset.accountAction;
    if (action === 'cancel') {
      void suspend();
      return;
    }
    if (work || !available()) return;
    const id = target.closest<HTMLElement>('[data-account-id]')?.dataset.accountId;
    const selected = accounts.find((row) => row.id === id);
    const account = selected ? { ...selected } : undefined;
    if (action === 'add') openForm(null);
    else if (action === 'reload') void update();
    else if (action === 'edit' && account) openForm(account);
    else if (action === 'remove' && account) {
      closeForm();
      removing = account.id;
      render();
      list.querySelector<HTMLButtonElement>('[data-account-action="confirm-remove"]')?.focus();
    } else if (action === 'keep') {
      removing = null;
      render();
      add.focus();
    } else if (action === 'confirm-remove' && account) {
      void start(
        'Removing saved sign-in…',
        async (owned) => {
          const receipt = await vault.remove(
            { schemaVersion: 1, accountId: account.id, expectedRevision: account.revision },
            owned.signal,
          );
          accounts = accounts.filter((row) => row.id !== account.id);
          removing = null;
          if (live(owned)) focusAfterWork = add;
          if (live(owned))
            status.textContent = receipt.cleanupPending
              ? 'Sign-in removed. Device cleanup will finish later. Existing channels remain in your library.'
              : 'Sign-in removed. Existing channels remain in your library.';
          await notifyChanged(owned);
        },
        'The saved sign-in could not be removed. Reload accounts and try again.',
      );
    } else if (action === 'refresh' && account && host.refresh) {
      closeForm();
      void start(
        'Importing this account’s channels… You can close Settings; the import continues.',
        async (owned) => {
          importing = true;
          let skipped: number;
          try {
            skipped = (await host.refresh!(account, owned.signal))?.skipped ?? 0;
          } catch (error) {
            if (dialog && !dialog.open && !owned.signal.aborted)
              host.notice?.(`${account.name}: channels could not be imported. Try Refresh again.`);
            throw error;
          } finally {
            importing = false;
          }
          const leftOut = skipped
            ? ` ${skipped.toLocaleString()} unusable ${skipped === 1 ? 'entry was' : 'entries were'} left out.`
            : '';
          if (dialog && !dialog.open)
            host.notice?.(`${account.name}: channels imported.${leftOut}`);
          if (live(owned))
            status.textContent = `Channel refresh finished.${leftOut} Review its results in your channel library.`;
        },
        'Channels could not be refreshed. Check your sign-in and network, then try again.',
      );
    } else if (action === 'browse' && account && !account.requiresSignIn && host.browse) {
      closeForm();
      void start(
        'Opening this account’s channels…',
        async (owned) => {
          await host.browse!(account, owned.signal);
          if (live(owned)) status.textContent = 'Account channels are ready to browse.';
        },
        'Account channels could not be opened. Refresh channels or sign in again, then try again.',
      );
    }
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    checkTransport();
    if (work || !available() || form.hidden || !form.reportValidity()) return;
    const base = {
      schemaVersion: 1 as const,
      name: name.input.value,
      allowHttp: plain.checked,
      ...(editing ? { accountId: editing.id, expectedRevision: editing.revision } : {}),
    };
    const request: AccountSaveRequest =
      kind.value === 'xtream'
        ? {
            ...base,
            kind: 'xtream',
            serverUrl: address.input.value,
            username: username.input.value,
            password: password.input.value,
          }
        : { ...base, kind: 'playlist', playlistUrl: address.input.value };
    clearSecrets();
    void start('Saving sign-in on this device…', async (owned) => {
      const receipt = await vault.save(request, owned.signal);
      accounts = [...accounts.filter((row) => row.id !== receipt.metadata.id), receipt.metadata];
      if (live(owned)) {
        closeForm();
        focusAfterWork = add;
        status.textContent = receipt.cleanupPending
          ? 'Sign-in saved. Device cleanup will finish later. Refresh channels when you are ready.'
          : 'Sign-in saved. Refresh channels when you are ready. No channels were imported by this save.';
      }
      await notifyChanged(owned);
    });
  };
  const visibility = () => {
    if (document.visibilityState !== 'visible') void suspend();
  };
  const changeKind = () => {
    showFields(false);
    checkTransport();
  };
  const typedAddress = () => {
    checkTransport();
    hintLinkType();
  };
  root.addEventListener('click', click);
  form.addEventListener('submit', submit);
  kind.addEventListener('change', changeKind);
  address.input.addEventListener('input', typedAddress);
  plain.addEventListener('change', checkTransport);
  document.addEventListener('visibilitychange', visibility);
  const dialog = container.closest('dialog');
  const close = () => {
    if (importing && work) {
      closeForm();
      return;
    }
    void suspend();
  };
  dialog?.addEventListener('close', close);
  // Stored buffer choices may arrive after the cards are drawn.
  const unsubscribeBuffers = viewingSettings.subscribe(() => {
    for (const select of root.querySelectorAll<HTMLSelectElement>('select[data-buffer-account]'))
      select.value = viewingSettings.bufferFor(select.dataset.bufferAccount!);
  });
  render();
  void update();
  return {
    update,
    suspend,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      root.removeEventListener('click', click);
      form.removeEventListener('submit', submit);
      kind.removeEventListener('change', changeKind);
      address.input.removeEventListener('input', typedAddress);
      plain.removeEventListener('change', checkTransport);
      document.removeEventListener('visibilitychange', visibility);
      dialog?.removeEventListener('close', close);
      unsubscribeBuffers();
      disposal = suspend().then(() => {
        accounts = [];
        root.remove();
      });
      return disposal;
    },
  };
}
