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
 * Install on TV, step by step (docs/send-to-tv.md): what the TV is doing,
 * read from the app it reports in front, and what GenX does next. GenX only
 * opens links; every approval on the TV is the person's (TV-004).
 */

export type TvStep =
  | 'sending'
  | 'choose'
  | 'helper'
  | 'downloading'
  | 'permission'
  | 'approve'
  | 'checking'
  | 'done'
  | 'older-copy'
  | 'unconfirmed'
  | 'not-installed'
  | 'stalled'
  | 'disconnected';

/** What GenX does next: open the helper's store page, send GenX again, ask the TV to open GenX. */
export type TvAction = 'get-helper' | 'send' | 'open-genx' | null;

/**
 * What GenX on the TV reported to the phone's nearby share (TV-006): it runs
 * the very file shared ('same'), another copy ('different'), or nothing yet.
 */
export type CheckIn = 'same' | 'different' | null;

export interface TvWatch {
  step: TvStep;
  /** When this step began (ms). */
  since: number;
  /** The app in front before GenX opened its link. */
  baseline: string;
}

export const DOWNLOADER = 'com.esaba.downloader';
export const GENX = 'com.tmg.tv';

/** How long a link may go unanswered before the TV is taken to have no app for it. */
export const NO_ANSWER_MS = 8_000;
/** How long GenX waits for the TV's GenX to report after the installer. */
export const CHECK_MS = 10_000;
/** How long a download may run before it is called stalled. */
export const DOWNLOAD_MS = 5 * 60_000;

export type FrontKind =
  | 'genx'
  | 'installer'
  | 'settings'
  | 'store'
  | 'stub'
  | 'chooser'
  | 'home'
  | 'downloader'
  | 'other'
  | 'none';

export function frontKind(app: string): FrontKind {
  if (!app) return 'none';
  if (app === GENX) return 'genx';
  if (/packageinstaller/u.test(app)) return 'installer';
  if (/^com\.(?:android|google\.android)\.(?:tv\.)?settings$/u.test(app)) return 'settings';
  if (app === 'com.android.vending') return 'store';
  if (app === 'com.android.tv.frameworkpackagestubs') return 'stub';
  // Android itself: its "Open with" list when several apps can open a link.
  if (app === 'android') return 'chooser';
  if (/launcher/u.test(app)) return 'home';
  if (app === DOWNLOADER) return 'downloader';
  return 'other';
}

/** A watch that has just sent GenX's link to the TV. */
export const sent = (baseline: string, now: number): TvWatch => ({
  step: 'sending',
  since: now,
  baseline,
});

const to = (step: TvStep, now: number, watch: TvWatch): TvWatch =>
  step === watch.step ? watch : { ...watch, step, since: now };

export const finishedSteps: readonly TvStep[] = [
  'done',
  'older-copy',
  'unconfirmed',
  'not-installed',
  'stalled',
  'disconnected',
];

/** The next step from what the TV reports, and what GenX should do now. */
export function observe(
  watch: TvWatch,
  connected: boolean,
  front: string,
  checkIn: CheckIn,
  now: number,
): { watch: TvWatch; action: TvAction } {
  const stay = { watch, action: null };
  const go = (step: TvStep, action: TvAction = null) => ({ watch: to(step, now, watch), action });
  if (finishedSteps.includes(watch.step)) return stay;
  if (!connected) return go('disconnected');
  // The TV's GenX reported the very file shared: installed (TV-006).
  if (checkIn === 'same') return go('done');
  const kind = frontKind(front);
  const waited = now - watch.since;
  switch (watch.step) {
    case 'sending':
      if (kind === 'chooser') return go('choose');
      if (kind === 'installer') return go('approve');
      if (kind === 'settings' && front !== watch.baseline) return go('permission');
      if (kind === 'downloader' || (kind === 'other' && front !== watch.baseline))
        return go('downloading');
      // Nothing on the TV took the link: get the download helper (TV-009).
      if (kind === 'stub' || waited >= NO_ANSWER_MS) return go('helper', 'get-helper');
      return stay;
    case 'choose':
      if (kind === 'chooser') return stay;
      if (kind === 'installer') return go('approve');
      if (kind === 'settings') return go('permission');
      if (kind === 'downloader' || kind === 'other') return go('downloading');
      // The list was closed without a choice.
      return go('stalled');
    case 'helper':
      // Installed and opened from the store: send GenX to it.
      if (kind === 'downloader') return { watch: sent(front, now), action: 'send' };
      return stay;
    case 'downloading':
    case 'permission':
      if (kind === 'installer') return go('approve');
      if (kind === 'settings') return go('permission');
      if (kind === 'genx') return go('checking', 'open-genx');
      if (watch.step === 'permission' && (kind === 'downloader' || kind === 'other'))
        return go('downloading');
      if (watch.step === 'downloading' && waited >= DOWNLOAD_MS) return go('stalled');
      return stay;
    case 'approve':
      // Google Play Protect's scan prompt belongs to the Play Store (seen on the Streamer).
      if (kind === 'installer' || kind === 'store') return stay;
      if (kind === 'settings') return go('permission');
      // The installer closed (or GenX was opened from it): ask the TV's GenX to report.
      return go('checking', 'open-genx');
    case 'checking':
      if (checkIn === 'different') return go('older-copy');
      if (kind === 'installer' || kind === 'store') return go('approve');
      // GenX opened but did not report: it is there, its version unknown (never "installed").
      if (waited >= CHECK_MS) return go(kind === 'genx' ? 'unconfirmed' : 'not-installed');
      return stay;
    default:
      return stay;
  }
}

/**
 * One short line for each step, as the person reads it (TV-005: no
 * technical words). "Installed" is said only once the TV's GenX reported the
 * file shared (TV-006); a finished download alone is said as a download.
 */
export function stepText(step: TvStep, downloaded: boolean): string {
  switch (step) {
    case 'sending':
    case 'downloading':
      return 'Sending GenX Streamer…';
    case 'choose':
      return 'On your TV, pick an app to open it.';
    case 'helper':
      return 'Your TV needs a download helper. Press Install on your TV to continue.';
    case 'permission':
    case 'approve':
      return 'Please approve on your TV.';
    case 'checking':
      return 'Checking your TV…';
    case 'done':
      return 'Ready! GenX Streamer is installed.';
    case 'older-copy':
      return 'Your TV has an older GenX Streamer. Uninstall it on your TV, then try again.';
    case 'unconfirmed':
      return "GenX Streamer is on your TV, but its version couldn't be checked.";
    case 'not-installed':
      return downloaded
        ? 'Downloaded, but not installed. If your TV has an older GenX Streamer, uninstall it first.'
        : "Couldn't install GenX Streamer.";
    case 'stalled':
      return "Couldn't finish sending.";
    case 'disconnected':
      return "Couldn't connect.";
  }
}

/** One short line for a refusal; the card adds one Try Again button. */
export function tvFailure(code: string): string {
  switch (code) {
    case 'tv-pair-wrong-code':
      return "That code didn't match.";
    case 'tv-pair-refused':
    case 'tv-pair-expired':
    case 'tv-pair-failed':
      return "Your TV didn't finish pairing.";
    case 'nearby-no-network':
      return 'Connect this phone to the same Wi-Fi as your TV.';
    case 'share-app-development':
      return 'Install on TV works from official releases of GenX Streamer.';
    case 'share-app-split':
      return "This copy of GenX Streamer can't be sent.";
    default:
      return "Couldn't connect.";
  }
}
