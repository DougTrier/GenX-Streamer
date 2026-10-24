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

import './native-video.css';
import type { NativeEngineHost, PictureRect } from '../playback/native-vod-engine';
import type { NativeVideoBridge } from '../platform/native-video';
import { registerAudioControls } from '../platform/browser-audio-tracks';
import { setSubtitleChoices } from './captions';
import { nativeAudioSnapshot } from '../playback/native-vod-engine';

/**
 * Where the native on-demand picture goes (docs/native-vod-player.md): the
 * viewing area's rectangle in WebView pixels, kept current as the layout
 * changes (Expand, full screen, the Guide's picture). While it plays, the page
 * leaves a see-through hole there; everything GenX draws over the picture
 * (menus, overlays, the full-screen dock, VOD titles) stays on top.
 */
export function createNativePictureHost(
  bridge: NativeVideoBridge,
  elements: { app: HTMLElement; screen: HTMLElement; video: HTMLVideoElement },
): NativeEngineHost {
  const root = document.documentElement;
  let releaseAudio: (() => void) | null = null;
  const hole = () => {
    const box = elements.screen.getBoundingClientRect();
    root.style.setProperty('--gx-hole-x', `${box.left}px`);
    root.style.setProperty('--gx-hole-y', `${box.top}px`);
    root.style.setProperty('--gx-hole-w', `${box.width}px`);
    root.style.setProperty('--gx-hole-h', `${box.height}px`);
    // The Guide's picture sits over the channel panel, whose own background
    // would cover the native picture ("playing behind a dark cover", Sansui,
    // October 19, 2026); native-video.css cuts the same hole through it.
    const panel = elements.app.querySelector<HTMLElement>('.browser')?.getBoundingClientRect();
    root.style.setProperty('--gx-panel-x', `${panel?.left ?? 0}px`);
    root.style.setProperty('--gx-panel-y', `${panel?.top ?? 0}px`);
  };
  return {
    bridge,
    rect(): PictureRect | null {
      const box = elements.screen.getBoundingClientRect();
      if (
        box.width < 2 ||
        box.height < 2 ||
        !elements.screen.getClientRects().length ||
        getComputedStyle(elements.screen).visibility === 'hidden'
      )
        return null;
      hole();
      const scale = window.devicePixelRatio || 1;
      const value = (n: number) => Math.min(16_384, Math.max(0, Math.round(n * scale)));
      return [value(box.left), value(box.top), value(box.width), value(box.height)];
    },
    watchRect(changed) {
      let frame = 0;
      const soon = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          hole();
          changed();
        });
      };
      const resize = new ResizeObserver(soon);
      resize.observe(elements.screen);
      // Layout modes move the picture without resizing it (the Guide, full screen).
      const modes = new MutationObserver(soon);
      modes.observe(elements.app, {
        attributes: true,
        attributeFilter: ['class', 'data-guide-panel', 'data-vod-browsing', 'data-compact-view'],
      });
      window.addEventListener('resize', soon);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        resize.disconnect();
        modes.disconnect();
        window.removeEventListener('resize', soon);
      };
    },
    present(on) {
      if (on) {
        hole();
        root.dataset.nativeVideo = 'on';
      } else delete root.dataset.nativeVideo;
    },
    publish(tracks, controls) {
      releaseAudio?.();
      releaseAudio = null;
      if (!tracks || !controls) {
        setSubtitleChoices(elements.video, null);
        return;
      }
      const audio = tracks.audio;
      releaseAudio = registerAudioControls(elements.video, {
        read: () => nativeAudioSnapshot(audio),
        set: (id) => {
          if (!id || !audio.some((track) => track.id === id && track.supported)) return false;
          controls.audio(id);
          return true;
        },
      });
      setSubtitleChoices(elements.video, { tracks: tracks.text, select: controls.text });
    },
  };
}
