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
 * The share card (docs/share-links.md): "<name> was shared with you — Play ·
 * Add to favorites" for an incoming link, and the link itself, ready to copy,
 * where the device has no share sheet (many TVs). Everything from a link is
 * set as text; the logo is an image address already checked as public https.
 * Nothing plays until the viewer chooses Play.
 */
import '../share-card.css';
import { qrSvg } from '../../sharing/qr-code';

export interface ShareCardAction {
  label: string;
  run: () => void;
}

export interface ShareCardView {
  title: string;
  /** One plain line under the title: guidance, progress or a failure, as text. */
  message?: string;
  logo?: string | null;
  /** A link shown in a read-only field with Copy beside it. */
  link?: string;
  /** Text shown as a QR code (when it fits one). */
  qr?: string;
  actions?: readonly ShareCardAction[];
}

export function mountShareCard(root: HTMLElement, copy: (text: string) => Promise<boolean>) {
  const dialog = document.createElement('dialog');
  dialog.id = 'share-card';
  dialog.className = 'share-card';
  dialog.setAttribute('aria-labelledby', 'share-card-title');
  dialog.innerHTML = `
    <header class="dialog-head share-card-header">
      <img class="share-card-logo" alt="" referrerpolicy="no-referrer" hidden />
      <h2 id="share-card-title"></h2>
      <button type="button" class="share-card-close" aria-label="Close">×</button>
    </header>
    <div class="dialog-body share-card-body">
      <p class="share-card-message" role="status" aria-live="polite"></p>
      <div class="share-card-qr" hidden></div>
      <div class="share-card-link" hidden>
        <input type="text" readonly aria-label="Share link" />
        <button type="button" class="share-card-copy">Copy</button>
      </div>
      <div class="share-card-actions"></div>
    </div>`;
  root.append(dialog);
  const title = dialog.querySelector<HTMLElement>('#share-card-title')!;
  const logo = dialog.querySelector<HTMLImageElement>('.share-card-logo')!;
  const message = dialog.querySelector<HTMLElement>('.share-card-message')!;
  const linkRow = dialog.querySelector<HTMLElement>('.share-card-link')!;
  const linkField = linkRow.querySelector<HTMLInputElement>('input')!;
  const actions = dialog.querySelector<HTMLElement>('.share-card-actions')!;
  const qr = dialog.querySelector<HTMLElement>('.share-card-qr')!;
  const close = () => dialog.close();
  dialog.querySelector('.share-card-close')!.addEventListener('click', close);
  linkRow.querySelector('.share-card-copy')!.addEventListener('click', () => {
    const text = linkField.value;
    void copy(text).then((copied) => {
      if (!dialog.open || linkField.value !== text) return;
      message.textContent = copied
        ? 'Link copied.'
        : 'Copying is not available here. Select the link and copy it.';
      if (!copied) linkField.select();
    });
  });
  logo.addEventListener('error', () => (logo.hidden = true));

  function show(view: ShareCardView): void {
    title.textContent = view.title;
    message.textContent = view.message ?? '';
    message.hidden = !view.message;
    if (view.logo) {
      if (logo.getAttribute('src') !== view.logo) logo.src = view.logo;
      logo.hidden = false;
    } else {
      logo.hidden = true;
      logo.removeAttribute('src');
    }
    qr.replaceChildren();
    qr.hidden = true;
    if (view.qr) {
      try {
        qr.append(qrSvg(view.qr, 'Code to scan for this link'));
        qr.hidden = false;
      } catch {
        // Too long for a code: the link and Copy remain.
      }
    }
    linkRow.hidden = !view.link;
    linkField.value = view.link ?? '';
    actions.replaceChildren(
      ...(view.actions ?? []).map((action, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        if (index === 0) button.className = 'primary';
        button.addEventListener('click', action.run);
        return button;
      }),
    );
    if (!dialog.open) dialog.showModal();
    // The first choice is ready for OK on a remote; nothing runs until it is chosen.
    (actions.querySelector('button') ?? linkRow.querySelector('button'))?.focus();
  }

  /** Changes only the message line (progress, a failure); keeps the choices. */
  function say(text: string): void {
    message.textContent = text;
    message.hidden = !text;
  }

  /** Disables or enables the card's choices while one runs. */
  function busy(value: boolean): void {
    for (const button of actions.querySelectorAll('button')) button.disabled = value;
  }

  return {
    show,
    say,
    busy,
    close,
    get open() {
      return dialog.open;
    },
    dispose() {
      dialog.close();
      dialog.remove();
    },
  };
}
