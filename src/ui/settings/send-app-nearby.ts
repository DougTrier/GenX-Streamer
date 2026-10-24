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
 * Share with everyone nearby (Send app page; docs/share-links.md): this
 * device serves GenX Streamer on the local Wi-Fi for ten minutes; friends scan
 * the code with their camera, or type the short address (a TV remote can),
 * and download it, with no store, link or internet. Started and stopped only
 * by the viewer.
 */
import { qrSvg } from '../../sharing/qr-code';
import {
  nearbyAvailable,
  nearbyStatus,
  onNearbyChanged,
  startNearby,
  stopNearby,
  type NearbyEnded,
  type NearbyStatus,
} from '../../platform/nearby-share';

/** What the sharer is told when a session ended before its time. */
export function nearbyEnded(why: NearbyEnded | null): string {
  switch (why) {
    case 'guesses':
      return 'Sharing stopped: someone kept trying wrong codes. Start again for a new code.';
    case 'network':
      return 'Sharing stopped because this device left the Wi-Fi network.';
    default:
      return '';
  }
}

/** The address as a person types it: no http://. */
export const typedAddress = (url: string) => url.replace(/^http:\/\//u, '');

export function nearbyFailure(code: string): string {
  switch (code) {
    case 'nearby-no-network':
      return 'Connect this device to Wi-Fi first. Friends join the same Wi-Fi to download it.';
    case 'share-app-development':
      return 'Sharing the app itself works from official releases. Send the link or QR code instead.';
    case 'share-app-split':
      return 'This copy was installed in several parts, so it cannot be shared as one file.';
    case 'share-app-unavailable':
      return 'The app file could not be opened for sharing.';
    case 'application-closing':
      return '';
    default:
      return 'Sharing nearby could not start. Try again.';
  }
}

/** A refusal's fixed code, never a platform error's text. */
function failureCode(error: unknown): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /^(?:(?:nearby|share)-[a-z-]{1,40}|application-closing)$/u.test(text) ? text : '';
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The nearby card; `activate` (when Pass It Along first opens, never at
 * start-up) reads the session and shows the card if this copy may serve its
 * own app file (`allowed`: an official release on Android).
 */
export function mountNearbyShare(card: HTMLElement): {
  activate: (allowed: Promise<boolean>) => void;
  dispose: () => void;
} {
  let disposed = false;
  card.hidden = true;
  if (!nearbyAvailable()) return { activate: () => undefined, dispose: () => undefined };
  card.innerHTML = `
    <h3>Share with everyone nearby</h3>
    <p class="send-app-detail">Friends on the same Wi-Fi scan the code with their camera, or type the address, and download GenX Streamer from this device. No store, link or internet needed. It stops after 10 minutes.</p>
    <div class="nearby-active" hidden>
      <div class="nearby-code"></div>
      <p class="nearby-typed">Or type <strong class="nearby-address"></strong></p>
      <div class="send-app-copy"><input type="text" readonly aria-label="Nearby download address" /></div>
      <p class="nearby-counts" role="status" aria-live="polite"></p>
      <p class="nearby-cheer" hidden></p>
      <p class="send-app-guidance">On a TV, type the address in its browser or download app. Anyone on this Wi-Fi with the address can download it while it is on; someone guessing codes is shut out.</p>
    </div>
    <button type="button" class="nearby-toggle">Start sharing nearby</button>
    <p class="nearby-status" role="status" aria-live="polite"></p>`;
  const active = card.querySelector<HTMLElement>('.nearby-active')!;
  const code = card.querySelector<HTMLElement>('.nearby-code')!;
  const address = card.querySelector<HTMLInputElement>('.send-app-copy input')!;
  const typed = card.querySelector<HTMLElement>('.nearby-address')!;
  const counts = card.querySelector<HTMLElement>('.nearby-counts')!;
  const cheer = card.querySelector<HTMLElement>('.nearby-cheer')!;
  const toggle = card.querySelector<HTMLButtonElement>('.nearby-toggle')!;
  const message = card.querySelector<HTMLElement>('.nearby-status')!;
  let pending = false;
  let current: NearbyStatus | null = null;
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  function tick(): void {
    if (!current?.active) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      void refresh();
      return;
    }
    const people = current.visitors === 1 ? '1 connected' : `${current.visitors} connected`;
    const files = current.downloads === 1 ? '1 download' : `${current.downloads} downloads`;
    counts.textContent = `${people} · ${files} · ${clock(left)} left`;
  }
  function render(status: NearbyStatus): void {
    if (disposed) return;
    const changedUrl = status.url !== current?.url;
    current = status;
    active.hidden = !status.active;
    toggle.textContent = status.active ? 'Stop sharing' : 'Start sharing nearby';
    toggle.classList.toggle('primary', !status.active);
    // A finished download: the friend's phone has the whole app.
    cheer.hidden = !status.active || status.completed === 0;
    cheer.textContent =
      status.completed === 1
        ? 'Totally tubular! 1 friend is ready to rock.'
        : `Totally tubular! ${status.completed} friends are ready to rock.`;
    if (status.active && status.url) {
      deadline = Date.now() + status.expiresInMs;
      if (changedUrl) {
        code.replaceChildren(qrSvg(status.url, 'Code to download GenX Streamer nearby'));
        address.value = status.url;
        typed.textContent = typedAddress(status.url);
      }
      tick();
      if (!timer) timer = setInterval(tick, 1000);
    } else {
      stopTimer();
      code.replaceChildren();
      address.value = '';
      typed.textContent = '';
      counts.textContent = '';
      if (status.ended) message.textContent = nearbyEnded(status.ended);
    }
  }
  async function refresh(): Promise<void> {
    try {
      render(await nearbyStatus());
    } catch {
      render({
        active: false,
        url: null,
        expiresInMs: 0,
        visitors: 0,
        downloads: 0,
        completed: 0,
        ended: null,
        checkIn: null,
      });
    }
  }
  toggle.addEventListener('click', () => {
    if (pending || disposed) return;
    pending = true;
    message.textContent = current?.active ? '' : 'Starting…';
    void (current?.active ? stopNearby().then(refresh) : startNearby().then(render))
      .then(() => {
        if (!disposed) message.textContent = '';
      })
      .catch((error: unknown) => {
        if (!disposed) message.textContent = nearbyFailure(failureCode(error));
      })
      .finally(() => {
        pending = false;
      });
  });
  let stopListening: (() => void) | null = null;
  return {
    activate(allowed) {
      if (stopListening || disposed) return;
      stopListening = onNearbyChanged(() => void refresh());
      void refresh();
      void allowed.then((yes) => {
        if (!disposed) card.hidden = !yes;
      });
    },
    dispose() {
      disposed = true;
      stopTimer();
      stopListening?.();
    },
  };
}
