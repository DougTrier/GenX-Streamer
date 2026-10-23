/**
 * Android app sites, on their own APK sites tab on Android (owner request, October 19,
 * 2026): one press opens the site, no long addresses to type. An app's APK link
 * on these sites downloads and opens in Android's installer (W16,
 * docs/web-viewer-invariants.md); app bundles (XAPK/APKM) are refused with a
 * note. Plain links only: GenX does not scrape or mirror these sites. Each
 * answered on October 19, 2026 (APKPure, which refuses plain requests, loaded
 * in GenX's viewer through its Cloudflare check); APKCombo was left out because
 * its domain no longer resolves.
 */
export interface AppSite {
  readonly title: string;
  readonly url: string;
  readonly note: string;
}

export const APP_SITES: readonly AppSite[] = [
  { title: 'F-Droid', url: 'https://f-droid.org/en/packages/', note: 'Free and open-source apps' },
  { title: 'IzzyOnDroid', url: 'https://apt.izzysoft.de/fdroid/', note: 'More open-source apps' },
  {
    title: 'GitHub',
    url: 'https://github.com/search?q=android+apk&type=repositories',
    note: 'Apps from their projects: open Releases, then the .apk',
  },
  {
    title: 'GitLab',
    url: 'https://gitlab.com/explore/projects/topics/android',
    note: 'Android projects and their releases',
  },
  {
    title: 'Codeberg',
    url: 'https://codeberg.org/explore/repos?q=android',
    note: 'Android projects and their releases',
  },
  { title: 'APKPure', url: 'https://apkpure.net/', note: 'Choose APK, not XAPK' },
  { title: 'Uptodown', url: 'https://www.uptodown.com/', note: 'App catalog' },
  { title: 'Aptoide', url: 'https://en.aptoide.com/', note: 'App catalog' },
  { title: 'itch.io', url: 'https://itch.io/games/platform-android', note: 'Android games' },
  { title: 'APKMirror', url: 'https://www.apkmirror.com/', note: 'Choose APK, not an APK bundle' },
];
