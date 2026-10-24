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

// Windows station pages: a site's own full-screen button would take over the
// whole GenX window. GenX's Full screen is the one full-screen control on
// every site, so the page's own requests are refused.
(() => {
  const refuse = function () {
    return Promise.reject(new TypeError("Use GenX's Full screen button."));
  };
  for (const proto of [Element.prototype, HTMLElement.prototype]) {
    proto.requestFullscreen = refuse;
    proto.webkitRequestFullscreen = refuse;
    proto.webkitRequestFullScreen = refuse;
  }
  if (window.HTMLVideoElement) HTMLVideoElement.prototype.webkitEnterFullscreen = refuse;
  for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled'])
    Object.defineProperty(Document.prototype, name, { get: () => false, configurable: true });
})();
