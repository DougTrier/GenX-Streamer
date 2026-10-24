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

/**
 * Channels being cast, pinned above the channel list and marked with their
 * TVs' names, so they cannot get lost among thousands of channels (owner
 * request, October 24, 2026). The strip sits above the list itself, so it
 * stays on top in every view of it: all channels, search results, categories,
 * favorites and Paid TV. A pin goes when its TV's cast ends.
 */
import '../cast-pins.css';
import type { ActiveCast } from '../../casting/controller';
import type { ChannelSelection } from '../../playback/controller';

export interface CastPins {
  update(casts: readonly ActiveCast[]): void;
  dispose(): void;
}
/** Mounts the strip above `list`; choosing a pin watches that channel here too. */
export function mountCastPins(
  list: HTMLElement,
  watch: (selection: ChannelSelection) => void,
): CastPins {
  const strip = document.createElement('div');
  strip.id = 'cast-pins';
  strip.className = 'cast-pins';
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Casting to your TVs');
  strip.hidden = true;
  list.before(strip);
  let pinned: ChannelSelection[] = [];
  const click = (event: Event) => {
    const pin = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-cast-channel]');
    const selection = pinned.find((item) => item.id === pin?.dataset.castChannel);
    if (selection) watch({ ...selection });
  };
  strip.addEventListener('click', click);
  return {
    update(casts) {
      // One pin per channel, naming every TV that plays it.
      const channels = new Map<string, { selection: ChannelSelection; televisions: string[] }>();
      for (const cast of casts) {
        const entry = channels.get(cast.selection.id) ?? {
          selection: { ...cast.selection },
          televisions: [],
        };
        entry.televisions.push(cast.device.name);
        channels.set(cast.selection.id, entry);
      }
      pinned = [...channels.values()].map((entry) => entry.selection);
      const focused = strip.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.castChannel
        : undefined;
      strip.replaceChildren(
        ...[...channels.values()].map(({ selection, televisions }) => {
          const pin = document.createElement('button');
          pin.type = 'button';
          pin.className = 'cast-pin';
          pin.dataset.castChannel = selection.id;
          const where = `On ${televisions.join(', ')}`;
          pin.title = `${selection.name} · ${where}`;
          pin.setAttribute('aria-label', `${selection.name}, casting on ${televisions.join(', ')}`);
          const badge = document.createElement('span');
          badge.className = 'cast-pin-tv';
          badge.textContent = where;
          const name = document.createElement('strong');
          name.className = 'cast-pin-name';
          name.textContent = selection.name;
          pin.append(badge, name);
          return pin;
        }),
      );
      strip.hidden = channels.size === 0;
      if (focused)
        strip
          .querySelector<HTMLElement>(`[data-cast-channel="${CSS.escape(focused)}"]`)
          ?.focus({ preventScroll: true });
    },
    dispose() {
      strip.removeEventListener('click', click);
      strip.remove();
      pinned = [];
    },
  };
}
