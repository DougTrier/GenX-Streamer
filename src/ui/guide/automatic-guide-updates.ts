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

export interface AutomaticGuideUpdatesHost {
  automaticGuideUpdates?: boolean;
  /** Resolution confirms that the preference was saved. */
  save(value: boolean): Promise<void>;
}

/** Adds an ordinary checkbox to the existing Advanced settings section. */
export function mountAutomaticGuideUpdates(
  dialog: HTMLDialogElement,
  host: AutomaticGuideUpdatesHost,
) {
  const anchor = dialog.querySelector('#advanced-guide-button');
  if (!anchor) throw new Error('Program guide settings are unavailable.');
  const label = document.createElement('label');
  label.className = 'check';
  label.style.minHeight = '44px';
  const input = document.createElement('input');
  input.id = 'automatic-guide-updates';
  input.type = 'checkbox';
  input.style.minWidth = '44px';
  input.style.minHeight = '44px';
  const text = document.createTextNode('Update program guides automatically');
  label.append(input, text);
  const help = document.createElement('p');
  help.id = 'automatic-guide-updates-help';
  help.textContent = 'You can still refresh program guides manually in Program guide settings.';
  input.setAttribute('aria-describedby', help.id);
  const status = document.createElement('p');
  status.id = 'automatic-guide-updates-status';
  status.setAttribute('role', 'status');
  anchor.before(label, help, status);

  let acknowledged = host.automaticGuideUpdates ?? true;
  let disposed = false;
  let pending: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  input.checked = acknowledged;
  const change = () => {
    if (disposed || pending) {
      input.checked = acknowledged;
      return;
    }
    const requested = input.checked;
    input.disabled = true;
    status.textContent = 'Saving program guide preference…';
    const work = Promise.resolve()
      .then(() => host.save(requested))
      .then(
        () => {
          acknowledged = requested;
          if (!disposed) status.textContent = 'Program guide preference saved.';
        },
        () => {
          if (!disposed)
            status.textContent = 'The preference could not be saved. Try again when ready.';
        },
      )
      .finally(() => {
        if (pending === work) pending = null;
        input.checked = acknowledged;
        input.disabled = disposed;
      });
    pending = work;
  };
  input.addEventListener('change', change);
  return {
    update(value: boolean = true): void {
      if (disposed) return;
      if (typeof value !== 'boolean') throw new Error('The program guide preference is invalid.');
      acknowledged = value;
      input.checked = value;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      input.disabled = true;
      input.removeEventListener('change', change);
      disposal = Promise.resolve(pending).then(() => {
        label.remove();
        help.remove();
        status.remove();
      });
      return disposal;
    },
  };
}
