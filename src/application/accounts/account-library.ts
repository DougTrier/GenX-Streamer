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
  validateAccountList,
  type AccountMetadata,
} from '../../platform/account-vault';
import {
  createAccountCatalog,
  validateAccountCatalogRefreshReceipt,
  validateAccountChannelPage,
  type AccountCatalogFence,
  type AccountCatalogRefreshReceipt,
  type AccountChannel,
  type AccountChannelPageRequest,
} from '../../platform/account-catalog';
import type { BrowserChannel } from '../../ui/channels/channel-browser';

const PAGE = 64;
const ANCHORS = 64;
const MAX_CHANNELS = 100_000;
export interface AccountLibraryWindow {
  startIndex: number;
  channels: readonly BrowserChannel[];
  fence: Readonly<AccountCatalogFence> | null;
  nextAfterId: string | null;
}
export interface AccountLibraryState {
  accounts: readonly Readonly<AccountMetadata>[];
  selectedAccount: Readonly<AccountMetadata> | null;
  window: Readonly<AccountLibraryWindow>;
  /** null means native total has not been observed; cached rows are not a total. */
  count: number | null;
  loading: boolean;
  error: string | null;
}
export interface AccountLibrarySelection {
  channel: Readonly<AccountChannel>;
  fence: Readonly<AccountCatalogFence>;
}
export interface AccountLibraryOptions {
  vault?: Pick<ReturnType<typeof createAccountVault>, 'list'>;
  catalog?: Pick<ReturnType<typeof createAccountCatalog>, 'page' | 'refresh'>;
  changed?(state: AccountLibraryState): void;
}
export interface AccountWindowRequest {
  startIndex: number;
  limit?: number;
}
/** A distant jump needs another bounded read, not an unbounded metadata walk.
 * Retrying the same requested index continues from retained keyset anchors. */
export class AccountWindowPendingError extends Error {
  readonly code = 'account-window-pending';
  constructor(readonly resumeIndex: number) {
    super('Account channel window is still loading.');
    this.name = 'AccountWindowPendingError';
  }
}
interface Episode {
  generation: number;
  signal: AbortSignal;
}
const canceled = () => new DOMException('Account channel reading was canceled.', 'AbortError');
const browserRow = (row: AccountChannel, accountId: string): BrowserChannel => ({
  id: row.id,
  name: row.name,
  category: row.category,
  sourceId: `account-${accountId}`,
  ...(row.providerId === null ? {} : { providerId: row.providerId }),
});

/** One serialized, joined native request owner; metadata only. The library
 * never acquires credentials, media URLs, or whole-account JS channel arrays. */
export class AccountLibrary {
  private readonly vault: NonNullable<AccountLibraryOptions['vault']>;
  private readonly catalog: NonNullable<AccountLibraryOptions['catalog']>;
  private accountsValue: Readonly<AccountMetadata>[] = [];
  private selected: Readonly<AccountMetadata> | null = null;
  private fence: Readonly<AccountCatalogFence> | null = null;
  private countValue: number | null = null;
  private visible: AccountLibraryWindow = {
    startIndex: 0,
    channels: [],
    fence: null,
    nextAfterId: null,
  };
  private capabilities = new Map<string, Readonly<AccountChannel>>();
  private anchors = new Map<number, string>([[0, '']]);
  private generation = 0;
  private controller: AbortController | null = null;
  private work: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loadingValue = false;
  private errorValue: string | null = null;
  constructor(private readonly options: AccountLibraryOptions = {}) {
    this.vault = options.vault ?? createAccountVault();
    this.catalog = options.catalog ?? createAccountCatalog();
  }
  get state(): AccountLibraryState {
    return Object.freeze({
      accounts: Object.freeze([...this.accountsValue]),
      selectedAccount: this.selected,
      window: Object.freeze({
        ...this.visible,
        channels: Object.freeze([...this.visible.channels]),
      }),
      count: this.countValue,
      loading: this.loadingValue,
      error: this.errorValue,
    });
  }
  get cachedChannels(): number {
    return this.capabilities.size;
  }
  /** Selection capabilities are available for the exact current window only. */
  selectionFor(id: string): AccountLibrarySelection | undefined {
    const row = this.capabilities.get(id);
    if (
      !row ||
      !this.fence ||
      !this.selected ||
      this.selected.revision !== this.fence.accountRevision ||
      this.selected.id !== this.fence.accountId
    )
      return undefined;
    return Object.freeze({ channel: row, fence: this.fence });
  }
  private notify(): void {
    // An observer cannot interrupt the actual native cancellation/join owner.
    try {
      this.options.changed?.(this.state);
    } catch {
      /* UI observer owns its error. */
    }
  }
  private active(episode: Episode): boolean {
    return !this.closed && episode.generation === this.generation && !episode.signal.aborted;
  }
  private check(episode: Episode): void {
    if (!this.active(episode)) throw canceled();
  }
  private resetWindow(): void {
    this.fence = null;
    this.countValue = null;
    this.capabilities.clear();
    this.anchors = new Map([[0, '']]);
    this.visible = { startIndex: 0, channels: [], fence: null, nextAfterId: null };
  }
  private run<T>(
    operation: (episode: Episode) => Promise<T>,
    signal?: AbortSignal,
    durable = false,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Account channel library is closed.'));
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const prior = this.work;
    const episode = { generation, signal: controller.signal };
    this.loadingValue = true;
    this.errorValue = null;
    const work = (async () => {
      // Bridges acknowledge abort only after actual native work has settled.
      await prior.catch(() => undefined);
      try {
        this.check(episode);
        const result = await operation(episode);
        // A validated actual refresh COMMIT remains a receipt even if superseded.
        if (!durable) this.check(episode);
        return result;
      } catch (error) {
        if (this.active(episode)) {
          this.errorValue =
            error instanceof AccountWindowPendingError
              ? null
              : 'Account channels could not be read. Try again.';
          if (!(error instanceof AccountWindowPendingError)) this.resetWindow();
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (generation === this.generation) {
          this.loadingValue = false;
          this.controller = null;
          this.notify();
        }
      }
    })();
    this.work = work;
    this.notify();
    return work;
  }
  /** Re-list after save/remove/sign-in changes; changed revisions revoke cached
   * stream capabilities before another viewing selection can be made. */
  loadAccounts(signal?: AbortSignal): Promise<readonly Readonly<AccountMetadata>[]> {
    return this.run(async (episode) => {
      const rows = validateAccountList(await this.vault.list(episode.signal));
      this.check(episode);
      this.accountsValue = rows.map((row) => Object.freeze({ ...row }));
      if (this.selected) {
        const current = this.accountsValue.find((row) => row.id === this.selected?.id) ?? null;
        if (
          !current ||
          current.revision !== this.selected.revision ||
          current.requiresSignIn !== this.selected.requiresSignIn
        )
          this.resetWindow();
        this.selected = current;
      }
      return Object.freeze([...this.accountsValue]);
    }, signal);
  }
  selectAccount(accountId: string | null, signal?: AbortSignal): Promise<AccountLibraryWindow> {
    if (this.closed) return Promise.reject(new Error('Account channel library is closed.'));
    const account =
      accountId === null ? null : this.accountsValue.find((row) => row.id === accountId);
    if (account === undefined)
      return Promise.reject(new Error('The account is no longer available. Reload accounts.'));
    this.selected = account;
    this.resetWindow();
    return this.run(async (episode) => {
      if (!account) {
        this.countValue = 0;
        return this.visible;
      }
      if (account.requiresSignIn)
        throw new Error('Sign in again on this device to read account channels.');
      return this.readWindow(account, { startIndex: 0, limit: PAGE }, episode);
    }, signal);
  }
  loadWindow(request: AccountWindowRequest, signal?: AbortSignal): Promise<AccountLibraryWindow> {
    const account = this.selected;
    if (!account || account.requiresSignIn)
      return Promise.reject(new Error('Select a signed-in account first.'));
    if (
      !Number.isSafeInteger(request.startIndex) ||
      request.startIndex < 0 ||
      request.startIndex > MAX_CHANNELS ||
      (request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > PAGE))
    ) {
      return Promise.reject(new Error('The account channel window request is invalid.'));
    }
    const admitted = { startIndex: request.startIndex, limit: request.limit ?? PAGE };
    return this.run((episode) => this.readWindow(account, admitted, episode), signal);
  }
  refreshSelected(signal?: AbortSignal): Promise<AccountCatalogRefreshReceipt> {
    if (this.closed) return Promise.reject(new Error('Account channel library is closed.'));
    const account = this.selected;
    if (!account || account.requiresSignIn)
      return Promise.reject(new Error('Select a signed-in account first.'));
    // Unknown late COMMIT must never leave old stream references selectable.
    this.resetWindow();
    return this.run(
      async (episode) => {
        const receipt = validateAccountCatalogRefreshReceipt(
          await this.catalog.refresh(account, episode.signal),
          account.id,
          account.revision,
        );
        if (this.active(episode)) {
          this.fence = Object.freeze({
            accountId: receipt.accountId,
            accountRevision: receipt.accountRevision,
            mediaRevision: receipt.mediaRevision,
          });
          this.countValue = receipt.channels;
          // Catalog completion is independent of a later window read failure.
          try {
            await this.readWindow(account, { startIndex: 0, limit: PAGE }, episode);
          } catch (error) {
            if (this.active(episode) && !(error instanceof AccountWindowPendingError)) {
              this.errorValue = 'Account channels were refreshed. Reload the visible channels.';
            }
          }
        }
        return receipt;
      },
      signal,
      true,
    );
  }
  private remember(index: number, afterId: string, pinned: number): void {
    this.anchors.delete(index);
    this.anchors.set(index, afterId);
    while (this.anchors.size > ANCHORS) {
      const oldest = [...this.anchors.keys()].find((key) => key !== 0 && key !== pinned);
      if (oldest === undefined) break;
      this.anchors.delete(oldest);
    }
  }
  private async readWindow(
    account: Readonly<AccountMetadata>,
    request: AccountWindowRequest,
    episode: Episode,
  ): Promise<AccountLibraryWindow> {
    this.check(episode);
    const limit = request.limit ?? PAGE;
    const startIndex = request.startIndex;
    let index = 0;
    let afterId = '';
    for (const [anchor, cursor] of this.anchors) {
      if (anchor <= startIndex && anchor >= index) {
        index = anchor;
        afterId = cursor;
      }
    }
    let pinnedAnchor = index;
    const selected: AccountChannel[] = [];
    let terminal = false;
    for (let calls = 0; calls < PAGE; calls++) {
      this.check(episode);
      const input: AccountChannelPageRequest = {
        schemaVersion: 1,
        accountId: account.id,
        expectedAccountRevision: account.revision,
        expectedMediaRevision: this.fence?.mediaRevision ?? null,
        afterId,
        limit: PAGE,
      };
      const page = validateAccountChannelPage(
        await this.catalog.page(input, episode.signal),
        input,
      );
      this.check(episode);
      if (this.selected?.id !== account.id || this.selected.revision !== account.revision)
        throw canceled();
      const fence = Object.freeze({
        accountId: page.accountId,
        accountRevision: page.accountRevision,
        mediaRevision: page.mediaRevision,
      });
      if (
        this.fence &&
        (this.fence.accountId !== fence.accountId ||
          this.fence.accountRevision !== fence.accountRevision ||
          this.fence.mediaRevision !== fence.mediaRevision)
      ) {
        this.resetWindow();
        throw new Error('Account channels changed. Reload the account channel window.');
      }
      this.fence = fence;
      if (index + page.channels.length > MAX_CHANNELS)
        throw new Error('The account catalog exceeds its channel limit.');
      for (let offset = 0; offset < page.channels.length; offset++) {
        const ordinal = index + offset;
        if (ordinal >= startIndex && selected.length < limit) selected.push(page.channels[offset]!);
      }
      index += page.channels.length;
      terminal = page.nextAfterId === null;
      if (terminal) {
        if (this.countValue !== null && this.countValue !== index) {
          this.resetWindow();
          throw new Error('Account channel count changed. Reload the account channel window.');
        }
        this.countValue = index;
      } else {
        if (!page.channels.length || !page.nextAfterId)
          throw new Error('The account channel cursor did not advance.');
        afterId = page.nextAfterId;
        if (index <= startIndex) pinnedAnchor = index;
        this.remember(index, afterId, pinnedAnchor);
      }
      if (selected.length === limit || terminal) break;
    }
    this.check(episode);
    if (selected.length < limit && !terminal) throw new AccountWindowPendingError(index);
    this.capabilities.clear();
    const channels = selected.map((row) => {
      const channel = Object.freeze({ ...row });
      this.capabilities.set(channel.id, channel);
      return Object.freeze(browserRow(channel, account.id));
    });
    // A native page can extend beyond the requested visible window. Never use
    // its terminal cursor to skip metadata that the visible window did not read.
    const endIndex = startIndex + channels.length;
    const nextAfterId =
      channels.length && (this.countValue === null || endIndex < this.countValue)
        ? channels.at(-1)!.id
        : null;
    this.visible = Object.freeze({
      startIndex,
      channels: Object.freeze(channels),
      fence: this.fence,
      nextAfterId,
    });
    return this.visible;
  }
  /** Immediate invalidation followed by actual join; use for background,
   * subscription mutation, root changes and close before acknowledging cleanup. */
  async invalidate(): Promise<void> {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.resetWindow();
    this.loadingValue = false;
    this.errorValue = null;
    this.notify();
    await this.work.catch(() => undefined);
  }
  async dispose(): Promise<void> {
    if (this.closed) {
      await this.work.catch(() => undefined);
      return;
    }
    this.closed = true;
    await this.invalidate();
    this.accountsValue = [];
    this.selected = null;
    this.notify();
  }
}
