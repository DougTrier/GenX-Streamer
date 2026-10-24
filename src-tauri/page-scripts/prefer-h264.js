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
  // Low-memory TVs only (PageController): sites are told VP9 and AV1 do not
  // play, so they send H.264, which the TV decodes in far less memory.
  const other = (type) => /vp0?9|av01|av1/i.test(String(type));
  const source = window.MediaSource;
  if (source?.isTypeSupported) {
    const supported = source.isTypeSupported.bind(source);
    source.isTypeSupported = (type) => !other(type) && supported(type);
  }
  const capabilities = navigator.mediaCapabilities;
  if (capabilities?.decodingInfo) {
    const decoding = capabilities.decodingInfo.bind(capabilities);
    capabilities.decodingInfo = (config) =>
      other(config?.video?.contentType)
        ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false })
        : decoding(config);
  }
  const canPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return other(type) ? '' : canPlay.call(this, type);
  };
})();
