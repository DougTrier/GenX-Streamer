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
  if (document.getElementById('genx-hide-ads')) return;
  const s = document.createElement('style');
  s.id = 'genx-hide-ads';
  s.textContent = '[id^="google_ads"],[id^="div-gpt-ad"],[id^="taboola"],.trc_related_container,.OUTBRAIN,iframe[src*="doubleclick"],iframe[src*="googlesyndication"],[data-ad-slot],[data-google-query-id],.adsbygoogle{display:none!important}';
  document.documentElement.appendChild(s);
})()
