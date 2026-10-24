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
import { describe, expect, it } from 'vitest';
import {
  CHECK_MS,
  DOWNLOAD_MS,
  DOWNLOADER,
  frontKind,
  GENX,
  NO_ANSWER_MS,
  observe,
  sent,
  stepText,
  tvFailure,
  type CheckIn,
  type TvWatch,
} from '../../src/sharing/tv-install';
import { tvFailureCode } from '../../src/platform/tv-remote';

// The apps a Google TV Streamer reported in front during the October 24, 2026 test.
const HOME = 'com.google.android.apps.tv.launcherx';
const STUB = 'com.android.tv.frameworkpackagestubs';
const STORE = 'com.android.vending';
const INSTALLER = 'com.google.android.packageinstaller';
const SETTINGS = 'com.android.tv.settings';

/** Android's own "Open with" list, as the Sansui reported it. */
const CHOOSER = 'android';

/** Plays what the TV reports (and the TV's GenX check-in), in order: each step and action. */
function play(start: TvWatch, reports: [string, number, CheckIn?][], connected = true) {
  let watch = start;
  return reports.map(([front, at, checkIn]) => {
    const next = observe(watch, connected, front, checkIn ?? null, at);
    watch = next.watch;
    return [next.watch.step, next.action];
  });
}

describe('Install on TV', () => {
  it('reads the app in front of the TV', () => {
    expect(frontKind(HOME)).toBe('home');
    expect(frontKind(STUB)).toBe('stub');
    expect(frontKind(STORE)).toBe('store');
    expect(frontKind(INSTALLER)).toBe('installer');
    expect(frontKind('com.android.packageinstaller')).toBe('installer');
    expect(frontKind(SETTINGS)).toBe('settings');
    expect(frontKind(DOWNLOADER)).toBe('downloader');
    expect(frontKind(GENX)).toBe('genx');
    expect(frontKind('com.example.browser')).toBe('other');
    expect(frontKind(CHOOSER)).toBe('chooser');
    expect(frontKind('')).toBe('none');
  });

  it('a TV with a download app goes from sending to approval to a verified install', () => {
    expect(
      play(sent(HOME, 0), [
        [DOWNLOADER, 500],
        [SETTINGS, 9_000],
        [DOWNLOADER, 12_000],
        [INSTALLER, 20_000],
        [INSTALLER, 21_000],
        [DOWNLOADER, 30_000],
        [GENX, 31_000],
        [GENX, 32_000, 'same'],
      ]),
    ).toEqual([
      ['downloading', null],
      ['permission', null],
      ['downloading', null],
      ['approve', null],
      ['approve', null],
      // The installer closed: GenX asks the TV's GenX to report which file it runs.
      ['checking', 'open-genx'],
      // GenX in front is not proof yet (it could be an older copy) ...
      ['checking', null],
      // ... the report of the very file shared is.
      ['done', null],
    ]);
  });

  it('a TV with no download app gets the helper, then GenX is sent to it', () => {
    expect(
      play(sent(HOME, 0), [
        [STUB, 300],
        [STORE, 2_000],
        [STORE, 40_000],
        [DOWNLOADER, 60_000],
        [DOWNLOADER, 61_000],
      ]),
    ).toEqual([
      ['helper', 'get-helper'],
      ['helper', null],
      ['helper', null],
      ['sending', 'send'],
      ['downloading', null],
    ]);
  });

  it('a TV with several apps for links asks the person to pick one (the Sansui)', () => {
    expect(
      play(sent(HOME, 0), [
        [CHOOSER, 400],
        [CHOOSER, 20_000],
        [DOWNLOADER, 25_000],
      ]),
    ).toEqual([
      ['choose', null],
      ['choose', null],
      ['downloading', null],
    ]);
    expect(play({ step: 'choose', since: 0, baseline: HOME }, [[HOME, 5_000]])).toEqual([
      ['stalled', null],
    ]);
  });

  it('an older copy that opens instead is never taken for the install', () => {
    const checking: TvWatch = { step: 'checking', since: 0, baseline: HOME };
    expect(play(checking, [[GENX, 1_000, 'different']])).toEqual([['older-copy', null]]);
    // An older copy without the check (it never reports): GenX in front, no report.
    expect(
      play(checking, [
        [GENX, 1_000],
        [GENX, CHECK_MS],
      ]),
    ).toEqual([
      ['checking', null],
      ['older-copy', null],
    ]);
    expect(stepText('older-copy', true)).toBe(
      'Your TV has an older GenX Streamer. Uninstall it on your TV, then try again.',
    );
  });

  it('a link nothing answers is the same as no download app', () => {
    expect(
      play(sent(HOME, 0), [
        [HOME, NO_ANSWER_MS - 1],
        [HOME, NO_ANSWER_MS],
      ]),
    ).toEqual([
      ['sending', null],
      ['helper', 'get-helper'],
    ]);
  });

  it('says installed only when the TV reports the file shared', () => {
    const approving: TvWatch = { step: 'approve', since: 0, baseline: HOME };
    expect(
      play(approving, [
        [HOME, 1_000],
        [HOME, 1_000 + CHECK_MS],
      ]),
    ).toEqual([
      ['checking', 'open-genx'],
      ['not-installed', null],
    ]);
    expect(stepText('done', true)).toBe('Ready! GenX Streamer is installed.');
    expect(stepText('not-installed', true)).toBe(
      'Downloaded, but not installed. If your TV has an older GenX Streamer, uninstall it first.',
    );
    expect(stepText('not-installed', false)).toBe("Couldn't install GenX Streamer.");
  });

  it('a stalled download and a lost connection end with one plain line', () => {
    const downloading: TvWatch = { step: 'downloading', since: 0, baseline: HOME };
    expect(play(downloading, [[DOWNLOADER, DOWNLOAD_MS]])).toEqual([['stalled', null]]);
    expect(play(downloading, [[DOWNLOADER, 10]], false)).toEqual([['disconnected', null]]);
    // Finished steps stay finished.
    expect(play({ step: 'done', since: 0, baseline: HOME }, [[HOME, 1]], false)).toEqual([
      ['done', null],
    ]);
    expect(stepText('disconnected', false)).toBe("Couldn't connect.");
  });

  it('never shows network details: refusals become fixed codes and short lines', () => {
    expect(tvFailureCode('tv-pair-wrong-code')).toBe('tv-pair-wrong-code');
    expect(tvFailureCode(new Error('java.net.SocketTimeoutException: 192.168.1.30:6466'))).toBe(
      'tv-unavailable',
    );
    expect(tvFailure('tv-unavailable')).toBe("Couldn't connect.");
    expect(tvFailure('tv-pair-wrong-code')).toBe("That code didn't match.");
    for (const step of [
      'sending',
      'choose',
      'older-copy',
      'helper',
      'downloading',
      'permission',
      'approve',
      'checking',
      'done',
      'not-installed',
      'stalled',
      'disconnected',
    ] as const) {
      const line = stepText(step, false);
      expect(line.length).toBeLessThanOrEqual(100);
      expect(line).not.toMatch(/APK|IP|URL|port|http|Downloader/u);
    }
  });
});
