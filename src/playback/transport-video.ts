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

/**
 * Reads which picture format an MPEG transport stream segment declares
 * (its program map). The web player decodes H.264 and HEVC; some free
 * channels (ACC Network, October 2026) send MPEG-2 video, which it silently
 * drops while the sound plays. Android hands those to its own player.
 */
const PACKET = 188;
const MPEG_VIDEO = new Set([0x01, 0x02]);
const WEB_VIDEO = new Set([0x1b, 0x24]);

/** 'mpeg2' when the segment's programs carry MPEG-1/2 video and no H.264/HEVC. */
export function transportVideoFormat(bytes: Uint8Array): 'mpeg2' | null {
  const programMaps = new Set<number>();
  let mpeg = false;
  let web = false;
  // The first sync byte that the next packet confirms (or the segment's last).
  let start = bytes.indexOf(0x47);
  while (start >= 0 && start + PACKET < bytes.length && bytes[start + PACKET] !== 0x47)
    start = bytes.indexOf(0x47, start + 1);
  if (start < 0) return null;
  const limit = Math.min(bytes.length, start + PACKET * 2000);
  for (let at = start; at + PACKET <= limit; at += PACKET) {
    if (bytes[at] !== 0x47) return null;
    const unitStart = (bytes[at + 1]! & 0x40) !== 0;
    if (!unitStart) continue;
    const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
    if (pid !== 0 && !programMaps.has(pid)) continue;
    const control = (bytes[at + 3]! >> 4) & 0x3;
    let offset = at + 4;
    if (control === 2) continue;
    if (control === 3) offset += 1 + bytes[offset]!;
    offset += 1 + bytes[offset]!;
    const end = at + PACKET;
    if (offset + 3 > end) continue;
    const length = ((bytes[offset + 1]! & 0x0f) << 8) | bytes[offset + 2]!;
    const sectionEnd = Math.min(end, offset + 3 + length) - 4;
    if (pid === 0 && bytes[offset] === 0x00) {
      for (let entry = offset + 8; entry + 4 <= sectionEnd; entry += 4) {
        const program = (bytes[entry]! << 8) | bytes[entry + 1]!;
        if (program !== 0) programMaps.add(((bytes[entry + 2]! & 0x1f) << 8) | bytes[entry + 3]!);
      }
    } else if (bytes[offset] === 0x02 && offset + 12 <= sectionEnd) {
      const info = ((bytes[offset + 10]! & 0x0f) << 8) | bytes[offset + 11]!;
      for (let entry = offset + 12 + info; entry + 5 <= sectionEnd;) {
        const type = bytes[entry]!;
        if (MPEG_VIDEO.has(type)) mpeg = true;
        if (WEB_VIDEO.has(type)) web = true;
        entry += 5 + (((bytes[entry + 3]! & 0x0f) << 8) | bytes[entry + 4]!);
      }
      return mpeg && !web ? 'mpeg2' : null;
    }
  }
  return null;
}
