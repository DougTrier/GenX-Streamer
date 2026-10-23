import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import packageInfo from '../../package.json';
import robotoLicense from '../../assets/fonts/roboto-condensed/OFL.txt?raw';
import yellowtailLicense from '../../assets/fonts/yellowtail/LICENSE.txt?raw';
import dependencyNoticesUrl from '../../assets/licenses/dependency-notices.txt?url&no-inline';

/** Static support destinations belong to the app, never to imported channel metadata. */
export const supportLinks = [
  { target: 'github', name: 'GitHub Sponsors', url: 'https://github.com/sponsors/dougtrier' },
  { target: 'coffee', name: 'Buy Me a Coffee', url: 'https://www.buymeacoffee.com/dougtrier' },
  { target: 'opencollective', name: 'Open Collective', url: 'https://opencollective.com/trier-os' },
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
    <div class="dialog-head"><h2 id="about-title">About GenX Streamer</h2><button type="button" aria-label="Close about">×</button></div>
    <div class="dialog-body">
      <p>A comfortable place for your channels, live programs, and favorite streams.</p>
      <p id="about-version"></p><p>Created by Doug Trier.</p>
      <h3>Quick guide</h3>
      <ol>
        <li><strong>Find channels:</strong> typing filters your saved channels immediately. Choose the search magnifier to find matching channels online; leave the text empty to scan all included sources. Keep watching as channels are added. Stop and Continue retain progress; Rescan starts a new check.</li>
        <li><strong>Your channel list:</strong> Settings → Sources offers playlist import and M3U export. Full backup also preserves favorites and settings.</li>
        <li><strong>Watch:</strong> choose a channel. Use search, favorites, category, or Location and sort to find it again. Remove a broken channel without removing its source.</li>
        <li><strong>Guide:</strong> schedules connect after channels are added when matching data is available. Use Map guide for a missing connection. Browse programs or search the next seven days when listings are available.</li>
        <li><strong>Your screen:</strong> use Pause, Mute, Expand, or Full screen. On narrow screens, switch between Watch and Channels.</li>
        <li><strong>Your TV:</strong> choose Cast and find a compatible Chromecast or DLNA receiver. Both devices need a network that allows them to communicate.</li>
        <li><strong>Controls:</strong> use touch, mouse, or keyboard. On supported TV devices, use remote arrows and OK; Back closes menus, dialogs or full screen and stays in the app. Home returns to the launcher. Choose Settings → Exit app to close cleanly.</li>
        <li><strong>Another device:</strong> in Windows Settings, enable LAN viewing and pair your phone for viewing or control. Stop sharing when you are finished.</li>
      </ol>
      <h3>Bundled font licenses</h3>
      <div class="about-font-licenses"></div>
      <h3>Support the project</h3>
      <p>If you enjoy the application, please support the project.</p>
      <p>Support links open in your browser.</p>
      <div class="about-support"></div>
      <p class="about-status" role="status" aria-live="polite"></p>
    </div>`;
  root.append(dialog);
  const version = dialog.querySelector<HTMLElement>('#about-version')!;
  const status = dialog.querySelector<HTMLElement>('.about-status')!;
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
    text.style.whiteSpace = 'pre-wrap';
    text.style.overflowWrap = 'anywhere';
    text.textContent = license;
    details.append(summary, attribution, text);
    dialog.querySelector('.about-font-licenses')!.append(details);
  }
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
  for (const link of supportLinks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = link.name;
    button.dataset.supportTarget = link.target;
    const address = document.createElement('small');
    address.textContent = link.url;
    const item = document.createElement('div');
    item.append(button, address);
    dialog.querySelector('.about-support')!.append(item);
    const activate = () => {
      if (disposed || pending) return;
      status.textContent = '';
      if (!isTauri()) {
        const opened = window.open(link.url, '_blank', 'noopener,noreferrer');
        // With noopener the returned handle may be null even when the tab opens.
        void opened;
        status.textContent = 'If your browser blocked the link, use the address shown above.';
        return;
      }
      pending = true;
      status.textContent = 'Opening your browser…';
      void invoke('open_donation', { target: link.target })
        .then(
          () => {
            if (!disposed) status.textContent = 'Browser launch requested.';
          },
          () => {
            if (!disposed)
              status.textContent =
                'Could not open your browser. Use the support address shown above.';
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    button.addEventListener('click', activate);
    removers.push(() => button.removeEventListener('click', activate));
  }
  const show = () => {
    status.textContent = '';
    if (!disposed && !dialog.open) dialog.showModal();
  };
  const close = () => dialog.close();
  opener.addEventListener('click', show);
  const closeButton = dialog.querySelector<HTMLButtonElement>('[aria-label="Close about"]')!;
  closeButton.addEventListener('click', close);
  return () => {
    if (disposed) return;
    disposed = true;
    opener.removeEventListener('click', show);
    closeButton.removeEventListener('click', close);
    for (const remove of removers) remove();
    dialog.close();
    dialog.remove();
    componentNotices.remove();
  };
}
