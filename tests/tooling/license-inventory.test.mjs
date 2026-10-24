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
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectLicenseInventory,
  renderCandidateNotices,
  writeLicenseInventory,
} from '../../scripts/license-inventory.mjs';
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'GenX notice ü space '));
  try {
    const nodeModules = path.join(root, 'node_modules');
    const cargoRegistry = path.join(root, 'registry');
    await mkdir(nodeModules);
    await mkdir(cargoRegistry);
    await mkdir(path.join(nodeModules, 'runtime'));
    await mkdir(path.join(cargoRegistry, 'native-1.0.0'));
    const npmLock = path.join(root, 'package-lock.json');
    await writeFile(
      npmLock,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { runtime: '1.0.0' } },
          'node_modules/runtime': { version: '1.0.0', license: 'MIT OR Apache-2.0' },
          'node_modules/missing': { version: '2.0.0', dev: true },
        },
      }),
    );
    const cargoLock = path.join(root, 'Cargo.lock');
    await writeFile(
      cargoLock,
      'version=4\n[[package]]\nname="native"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="abc"\n',
    );
    const cargoManifest = path.join(root, 'Cargo.toml');
    await writeFile(
      cargoManifest,
      '[package]\nname="app"\nversion="1.0.0"\n[dependencies]\nnative="1"\n',
    );
    await writeFile(
      path.join(nodeModules, 'runtime', 'package.json'),
      JSON.stringify({ name: 'runtime', version: '1.0.0', license: 'MIT OR Apache-2.0' }),
    );
    await writeFile(
      path.join(nodeModules, 'runtime', 'LICENSE'),
      'Copyright exact ü\r\nMIT OR Apache text\r\n',
    );
    await writeFile(
      path.join(nodeModules, 'runtime', 'NOTICE.txt'),
      'Attribution NOTICE preserved separately\n',
    );
    await writeFile(
      path.join(cargoRegistry, 'native-1.0.0', 'Cargo.toml'),
      '[package]\nname="native"\nversion="1.0.0"\nlicense="MIT AND BSD-3-Clause"\nlinks="bundled_native"\n',
    );
    await writeFile(
      path.join(cargoRegistry, 'native-1.0.0', 'COPYING'),
      'Native copyright and license\n',
    );
    await run({
      root,
      options: {
        npmLock,
        cargoLock,
        cargoManifest,
        nodeModules,
        cargoRegistry,
        outputDir: path.join(root, 'inventory'),
      },
      nodeModules,
      cargoRegistry,
    });
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'GenX notice ü space ')));
    await rm(root, { recursive: true, force: true });
  }
}
async function pathPatchFixture(
  root,
  options,
  relative = 'vendor/tao',
  metadata = '[package]\nname="tao"\nversion="0.35.0"\nlicense="Apache-2.0 OR MIT"\n',
) {
  await writeFile(
    options.cargoManifest,
    '[package]\nname="app"\nversion="1.0.0"\n[dependencies]\ntao="0.35"\n[patch.crates-io]\ntao={path=' +
      JSON.stringify(relative) +
      '}\n',
  );
  await writeFile(
    options.cargoLock,
    'version=4\n[[package]]\nname="app"\nversion="1.0.0"\ndependencies=["tao"]\n[[package]]\nname="tao"\nversion="0.35.0"\n',
  );
  const folder = path.join(root, 'vendor', 'tao');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Cargo.toml'), metadata);
  await writeFile(
    path.join(folder, 'LICENSE'),
    'Exact vendored copyright\r\nMIT OR Apache full license\n',
  );
  await writeFile(path.join(folder, 'NOTICE'), 'Exact independent NOTICE\n');
  return folder;
}
test('explicit vendored path patch preserves locked identity, license/NOTICE and bounded relative provenance', async () =>
  fixture(async ({ root, options }) => {
    const folder = await pathPatchFixture(root, options);
    const result = (await collectLicenseInventory(options)).inventory;
    const row = result.records.find((r) => r.name === 'tao');
    assert.equal(row.sourceKind, 'vendored-path-override');
    assert.equal(row.metadataStatus, 'matched');
    assert.equal(row.scope, 'direct-runtime-candidate');
    assert.equal(row.licenseDeclaration, 'Apache-2.0 OR MIT');
    assert.deepEqual(row.metadataOrigin, {
      kind: 'manifest-relative-crates-io-patch',
      path: 'vendor/tao',
      manifestSha256: createHash('sha256')
        .update(await readFile(path.join(folder, 'Cargo.toml')))
        .digest('hex'),
    });
    assert.equal(
      row.licenseFiles.find((f) => f.path === 'LICENSE').text,
      'Exact vendored copyright\r\nMIT OR Apache full license\n',
    );
    assert.equal(row.licenseFiles.find((f) => f.path === 'NOTICE').kind, 'notice');
    assert.equal(result.records.find((r) => r.name === 'app').sourceKind, 'workspace-or-local');
    assert.equal(result.records.find((r) => r.name === 'app').metadataStatus, 'missing-package');
    assert.equal(result.releaseAcceptance, false);
    assert.deepEqual(result, (await collectLicenseInventory(options)).inventory);
  }));
test('vendored patch rejects wrong identity/version, malformed or oversized TOML', async () =>
  fixture(async ({ root, options }) => {
    const folder = await pathPatchFixture(root, options);
    for (const metadata of [
      '[package]\nname="other"\nversion="0.35.0"\n',
      '[package]\nname="tao"\nversion="0.34.0"\n',
      'invalid = [',
      '#'.repeat(1048577),
    ]) {
      await writeFile(path.join(folder, 'Cargo.toml'), metadata);
      await assert.rejects(collectLicenseInventory(options), /Cargo|Python/);
    }
  }));
test('vendored patch refuses traversal and absolute paths rather than reading other directories', async () =>
  fixture(async ({ root, options }) => {
    for (const relative of [
      '../vendor/tao',
      '/vendor/tao',
      'vendor/../tao',
      'vendor\\tao',
      'C:/vendor/tao',
      'vendor//tao',
    ]) {
      await pathPatchFixture(root, options, relative);
      await assert.rejects(collectLicenseInventory(options), /Cargo|Python/);
    }
  }));
test('vendored patch refuses linked ancestor and manifest-linked roots', async () =>
  fixture(async ({ root, options }) => {
    await pathPatchFixture(root, options);
    const external = path.join(root, 'outside');
    await mkdir(external);
    await writeFile(path.join(external, 'Cargo.toml'), '[package]\nname="tao"\nversion="0.35.0"\n');
    await rm(path.join(root, 'vendor'), { recursive: true });
    await symlink(external, path.join(root, 'vendor'), 'junction');
    await assert.rejects(collectLicenseInventory(options), /Cargo|Python/);
    await rm(path.join(root, 'vendor'));
    await symlink(root, path.join(root, 'linked-root'), 'junction');
    await assert.rejects(
      collectLicenseInventory({
        ...options,
        cargoManifest: path.join(root, 'linked-root', 'Cargo.toml'),
      }),
      /normal directories/,
    );
  }));
test('deterministic installed-text inventory preserves SPDX expressions, verbatim license/NOTICE and explicit missing tools', async () =>
  fixture(async ({ options }) => {
    const first = await collectLicenseInventory(options);
    const second = await collectLicenseInventory(options);
    assert.deepEqual(first.inventory, second.inventory);
    const npm = first.inventory.records.find((r) => r.name === 'runtime');
    assert.equal(npm.scope, 'direct-runtime');
    assert.equal(npm.licenseDeclaration, 'MIT OR Apache-2.0');
    assert.equal(
      npm.licenseFiles.find((f) => f.kind === 'license').text,
      'Copyright exact ü\r\nMIT OR Apache text\r\n',
    );
    assert.equal(
      npm.licenseFiles.find((f) => f.kind === 'notice').text,
      'Attribution NOTICE preserved separately\n',
    );
    const missing = first.inventory.records.find((r) => r.name === 'missing');
    assert.equal(missing.metadataStatus, 'missing-package');
    assert.equal(missing.scope, 'development-only');
    assert.equal(first.inventory.unknownCount, 1);
    const native = first.inventory.records.find((r) => r.name === 'native');
    assert.equal(native.licenseDeclaration, 'MIT AND BSD-3-Clause');
    assert.equal(native.nativeLinks, 'bundled_native');
    assert.equal(native.scope, 'direct-runtime-candidate');
    assert.equal(first.inventory.releaseAcceptance, false);
    const notice = renderCandidateNotices(first.inventory);
    assert.ok(notice.includes(npm.licenseFiles[0].text));
    assert.match(notice, /NOTICE: NOTICE.txt/);
    assert.match(notice, /MISSING OR UNSUPPORTED/);
  }));
test('writes receipts and never overwrites an existing output or changes installed inputs', async () =>
  fixture(async ({ options, nodeModules }) => {
    const before = await readFile(path.join(nodeModules, 'runtime', 'LICENSE'));
    await writeLicenseInventory(options);
    await assert.rejects(writeLicenseInventory(options), (error) => error.code === 'EEXIST');
    assert.deepEqual(await readFile(path.join(nodeModules, 'runtime', 'LICENSE')), before);
    const receipt = JSON.parse(
      await readFile(path.join(options.outputDir, 'receipt.json'), 'utf8'),
    );
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.releaseAcceptance, false);
    assert.match(receipt.command, /license-inventory/);
  }));
test('missing text and unknown metadata remain follow-up rather than guessed licenses', async () =>
  fixture(async ({ options, nodeModules, cargoRegistry }) => {
    await rm(path.join(nodeModules, 'runtime', 'LICENSE'));
    await rm(path.join(nodeModules, 'runtime', 'NOTICE.txt'));
    await writeFile(
      path.join(nodeModules, 'runtime', 'package.json'),
      JSON.stringify({ name: 'runtime', version: '1.0.0' }),
    );
    await writeFile(
      path.join(cargoRegistry, 'native-1.0.0', 'Cargo.toml'),
      '[package]\nname="native"\nversion="different"\n',
    );
    const { inventory } = await collectLicenseInventory(options);
    assert.equal(inventory.unknownCount, 3);
    assert.equal(inventory.records.find((r) => r.name === 'runtime').licenseDeclaration, null);
    assert.equal(
      inventory.records.find((r) => r.name === 'native').metadataStatus,
      'metadata-mismatch',
    );
    assert.match(renderCandidateNotices(inventory), /Declared license: UNKNOWN/);
  }));
test('lock paths and explicit license-file paths cannot traverse to unrelated files', async () =>
  fixture(async ({ options, nodeModules, cargoRegistry }) => {
    await writeFile(
      options.npmLock,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/../outside': { version: '1' } },
      }),
    );
    await assert.rejects(collectLicenseInventory(options), /outside its admitted root/);
    await writeFile(
      options.npmLock,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/runtime': { version: '1.0.0' } },
      }),
    );
    await writeFile(
      path.join(nodeModules, 'runtime', 'package.json'),
      JSON.stringify({
        name: 'runtime',
        version: '1.0.0',
        license: 'SEE LICENSE IN ../../outside.txt',
      }),
    );
    await assert.rejects(collectLicenseInventory(options), /outside its admitted root/);
    await writeFile(
      path.join(nodeModules, 'runtime', 'package.json'),
      JSON.stringify({ name: 'runtime', version: '1.0.0', license: 'MIT' }),
    );
    await writeFile(
      path.join(cargoRegistry, 'native-1.0.0', 'Cargo.toml'),
      '[package]\nname="native"\nversion="1.0.0"\nlicense-file="../../outside.txt"\n',
    );
    await assert.rejects(collectLicenseInventory(options), /outside its admitted root/);
  }));
test('unsupported license encoding, absent explicit file and oversized text have honest distinct results', async () =>
  fixture(async ({ options, nodeModules }) => {
    await writeFile(path.join(nodeModules, 'runtime', 'LICENSE'), Buffer.from([255, 254, 255]));
    let { inventory } = await collectLicenseInventory(options);
    assert.equal(
      inventory.records
        .find((r) => r.name === 'runtime')
        .licenseFiles.find((f) => f.path === 'LICENSE').status,
      'unsupported-encoding',
    );
    await writeFile(
      path.join(nodeModules, 'runtime', 'package.json'),
      JSON.stringify({
        name: 'runtime',
        version: '1.0.0',
        license: 'SEE LICENSE IN LICENSE.other',
      }),
    );
    ({ inventory } = await collectLicenseInventory(options));
    assert.equal(
      inventory.records
        .find((r) => r.name === 'runtime')
        .licenseFiles.find((f) => f.path === 'LICENSE.other').status,
      'missing-explicit-file',
    );
    await writeFile(path.join(nodeModules, 'runtime', 'LICENSE'), Buffer.alloc(1048577));
    await assert.rejects(collectLicenseInventory(options), /bounded regular file/);
  }));
test('optional npm dependencies and Rust proc macros stay scoped as declarations, never exact binary proof', async () =>
  fixture(async ({ options, cargoRegistry }) => {
    const lock = JSON.parse(await readFile(options.npmLock, 'utf8'));
    lock.packages['node_modules/runtime'].optional = true;
    await writeFile(options.npmLock, JSON.stringify(lock));
    await writeFile(
      path.join(cargoRegistry, 'native-1.0.0', 'Cargo.toml'),
      '[package]\nname="native"\nversion="1.0.0"\nlicense="MIT"\n[lib]\nproc-macro=true\n',
    );
    const { inventory } = await collectLicenseInventory(options);
    assert.equal(inventory.records.find((r) => r.name === 'runtime').optional, true);
    assert.equal(inventory.records.find((r) => r.name === 'native').scope, 'build-proc-macro');
    assert.match(inventory.inventoryAuthority, /no exact shipped-binary proof/);
    assert.ok(inventory.externalReview.some((s) => s.includes('FFmpeg')));
  }));

test('multiple locked Cargo versions do not all inherit direct-runtime status', async () =>
  fixture(async ({ options }) => {
    await writeFile(
      options.cargoLock,
      'version=4\n[[package]]\nname="app"\nversion="1.0.0"\ndependencies=["native 1.0.0"]\n[[package]]\nname="native"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname="native"\nversion="2.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    const { inventory } = await collectLicenseInventory(options);
    assert.equal(
      inventory.records.find(
        (r) => r.ecosystem === 'cargo' && r.name === 'native' && r.version === '1.0.0',
      ).scope,
      'direct-runtime-candidate',
    );
    assert.equal(
      inventory.records.find(
        (r) => r.ecosystem === 'cargo' && r.name === 'native' && r.version === '2.0.0',
      ).scope,
      'locked-other-target-or-build',
    );
  }));
test('installed directory links are refused and UTF8 BOM license text is preserved', async () =>
  fixture(async ({ options, nodeModules, root }) => {
    await writeFile(
      path.join(nodeModules, 'runtime', 'LICENSE'),
      Buffer.from('\ufeffCopyright preserved\r\n'),
    );
    let { inventory } = await collectLicenseInventory(options);
    assert.equal(
      inventory.records
        .find((r) => r.name === 'runtime')
        .licenseFiles.find((f) => f.path === 'LICENSE').text,
      '\ufeffCopyright preserved\r\n',
    );
    const outside = path.join(root, 'unrelated');
    await mkdir(outside);
    await symlink(outside, path.join(nodeModules, 'linked'), 'junction');
    const lock = JSON.parse(await readFile(options.npmLock, 'utf8'));
    lock.packages['node_modules/linked'] = { version: '1' };
    await writeFile(options.npmLock, JSON.stringify(lock));
    await assert.rejects(collectLicenseInventory(options), /symbolic links/);
  }));

async function addKnownCargo(options, registry, name, version, files) {
  const folder = path.join(registry, `${name}-${version}`);
  await mkdir(folder);
  await writeFile(
    options.cargoLock,
    (await readFile(options.cargoLock, 'utf8')) +
      `\n[[package]]\nname="${name}"\nversion="${version}"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n`,
  );
  await writeFile(
    path.join(folder, 'Cargo.toml'),
    `[package]\nname="${name}"\nversion="${version}"\nlicense="MIT"\n`,
  );
  for (const [relative, text] of Object.entries(files)) {
    const filename = path.join(folder, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text);
  }
  return folder;
}

test('explicit ring nested license preservation, missing attribution and no recursive harvesting', () =>
  fixture(async ({ options, cargoRegistry }) => {
    await addKnownCargo(options, cargoRegistry, 'ring', '0.17.14', {
      LICENSE: 'Root license\n',
      'third_party/fiat/LICENSE': 'Fiat exact ü\r\nSee AUTHORS\r\n',
      'src/polyfill/once_cell/LICENSE-APACHE': 'Apache nested\n',
      'src/polyfill/once_cell/LICENSE-MIT': 'MIT nested\n',
      'unlisted/LICENSE': 'Must not harvest\n',
      'COPYRIGHT-RUST.txt': 'Copyright alone\n',
    });
    const { inventory } = await collectLicenseInventory(options);
    const ring = inventory.records.find((r) => r.name === 'ring');
    assert.equal(ring.licenseFiles.length, 5);
    assert.equal(
      ring.licenseFiles.find((f) => f.path === 'third_party/fiat/LICENSE').text,
      'Fiat exact ü\r\nSee AUTHORS\r\n',
    );
    assert.equal(ring.licenseFiles.find((f) => f.path === 'COPYRIGHT-RUST.txt').kind, 'copyright');
    assert.equal(ring.supplementalGaps[0].status, 'missing-referenced-attribution');
    assert.equal(inventory.supplementalGapCount, 1);
    assert.equal(inventory.releaseAcceptance, false);
    assert.match(renderCandidateNotices(inventory), /SUPPLEMENTAL GAP: third_party\/fiat\/AUTHORS/);
  }));

test('copyright alone does not satisfy license-text follow-up', () =>
  fixture(async ({ options, nodeModules }) => {
    await rm(path.join(nodeModules, 'runtime', 'LICENSE'));
    await writeFile(path.join(nodeModules, 'runtime', 'COPYRIGHT'), 'Attribution only');
    const { inventory } = await collectLicenseInventory(options);
    assert.equal(inventory.unknownCount, 2);
    assert.match(renderCandidateNotices(inventory), /LICENSE TEXT MISSING/);
  }));

test('SQLite complete comment retained with whole streamed source hash and exclusive range', () =>
  fixture(async ({ options, cargoRegistry }) => {
    const comment = '/*\r\nComplete SQLite upstream notice ü\r\n*/';
    const source = comment + '\n#ifndef SQLITE3_H\n' + 'x'.repeat(1048576);
    await addKnownCargo(options, cargoRegistry, 'libsqlite3-sys', '0.38.2', {
      LICENSE: 'Wrapper MIT',
      'sqlite3/sqlite3.h': source,
      'sqlcipher/LICENSE': 'Inactive variant',
    });
    const { inventory } = await collectLicenseInventory(options);
    const row = inventory.records.find((r) => r.name === 'libsqlite3-sys');
    const notice = row.licenseFiles.find((f) => f.kind === 'upstream-native-notice');
    assert.equal(notice.text, comment);
    assert.equal(notice.provenance.byteEndExclusive, Buffer.byteLength(comment));
    assert.equal(notice.provenance.sourceBytes, Buffer.byteLength(source));
    const { createHash } = await import('node:crypto');
    assert.equal(notice.provenance.sourceSha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(
      row.licenseFiles.some((f) => f.path.startsWith('sqlcipher')),
      false,
    );
  }));

test('SQLite incomplete or oversized comment fails whole operation', () =>
  fixture(async ({ options, cargoRegistry }) => {
    const folder = await addKnownCargo(options, cargoRegistry, 'libsqlite3-sys', '0.38.2', {
      LICENSE: 'MIT',
      'sqlite3/sqlite3.h': '/* incomplete',
    });
    await assert.rejects(collectLicenseInventory(options), /incomplete/);
    await writeFile(path.join(folder, 'sqlite3/sqlite3.h'), '/*' + 'x'.repeat(65536) + '*/');
    await assert.rejects(collectLicenseInventory(options), /64KiB/);
  }));

test('nested supplements obey combined count and junction refusal', () =>
  fixture(async ({ options, cargoRegistry, root }) => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`LICENSE-${i}`, 'MIT']));
    const folder = await addKnownCargo(options, cargoRegistry, 'ring', '0.17.14', files);
    await assert.rejects(collectLicenseInventory(options), /count/);
    for (let i = 0; i < 30; i++) await rm(path.join(folder, `LICENSE-${i}`));
    const external = path.join(root, 'outside');
    await mkdir(external);
    await symlink(external, path.join(folder, 'third_party'), 'junction');
    await assert.rejects(collectLicenseInventory(options), /symbolic/);
  }));
