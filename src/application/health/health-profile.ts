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

/** Versioned observation policies; a requested limit is not a measured duration. */
export const DECODER_HEALTH_PROFILE = 'decoder-v1/html-video-quality-presented-v1';
export function reachabilityHealthProfile(native: boolean, budgetMs = 20000): string {
  if (![20000, 45000, 60000].includes(budgetMs))
    throw new Error('Choose a supported channel check time.');
  return `reachability-v3/${native ? 'native-media-resources-v1' : 'browser-fetch-v1'}/max-${budgetMs}/sequential`;
}
