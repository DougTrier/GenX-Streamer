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

import { createCipheriv, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = fileURLToPath(new URL('../tests/fixtures/media/', import.meta.url));
const output = fileURLToPath(new URL('../tests/fixtures/media/protocol/', import.meta.url));
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = {
  seed: 'owned-aes-range-v1-sequence100',
  encryption: 'AES-128-CBC PKCS7, explicit sequence IVs 100–103; public fixture key',
  inputs: [],
  outputs: [],
};
async function input(name) {
  const bytes = await readFile(path.join(source, name));
  receipt.inputs.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  return bytes;
}
async function save(name, bytes) {
  await writeFile(path.join(output, name), bytes);
  receipt.outputs.push({ name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
}
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
await save('aes.key', key);
const aes = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-PLAYLIST-TYPE:VOD',
];
for (let n = 0; n < 4; n++) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(100 + n, 12);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const bytes = await input(`segment00${n}.ts`);
  await save(`aes00${n}.ts`, Buffer.concat([cipher.update(bytes), cipher.final()]));
  aes.push(
    `#EXT-X-KEY:METHOD=AES-128,URI="../resources/aes.key?fixture=owned",IV=0x${iv.toString('hex')}`,
    '#EXTINF:2.000000,',
    `../resources/aes00${n}.ts?fixture=owned`,
  );
}
aes.push('#EXT-X-ENDLIST');
await save('aes.m3u8', aes.join('\n') + '\n');
await save(
  'master.m3u8',
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=450000,CODECS="avc1.42c01e,mp4a.40.2"\nindex.m3u8?fixture=owned\n',
);
const init = await input('init.mp4');
const chunks = [init];
const ranged = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  `#EXT-X-MAP:URI="../resources/ranges.mp4?fixture=owned",BYTERANGE="${init.length}@0"`,
];
for (let n = 0; n < 4; n++) {
  const bytes = await input(`fmp4segment00${n}.m4s`);
  chunks.push(bytes);
  ranged.push(
    '#EXTINF:2.000000,',
    `#EXT-X-BYTERANGE:${bytes.length}${n === 0 ? '@' + init.length : ''}`,
    '../resources/ranges.mp4?fixture=owned',
  );
}
ranged.push('#EXT-X-ENDLIST');
await save('ranges.mp4', Buffer.concat(chunks));
await save('range.m3u8', ranged.join('\n') + '\n');
await writeFile(path.join(output, 'generation.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(
  JSON.stringify({ seed: receipt.seed, outputs: receipt.outputs.length }) + '\n',
);
