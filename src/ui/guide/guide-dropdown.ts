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

let guideDropdownId = 0;

/** What this part reads from, and writes back to, mountGuide. */
export interface GuideDropdownEnvironment {
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
}

/**
 * The guide's source dropdown. Part of mountGuide.
 */
export function createGuideDropdown(env: GuideDropdownEnvironment) {
  const dropdown = (label: string, choices: readonly (readonly [string, string])[]) => {
    const wrapper = document.createElement('div') as HTMLDivElement & {
      value: string;
      disabled: boolean;
    };
    wrapper.className = 'guide-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.id = `guide-choice-${++guideDropdownId}`;
    trigger.setAttribute('aria-controls', menu.id);
    menu.className = 'guide-dropdown-options';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label + ' choices');
    menu.hidden = true;
    let value = choices[0]![0];
    const close = (restore = false) => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restore) trigger.focus();
    };
    const options = choices.map(([key, name]) => {
      const option = env.button(name, () => {
        wrapper.value = key;
        close(true);
        wrapper.dispatchEvent(new Event('change'));
      });
      option.setAttribute('role', 'option');
      option.dataset.value = key;
      menu.append(option);
      return option;
    });
    const update = () => {
      trigger.textContent = choices.find(([key]) => key === value)?.[1] ?? label;
      options.forEach((option) =>
        option.setAttribute('aria-selected', String(option.dataset.value === value)),
      );
    };
    Object.defineProperties(wrapper, {
      value: {
        get: () => value,
        set: (next: string) => {
          if (choices.some(([key]) => key === next)) {
            value = next;
            close();
            update();
          }
        },
      },
      disabled: {
        get: () => trigger.disabled,
        set: (disabled: boolean) => {
          trigger.disabled = disabled;
          options.forEach((option) => (option.disabled = disabled));
          if (disabled) close();
        },
      },
    });
    const open = () => {
      if (trigger.disabled) return;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const available = options.filter((option) => !option.hidden);
      (available.find((option) => option.dataset.value === value) ?? available[0])?.focus();
    };
    trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      // Closed selectors are navigation controls. Only explicit OK/click opens choices.
      if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const available = options.filter((option) => !option.hidden);
      const current = available.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? available.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) %
              available.length;
      available[index]?.focus();
    });
    wrapper.addEventListener('focusout', (event) => {
      if (!wrapper.contains(event.relatedTarget as Node | null)) close();
    });
    wrapper.addEventListener('guide-dropdown-close', () => close(true));
    wrapper.append(trigger, menu);
    update();
    return wrapper;
  };
  return {
    dropdown,
  };
}
