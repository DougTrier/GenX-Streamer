import type { AccountMetadata } from '../platform/account-vault';
import { mountAccountVod, type AccountVodHost } from './account-vod';

/**
 * Free TV (public channels) and Paid TV (signed-in provider accounts) are
 * separate libraries of the same Live TV page, so the two never mix. Paid TV
 * reopens the last account used; with more than one account a picker chooses
 * between them. With no usable account, Paid TV opens the account sign-in form.
 */
export interface LibrarySwitcherHost {
  list(signal: AbortSignal): Promise<AccountMetadata[]>;
  ready(): boolean;
  selected(): AccountMetadata | null;
  /** Switch the channel list to one account, or to the public channels (null). */
  select(account: AccountMetadata | null): Promise<void>;
  /** Stop playback that belongs to an account that disappeared or changed. */
  release(accountId: string): Promise<void>;
  /** Show the Live TV page (shared by both libraries). */
  showLive(): Promise<void>;
  openAccounts(): void;
  run(work: Promise<void>): void;
  /** Video On Demand for the selected Paid TV account (the provider's movies and series). */
  vod?: Omit<AccountVodHost, 'run'>;
}

export function mountLibrarySwitcher(
  host: LibrarySwitcherHost,
  elements: {
    free: HTMLButtonElement;
    paid: HTMLButtonElement;
    list: HTMLElement;
    /** The row under the category tabs that holds the Video On Demand button. */
    row?: HTMLElement | null;
    /** The channel row's Guide button: it covers the library it sits in. */
    guide?: HTMLElement | null;
  },
) {
  const vod =
    host.vod && elements.row && document.getElementById('screen')
      ? mountAccountVod(
          { ...host.vod, run: host.run },
          { row: elements.row, list: elements.list, stage: document.getElementById('screen')! },
        )
      : null;
  const label = document.createElement('label');
  label.id = 'account-library';
  label.textContent = 'Paid TV account';
  const picker = document.createElement('select');
  picker.setAttribute('aria-label', 'Paid TV account');
  picker.style.minHeight = '44px';
  label.append(picker);
  elements.list.before(label);
  let accounts: AccountMetadata[] = [];
  let lastPaid: string | null = null;
  let onLive = true;
  let owner: AbortController | null = null;
  let work: Promise<void> = Promise.resolve();
  const usable = () => accounts.filter((row) => !row.requiresSignIn);
  function present(live = onLive): void {
    onLive = live;
    const paid = host.selected();
    elements.free.setAttribute('aria-pressed', String(live && !paid));
    elements.paid.setAttribute('aria-pressed', String(live && !!paid));
    const choose = live && !!paid && accounts.length > 1;
    // Shown by the stylesheet (account-vod.css), so Local and GenXtra can still hide it;
    // an inline display kept it on screen inside Local (Streamer, October 19, 2026).
    label.hidden = !choose;
    picker.value = paid?.id ?? '';
    vod?.present(live && paid ? paid : null);
    if (elements.guide) {
      const library = paid ? 'paid' : 'free';
      const name = paid ? 'Paid TV guide' : 'Free TV guide';
      elements.guide.dataset.library = library;
      elements.guide.setAttribute('aria-label', name);
      elements.guide.title = name;
    }
  }
  async function select(account: AccountMetadata | null): Promise<void> {
    await host.select(account);
    if (account) lastPaid = account.id;
    present();
  }
  function reload(): Promise<void> {
    owner?.abort();
    const owned = new AbortController();
    owner = owned;
    const task = work
      .catch(() => undefined)
      .then(async () => {
        if (!host.ready() || owned.signal.aborted) return;
        const rows = await host.list(owned.signal);
        if (owned.signal.aborted || owner !== owned) return;
        accounts = rows;
        const current = host.selected();
        if (current) {
          const latest = rows.find((row) => row.id === current.id);
          if (!latest || latest.requiresSignIn || latest.revision !== current.revision) {
            await host.release(current.id);
            await select(null);
          }
        }
        const options = document.createDocumentFragment();
        for (const account of rows) {
          const option = document.createElement('option');
          option.value = account.id;
          option.textContent = account.requiresSignIn
            ? `${account.name} · Sign in again`
            : account.name;
          option.disabled = account.requiresSignIn;
          options.append(option);
        }
        picker.replaceChildren(options);
        present();
      });
    work = task;
    void task.catch(() => undefined);
    return task;
  }
  const free = () =>
    host.run(
      (async () => {
        await host.showLive();
        if (host.selected()) await select(null);
        present(true);
      })(),
    );
  const paid = () =>
    host.run(
      (async () => {
        // Paid TV in the top bar always returns to its channel list.
        vod?.close();
        await work.catch(() => undefined);
        const rows = usable();
        if (!rows.length) {
          host.openAccounts();
          return;
        }
        await host.showLive();
        const current = host.selected();
        const target =
          (current && rows.find((row) => row.id === current.id)) ??
          rows.find((row) => row.id === lastPaid) ??
          rows[0]!;
        if (current?.id !== target.id) await select(target);
        present(true);
      })(),
    );
  const changed = () => {
    const account = usable().find((row) => row.id === picker.value) ?? null;
    if (account) host.run(select(account));
  };
  elements.free.addEventListener('click', free);
  elements.paid.addEventListener('click', paid);
  picker.addEventListener('change', changed);
  present();
  return {
    reload,
    present,
    /** Show an account's channels (from Settings), remembering it for Paid TV. */
    select,
    /** Leave Video On Demand and show the channel list again. */
    closeVod: () => vod?.close(),
    /** Remote Back inside Video On Demand; false when VOD is not open. */
    vodBack: () => vod?.back() ?? false,
    /** After a Paid TV movie stops: back to the titles, on the same poster. */
    showVodTitles: () => vod?.showTitles(),
    dispose() {
      owner?.abort();
      vod?.dispose();
      elements.free.removeEventListener('click', free);
      elements.paid.removeEventListener('click', paid);
      picker.removeEventListener('change', changed);
    },
  };
}
