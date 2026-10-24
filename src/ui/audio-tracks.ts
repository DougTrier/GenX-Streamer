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
  readAudioTracks,
  setAudioTrack,
  AUDIO_TRACKS_CHANGE,
} from '../platform/browser-audio-tracks';
import './video-quality.css';

/** Exposes actual alternative audio tracks using attachment-scoped option IDs. */
export function installAudioTracks(video: HTMLVideoElement, container: HTMLElement): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'video-quality-button';
  button.setAttribute('aria-label', 'Audio track');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'video-quality-menu';
  menu.role = 'menu';
  menu.setAttribute('aria-label', 'Available audio tracks');
  menu.hidden = true;
  container.append(button, menu);
  let disposed = false;
  const eligible = () =>
    !button.disabled &&
    !button.closest('[inert]') &&
    button.getClientRects().length > 0 &&
    getComputedStyle(button).visibility !== 'hidden';
  const close = (restore = false) => {
    const ownedFocus = menu.contains(document.activeElement);
    if (!menu.hidden) menu.hidden = true;
    delete container.dataset.audioTracksOpen;
    button.setAttribute('aria-expanded', 'false');
    if (restore && ownedFocus && eligible()) button.focus({ preventScroll: true });
  };
  const refresh = () => {
    if (disposed) return;
    const state = readAudioTracks(video);
    const tracks = state?.tracks ?? [];
    container.hidden = !state?.selectable || state.trackCount < 2 || state.truncated;
    button.disabled = container.hidden;
    const current = tracks.find((track) => track.selected);
    button.textContent = `Audio${current?.language ? ` · ${current.language}` : ''} ▴`;
    button.title = 'Choose an audio track supplied by this stream.';
    if (button.disabled || !eligible()) {
      close();
      menu.replaceChildren();
      return;
    }
    const focused = (document.activeElement as HTMLElement | null)?.dataset.quality;
    const fragment = document.createDocumentFragment();
    const choices = [
      ...(state?.providerDefaultAvailable && state.providerDefaultId
        ? [
            {
              id: state.providerDefaultId,
              label: 'Provider default',
              checked: state.mode === 'provider-default',
            },
          ]
        : []),
      ...tracks.map((track) => ({
        id: track.id,
        label:
          [track.name, track.language, track.description].filter(Boolean).join(' · ') ||
          `Track ${track.index + 1}`,
        checked: state?.mode === 'manual' && track.selected,
      })),
    ];
    for (const choice of choices) {
      const option = document.createElement('button');
      option.type = 'button';
      option.role = 'menuitemradio';
      option.dataset.quality = choice.id;
      const label = document.createElement('span');
      label.textContent = choice.label;
      option.append(label);
      option.title = choice.label;
      option.setAttribute('aria-checked', String(choice.checked));
      option.addEventListener('click', () => {
        if (disposed || !eligible() || menu.hidden) return;
        const changed = setAudioTrack(video, choice.id);
        close(true);
        refresh();
        if (!changed)
          button.title = 'Audio choice changed or is unavailable. Open Audio and try again.';
      });
      fragment.append(option);
    }
    menu.replaceChildren(fragment);
    if (!menu.hidden && focused)
      [...menu.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.dataset.quality === focused)
        ?.focus({ preventScroll: true });
  };
  const open = () => {
    if (disposed || !eligible()) return;
    if (!menu.hidden) {
      close(true);
      return;
    }
    refresh();
    if (button.disabled) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, innerWidth - 16);
    const height = Math.max(0, rect.top - 12);
    if (height < 44) return;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width))}px`;
    menu.style.bottom = `${innerHeight - rect.top + 4}px`;
    menu.style.maxHeight = `${height}px`;
    menu.hidden = false;
    container.dataset.audioTracksOpen = 'true';
    button.setAttribute('aria-expanded', 'true');
    (
      menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.querySelector<HTMLButtonElement>('button')
    )?.focus();
  };
  const keys = (event: KeyboardEvent) => {
    if (menu.hidden) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
      items[next]?.scrollIntoView({ block: 'nearest' });
    }
  };
  const outside = (event: Event) => {
    if (!container.contains(event.target as Node)) close();
  };
  const geometry = () => close(true);
  const requestedClose = () => close(true);
  // Only an open menu needs its button to stay usable. Measuring on every
  // attribute change anywhere in the app forced a layout each time while
  // video played: 0.8 s of every 8 s on the Sansui (October 19, 2026).
  const observer = new MutationObserver(() => {
    if (!menu.hidden && !eligible()) close();
  });
  observer.observe(container.closest('#app') ?? container, {
    attributes: true,
    subtree: true,
    attributeFilter: ['inert', 'class', 'hidden'],
  });
  button.addEventListener('click', open);
  container.addEventListener('audio-tracks-close', requestedClose);
  menu.addEventListener('keydown', keys);
  video.addEventListener(AUDIO_TRACKS_CHANGE, refresh);
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', geometry);
  refresh();
  return () => {
    if (disposed) return;
    close();
    disposed = true;
    observer.disconnect();
    button.removeEventListener('click', open);
    container.removeEventListener('audio-tracks-close', requestedClose);
    menu.removeEventListener('keydown', keys);
    video.removeEventListener(AUDIO_TRACKS_CHANGE, refresh);
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('focusin', outside);
    document.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', geometry);
    button.remove();
    menu.remove();
  };
}
