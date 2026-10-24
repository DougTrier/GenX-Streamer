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
 * Share GenX Streamer (About; docs/share-links.md): send the download link by
 * text or message, or send the installed app itself. On Android that is this
 * copy's APK through the share sheet (Quick Share, Bluetooth, messaging apps:
 * Android Beam left with Android 10); on Windows, GenX Streamer.exe through
 * Windows' share (Nearby Sharing, mail).
 */
import { isTauri } from '@tauri-apps/api/core';
import { DOWNLOAD_PAGE } from '../../sharing/share-link';
import {
  androidApp,
  copyText,
  shareAppFile,
  shareFailureCode,
  shareText,
} from '../../platform/share-sheet';

export const appShareMessage = `Get GenX Streamer, a free TV app for Windows and Android: ${DOWNLOAD_PAGE}`;

/** The receiver's one line of guidance for each platform's app file. */
export const appFileGuidance = {
  android:
    'On their phone: open the received file and, when asked, allow Files or Quick Share to install apps.',
  windows:
    'Windows may say the app is from an unknown publisher: they choose More info, then Run anyway.',
} as const;

function failure(code: string): string {
  switch (code) {
    case 'share-no-target':
      return 'No app on this device can send it. Copy the link instead.';
    case 'share-app-split':
      return 'This copy was installed in several parts, so it cannot be sent as one file. Send the download link instead.';
    case 'share-app-unavailable':
      return 'The app file could not be prepared. Send the download link instead.';
    case 'share-copy-refused':
      return `Copying is not available here. The link is ${DOWNLOAD_PAGE}`;
    case 'share-background':
      return '';
    default:
      return 'Sharing is not available here. Copy the link instead.';
  }
}

export function mountAboutShare(container: HTMLElement): () => void {
  const android = androidApp();
  const desktop = isTauri() && !android;
  container.innerHTML = `
    <h3 class="about-section-title">Share GenX Streamer</h3>
    <p>Send GenX Streamer to friends and family: the download link by text or message${
      android ? ', or this app itself, phone to phone' : desktop ? ', or the app file itself' : ''
    }.</p>
    <div class="about-share-actions">
      <button type="button" class="about-share-link">Send the download link</button>
      <button type="button" class="about-share-copy">Copy link</button>
      <button type="button" class="about-share-app" hidden></button>
    </div>
    <p class="about-share-guidance" hidden></p>
    <p class="about-share-status" role="status" aria-live="polite"></p>`;
  const status = container.querySelector<HTMLElement>('.about-share-status')!;
  const app = container.querySelector<HTMLButtonElement>('.about-share-app')!;
  const guidance = container.querySelector<HTMLElement>('.about-share-guidance')!;
  if (android || desktop) {
    app.hidden = false;
    app.textContent = android ? 'Send the app (Quick Share, Bluetooth)' : 'Send the app file';
    guidance.hidden = false;
    guidance.textContent = android ? appFileGuidance.android : appFileGuidance.windows;
  }
  let disposed = false;
  let pending = false;
  const run = (work: () => Promise<void>, busy: string) => {
    if (disposed || pending) return;
    pending = true;
    status.textContent = busy;
    void work()
      .then(
        () => {
          if (!disposed && status.textContent === busy) status.textContent = '';
        },
        (error: unknown) => {
          if (disposed) return;
          if (error instanceof DOMException && error.name === 'AbortError') status.textContent = '';
          else status.textContent = failure(shareFailureCode(error));
        },
      )
      .finally(() => {
        pending = false;
      });
  };
  const removers: (() => void)[] = [];
  const listen = (button: HTMLButtonElement, handler: () => void) => {
    button.addEventListener('click', handler);
    removers.push(() => button.removeEventListener('click', handler));
  };
  listen(container.querySelector<HTMLButtonElement>('.about-share-link')!, () =>
    run(() => shareText('GenX Streamer', appShareMessage), 'Opening the share sheet…'),
  );
  listen(container.querySelector<HTMLButtonElement>('.about-share-copy')!, () =>
    run(async () => {
      if (!(await copyText(DOWNLOAD_PAGE))) throw new Error('share-copy-refused');
      if (!disposed) status.textContent = 'Link copied.';
    }, ''),
  );
  listen(app, () =>
    run(
      () =>
        shareAppFile(
          'GenX Streamer',
          `GenX Streamer, a free TV app. ${android ? appFileGuidance.android : appFileGuidance.windows}`,
        ),
      android ? 'Preparing the app to send…' : 'Opening the share sheet…',
    ),
  );
  return () => {
    disposed = true;
    for (const remove of removers) remove();
  };
}
