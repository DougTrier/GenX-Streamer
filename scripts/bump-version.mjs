#!/usr/bin/env node

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

// GenX Streamer's version, in every place it is written (docs/updates.md):
// package.json, package-lock.json (twice), src-tauri/Cargo.toml,
// src-tauri/Cargo.lock (the tmg-tv entry), src-tauri/tauri.conf.json (which
// the Android build turns into versionName and versionCode =
// major*1000000 + minor*1000 + patch), and the README's version badge.
//
// Every release needs a higher version: Check for updates compares versions,
// and Android refuses to update to an equal or lower versionCode.
//
//   node scripts/bump-version.mjs check            # all places agree?
//   node scripts/bump-version.mjs patch|minor|major
//   node scripts/bump-version.mjs 0.2.0            # an explicit, higher version
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/** Each place: how to read the version there and how to write a new one. */
const places = [
  {
    file: 'package.json',
    read: (text) => [JSON.parse(text).version],
    write: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    file: 'package-lock.json',
    read: (text) => {
      const lock = JSON.parse(text);
      return [lock.version, lock.packages?.['']?.version];
    },
    // Only the project's own two entries (the top and packages[""]), never a dependency.
    write: (text, from, to) => {
      const lock = JSON.parse(text);
      lock.version = to;
      lock.packages[''].version = to;
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
  {
    file: 'src-tauri/Cargo.toml',
    read: (text) => [/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(text)?.[1]],
    write: (text, from, to) =>
      text.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/ms, `$1${to}$2`),
  },
  {
    file: 'src-tauri/Cargo.lock',
    read: (text) => [/^name = "tmg-tv"\r?\nversion = "([^"]+)"/m.exec(text)?.[1]],
    write: (text, from, to) =>
      text.replace(/^(name = "tmg-tv"\r?\nversion = ")[^"]+(")/m, `$1${to}$2`),
  },
  {
    file: 'src-tauri/tauri.conf.json',
    read: (text) => [JSON.parse(text).version],
    write: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    file: 'README.md',
    read: (text) => [/img\.shields\.io\/badge\/Version-([0-9.]+)-/.exec(text)?.[1]],
    write: (text, from, to) => text.replace(`badge/Version-${from}-`, `badge/Version-${to}-`),
  },
];

/** Every place's version, by file (a place may hold it twice). */
export function readVersions(root) {
  return places.map((place) => ({
    file: place.file,
    versions: place.read(readFileSync(path.join(root, place.file), 'utf8')),
  }));
}

/** The one version every place agrees on; throws naming each place that differs. */
export function checkVersions(root) {
  const found = readVersions(root);
  const first = found[0].versions[0];
  const wrong = found.filter((place) => place.versions.some((version) => version !== first));
  if (!VERSION.test(first ?? '') || wrong.length)
    throw new Error(
      `Versions disagree: ${found.map((place) => `${place.file} ${place.versions.join('/')}`).join(', ')}`,
    );
  return first;
}

const parts = (version) => version.split('.').map(Number);

/** The next version: patch, minor, major, or an explicit one that must be higher. */
export function nextVersion(current, how) {
  const [major, minor, patch] = parts(current);
  const next =
    how === 'patch'
      ? `${major}.${minor}.${patch + 1}`
      : how === 'minor'
        ? `${major}.${minor + 1}.0`
        : how === 'major'
          ? `${major + 1}.0.0`
          : how;
  // Each part must fit Android's versionCode (major*1000000 + minor*1000 + patch).
  if (!VERSION.test(next)) throw new Error(`Not a version GenX can use: ${how}`);
  if (versionCode(next) <= versionCode(current))
    throw new Error(`${next} is not higher than ${current}: Android would refuse the update.`);
  return next;
}

/** Android's versionCode for a version (build-android-release.ps1 writes it the same way). */
export function versionCode(version) {
  const [major, minor, patch] = parts(version);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/** Writes the next version everywhere, then checks they all agree. */
export function bumpVersion(root, how) {
  const current = checkVersions(root);
  const next = nextVersion(current, how);
  for (const place of places) {
    const filename = path.join(root, place.file);
    const before = readFileSync(filename, 'utf8');
    const after = place.write(before, current, next);
    if (after === before) throw new Error(`${place.file}: the version was not found to change.`);
    writeFileSync(filename, after);
  }
  if (checkVersions(root) !== next) throw new Error('The new version did not take everywhere.');
  return { from: current, to: next, versionCode: versionCode(next) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const how = process.argv[2];
  try {
    if (!how) throw new Error('usage: bump-version.mjs check | patch | minor | major | <x.y.z>');
    const result = how === 'check' ? { version: checkVersions(root) } : bumpVersion(root, how);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
