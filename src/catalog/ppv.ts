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

/** Explicit provider metadata only: a sport, price tier or event name is not PPV evidence. */
export function hasPpvMarker(value: string | null | undefined): boolean {
  if (!value) return false;
  const words =
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some(
    (word, index) =>
      /^ppv[0-9]*$/u.test(word) ||
      word === 'payperview' ||
      (word === 'pay' && words[index + 1] === 'per' && words[index + 2] === 'view') ||
      (word === 'p' && words[index + 1] === 'p' && words[index + 2] === 'v'),
  );
}

export interface PpvChannelMetadata {
  name: string;
  category?: string;
  /** Provider evidence survives a local category override. */
  originalCategory?: string;
  /** Native exact-group classification may include a differently named retained alias. */
  ppv?: boolean;
}

export function isPpvChannel(channel: PpvChannelMetadata): boolean {
  return (
    channel.ppv === true ||
    hasPpvMarker(channel.name) ||
    hasPpvMarker(channel.category) ||
    hasPpvMarker(channel.originalCategory)
  );
}
