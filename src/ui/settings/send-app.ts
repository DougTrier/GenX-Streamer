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
 * Send app to a friend (Settings header, and About; docs/share-links.md):
 * Pass It Along, one page with every way to pass GenX Streamer on, in the
 * spirit of a mixtape handed to a friend. Send the installed app
 * itself (Android: this copy's APK through the share sheet, so Quick Share,
 * Bluetooth or a messaging app, since Android Beam left with Android 10;
 * Windows: GenX Streamer.exe through Windows' share, so Nearby Sharing or
 * mail), send the download link by text or message, or copy it.
 */
import '../send-app.css';
import { mountNearbyShare } from './send-app-nearby';
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
      return 'Copying is not available here. Select the link and copy it.';
    case 'share-background':
      return '';
    default:
      return 'Sharing is not available here. Copy the link instead.';
  }
}

/** The page, opened by every opener given (a missing one is skipped). */
export function mountSendApp(
  root: HTMLElement,
  openers: readonly (HTMLButtonElement | null)[],
): () => void {
  const android = androidApp();
  const desktop = isTauri() && !android;
  const dialog = document.createElement('dialog');
  dialog.id = 'send-app-dialog';
  dialog.setAttribute('aria-labelledby', 'send-app-title');
  dialog.innerHTML = `
    <div class="dialog-head">
      <h2 id="send-app-title">Pass It Along</h2>
      <button type="button" class="send-app-close" aria-label="Close send app">×</button>
    </div>
    <div class="dialog-body send-app-body">
      <div class="send-app-tape" aria-hidden="true">
        <svg viewBox="0 0 64 40" focusable="false"><rect x="2" y="2" width="60" height="36" rx="4"/><rect x="9" y="7" width="46" height="12" rx="2"/><circle cx="21" cy="26" r="5"/><circle cx="43" cy="26" r="5"/><path d="M26 26h12M14 38l4-6h28l4 6"/></svg>
      </div>
      <p class="send-app-tagline">Too rad to keep to yourself.</p>
      <p class="send-app-intro">Pass GenX Streamer to friends and family: they get the same free app you have.</p>
      <div class="send-app-options">
        <section class="send-app-option send-app-file" hidden>
          <h3></h3>
          <p class="send-app-detail"></p>
          <p class="send-app-guidance"></p>
          <button type="button" class="primary send-app-file-button"></button>
        </section>
        <section class="send-app-option send-app-nearby" hidden></section>
        <section class="send-app-option">
          <h3>Send a download link</h3>
          <p class="send-app-detail">By text, email or chat: they download GenX Streamer themselves, on Windows or Android.</p>
          <button type="button" class="send-app-link-button">Send the download link</button>
        </section>
        <section class="send-app-option">
          <h3>Copy the download link</h3>
          <p class="send-app-detail">Paste it anywhere, or read it out.</p>
          <div class="send-app-copy">
            <input type="text" readonly aria-label="Download link" />
            <button type="button" class="send-app-copy-button">Copy link</button>
          </div>
        </section>
      </div>
      <p class="send-app-status" role="status" aria-live="polite"></p>
    </div>`;
  root.append(dialog);
  const status = dialog.querySelector<HTMLElement>('.send-app-status')!;
  const fileOption = dialog.querySelector<HTMLElement>('.send-app-file')!;
  const fileButton = dialog.querySelector<HTMLButtonElement>('.send-app-file-button')!;
  const linkField = dialog.querySelector<HTMLInputElement>('.send-app-copy input')!;
  linkField.value = DOWNLOAD_PAGE;
  if (android || desktop) {
    fileOption.hidden = false;
    fileOption.querySelector('h3')!.textContent = android
      ? 'Send the app, phone to phone'
      : 'Send the app file';
    fileOption.querySelector('.send-app-detail')!.textContent = android
      ? 'Quick Share, Bluetooth or a messaging app sends GenX Streamer itself, with no download.'
      : 'Nearby Sharing or mail sends GenX Streamer.exe to another PC.';
    fileOption.querySelector('.send-app-guidance')!.textContent = android
      ? appFileGuidance.android
      : appFileGuidance.windows;
    fileButton.textContent = android ? 'Send the app' : 'Send the app file';
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
          if (shareFailureCode(error) === 'share-copy-refused') linkField.select();
        },
      )
      .finally(() => {
        pending = false;
      });
  };
  const removers: (() => void)[] = [
    mountNearbyShare(dialog.querySelector<HTMLElement>('.send-app-nearby')!),
  ];
  const listen = (button: HTMLButtonElement, handler: () => void) => {
    button.addEventListener('click', handler);
    removers.push(() => button.removeEventListener('click', handler));
  };
  listen(fileButton, () =>
    run(
      () =>
        shareAppFile(
          'GenX Streamer',
          `GenX Streamer, a free TV app. ${android ? appFileGuidance.android : appFileGuidance.windows}`,
        ),
      android ? 'Preparing the app to send…' : 'Opening the share sheet…',
    ),
  );
  listen(dialog.querySelector<HTMLButtonElement>('.send-app-link-button')!, () =>
    run(() => shareText('GenX Streamer', appShareMessage), 'Opening the share sheet…'),
  );
  listen(dialog.querySelector<HTMLButtonElement>('.send-app-copy-button')!, () =>
    run(async () => {
      if (!(await copyText(DOWNLOAD_PAGE))) throw new Error('share-copy-refused');
      if (!disposed) status.textContent = 'Link copied.';
    }, ''),
  );
  listen(dialog.querySelector<HTMLButtonElement>('.send-app-close')!, () => dialog.close());
  for (const opener of openers) {
    if (!opener) continue;
    listen(opener, () => {
      if (disposed || dialog.open) return;
      status.textContent = '';
      dialog.showModal();
      (fileOption.hidden
        ? dialog.querySelector<HTMLButtonElement>('.send-app-link-button')!
        : fileButton
      ).focus();
    });
  }
  return () => {
    disposed = true;
    for (const remove of removers) remove();
    dialog.close();
    dialog.remove();
  };
}
