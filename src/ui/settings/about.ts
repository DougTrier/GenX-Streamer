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

import '../about.css';
import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import packageInfo from '../../../package.json';
import iconUrl from '../../../assets/tmg-retro-tv-96.png';
import wordmarkUrl from '../../../assets/genx-wordmark-v2-display.png?no-inline';
import robotoLicense from '../../../assets/fonts/roboto-condensed/OFL.txt?raw';
import yellowtailLicense from '../../../assets/fonts/yellowtail/LICENSE.txt?raw';
import dependencyNoticesUrl from '../../../assets/licenses/dependency-notices.txt?url&no-inline';
import { mountSendApp } from './send-app';
import { mountAboutUpdate } from './about-update';
import { mountAboutIdentity } from './about-identity';

/** Static destinations belong to the app, never to imported channel metadata. */
export const authorLink = {
  target: 'author',
  name: 'Doug Trier on GitHub',
  url: 'https://github.com/dougtrier',
} as const;
export const supportLinks = [
  {
    target: 'github',
    name: 'GitHub Sponsors',
    detail: 'Monthly or one-time sponsorship',
    url: 'https://github.com/sponsors/dougtrier',
  },
  {
    target: 'coffee',
    name: 'Buy Me a Coffee',
    detail: 'A quick one-time thank-you',
    url: 'https://www.buymeacoffee.com/dougtrier',
  },
  {
    target: 'opencollective',
    name: 'Open Collective',
    detail: 'Open, transparent project funding',
    url: 'https://opencollective.com/trier-os',
  },
] as const;

/** Simple line glyphs (no third-party logos), drawn in the button's colour. */
const glyphs: Record<string, string> = {
  author: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>',
  github:
    '<path d="M12 20.5s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1Z"/>',
  coffee:
    '<path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5Z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c-.8 1 .8 2 0 3M11 3.5c-.8 1 .8 2 0 3"/>',
  opencollective: '<circle cx="12" cy="12" r="8"/><path d="M15.5 8.6a4.8 4.8 0 1 0 0 6.8"/>',
};
const glyph = (target: string) =>
  `<svg class="about-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyphs[target] ?? ''}</svg>`;

const guide = [
  [
    'Find channels',
    'Typing filters your saved channels immediately. Choose the search magnifier to find matching channels online; leave the text empty to scan all included sources. Keep watching as channels are added. Stop and Continue keep progress; Rescan starts a new check.',
  ],
  [
    'Your channel list',
    'Settings → Sources offers playlist import and M3U export. Full backup also keeps favorites and settings.',
  ],
  [
    'Watch',
    'Choose a channel. Use search, favorites, a category, or Location and sort to find it again. Remove a broken channel without removing its source.',
  ],
  [
    'Program guide',
    'Schedules connect after channels are added when matching data is available. Use Map guide for a missing connection. Browse programs or search the next seven days when listings are available.',
  ],
  [
    'Your screen',
    'Use Pause, Mute, Expand or Full screen. On narrow screens, switch between Watch and Channels.',
  ],
  [
    'Your TV',
    'Choose Cast and pick a Chromecast or DLNA receiver. Both devices need a network that lets them talk to each other.',
  ],
  [
    'Controls',
    'Use touch, mouse or keyboard. On TV devices, use the remote arrows and OK; Back closes menus, dialogs or full screen and stays in the app. Home returns to the launcher. Choose Settings → Exit app to close cleanly.',
  ],
  [
    'Another device',
    'In the Windows app’s Settings, turn on LAN viewing and pair your phone for viewing or control. Stop sharing when you are finished.',
  ],
] as const;

export function mountAbout(root: HTMLElement, opener: HTMLButtonElement): () => void {
  // Bundle the full notice file without loading its text into the viewing/scan heap.
  const componentNotices = document.createElement('link');
  componentNotices.rel = 'license';
  componentNotices.href = dependencyNoticesUrl;
  document.head.append(componentNotices);
  const dialog = document.createElement('dialog');
  dialog.id = 'about-dialog';
  dialog.setAttribute('aria-labelledby', 'about-title');
  dialog.innerHTML = `
    <header class="about-hero">
      <img class="about-hero-icon" alt="" />
      <div class="about-hero-copy">
        <h2 id="about-title"><img class="about-hero-wordmark" alt="About GenX Streamer" /></h2>
        <p id="about-version"></p>
      </div>
      <button type="button" class="about-close" aria-label="Close about">×</button>
    </header>
    <div class="about-tabs" role="tablist" aria-label="About sections">
      <button type="button" role="tab" id="about-tab-author" aria-controls="about-panel-author">About the Author</button>
      <button type="button" role="tab" id="about-tab-guide" aria-controls="about-panel-guide">Quick Guide</button>
    </div>
    <div class="dialog-body about-body">
      <section class="about-panel" role="tabpanel" id="about-panel-author" aria-labelledby="about-tab-author">
        <div class="about-author">
          <div class="about-author-mark" aria-hidden="true">DT</div>
          <div class="about-author-copy">
            <p class="about-eyebrow">Created by</p>
            <p class="about-author-name">Doug Trier</p>
            <p>Designer and developer of GenX Streamer. Find my other projects on GitHub.</p>
            <button type="button" class="about-link about-author-link" data-link-target="${authorLink.target}" aria-label="${authorLink.name}">
              ${glyph(authorLink.target)}<span>github.com/dougtrier</span>
            </button>
          </div>
        </div>
        <section class="about-identity"></section>
        <section class="about-update"></section>
        <h3 class="about-section-title">Share GenX Streamer</h3>
        <p>Send the app itself, or a download link, to friends and family.</p>
        <div class="about-share-actions"><button type="button" class="about-send-app">Send app to a friend</button></div>
        <h3 class="about-section-title">Support GenX Streamer</h3>
        <p>If GenX Streamer has earned a place on your screen, you can support its development. Links open in your browser.</p>
        <div class="about-support"></div>
        <p class="about-status" role="status" aria-live="polite"></p>
        <details class="about-licenses">
          <summary>Open-source licenses</summary>
          <p>GenX Streamer includes open-source components; their notices ship with the app.</p>
          <div class="about-font-licenses"></div>
        </details>
      </section>
      <section class="about-panel" role="tabpanel" id="about-panel-guide" aria-labelledby="about-tab-guide" hidden>
        <ol class="about-guide"></ol>
      </section>
    </div>`;
  root.append(dialog);
  dialog.querySelector<HTMLImageElement>('.about-hero-icon')!.src = iconUrl;
  dialog.querySelector<HTMLImageElement>('.about-hero-wordmark')!.src = wordmarkUrl;
  const version = dialog.querySelector<HTMLElement>('#about-version')!;
  const status = dialog.querySelector<HTMLElement>('.about-status')!;
  const body = dialog.querySelector<HTMLElement>('.about-body')!;
  const steps = dialog.querySelector<HTMLOListElement>('.about-guide')!;
  guide.forEach(([title, text], index) => {
    const item = document.createElement('li');
    // Focusable so a TV remote can step through the guide and scroll it.
    item.tabIndex = 0;
    const number = document.createElement('span');
    number.className = 'about-step';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(index + 1);
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    copy.append(heading, paragraph);
    item.append(number, copy);
    steps.append(item);
  });
  for (const [name, copyright, license] of [
    [
      'Roboto Condensed · SIL Open Font License 1.1',
      'Copyright 2011 The Roboto Project Authors.',
      robotoLicense,
    ],
    [
      'Yellowtail · Apache License 2.0',
      'Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI).',
      yellowtailLicense,
    ],
  ] as const) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = name;
    const attribution = document.createElement('p');
    attribution.textContent = copyright;
    const text = document.createElement('pre');
    text.textContent = license;
    details.append(summary, attribution, text);
    dialog.querySelector('.about-font-licenses')!.append(details);
  }
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (chosen: HTMLButtonElement) => {
    for (const tab of tabs) {
      const selected = tab === chosen;
      tab.setAttribute('aria-selected', String(selected));
      dialog.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')!}`)!.hidden =
        !selected;
    }
    body.scrollTop = 0;
  };
  select(tabs[0]!);
  let disposed = false;
  let pending = false;
  version.textContent = isTauri()
    ? 'Version: checking…'
    : `Version ${packageInfo.version} · Browser development preview`;
  if (isTauri())
    void getVersion().then(
      (value) => {
        if (!disposed) version.textContent = `Version ${value}`;
      },
      () => {
        if (!disposed)
          version.textContent = 'Version unavailable. Reopen the application to try again.';
      },
    );
  const removers: (() => void)[] = [];
  // The same page Settings' header opens (Send app to a friend).
  removers.push(
    mountSendApp(root, [
      document.querySelector<HTMLButtonElement>('#send-app-button'),
      dialog.querySelector<HTMLButtonElement>('.about-send-app'),
    ]),
  );
  const identity = mountAboutIdentity(dialog.querySelector<HTMLElement>('.about-identity')!);
  removers.push(identity.dispose);
  removers.push(
    mountAboutUpdate(dialog.querySelector<HTMLElement>('.about-update')!, {
      // Restart after an update is an ordinary exit (Settings → Exit app).
      restart: () => {
        dialog.close();
        document.getElementById('exit-button')?.click();
      },
    }),
  );
  const listen = (element: HTMLElement, handler: () => void) => {
    element.addEventListener('click', handler);
    removers.push(() => element.removeEventListener('click', handler));
  };
  const open = (link: { target: string; url: string }) => {
    if (disposed || pending) return;
    status.textContent = '';
    if (!isTauri()) {
      const opened = window.open(link.url, '_blank', 'noopener,noreferrer');
      // With noopener the returned handle may be null even when the tab opens.
      void opened;
      status.textContent = `If your browser blocked the link, visit ${link.url}`;
      return;
    }
    pending = true;
    status.textContent = 'Opening your browser…';
    void invoke('open_donation', { target: link.target })
      .then(
        () => {
          if (!disposed) status.textContent = '';
        },
        () => {
          if (!disposed) status.textContent = `Could not open your browser. Visit ${link.url}`;
        },
      )
      .finally(() => {
        pending = false;
      });
  };
  const support = dialog.querySelector<HTMLElement>('.about-support')!;
  for (const link of supportLinks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'about-link about-support-card';
    button.dataset.supportTarget = link.target;
    button.setAttribute('aria-label', link.name);
    button.innerHTML = glyph(link.target);
    const copy = document.createElement('span');
    copy.className = 'about-support-copy';
    const name = document.createElement('strong');
    name.textContent = link.name;
    const detail = document.createElement('span');
    detail.textContent = link.detail;
    const address = document.createElement('small');
    address.textContent = link.url.replace(/^https:\/\/(www\.)?/, '');
    copy.append(name, detail, address);
    button.append(copy);
    support.append(button);
    listen(button, () => open(link));
  }
  listen(dialog.querySelector<HTMLButtonElement>('.about-author-link')!, () => open(authorLink));
  for (const tab of tabs) listen(tab, () => select(tab));
  const show = () => {
    status.textContent = '';
    if (disposed || dialog.open) return;
    select(tabs[0]!);
    identity.load();
    dialog.showModal();
  };
  const close = () => dialog.close();
  listen(opener, show);
  listen(dialog.querySelector<HTMLButtonElement>('[aria-label="Close about"]')!, close);
  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers) remove();
    dialog.close();
    dialog.remove();
    componentNotices.remove();
  };
}
