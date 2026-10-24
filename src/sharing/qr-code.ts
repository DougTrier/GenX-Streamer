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
 * A small QR code encoder (ISO/IEC 18004) for Share with everyone nearby:
 * byte mode, error correction level M, versions 1–10 (up to 213 bytes), the
 * mask chosen by the standard's penalty rules. It follows the structure of
 * Project Nayuki's public QR code generator. Tested by decoding its output
 * with OpenCV (tests/tooling/test_qr_code.py).
 */

/** Error-correction codewords per block, and blocks, at level M (index = version). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_VERSION = 10;

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (version: number) =>
  Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;

function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = multiply(root, 0x02);
  }
  return result;
}
function remainder(data: readonly number[], div: readonly number[]): number[] {
  const result = new Array<number>(div.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    div.forEach((coefficient, i) => (result[i]! ^= multiply(coefficient, factor)));
  }
  return result;
}

/** The codewords for `bytes` at `version`: data, padding, then interleaved error correction. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  const blockCount = BLOCKS[version]!;
  const eccLength = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const div = divisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = remainder(block, div);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!);
    });
  return result;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The standard's penalty for a finished symbol: lower reads more reliably. */
function penalty(modules: readonly boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
      for (let j = 0; j + 11 <= size; j++) {
        const pattern = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join('');
        if (pattern === '10111010000' || pattern === '00001011101') score += 40;
      }
    }
  };
  line((y, x) => modules[y]![x]!);
  line((x, y) => modules[y]![x]!);
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (modules[y]![x]) dark++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        modules[y]![x] === modules[y]![x + 1] &&
        modules[y]![x] === modules[y + 1]![x] &&
        modules[y]![x] === modules[y + 1]![x + 1]
      )
        score += 3;
    }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The format information for `mask` at level M: [x, y, dark] for both copies. */
function formatCells(mask: number, size: number): [number, number, boolean][] {
  // Level M is 00 in the format bits.
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((mask << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const cells: [number, number, boolean][] = [];
  for (let i = 0; i <= 5; i++) cells.push([8, i, bit(i)]);
  cells.push([8, 7, bit(6)], [8, 8, bit(7)], [7, 8, bit(8)]);
  for (let i = 9; i < 15; i++) cells.push([14 - i, 8, bit(i)]);
  for (let i = 0; i < 8; i++) cells.push([size - 1 - i, 8, bit(i)]);
  for (let i = 8; i < 15; i++) cells.push([8, size - 15 + i, bit(i)]);
  cells.push([8, size - 8, true]);
  return cells;
}

/** The QR code for `text` as rows of dark (true) and light modules, without the quiet zone. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= MAX_VERSION &&
    4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8
  )
    version++;
  if (version > MAX_VERSION) throw new RangeError('qr-text-too-long');
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
  const positions = alignmentPositions(version, size);
  positions.forEach((cx, i) =>
    positions.forEach((cy, j) => {
      const last = positions.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  // Reserve the format modules (written per mask below).
  for (const [x, y] of formatCells(0, size)) set(x, y, false);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  const data = codewords(bytes, version);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!fixed[y]![x] && index < data.length * 8) {
          modules[y]![x] = ((data[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0;
          index++;
        }
      }
  }
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  MASKS.forEach((mask, number) => {
    const candidate = modules.map((row, y) =>
      row.map((dark, x) => (fixed[y]![x] ? dark : dark !== mask(x, y))),
    );
    for (const [x, y, dark] of formatCells(number, size)) candidate[y]![x] = dark;
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best!;
}

/** The QR code as an SVG element, drawn as text-free paths (quiet zone included). */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const modules = encodeQr(text);
  const size = modules.length + 8;
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(namespace, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const path = document.createElementNS(namespace, 'path');
  let d = '';
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(background, path);
  return svg;
}
