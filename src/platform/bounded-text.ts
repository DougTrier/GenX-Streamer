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

/** Match native UTF-8 byte limits without allocating encoded copies for large catalogs. */
export function boundedUtf8Text(
  value: unknown,
  limit: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > limit)
    return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > limit) return false;
  }
  return true;
}
