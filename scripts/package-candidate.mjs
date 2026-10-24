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

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const LIMIT = 512 * 1024 * 1024;
const PYTHON = String.raw`
import json,sys,zipfile,pathlib
p=json.load(sys.stdin)
if p['action']=='inspect':
 with zipfile.ZipFile(p['file']) as z:
  entries=z.infolist()
  if len(entries)>10000: raise ValueError('APK entry limit')
  total=0;names=set()
  for e in entries:
   n=e.orig_filename
   if n in names or len(n)>1024 or '\\' in n or any(ord(c)<32 or ord(c)==127 for c in n) or ':' in n or n.startswith('/') or '..' in n.split('/') or e.flag_bits&1 or e.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): raise ValueError('APK entry policy')
   names.add(n);total+=e.file_size
   if e.file_size>268435456 or total>1073741824 or e.file_size>max(1,e.compress_size)*200: raise ValueError('APK expansion limit')
   if n=='AndroidManifest.xml' and not 0<e.file_size<=8388608: raise ValueError('APK manifest limit')
  if 'AndroidManifest.xml' not in names or 'classes.dex' not in names or not any(n.startswith('lib/arm64-v8a/') and n.endswith('.so') for n in names): raise ValueError('APK ARM64 structure missing')
  for e in entries:
   if not e.is_dir():
    with z.open(e) as stream:
     while stream.read(65536): pass
 abis=sorted({n.split('/')[1] for n in names if n.startswith('lib/') and n.count('/')==2 and n.endswith('.so')})
 print(json.dumps({'entries':len(entries),'expandedBytes':total,'architecture':'arm64-v8a','architectures':abis,'validation':'bounded ZIP structure and CRC only; no signature or install proof'}))
else:
 with zipfile.ZipFile(p['file'],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name in sorted(p['entries']):
   info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.create_system=3;info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,pathlib.Path(p['entries'][name]).read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
 print(json.dumps({'python':sys.version.split()[0]}))
`;
async function python(payload, executable = 'python') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-B', '-X', 'utf8', '-c', PYTHON], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 65536) {
        tooLarge = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Python packaging runtime is unavailable.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new Error('Bounded APK or ZIP validation failed.'));
      else {
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new Error('Packaging runtime returned invalid evidence.'));
        }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
async function file(filename, max = LIMIT) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > max)
    throw new Error('Packaging input must be a bounded regular file.');
  return info;
}
export async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function pe(filename) {
  const info = await file(filename);
  const handle = await open(filename, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(info.size, 1048576));
    await handle.read(bytes, 0, bytes.length, 0);
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ')
      throw new Error('Windows executable PE structure is invalid.');
    const at = bytes.readUInt32LE(60);
    if (
      at < 64 ||
      at + 26 > bytes.length ||
      bytes.toString('binary', at, at + 4) !== 'PE\0\0' ||
      bytes.readUInt16LE(at + 4) !== 0x8664 ||
      bytes.readUInt16LE(at + 6) === 0 ||
      bytes.readUInt16LE(at + 20) < 112 ||
      at + 24 + bytes.readUInt16LE(at + 20) > info.size ||
      bytes.readUInt16LE(at + 24) !== 0x20b
    )
      throw new Error('Windows executable PE structure is invalid.');
    return {
      architecture: 'x86_64',
      validation: 'basic PE structure only; no authenticity, signature or runtime proof',
    };
  } finally {
    await handle.close();
  }
}
/**
 * Release file names carry the version and platform (docs/verify-a-download.md,
 * docs/updates.md): the portable ZIP for new installs, the bare exe that
 * Check for updates installs, and the Android APK. SHA256SUMS lists them all.
 */
export function releaseNames(version) {
  if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) throw new Error('A release version is x.y.z.');
  return {
    windows: `GenX-Streamer-${version}-Windows-x64-portable.zip`,
    'windows-exe': `GenX-Streamer-${version}-Windows-x64.exe`,
    // One APK for every ARM phone and TV: arm64-v8a and armeabi-v7a (SH-010).
    android: `GenX-Streamer-${version}-Android.apk`,
  };
}
/** The app's own version (src-tauri/tauri.conf.json), the one GenX reports in About. */
async function appVersion() {
  const config = JSON.parse(
    await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  );
  return String(config.version);
}
export async function packageCandidate(options) {
  const {
    windowsExe,
    androidApk,
    outputDir,
    windowsProfile,
    androidProfile,
    notices,
    sourceRevision = null,
    pythonExecutable = 'python',
    mode = 'candidate',
  } = options;
  const names = releaseNames(options.version ?? (await appVersion()));
  // windows-only (owner, October 23, 2026): the Windows ZIP alone, while the
  // Android release APK waits for its owner-held release key.
  const windowsOnly = mode === 'windows-only';
  if (
    !['candidate', 'final-inputs', 'windows-only'].includes(mode) ||
    !(windowsOnly
      ? ['debug', 'release'].includes(windowsProfile) && !androidApk && !androidProfile
      : [windowsProfile, androidProfile].every((p) => ['debug', 'release'].includes(p))) ||
    (sourceRevision !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision))
  )
    throw new Error(
      'Explicit valid packaging mode, source revision and caller-declared build profiles are required.',
    );
  if (
    mode === 'final-inputs' &&
    (!notices || windowsProfile !== 'release' || androidProfile !== 'release')
  )
    throw new Error(
      'Final inputs require release-declared profiles and dependency notices; acceptance is still unverified.',
    );
  const out = path.resolve(outputDir);
  const parent = path.dirname(out);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error('Output parent must be an existing regular directory.');
  try {
    await lstat(out);
    throw new Error('Output destination already exists; it will not be overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const windowsInfo = await pe(windowsExe);
  let apkInfo = null;
  if (!windowsOnly) {
    await file(androidApk);
    apkInfo = await python({ action: 'inspect', file: path.resolve(androidApk) }, pythonExecutable);
  }
  // SH-010: a release APK carries every ARM architecture it is offered for.
  if (
    mode === 'final-inputs' &&
    !['arm64-v8a', 'armeabi-v7a'].every((abi) => apkInfo?.architectures?.includes(abi))
  )
    throw new Error('A release APK must carry both arm64-v8a and armeabi-v7a libraries.');
  if (notices) await file(notices, 1024 * 1024);
  const inputHashes = {
    windows: await sha256(windowsExe),
    ...(windowsOnly ? {} : { android: await sha256(androidApk) }),
    ...(notices ? { notices: await sha256(notices) } : {}),
  };
  const stage = path.join(parent, `.genx-package-${randomUUID()}`);
  let reserved = false;
  await mkdir(stage);
  try {
    const exe = path.join(stage, 'GenX Streamer.exe');
    await copyFile(windowsExe, exe);
    if ((await sha256(exe)) !== inputHashes.windows)
      throw new Error('Packaging inputs changed during staging.');
    // The bare exe beside the ZIP: what Check for updates installs.
    const bareExe = path.join(stage, names['windows-exe']);
    await copyFile(windowsExe, bareExe);
    if ((await sha256(bareExe)) !== inputHashes.windows)
      throw new Error('Packaging inputs changed during staging.');
    if (!windowsOnly) {
      const apk = path.join(stage, names.android);
      await copyFile(androidApk, apk);
      if ((await sha256(apk)) !== inputHashes.android)
        throw new Error('Packaging inputs changed during staging.');
    }
    const marker = path.join(stage, 'tmg-portable.flag');
    await writeFile(marker, '');
    const readme = path.join(stage, 'README.txt');
    await writeFile(
      readme,
      `GenX Streamer development candidate\n\nWindows build profile: ${windowsProfile} (caller-declared, not independently verified).\nSource revision: ${sourceRevision ?? 'not supplied'}\nUnsigned status: signature UNVERIFIED; this helper does not sign or certify publisher trust.\n\nExtract all ZIP entries together. tmg-portable.flag requests data beside the executable when writable. An explicit absolute TMG_DATA_DIR override can select another writable directory; this changes where data resides. Read-only locations require an explicit writable storage choice.\n\nMicrosoft Edge WebView2 Runtime must already be available. This package does not install WebView2, trust certificates, or change Windows CA, firewall, antivirus or EDR settings.\n\nNOT RELEASE ACCEPTANCE. Clean installation, updates, physical Windows/Android playback, receiver compatibility, production signatures, dependency notices and security-product evidence require separate verification.\nDependency notices: ${notices ? 'included (completeness not verified)' : 'MISSING; development candidate only'}.\n`,
      'utf8',
    );
    const entries = { 'GenX Streamer.exe': exe, 'README.txt': readme, 'tmg-portable.flag': marker };
    if (notices) {
      const target = path.join(stage, 'DEPENDENCY-NOTICES.txt');
      await copyFile(notices, target);
      if ((await sha256(target)) !== inputHashes.notices)
        throw new Error('Notices changed during staging.');
      entries['DEPENDENCY-NOTICES.txt'] = target;
    }
    const runtime = await python(
      { action: 'zip', file: path.join(stage, names.windows), entries },
      pythonExecutable,
    );
    for (const filename of Object.values(entries)) await rm(filename);
    const artifacts = [];
    for (const [platform, name] of Object.entries(names)) {
      if (windowsOnly && platform === 'android') continue;
      const filename = path.join(stage, name);
      artifacts.push({
        platform,
        name,
        bytes: (await lstat(filename)).size,
        sha256: await sha256(filename),
      });
    }
    const manifest = {
      schemaVersion: 1,
      product: 'GenX Streamer',
      appIdentifier: 'com.tmg.tv',
      version: names.windows.split('-')[2],
      mode,
      releaseAcceptance: false,
      profiles: {
        authority: 'caller-declared; not independently verified',
        windows: windowsProfile,
        android: windowsOnly ? null : androidProfile,
      },
      sourceRevision,
      signatureStatus: 'unverified',
      noticesStatus: notices ? 'included-completeness-unverified' : 'missing',
      pendingEvidence: [
        ...(windowsOnly ? ['Android release APK (waits for the owner-held release key)'] : []),
        'production signatures and publisher trust',
        'clean installation and update preservation',
        'physical Windows and Android playback',
        'receiver/travel acceptance',
        'security-product checks',
        'complete dependency/license review',
      ],
      inputs: { hashes: inputHashes, windows: windowsInfo, android: apkInfo },
      artifacts,
    };
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // release-manifest.json (docs/verify-a-download.md): what each release file
    // is for, so every distribution method picks by the same rules. Its own
    // integrity is GitHub's published digest; Android files are also checked
    // against the certificate compiled into GenX, never one named here.
    const describe = {
      windows: {
        platform: 'windows',
        architectures: ['x64'],
        format: 'portable-zip',
        minimumOs: 'Windows 10 (64-bit) with the WebView2 Runtime',
      },
      'windows-exe': {
        platform: 'windows',
        architectures: ['x64'],
        format: 'exe',
        minimumOs: 'Windows 10 (64-bit) with the WebView2 Runtime',
      },
      android: {
        platform: 'android',
        architectures: apkInfo?.architectures ?? [],
        format: 'apk',
        minimumOs: 'Android 7.0',
        minimumSdk: 24,
      },
    };
    await writeFile(
      path.join(stage, 'release-manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          product: 'GenX Streamer',
          appIdentifier: 'com.tmg.tv',
          version: manifest.version,
          files: artifacts.map((a) => ({
            name: a.name,
            ...describe[a.platform],
            bytes: a.bytes,
            sha256: a.sha256,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(
      path.join(stage, 'SHA256SUMS'),
      artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n',
    );
    await writeFile(
      path.join(stage, 'receipt.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: 'package-candidate',
          command: 'node scripts/package-candidate.mjs',
          profiles: {
            authority: 'caller-declared',
            windows: windowsProfile,
            android: windowsOnly ? null : androidProfile,
          },
          startedFromExplicitInputs: true,
          finishedUtc: new Date().toISOString(),
          exitCode: 0,
          node: process.version,
          python: runtime.python,
          mode,
          releaseAcceptance: false,
          sourceRevision,
          inputHashes,
          artifacts,
        },
        null,
        2,
      ) + '\n',
    );
    await mkdir(out);
    reserved = true;
    await rename(stage, path.join(out, 'package'));
    return { directory: path.join(out, 'package'), manifest };
  } catch (error) {
    if (
      path.dirname(path.resolve(stage)) !== parent ||
      !/^\.genx-package-[a-f0-9-]{36}$/.test(path.basename(stage))
    )
      throw new Error('Owned staging cleanup boundary is invalid.', { cause: error });
    await rm(stage, { recursive: true, force: true });
    if (reserved) {
      try {
        await rmdir(out);
      } catch {}
    }
    throw error;
  }
}
export async function verifyCandidate(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  await file(manifestPath, 1024 * 1024);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== 'GenX Streamer' ||
    manifest.appIdentifier !== 'com.tmg.tv' ||
    manifest.releaseAcceptance !== false ||
    manifest.signatureStatus !== 'unverified' ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== (manifest.mode === 'windows-only' ? 2 : 3)
  )
    throw new Error('Candidate manifest is invalid.');
  const names = releaseNames(String(manifest.version));
  for (const platform of manifest.mode === 'windows-only'
    ? ['windows', 'windows-exe']
    : ['windows', 'windows-exe', 'android']) {
    const artifact = manifest.artifacts.find((a) => a.platform === platform);
    if (!artifact || artifact.name !== names[platform] || !/^[a-f0-9]{64}$/.test(artifact.sha256))
      throw new Error('Candidate artifact identity is invalid.');
    const filename = path.join(directory, artifact.name);
    const info = await file(filename);
    if (info.size !== artifact.bytes || (await sha256(filename)) !== artifact.sha256)
      throw new Error('Candidate artifact checksum mismatch.');
  }
  return manifest;
}
function cli(argv) {
  const allowed = [
    'windows-exe',
    'android-apk',
    'output-dir',
    'windows-profile',
    'android-profile',
    'mode',
    'notices',
    'source-revision',
    'python',
    'version',
  ];
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (
      !argv[i]?.startsWith('--') ||
      !allowed.includes(key) ||
      args[key] !== undefined ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new Error('Invalid packaging arguments.');
    args[key] = argv[i + 1];
  }
  const required =
    args.mode === 'windows-only'
      ? ['windows-exe', 'output-dir', 'windows-profile']
      : allowed.slice(0, 5);
  for (const key of required)
    if (!args[key])
      throw new Error(
        'Explicit binary paths, new output directory and both profiles are required.',
      );
  return {
    windowsExe: args['windows-exe'],
    androidApk: args['android-apk'],
    outputDir: args['output-dir'],
    windowsProfile: args['windows-profile'],
    androidProfile: args['android-profile'],
    mode: args.mode,
    notices: args.notices,
    sourceRevision: args['source-revision'],
    pythonExecutable: args.python,
    version: args.version,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    packageCandidate(cli(process.argv.slice(2)))
      .then((result) =>
        console.log(JSON.stringify({ directory: result.directory, releaseAcceptance: false })),
      )
      .catch(() => {
        console.error(
          'Candidate packaging failed. Check explicit inputs, profiles, notices and a fresh output destination.',
        );
        process.exitCode = 1;
      });
  } catch {
    console.error('Explicit binary paths, profiles and a fresh output destination are required.');
    process.exitCode = 1;
  }
}
