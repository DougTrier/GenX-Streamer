import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// New owned fixtures only. Existing baseline/protocol/active-soak media stays intact.
const encoder = process.argv[2] ?? ffmpeg;
if (!encoder || process.argv.length > 3)
  throw new Error('Usage: generate-profile-fixtures [encoder]');
const root = path.resolve(
  'tests/fixtures/media/profiles',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(root, { recursive: true });
const version = spawnSync(encoder, ['-version'], {
  encoding: 'utf8',
  timeout: 30000,
  maxBuffer: 1048576,
});
if (version.status !== 0) throw new Error('Encoder version check failed');
const encoderHash = createHash('sha256');
for await (const bytes of createReadStream(encoder)) encoderHash.update(bytes);
const profiles = [
  {
    id: '720p30',
    width: 1280,
    height: 720,
    fps: 30,
    profile: 'main',
    level: '3.1',
    videoKbps: 2500,
    audioKbps: 128,
  },
  {
    id: '1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    profile: 'main',
    level: '4.0',
    videoKbps: 5000,
    audioKbps: 192,
  },
  {
    id: '1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    profile: 'high',
    level: '4.2',
    videoKbps: 8000,
    audioKbps: 192,
  },
];
const receipt = {
  schemaVersion: 1,
  scope: 'Owned profile generation; not device decode or P08 acceptance',
  fixtureSeed: 'lavfi-testsrc2-hd-sine440-stereo-8sec-v1',
  encoderVersion: version.stdout.split(/\r?\n/)[0],
  encoderSha256: encoderHash.digest('hex'),
  profiles: [],
};
let totalBytes = 0;
for (const profile of profiles) {
  const directory = path.join(root, profile.id);
  await mkdir(directory);
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${profile.width}x${profile.height}:rate=${profile.fps}`,
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
    profile.profile,
    '-level',
    profile.level,
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-threads',
    '2',
    '-b:v',
    `${profile.videoKbps}k`,
    '-maxrate',
    `${profile.videoKbps}k`,
    '-bufsize',
    `${profile.videoKbps * 2}k`,
    '-g',
    `${profile.fps * 2}`,
    '-keyint_min',
    `${profile.fps * 2}`,
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    `${profile.audioKbps}k`,
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
  ];
  const commands = [
    [...base, '-hls_segment_filename', 'segment%03d.ts', 'index.m3u8'],
    [
      ...base,
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
    const result = spawnSync(encoder, args, {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1048576,
    });
    if (result.status !== 0)
      throw new Error(`Profile generation failed: ${profile.id}: ${result.stderr?.slice(0, 2000)}`);
  }
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!/^(?:index|fmp4)\.m3u8$|^segment\d{3}\.ts$|^fmp4segment\d{3}\.m4s$|^init\.mp4$/.test(name))
      throw new Error('Unexpected generated file');
    const bytes = await readFile(path.join(directory, name));
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) throw new Error('Profile fixture output exceeds 64 MiB');
    files.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (files.length !== 11) throw new Error('Expected two playlists, init, and eight segments');
  receipt.profiles.push({ ...profile, durationSeconds: 8, segmentSeconds: 2, commands, files });
}
await writeFile(
  path.join(root, 'generation.json'),
  JSON.stringify({ ...receipt, totalBytes }, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({ directory: root, profiles: profiles.length, totalBytes, scope: receipt.scope }),
);
