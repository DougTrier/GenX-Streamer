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

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bumpVersion,
  checkVersions,
  nextVersion,
  readVersions,
  versionCode,
} from '../../scripts/bump-version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'README.md',
];

/** A scratch copy of the repository's own version files. */
function copy() {
  const root = mkdtempSync(path.join(tmpdir(), 'genx-version-'));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(repo, file), path.join(root, file));
  }
  return root;
}

test('every place in the repository holds the same version', () => {
  const version = checkVersions(repo);
  for (const place of readVersions(repo)) {
    assert.ok(place.versions.length > 0, place.file);
    for (const found of place.versions) assert.equal(found, version, place.file);
  }
});

test('the next version is always higher, as Android requires', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.9.4', 'major'), '1.0.0');
  assert.equal(nextVersion('0.1.0', '0.3.0'), '0.3.0');
  assert.throws(() => nextVersion('0.2.0', '0.2.0'), /not higher/);
  assert.throws(() => nextVersion('0.2.0', '0.1.9'), /not higher/);
  for (const bad of ['1.0', '01.0.0', '1.0.0-beta', 'v1.0.0', '0.1000.0', '', 'next'])
    assert.throws(() => nextVersion('0.1.0', bad), /Not a version/, bad);
  // versionCode, as build-android-release.ps1 computes it.
  assert.equal(versionCode('0.1.0'), 1000);
  assert.equal(versionCode('0.1.1'), 1001);
  assert.equal(versionCode('1.2.3'), 1002003);
  assert.ok(versionCode('0.2.0') > versionCode('0.1.999'));
});

test('a bump changes every place and nothing else', () => {
  const root = copy();
  try {
    const before = Object.fromEntries(
      files.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
    );
    const current = checkVersions(root);
    const result = bumpVersion(root, 'patch');
    assert.equal(result.from, current);
    assert.equal(result.to, nextVersion(current, 'patch'));
    assert.equal(checkVersions(root), result.to);
    for (const file of files) {
      // Line by line, the only changes are the old version becoming the new one.
      const old = before[file].split('\n');
      const now = readFileSync(path.join(root, file), 'utf8').split('\n');
      assert.equal(now.length, old.length, file);
      const changed = old.filter((line, i) => line !== now[i]);
      assert.ok(changed.length >= 1, file);
      old.forEach((line, i) => {
        if (line !== now[i]) assert.equal(now[i], line.replace(current, result.to), file);
      });
    }
    // A dependency that happens to share the old version is not touched.
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const others = Object.entries(lock.packages).filter(
      ([name, entry]) => name !== '' && entry.version === result.to,
    );
    assert.deepEqual(others, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('places that disagree are named, and a bump refuses to start', () => {
  const root = copy();
  try {
    const conf = path.join(root, 'src-tauri/tauri.conf.json');
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    assert.throws(() => checkVersions(root), /src-tauri\/tauri\.conf\.json 9\.9\.9/);
    assert.throws(() => bumpVersion(root, 'patch'), /Versions disagree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
