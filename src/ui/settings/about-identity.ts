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
 * This copy (About; docs/verify-a-download.md): version, platform and build;
 * on Android the signing certificate's fingerprint and Official release or
 * Development build; and, when asked, the app file's SHA-256 to compare with
 * SHA256SUMS on the release page.
 */
import {
  appChecksum,
  appIdentity,
  fingerprintText,
  type AppIdentity,
} from '../../platform/app-identity';

export function describeIdentity(identity: AppIdentity): { summary: string; status: string } {
  const build = identity.build === 'release' ? 'Release build' : 'Development build';
  const summary = `GenX Streamer ${identity.version} · ${identity.platform} (${identity.architecture}) · ${build}`;
  const status =
    identity.platform === 'Android'
      ? identity.official
        ? 'Official release: signed with the GenX Streamer release key.'
        : 'Development build: not signed with the GenX Streamer release key.'
      : 'Windows copies are unsigned. Compare the checksum with SHA256SUMS on the release page; Windows may still warn about an unknown publisher.';
  return { summary, status };
}

export function mountAboutIdentity(container: HTMLElement): () => void {
  container.innerHTML = `
    <h3 class="about-section-title">This copy</h3>
    <p class="about-identity-summary">Version details are shown in the installed app.</p>
    <p class="about-identity-signer" hidden></p>
    <p class="about-identity-status" hidden></p>
    <div class="about-identity-actions" hidden><button type="button" class="about-identity-checksum">Show checksum</button></div>
    <p class="about-identity-sha" hidden></p>`;
  const summary = container.querySelector<HTMLElement>('.about-identity-summary')!;
  const signer = container.querySelector<HTMLElement>('.about-identity-signer')!;
  const status = container.querySelector<HTMLElement>('.about-identity-status')!;
  const actions = container.querySelector<HTMLElement>('.about-identity-actions')!;
  const button = container.querySelector<HTMLButtonElement>('.about-identity-checksum')!;
  const sha = container.querySelector<HTMLElement>('.about-identity-sha')!;
  let disposed = false;
  void appIdentity().then(
    (identity) => {
      if (disposed || !identity) return;
      const text = describeIdentity(identity);
      summary.textContent = text.summary;
      status.textContent = text.status;
      status.hidden = false;
      if (identity.signers.length) {
        signer.textContent = `Signing certificate SHA-256: ${identity.signers.map(fingerprintText).join(', ')}`;
        signer.hidden = false;
      }
      actions.hidden = false;
    },
    () => {
      if (!disposed) summary.textContent = 'This copy’s details are unavailable right now.';
    },
  );
  const show = () => {
    button.disabled = true;
    sha.hidden = false;
    sha.textContent = 'Calculating…';
    void appChecksum()
      .then(
        (result) => {
          if (!disposed) sha.textContent = `SHA-256 of this copy’s file: ${result.sha256}`;
        },
        () => {
          if (!disposed) sha.textContent = 'The checksum could not be calculated.';
        },
      )
      .finally(() => {
        if (!disposed) button.disabled = false;
      });
  };
  button.addEventListener('click', show);
  return () => {
    disposed = true;
    button.removeEventListener('click', show);
  };
}
