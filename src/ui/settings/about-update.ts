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
 * Check for updates (About; docs/updates.md). Updates are always optional:
 * GenX checks only when this button is chosen, downloads only on Download
 * update, installs only on Install update, and restarts only on Restart now.
 * Release notes are shown as text.
 */
import {
  cancelUpdateDownload,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  requestUpdateRestart,
  updateFailureCode,
  updatesAvailable,
  type AvailableRelease,
} from '../../platform/app-update';

export const UPDATE_PROMISE =
  'Updates are always optional. GenX Streamer will never update without your permission.';

/** What each refusal means for the viewer, plainly (empty: say nothing). */
export function updateMessage(code: string): string {
  switch (code) {
    case 'update-offline':
    case 'update-timeout':
      return 'GitHub could not be reached. GenX Streamer keeps working as it is; try again when you are online.';
    case 'update-no-release':
      return 'No public GenX Streamer release was found on GitHub yet.';
    case 'update-rate-limited':
      return 'GitHub is limiting requests right now. Try again later.';
    case 'update-platform-unsupported':
    case 'update-asset-missing':
      return 'The latest release has no update file for this device yet.';
    case 'update-asset-invalid':
    case 'update-unverifiable':
      return 'The latest release’s file could not be verified, so GenX Streamer will not download it.';
    case 'update-digest-mismatch':
    case 'update-download-mismatch':
      return 'The download did not match the official release, so it was deleted. Nothing was changed.';
    case 'update-canceled':
      return 'Download canceled. Nothing was changed.';
    case 'update-download-refused':
    case 'update-redirect-refused':
      return 'GitHub did not provide the file. Try again later.';
    case 'update-storage-unavailable':
      return 'The update could not be saved on this device. Free some space and try again.';
    case 'update-development-build':
      return 'This is a development build. Updates are for the packaged GenX Streamer.';
    case 'update-folder-read-only':
      return 'GenX Streamer’s folder cannot be changed. Move GenX Streamer to a folder you can write to, or get the update from the release page.';
    case 'update-in-use':
    case 'update-install-failed':
      return 'The update could not be put in place. Your current version still works.';
    case 'update-install-incomplete':
      return 'The update stopped halfway. In GenX Streamer’s folder, rename “GenX Streamer.exe.old” back to “GenX Streamer.exe”.';
    case 'update-restart-pending':
      return 'Restart GenX Streamer to finish the previous update first.';
    case 'update-signature-mismatch':
      return 'This update is signed differently from your installed copy, so Android will not install it over this one. A development copy must be uninstalled first (back up your channels).';
    case 'update-not-newer':
      return 'That file is not newer than your installed version.';
    case 'update-not-an-app':
    case 'update-wrong-app':
      return 'The downloaded file is not GenX Streamer, so it was deleted.';
    case 'update-no-installer':
      return 'This device has no app installer to open the update.';
    case 'update-background':
    case 'application-closing':
      return '';
    default:
      return 'Checking for updates did not work this time. Try again later.';
  }
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;

export function mountAboutUpdate(
  container: HTMLElement,
  options: { restart: () => void },
): () => void {
  container.innerHTML = `
    <h3 class="about-section-title">Updates</h3>
    <div class="about-update-actions"><button type="button" class="about-update-check">Check for updates</button></div>
    <p class="about-update-promise"></p>
    <div class="about-update-result" hidden>
      <p class="about-update-heading"></p>
      <dl class="about-update-versions">
        <dt>Installed version</dt><dd class="about-update-installed"></dd>
        <dt>Available version</dt><dd class="about-update-available"></dd>
      </dl>
      <p class="about-update-notes-title">What’s new</p>
      <div class="about-update-notes" tabindex="0"></div>
      <div class="about-update-choices"></div>
    </div>
    <p class="about-update-status" role="status" aria-live="polite"></p>`;
  const promise = container.querySelector<HTMLElement>('.about-update-promise')!;
  promise.textContent = UPDATE_PROMISE;
  const check = container.querySelector<HTMLButtonElement>('.about-update-check')!;
  const result = container.querySelector<HTMLElement>('.about-update-result')!;
  const heading = container.querySelector<HTMLElement>('.about-update-heading')!;
  const notes = container.querySelector<HTMLElement>('.about-update-notes')!;
  const choices = container.querySelector<HTMLElement>('.about-update-choices')!;
  const status = container.querySelector<HTMLElement>('.about-update-status')!;
  let disposed = false;
  let busy = false;
  let release: AvailableRelease | null = null;

  const say = (text: string) => {
    if (!disposed) status.textContent = text;
  };
  function offer(...buttons: [string, () => void][]): void {
    choices.replaceChildren(
      ...buttons.map(([label, run], index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (index === 0) button.className = 'primary';
        button.addEventListener('click', run);
        return button;
      }),
    );
  }
  const notNow = (): [string, () => void] => [
    'Not now',
    () => {
      result.hidden = true;
      say('');
      check.focus();
    },
  ];
  /** One choice at a time; a failure leaves the installed app as it was. */
  async function step(work: () => Promise<void>): Promise<void> {
    if (disposed || busy) return;
    busy = true;
    check.disabled = true;
    for (const button of choices.querySelectorAll('button')) button.disabled = true;
    try {
      await work();
    } catch (error) {
      say(updateMessage(updateFailureCode(error)));
      for (const button of choices.querySelectorAll('button')) button.disabled = false;
    } finally {
      busy = false;
      if (!disposed) check.disabled = false;
    }
  }

  const restart = () =>
    void step(async () => {
      await requestUpdateRestart();
      say('Closing GenX Streamer to start the new version…');
      options.restart();
    });
  const install = () =>
    void step(async () => {
      const chosen = release!;
      say('Installing…');
      const receipt = await installUpdate(chosen.version);
      if (receipt.restartRequired) {
        heading.textContent = `Version ${chosen.version} is installed`;
        say('It starts the next time you open GenX Streamer, or now if you restart.');
        offer(['Restart now', restart], ['Later', notNow()[1]]);
      } else {
        say('Android will ask you before installing. Your channels and settings stay.');
        offer(notNow());
      }
    });
  const download = () =>
    void step(async () => {
      const chosen = release!;
      say('Downloading…');
      offer(['Cancel download', () => void cancelUpdateDownload()]);
      choices.querySelector('button')!.disabled = false;
      try {
        await downloadUpdate(chosen.version, (received, total) =>
          say(`Downloading… ${Math.floor((received / total) * 100)}% of ${size(total)}`),
        );
      } catch (error) {
        offer(['Download update', download], notNow());
        throw error;
      }
      heading.textContent = `Version ${chosen.version} is downloaded`;
      say('The download matches the official release. Nothing changes until you install it.');
      offer(['Install update', install], notNow());
    });

  check.addEventListener('click', () => {
    if (!updatesAvailable()) {
      say('Updates are checked in the installed app.');
      return;
    }
    void step(async () => {
      say('Checking GitHub…');
      result.hidden = true;
      const found = await checkForUpdate();
      release = found.newer ? found.latest : null;
      if (!found.newer || !found.latest) {
        say(
          found.latest
            ? `GenX Streamer is up to date (version ${found.installed}).`
            : 'No public GenX Streamer release was found on GitHub yet.',
        );
        return;
      }
      heading.textContent = 'Update available';
      container.querySelector('.about-update-installed')!.textContent = found.installed;
      container.querySelector('.about-update-available')!.textContent = found.latest.version;
      notes.textContent = found.latest.notes || found.latest.title;
      result.hidden = false;
      say(`${found.latest.title} · ${size(found.latest.bytes)}`);
      offer(['Download update', download], notNow());
    });
  });
  return () => {
    disposed = true;
  };
}
