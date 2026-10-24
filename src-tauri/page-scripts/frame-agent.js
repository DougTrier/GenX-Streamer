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

// Station pages: GenX remote commands reach videos in every frame (players often
// live in another site's frame). Shared by Windows (web_page.rs); Android keeps
// the same script in WebPagePlugin.kt.
(() => {
  if (window.__genxAgent) return;
  window.__genxAgent = true;
  const videos = (root, out = []) => {
    root.querySelectorAll('video').forEach((v) => out.push(v));
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) videos(e.shadowRoot, out); });
    return out;
  };
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.genxRemote !== '__GENX_TOKEN__') return;
    const shown = videos(document).filter((v) => v.clientWidth * v.clientHeight > 0 && v.readyState > 0);
    for (const v of shown) {
      if (data.cmd === 'play') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
      if (data.cmd === 'mute') v.muted = !v.muted;
    }
    for (let i = 0; i < frames.length; i++) { try { frames[i].postMessage(data, '*'); } catch (e) {} }
  });
  // A video starting to play tells the page which frame holds it, so GenX's
  // Full screen shows the video being watched, not the biggest one.
  document.addEventListener('playing', (event) => {
    if (event.target instanceof HTMLMediaElement && parent !== window)
      parent.postMessage({ genxPlaying: '__GENX_TOKEN__' }, '*');
  }, true);
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.genxPlaying !== '__GENX_TOKEN__') return;
    for (const frame of document.querySelectorAll('iframe'))
      if (frame.contentWindow === event.source) frame.dataset.genxPlaying = String(Date.now());
    if (parent !== window) parent.postMessage(data, '*');
  });
})()
