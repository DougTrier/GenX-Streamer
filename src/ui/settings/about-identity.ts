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
 * This copy (About; docs/verify-a-download.md): one line with the version,
 * platform and build, and, when asked, the app file's SHA-256 to compare with
 * SHA256SUMS on the release page. The signing certificate is checked inside
 * the app (only official copies send themselves) but not shown here: the
 * owner's decision, October 24, 2026 (docs/verify-a-download.md says how to
 * check it with apksigner).
 */
import { appChecksum, appIdentity, type AppIdentity } from '../../platform/app-identity';

export function describeIdentity(identity: AppIdentity): { summary: string } {
  const build =
    identity.platform === 'Android' && identity.build === 'release' && !identity.official
      ? 'Unofficial build'
      : identity.build === 'release'
        ? 'Release build'
        : 'Development build';
  return {
    summary: `GenX Streamer ${identity.version} · ${identity.platform} (${identity.architecture}) · ${build}`,
  };
}

export function mountAboutIdentity(container: HTMLElement): {
  load: () => void;
  dispose: () => void;
} {
  container.innerHTML = `
    <h3 class="about-section-title">This copy</h3>
    <p class="about-identity-summary">Version details are shown in the installed app.</p>
    <div class="about-identity-actions" hidden><button type="button" class="about-identity-checksum">Show checksum</button></div>
    <p class="about-identity-sha" hidden></p>`;
  const summary = container.querySelector<HTMLElement>('.about-identity-summary')!;
  const actions = container.querySelector<HTMLElement>('.about-identity-actions')!;
  const button = container.querySelector<HTMLButtonElement>('.about-identity-checksum')!;
  const sha = container.querySelector<HTMLElement>('.about-identity-sha')!;
  let disposed = false;
  let loaded = false;
  /** Read when About opens (never at start-up). */
  const load = () => {
    if (loaded || disposed) return;
    loaded = true;
    void appIdentity().then(
      (identity) => {
        if (disposed || !identity) return;
        summary.textContent = describeIdentity(identity).summary;
        actions.hidden = false;
      },
      () => {
        loaded = false;
        if (!disposed) summary.textContent = 'This copy’s details are unavailable right now.';
      },
    );
  };
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
  return {
    load,
    dispose: () => {
      disposed = true;
      button.removeEventListener('click', show);
    },
  };
}
