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

// Serialized directly into the isolated fixture page; no application globals.
export function armMetadataBarrier(video, timeoutMs = 20000) {
  video.fixtureMetadataBarrier?.cancel();
  const previousSource = video.currentSrc;
  let reset = false;
  let finish;
  let settled = false;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  const cleanup = (observed) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    video.removeEventListener('emptied', onReset);
    video.removeEventListener('loadstart', onReset);
    video.removeEventListener('loadedmetadata', onMetadata);
    finish(observed);
  };
  const onReset = () => {
    reset = true;
  };
  const onMetadata = () => {
    if (reset && video.currentSrc !== previousSource && video.currentSrc !== '') cleanup(true);
  };
  const timer = setTimeout(() => cleanup(false), timeoutMs);
  video.addEventListener('emptied', onReset);
  video.addEventListener('loadstart', onReset);
  video.addEventListener('loadedmetadata', onMetadata);
  video.fixtureMetadataBarrier = { result, cancel: () => cleanup(false) };
  return true;
}
