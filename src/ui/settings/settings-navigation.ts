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

/** A compact settings selector keeps secondary workflows out of the viewing screen. */
export function mountSettingsNavigation(dialog: HTMLDialogElement): () => void {
  const heading = [...dialog.querySelectorAll('h3')];
  const sources = heading.find((node) => node.textContent === 'Your sources');
  const advanced = heading.find((node) => node.textContent === 'Advanced');
  const backup = heading.find((node) => node.textContent === 'Backup and migration');
  const discovery = heading.find((node) => node.textContent === 'Find channels');
  const sharing = dialog.querySelector<HTMLElement>('#sharing-settings');
  const migration = [...dialog.querySelectorAll<HTMLElement>('details')].find(
    (node) => node.querySelector('summary')?.textContent === 'Import from the previous app',
  );
  if (!sources || !advanced || !backup || !discovery || !sharing || !migration)
    throw new Error('Settings layout is incomplete.');
  const data = backup.previousElementSibling?.previousElementSibling;
  if (!(data instanceof HTMLElement)) throw new Error('Settings data layout is incomplete.');
  const selector = document.createElement('button');
  selector.type = 'button';
  selector.id = 'settings-section';
  selector.setAttribute('aria-label', 'Settings section');
  selector.setAttribute('aria-expanded', 'false');
  selector.setAttribute('aria-controls', 'settings-section-choices');
  const label = document.createElement('div');
  label.className = 'settings-selector';
  label.append(selector);
  const choices = document.createElement('div');
  choices.id = 'settings-section-choices';
  choices.className = 'settings-section-choices';
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Settings sections');
  choices.hidden = true;

  let selected = 'sources';
  let disposed = false;
  const groups = [
    ['sources', 'Sources', sources, advanced],
    ['advanced', 'Advanced', advanced, data],
    ['preferences', 'Settings backup', data, backup],
    ['data', 'Full backup', backup, migration],
    ['migration', 'Import previous app', migration, discovery],
    ['discovery', 'Find channels', discovery, sharing],
    ['sharing', 'LAN viewing and phone control', sharing, sharing.nextElementSibling],
  ] as const;
  const panels: HTMLElement[] = [];
  for (const [id, title, first, end] of groups) {
    const panel = document.createElement('section');
    panel.dataset.settingsPanel = id;
    panel.setAttribute('aria-label', title);
    let node: Element | null = first;
    while (node && node !== end) {
      const next: Element | null = node.nextElementSibling;
      panel.append(node);
      node = next;
    }
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.settingsSection = id;
    option.textContent = title;
    choices.append(option);
    panels.push(panel);
  }
  dialog.querySelector('.dialog-head')!.insertAdjacentElement('afterend', label);
  label.after(choices, ...panels);
  const storage = dialog.querySelector('#storage-status');
  if (storage) panels[0]!.append(storage);
  const setExpanded = (expanded: boolean, restoreFocus = false) => {
    if (disposed) return;
    choices.hidden = !expanded;
    selector.setAttribute('aria-expanded', String(expanded));
    change();
    if (!expanded && restoreFocus) selector.focus({ preventScroll: true });
  };
  const change = () => {
    for (const panel of panels)
      panel.hidden = !choices.hidden || panel.dataset.settingsPanel !== selected;
    const options = [...choices.querySelectorAll<HTMLButtonElement>('button')];
    for (const option of options)
      option.setAttribute('aria-current', String(option.dataset.settingsSection === selected));
    const current = options.find((option) => option.dataset.settingsSection === selected)!;
    selector.textContent = `${current.textContent} \u25be`;
  };
  const toggle = () => {
    setExpanded(choices.hidden === true);
    if (!choices.hidden) choices.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
  };
  const choose = (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-settings-section]',
    );
    if (!target || !choices.contains(target)) return;
    selected = target.dataset.settingsSection!;
    change();
    setExpanded(false, true);
  };
  const keydown = (event: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    if (choices.hidden) return;
    const options = [...choices.querySelectorAll<HTMLButtonElement>('button')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : index < 0
            ? options.findIndex((option) => option.dataset.settingsSection === selected)
            : Math.min(
                options.length - 1,
                Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
              );
    event.preventDefault();
    event.stopPropagation();
    options[Math.max(0, next)]?.focus();
  };
  const cancel = (event: Event) => {
    if (choices.hidden) return;
    event.preventDefault();
    setExpanded(false, true);
  };
  const close = () => setExpanded(false);
  selector.addEventListener('click', toggle);
  choices.addEventListener('click', choose);
  label.addEventListener('keydown', keydown);
  choices.addEventListener('keydown', keydown);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', close);
  change();
  return () => {
    if (disposed) return;
    setExpanded(false);
    disposed = true;
    selector.removeEventListener('click', toggle);
    choices.removeEventListener('click', choose);
    label.removeEventListener('keydown', keydown);
    choices.removeEventListener('keydown', keydown);
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('close', close);
  };
}

export function mountLocationDialog(container: HTMLElement): () => void {
  const details = container.closest('details');
  if (!details) throw new Error('Location controls layout is incomplete.');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'location-trigger';
  // Short on screen so the channel row fits: Favs | VOD | Loc & Sort | Guide.
  trigger.textContent = 'Loc & Sort';
  trigger.setAttribute('aria-label', 'Location and sort');
  trigger.title = 'Location and sort';
  const dialog = document.createElement('dialog');
  dialog.className = 'location-dialog';
  dialog.setAttribute('aria-label', 'Location and sort');
  const title = document.createElement('h2');
  title.textContent = 'Location and sort';
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => dialog.close());
  dialog.append(title, container, done);
  details.replaceWith(trigger);
  document.body.append(dialog);
  // The dialog's scrolling body must not take focus itself (Chromium makes
  // scrollers focusable): the remote starts on the first control.
  container.tabIndex = -1;
  const open = () => {
    dialog.showModal();
    // TV replaces each select with its own button; take the first one shown.
    [...container.querySelectorAll<HTMLElement>('select, button, input')]
      .find((control) => !control.matches(':disabled') && control.checkVisibility())
      ?.focus();
  };
  trigger.addEventListener('click', open);
  return () => {
    trigger.removeEventListener('click', open);
    dialog.remove();
  };
}
