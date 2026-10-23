import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const destination = fileURLToPath(new URL('../tests/fixtures/media/', import.meta.url));
const encoder = process.argv[2] ?? ffmpeg;
if (!encoder) throw new Error('FFmpeg development dependency is unavailable');
await mkdir(destination, { recursive: true });
const version = spawnSync(encoder, ['-version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error('FFmpeg version check failed');
const source = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '8',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libx264',
  '-profile:v',
  'baseline',
  '-level',
  '3.0',
  '-pix_fmt',
  'yuv420p',
  '-preset',
  'veryfast',
  '-crf',
  '28',
  '-threads',
  '1',
  '-g',
  '48',
  '-keyint_min',
  '48',
  '-sc_threshold',
  '0',
  '-c:a',
  'aac',
  '-b:a',
  '64k',
  '-f',
  'hls',
  '-hls_time',
  '2',
  '-hls_playlist_type',
  'vod',
];
const commands = [
  [...source, '-hls_segment_filename', 'segment%03d.ts', 'index.m3u8'],
  [
    ...source,
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    'fmp4segment%03d.m4s',
    'fmp4.m3u8',
  ],
];
for (const args of commands) {
  const result = spawnSync(encoder, args, { cwd: destination, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Fixture generation failed: ${result.stderr}`);
}
const files = [];
for (const name of (await readdir(destination)).sort()) {
  if (!/\.(?:m3u8|ts|m4s|mp4)$/.test(name)) continue;
  const bytes = await readFile(path.join(destination, name));
  files.push({
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  path.join(destination, 'generation.json'),
  JSON.stringify(
    {
      version: version.stdout.split(/\r?\n/)[0],
      fixtureSeed: 'lavfi-testsrc2-320x180-24fps-sine440-8sec-v1',
      commands,
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Generated ${files.length} owned media files (${files.reduce((sum, file) => sum + file.bytes, 0)} bytes).`,
);
