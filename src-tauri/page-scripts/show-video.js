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

(() => {
  window.__genxVideo = true;
  const size = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const fits = (e) => { const r = e.getBoundingClientRect(); return r.width >= 160 && r.height >= 90; };
  const all = (selector, root = document, out = []) => {
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) all(selector, e.shadowRoot, out); });
    return out;
  };
  const up = (e) => e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
  const restore = () => {
    for (const [e, css] of window.__genxTouched || []) {
      e.style.cssText = css;
      e.removeAttribute('data-genx-player');
      e.removeAttribute('data-genx-anc');
    }
    window.__genxTouched = [];
    for (const sheet of window.__genxSheets || []) sheet.remove();
    window.__genxSheets = [];
    if (window.__genxGuard) { window.__genxGuard.disconnect(); window.__genxGuard = null; }
    window.__genxHeld = null;
    document.getElementById('genx-backdrop')?.remove();
  };
  window.__genxRestore = restore;
  const touch = (e, extra) => {
    window.__genxTouched.push([e, e.style.cssText]);
    e.style.cssText += extra;
  };
  // YouTube's mobile site picks 360p for itself whatever the screen. Full
  // screen asks its player for the best level the screen can show, never above.
  const sharpen = () => {
    const player = document.getElementById('movie_player');
    if (typeof player?.setPlaybackQualityRange !== 'function') return;
    try {
      const tall = Math.round(screen.height * devicePixelRatio);
      const heights = { highres: 4320, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360 };
      const level = (player.getAvailableQualityLevels?.() ?? []).find((l) => heights[l] <= tall);
      if (level && player.getPlaybackQuality?.() !== level) player.setPlaybackQualityRange(level, level);
    } catch { /* the site's player, its rules */ }
  };
  const run = () => {
    if (!window.__genxVideo) return 'off';
    sharpen();
    if (window.__genxHeld && window.__genxHeld.isConnected) return 'kept';
    // The video being watched: one playing here, else the frame whose video
    // started most recently (frames report it), else the biggest.
    const largest = (list) => list.sort((a, b) => size(b) - size(a))[0];
    const videos = all('video').filter(fits);
    const frames = all('iframe').filter(fits);
    const playing = largest(videos.filter((v) => !v.paused && v.readyState > 2));
    const reported = frames.filter((f) => f.dataset.genxPlaying).sort((a, b) => Number(b.dataset.genxPlaying) - Number(a.dataset.genxPlaying))[0];
    // Only a frame that is a video player stands in for the video: one that may
    // go full screen or autoplay, or comes from a video host. Schedules, ads and
    // other boxes never do; with no player the page itself fills the screen.
    const playerLike = (f) =>
      f.hasAttribute('allowfullscreen') ||
      /fullscreen|autoplay|encrypted-media/.test(f.getAttribute('allow') || '') ||
      /youtube|vimeo|jwplayer|jwpcdn|brightcove|twitch|dailymotion|livestream|player|video|stream/i.test(f.src || '');
    const pick = playing || reported || largest(videos) || largest(frames.filter(playerLike));
    if (!pick) return 'none';
    // A player frame scales its own picture to the frame's width, so on a wide
    // screen (21:9, 32:9) a full-window frame runs off the top and bottom. The
    // frame keeps its own shape instead: the largest such box, centred.
    const box = pick.getBoundingClientRect();
    const shape = pick.tagName === 'IFRAME' ? Math.min(2.4, Math.max(1, box.width / box.height || 16 / 9)) : 0;
    restore();
    // Anything that makes an ancestor a containing block would trap the
    // fixed video inside the page (transforms, containment, filters), and
    // an ancestor's stacking context would let the site's header paint over it.
    const ancestor = 'transform:none!important;translate:none!important;scale:none!important;rotate:none!important;filter:none!important;backdrop-filter:none!important;perspective:none!important;contain:none!important;container-type:normal!important;content-visibility:visible!important;will-change:auto!important;z-index:auto!important;isolation:auto!important;transition:none!important';
    const roots = new Set();
    for (let p = up(pick); p && p !== document.documentElement; p = up(p)) {
      touch(p, ';' + ancestor);
      p.setAttribute('data-genx-anc', '');
      roots.add(p.getRootNode());
    }
    const fill = shape
      ? `width:min(100vw, calc(100vh * ${shape}))!important;height:min(100vh, calc(100vw / ${shape}))!important;margin:auto!important`
      : 'width:100vw!important;height:100vh!important;margin:0!important';
    const player = `position:fixed!important;inset:0!important;top:0!important;left:0!important;right:0!important;bottom:0!important;${fill};max-width:none!important;max-height:none!important;padding:0!important;transform:none!important;z-index:2147483647!important;background:#000!important;object-fit:contain!important`;
    touch(pick, ';' + player);
    pick.setAttribute('data-genx-player', '');
    roots.add(pick.getRootNode());
    // Players rewrite their own size and place (YouTube does on every
    // resize). The same rules in a style sheet win over those writes, in
    // every document or shadow root holding a marked element (W02).
    window.__genxSheets = [];
    for (const root of roots) {
      const sheet = document.createElement('style');
      sheet.textContent = `[data-genx-player]{${player}}[data-genx-anc]{${ancestor}}`;
      (root === document ? document.documentElement : root).appendChild(sheet);
      window.__genxSheets.push(sheet);
    }
    // A site that strips the marker gets it back.
    window.__genxGuard = new MutationObserver(() => {
      if (pick.isConnected && !pick.hasAttribute('data-genx-player')) pick.setAttribute('data-genx-player', '');
    });
    window.__genxGuard.observe(pick, { attributes: true, attributeFilter: ['data-genx-player'] });
    // Black behind the picture, so the page never shows around it.
    const backdrop = document.createElement('div');
    backdrop.id = 'genx-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646';
    document.documentElement.appendChild(backdrop);
    touch(document.documentElement, ';overflow:hidden!important');
    window.__genxHeld = pick;
    return pick.tagName.toLowerCase();
  };
  if (!window.__genxWatch) {
    let timer = 0;
    // At most one check every 400 ms: a page that never stops changing
    // (W02) cannot starve it, as waiting for quiet would.
    window.__genxWatch = new MutationObserver(() => { if (!timer) timer = setTimeout(() => { timer = 0; run(); }, 400); });
    window.__genxWatch.observe(document.documentElement, { childList: true, subtree: true });
  }
  return run();
})()
