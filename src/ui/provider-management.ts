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

import { validateProviderRegistry, type ProviderRegistry } from '../discovery/provider-registry';

export type ProviderKind = 'channel' | 'guide';
export interface ProviderManagementHost {
  read(): ProviderRegistry;
  /** Remove this ID from the latest preferences atomically; retain saved channels and guides. */
  remove(kind: ProviderKind, id: string, signal: AbortSignal): Promise<boolean>;
}

/** Editable suggestions only: no acquisitions and no deletion of saved source records. */
export function mountProviderManagement(container: HTMLElement, host: ProviderManagementHost) {
  const root = document.createElement('section');
  root.setAttribute('aria-label', 'Discovery providers');
  const help = document.createElement('p');
  help.textContent =
    'Remove suggestions you no longer want to scan. Saved channels and program guides are kept.';
  const lists = document.createElement('div');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  root.append(help, lists, status);
  container.append(root);
  let disposed = false;
  let work: Promise<void> | null = null;
  let controller: AbortController | null = null;

  function update() {
    if (disposed || work) return;
    const registry = validateProviderRegistry(host.read());
    const fragment = document.createDocumentFragment();
    for (const kind of ['channel', 'guide'] as const) {
      const heading = document.createElement('h4');
      heading.textContent = kind === 'channel' ? 'Channel providers' : 'Program guide providers';
      const entries =
        kind === 'channel' ? registry.reviewedChannelProviders : registry.reviewedGuideProviders;
      const list = document.createElement('ul');
      list.setAttribute('aria-label', heading.textContent);
      list.style.maxHeight = '240px';
      list.style.overflow = 'auto';
      for (const entry of entries) {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = entry.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.style.minWidth = '44px';
        remove.style.minHeight = '44px';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${kind} provider ${entry.name}`);
        remove.dataset.providerId = entry.id;
        remove.dataset.providerKind = kind;
        remove.addEventListener('click', () => start(kind, entry.id));
        row.append(name, remove);
        list.append(row);
      }
      if (!entries.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No discovery providers configured.';
        list.append(empty);
      }
      fragment.append(heading, list);
    }
    lists.replaceChildren(fragment);
  }

  function start(kind: ProviderKind, id: string) {
    if (disposed || work) return;
    const owned = new AbortController();
    controller = owned;
    const focused = document.activeElement;
    const buttons = [...lists.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.findIndex((button) => button === focused);
    for (const button of buttons) button.disabled = true;
    status.textContent = 'Removing provider…';
    const task = Promise.resolve()
      .then(() => host.remove(kind, id, owned.signal))
      .then((saved) => {
        if (!disposed && !owned.signal.aborted)
          status.textContent = saved
            ? 'Provider removed. Saved channels and guides are kept.'
            : 'Provider could not be removed. Try again.';
      })
      .catch(() => {
        if (!disposed && !owned.signal.aborted)
          status.textContent = 'Provider could not be removed. Try again.';
      })
      .finally(() => {
        if (work !== task) return;
        work = null;
        controller = null;
        if (disposed) return;
        update();
        if (
          index >= 0 &&
          (document.activeElement === focused || document.activeElement === document.body)
        ) {
          const next = [...lists.querySelectorAll<HTMLButtonElement>('button')];
          if (next.length) next[Math.min(index, next.length - 1)].focus({ preventScroll: true });
          else {
            status.tabIndex = -1;
            status.focus({ preventScroll: true });
          }
        }
      });
    work = task;
  }
  async function suspend() {
    controller?.abort();
    await work;
  }
  update();
  return {
    update,
    suspend,
    async dispose() {
      if (disposed) {
        await work;
        return;
      }
      disposed = true;
      await suspend();
      root.remove();
    },
  };
}
