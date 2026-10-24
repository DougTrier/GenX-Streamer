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

import iconUrl from '../../../assets/tmg-retro-tv-96.png';
// Display-size copy (724x241, a third of the source): about 0.7 MiB decoded instead of 6 MiB.
import wordmarkUrl from '../../../assets/genx-wordmark-v2-display.png?no-inline';
// Display-size copy (317x128) of the GenXtra badge; see assets/genxtra-badge-provenance.md.
import badgeUrl from '../../../assets/genxtra-badge-display.png?no-inline';
// The owner's picture-state artwork (October 19, 2026; assets/genx-picture-states-provenance.md):
// nothing playing, opening/buffering, and could not connect. The play screen is
// also the video's poster, in place of Android WebView's default gray play icon.
import playArtUrl from '../../../assets/genx-play-display.jpg?no-inline';
import bufferingArtUrl from '../../../assets/genx-buffering-display.jpg?no-inline';
import failedArtUrl from '../../../assets/genx-could-not-connect-display.jpg?no-inline';
import pausedArtUrl from '../../../assets/genx-paused-display.jpg?no-inline';
export const PICTURE_ART = {
  play: playArtUrl,
  buffering: bufferingArtUrl,
  failed: failedArtUrl,
  paused: pausedArtUrl,
} as const;

export function createShell(root: HTMLElement): void {
  root.innerHTML = `
    <header class="topbar">
      <div class="brand" aria-label="GenX Streamer"><img id="brand-icon" alt=""/><div class="brand-lockup"><img class="brand-wordmark" alt=""/><div class="brand-copy" hidden><strong>GenX</strong><small>Streamer</small></div></div></div>
      <select id="compact-view" aria-label="Viewing panel"><option value="watch">Watch</option><option value="channels">Channels</option></select>
      <div class="top-actions"><button id="live-tv-button" type="button" aria-pressed="true"><span class="nav-icon" aria-hidden="true"></span>Free TV</button><button id="paid-tv-button" type="button" aria-pressed="false"><span class="nav-icon" aria-hidden="true"></span>Paid TV</button><button id="genxtra-button" type="button" aria-pressed="false" aria-label="GenXtra"><img class="genxtra-badge" alt=""/><span class="genxtra-label">GenXtra</span></button><button id="cast-button" aria-label="Cast"><span class="nav-icon" aria-hidden="true"></span>Cast</button><button id="settings-button" aria-label="Open settings"><span class="nav-icon" aria-hidden="true"></span>Settings</button></div>
      <span class="header-callout" aria-hidden="true"><span>SAME</span><span>CHANNELS</span><span>DIFFERENT TIME</span></span>
    </header>
    <main class="workspace">
      <aside class="browser" aria-label="Channels">
        <div class="search-controls"><button id="search-programs" type="button" aria-label="Find channels online" title="Search saved channels and discover more online">Find channels online</button><input id="search" type="search" placeholder="Find channels or category…" aria-label="Search channels" autocomplete="off"/><button id="clear-search" type="button" aria-label="Clear search" title="Clear search" hidden>×</button><div id="speech-control"></div></div>
        <div id="genxtra-browse-filters" class="genxtra-browse-filters" hidden><select id="genxtra-kind-select" aria-label="GenXtra content"><option value="all">All videos</option><option value="tv">TV Shows</option><option value="movie">Movies</option><option value="short">Shorts</option><option value="favorites">Favorites</option></select><select id="genxtra-decade-select" aria-label="GenXtra source-listed decade"><option value="all">All years</option><option value="1960">1960s</option><option value="1970">1970s</option><option value="1980">1980s</option><option value="1990">1990s</option><option value="2000">2000s</option><option value="2010">2010s</option><option value="2020">2020s+</option></select></div>
        <p id="genxtra-filter-status" class="genxtra-filter-status" hidden>All years · Source-listed years</p>
        <div class="browse-options"><nav class="filters" aria-label="Channel filters">
          <button data-filter="all" aria-pressed="true">All</button><button data-filter="movies" aria-pressed="false">Movies</button><button data-filter="news" aria-pressed="false">News</button><button data-filter="sports" aria-pressed="false">Sports</button><button data-filter="unresponsive" aria-pressed="false" hidden>Not responding</button>
        </nav>
        <select id="compact-filter" aria-label="Channel category"><option value="all">All channels</option><option value="favorites">Favorites</option><option value="movies">Movies</option><option value="news">News</option><option value="sports">Sports</option><option value="unresponsive" hidden disabled>Not responding</option></select>
        <div class="sidehead"><span id="channel-count">0 channels</span><button class="row-filter" data-filter="favorites" aria-pressed="false" aria-label="Favorites" title="Favorites">Favs</button><details class="geography-options"><summary aria-label="Location and sort" title="Location and sort">Loc &amp; Sort</summary><div id="geography-controls"></div></details><button id="guide-button" class="row-filter" type="button" aria-pressed="false" aria-label="Free TV guide" title="Free TV guide" data-library="free">Guide</button></div></div>
        <div id="dead-channels" class="dead-channels" hidden><span id="dead-channels-text"></span><button id="remove-dead-channels" type="button">Remove all</button></div>
        <section id="inline-source-scan" class="inline-source-scan" aria-label="Channel discovery" hidden><p id="inline-scan-status" role="status"></p><p id="inline-scan-error" role="alert" hidden></p><div class="inline-scan-actions"><button id="inline-scan-stop" type="button" hidden>Stop</button><button id="inline-scan-continue" type="button" hidden>Finish scan</button><button id="inline-scan-refresh" type="button" aria-label="Refresh: find new channels and remove dead ones" title="Find new channels and remove dead ones" hidden>Refresh</button><button id="inline-scan-rescan" type="button" aria-label="Rescan: check every channel again from scratch" title="Check every channel again from scratch" hidden>Rescan</button></div></section>
        <div id="channel-list" class="channel-list" tabindex="0" aria-label="Channel list"><div id="channel-spacer"></div><div id="channel-rows"></div><div id="list-empty" class="list-empty">Use the search magnifier to scan the included channel sources.</div></div>
        <div id="genxtra-library" hidden></div><p id="genxtra-discovery-progress" role="status" aria-live="polite" hidden></p>
        <footer class="sidefoot"><span id="source-status">Your channels, your choice.</span><button id="refresh-button" aria-label="Refresh saved URL sources" title="Refresh saved URL sources" disabled>Refresh</button></footer>
      </aside>
      <div id="divider" role="separator" aria-orientation="vertical" aria-label="Resize channel panel" aria-valuemin="240" aria-valuemax="600" aria-valuenow="300" tabindex="0"></div>
      <section class="view" aria-label="Player">
        <div class="watch-card">
        <div class="watchhead"><div class="watch-details"><small class="eyebrow">NOW WATCHING</small><h2 id="watch-title">Make yourself comfortable.</h2></div></div>
        <div class="screen" id="screen"><p id="picture-note" class="picture-note" hidden></p><video id="video" playsinline preload="none" aria-label="Channel video" poster="${playArtUrl}"></video><button id="replay-overlay" class="replay-overlay" type="button" aria-label="Instant replay: back 10 seconds at a quarter speed" hidden disabled>⟲</button><div id="player-overlay" class="player-overlay"><div class="picture-stage"><div class="picture-art"><img class="picture-image" alt=""/><span class="picture-spinner" aria-hidden="true"></span><button id="retry-button" aria-label="Try again" hidden>Retry</button><button id="picture-resume" type="button" aria-label="Resume" hidden>Resume</button></div></div><div class="overlay-copy"><img id="welcome-icon" alt=""/><h3 id="overlay-title">Your next favorite channel.</h3><p id="overlay-message">Choose a channel, or use channel search to discover more.</p></div></div></div>
        <div class="dock"><div id="vod-transport" class="vod-transport" aria-label="On-demand playback position" hidden><button id="vod-rewind" type="button" aria-label="Rewind ten seconds" disabled>−10s</button><output id="vod-position" aria-label="Current playback position">0:00</output><button id="vod-forward" type="button" aria-label="Forward ten seconds" disabled>+10s</button></div><div id="playback-status" role="status" aria-live="polite">Ready when you are</div><div id="replay-transport" class="vod-transport replay-transport" role="group" aria-label="Instant replay" hidden><button id="replay-back" type="button" aria-label="Back ten more seconds">−10s</button><button id="replay-frame-back" type="button" aria-label="One picture back">◀|</button><button id="replay-pause" type="button" aria-label="Pause the replay">Pause</button><button id="replay-frame-forward" type="button" aria-label="One picture forward">|▶</button><button id="replay-speed" type="button" aria-label="Replay speed: a quarter">¼×</button><output id="replay-position" aria-label="Behind live">—</output><button id="replay-live" type="button" aria-label="Back to live">Live</button></div><div class="controls"><button id="pause-button" disabled>Pause</button><button id="replay-button" type="button" aria-label="Instant replay: back 10 seconds at a quarter speed" hidden disabled>Replay</button><button id="vod-stop" type="button" hidden disabled>Stop</button><button id="mute-button" aria-pressed="false">Mute</button><button id="expand-button" aria-pressed="false">Expand</button><button id="fullscreen-button" aria-pressed="false">Full screen</button><button id="dock-cast" type="button" aria-label="Cast to a TV">Cast</button></div><div class="secondary-controls"><label class="volume-label">Volume<input id="volume" type="range" min="0" max="1" step="0.05" value="0.8" aria-label="Volume"/></label><button id="captions-button" aria-label="Closed captions" aria-pressed="false" disabled>CC</button><div id="video-quality"></div><div id="audio-tracks" hidden></div></div><div class="channel-actions"><button id="favorite-button" disabled aria-pressed="false">☆ Favorite</button><button id="share-channel" type="button" disabled>Share</button><button id="remove-channel" disabled>Remove channel</button></div></div>
        </div>
        <div id="primary-view-host" hidden></div>
        <section id="archive-details" aria-label="Selected show or movie" hidden></section>
      </section>
    </main>
    <footer class="app-signoff" aria-label="GenX Streamer"><span>GenX Streamer</span><span>SIMPLE TV · BIG MEMORIES</span></footer>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
    <dialog id="cast-dialog"><div class="dialog-head"><h2>Watch on your TV</h2><button data-close="cast-dialog" aria-label="Close casting">×</button></div><p id="cast-status" role="status"></p><div class="dialog-actions"><button id="cast-discover">Find devices</button><button id="cast-stop" disabled>Stop casting</button></div><div id="cast-devices" class="cast-devices"></div><details><summary>Connect a Chromecast by address</summary><p>If discovery misses your TV, enter its local IP address. Checking the address does not start playback.</p><form id="cast-known-form"><label>TV address<input id="cast-known-address" required maxlength="45" autocomplete="off" placeholder="Local IP address"/></label><label>Name<input id="cast-known-name" maxlength="80" autocomplete="off" placeholder="My TV"/></label><button id="cast-known-check" type="submit">Check receiver</button></form></details></dialog>
    <dialog id="close-dialog"><h2>Closing could not finish</h2><p>The app is still open while cleanup is unconfirmed. Retry closing, or force quit. Force quit may leave a receiver playing or sharing connections unconfirmed.</p><div class="dialog-actions"><button id="close-retry">Retry closing</button><button id="close-force">Force quit</button></div></dialog>
    <dialog id="import-dialog"><form id="import-form"><div class="dialog-head"><h2>Add channels</h2><button type="button" data-close="import-dialog" aria-label="Close import">×</button></div><p id="import-explanation">Scan to find channels from the included sources. Responding channels are added automatically.</p><div class="dialog-actions"><button type="button" class="primary" id="automatic-scan-button">Scan</button><button type="button" id="rescan-automatic-button" hidden>Rescan</button></div><details id="custom-source-options"><summary>Add your own source</summary><label><span id="source-link-label">Source URL</span><input id="playlist-url" type="url" placeholder="Enter your source URL"/></label><label class="check"><input id="allow-http" type="checkbox"/>Allow unencrypted HTTP for this source and its channels</label><div class="dialog-actions"><button type="submit" class="primary" id="load-button">Scan channels</button><button type="button" id="find-sources-button">Find sources</button></div><div id="source-file-area"><div class="or">or choose a file</div><input id="playlist-file" type="file" aria-label="Choose source file"/></div></details><p id="import-status" role="status"></p><button type="button" id="cancel-import" hidden>Cancel import</button></form></dialog>
    <dialog id="settings-dialog"><div class="dialog-head"><h2>Settings</h2><button data-close="settings-dialog" aria-label="Close settings">×</button></div><h3>Your sources</h3><div class="channel-transfer-controls"><button id="import-button" type="button">Import playlist</button><button id="export-channels-button" type="button">Export channel list</button></div><p id="channel-transfer-status" role="status"></p><p>Import an M3U playlist or export your saved channels. Full backups also preserve favorites and settings.</p><label>Automatic updates<select id="daily-source-refresh" aria-label="Automatic updates"><option value="off">Off</option><option value="hourly">Hourly</option><option value="every6hours">4 times daily</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="every2weeks">Every 2 weeks</option><option value="monthly">Monthly</option></select></label><p>Checks while the app is open. Favorites and removed channels are preserved. If an update fails, your saved channels and previous program guide stay available.</p><p id="source-refresh-status" role="status"></p><button id="restore-channels" disabled>Restore removed channels</button><div id="region-settings"></div><label class="check"><input id="voice-search-consent" type="checkbox"/>Allow online voice search on this device</label><label class="check"><input id="hide-adult-channels" type="checkbox" checked/>Hide adult channels (Free TV and Paid TV)</label><h3>Advanced</h3><p>Manage individual sources and program-guide settings.</p><div id="source-list"></div><button type="button" id="advanced-guide-button">Program guide settings</button><button type="button" id="event-history-button">Event history</button><details><summary>Discovery providers</summary><div id="provider-management"></div><p>Edit the channel and guide sources used by Scan. Clearing a provider list disables those suggestions.</p><label>Provider configuration<textarea id="provider-configuration" rows="8" spellcheck="false"></textarea></label><button type="button" id="save-provider-configuration">Save discovery providers</button><button type="button" id="restore-provider-configuration">Restore suggested sources</button><p id="provider-configuration-status" role="status"></p><p>For a longer program guide, export a channel list for the iptv-org grabber, run it yourself, then add its guide address under Program guide settings.</p><button type="button" id="export-guide-grabber">Export 7-day guide grabber list</button><p id="guide-grabber-status" role="status"></p></details><p>Keep a copy of your preferences.</p><div class="dialog-actions"><button id="export-button">Export settings</button><label class="file-button">Import settings<input id="settings-file" type="file" accept=".json,application/json"/></label></div>
    <h3>Backup and migration</h3><p>Save all channels, favorites and removed channels together.</p><div class="dialog-actions"><button id="backup-export">Export full backup</button><label class="file-button">Import full backup<input id="backup-file" type="file" accept=".json,application/json"/></label></div><details><summary>Import from the previous app</summary><p>Choose your saved TMG JSON file. Review the channel counts before saving.</p><label>Source name<input id="legacy-source-name" maxlength="512" placeholder="My previous channels"/></label><label class="check"><input id="legacy-allow-http" type="checkbox"/>Allow HTTP for imported channels</label><input id="legacy-file" type="file" aria-label="Choose previous app JSON" accept=".json,application/json"/></details>
    <h3>Find channels</h3><p>Scan your saved sources, then save the channels that respond. Add a playlist file again to refresh it.</p><div id="source-scan-settings"></div>
    <div id="sharing-settings"><p>Encrypted LAN sharing is available in the Windows app.</p></div><p class="storage-note" id="storage-status"></p><div class="dialog-actions settings-footer"><button type="button" id="about-button" aria-label="About GenX Streamer">About</button><button type="button" id="exit-button">Exit app</button></div></dialog>
    <dialog id="transfer-dialog"><h2>Review your import</h2><p>Full backups replace saved channels and preferences. Previous-app imports preserve other sources.</p><p id="transfer-status" role="status"></p><div class="dialog-actions"><button id="transfer-cancel">Cancel</button><button id="transfer-apply" disabled>Save import</button></div></dialog>`;
  for (const id of ['brand-icon', 'welcome-icon']) {
    const image = root.querySelector(`#${id}`) as HTMLImageElement;
    // Decorative artwork must never replace the text or change reserved layout space.
    image.addEventListener('error', () => {
      image.style.visibility = 'hidden';
    });
    image.src = iconUrl;
  }
  const wordmark = root.querySelector('.brand-wordmark') as HTMLImageElement;
  const brandCopy = root.querySelector('.brand-copy') as HTMLElement;
  wordmark.addEventListener('error', () => {
    wordmark.hidden = true;
    brandCopy.hidden = false;
  });
  wordmark.src = wordmarkUrl;
  // The badge carries the GenXtra name; its text label returns if the artwork fails.
  const badge = root.querySelector('.genxtra-badge') as HTMLImageElement;
  badge.addEventListener('error', () => {
    badge.hidden = true;
    badge.parentElement!.dataset.badge = 'failed';
  });
  badge.src = badgeUrl;
  // Keep modal close controls fixed while long forms scroll inside their owner.
  for (const id of ['import-form', 'cast-dialog']) {
    const owner = root.querySelector(`#${id}`)!;
    const header = owner.querySelector('.dialog-head')!;
    const body = document.createElement('div');
    body.className = 'dialog-body';
    for (const child of [...owner.childNodes]) if (child !== header) body.append(child);
    header.after(body);
  }
}
