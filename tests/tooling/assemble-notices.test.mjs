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
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleNotices, writeDraftNotices } from '../../scripts/assemble-notices.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'GenX draft ü '));
  try {
    const inventory = {
      schemaVersion: 1,
      releaseAcceptance: false,
      unknownCount: 207,
      supplementalGapCount: 1,
      inputSha256: { npmLock: 'a', cargoLock: 'b', cargoManifest: 'c' },
      externalReview: ['Runtime platform review open'],
      records: [
        {
          ecosystem: 'cargo',
          name: 'included',
          version: '1.0.0',
          scope: 'runtime-candidate',
          metadataStatus: 'matched',
          licenseDeclaration: 'MIT OR Apache-2.0',
          reviewRequired: true,
          licenseFiles: [
            {
              path: 'NOTICE',
              kind: 'notice',
              sha256: hash('Original NOTICE\r\n'),
              text: 'Original NOTICE\r\n',
            },
          ],
        },
        {
          ecosystem: 'cargo',
          name: 'other-target',
          version: '1.0.0',
          scope: 'runtime-candidate',
          metadataStatus: 'missing-package',
          licenseDeclaration: null,
          licenseFiles: [],
          reviewRequired: true,
        },
        {
          ecosystem: 'npm',
          name: 'dev-only',
          version: '1.0.0',
          scope: 'development-only',
          licenseFiles: [],
          reviewRequired: true,
        },
      ],
    };
    const review = {
      schemaVersion: 1,
      releaseAcceptance: false,
      currentInputSha256: inventory.inputSha256,
      targetMetadata: [
        {
          platform: 'x86_64-pc-windows-msvc',
          exitCode: 0,
          runtimeCandidates: [{ name: 'included', version: '1.0.0' }],
        },
        {
          platform: 'aarch64-linux-android',
          exitCode: 0,
          runtimeCandidates: [{ name: 'other-target', version: '1.0.0' }],
        },
      ],
    };
    const text = 'Copyright exact ü\r\nComplete MIT license\r\n';
    await writeFile(path.join(root, 'LICENSE.txt'), text);
    const upstream = {
      schemaVersion: 1,
      releaseAcceptance: false,
      materials: [
        {
          key: 'known',
          url: 'https://example.org/pinned/LICENSE',
          file: 'LICENSE.txt',
          sha256: hash(text),
          status: 'fetched',
        },
      ],
    };
    const options = { target: 'windows', outputDir: path.join(root, 'output') };
    for (const [name, value] of Object.entries({
      inventory,
      targetReview: review,
      upstreamReport: upstream,
    })) {
      options[name] = path.join(root, name + '.json');
      await writeFile(options[name], JSON.stringify(value));
    }
    const manifest = {
      schemaVersion: 1,
      releaseAcceptance: false,
      inputSha256: Object.fromEntries(
        await Promise.all(
          ['inventory', 'targetReview', 'upstreamReport'].map(async (name) => [
            name,
            hash(await readFile(options[name])),
          ]),
        ),
      ),
      entries: [
        {
          id: 'known',
          recordIds: ['cargo:included@1.0.0'],
          targets: ['windows'],
          file: 'LICENSE.txt',
          sha256: hash(text),
          kind: 'license',
          sourceMaterialKey: 'known',
          provenance: { sourceUrl: upstream.materials[0].url, sourceSha256: hash(text) },
        },
      ],
      unresolved: [
        {
          targets: ['windows', 'android'],
          text: 'MPL source availability, Cesu8 exact source, Fiat AUTHORS and loader matching remain unverified.',
        },
      ],
    };
    options.supplementManifest = path.join(root, 'manifest.json');
    await writeFile(options.supplementManifest, JSON.stringify(manifest));
    await run({
      root,
      options,
      manifest,
      inventory,
      review,
      text,
      save: () => writeFile(options.supplementManifest, JSON.stringify(manifest)),
    });
  } finally {
    if (root.startsWith(path.join(os.tmpdir(), 'GenX draft ü ')))
      await rm(root, { recursive: true, force: true });
  }
}
test('deterministic target draft preserves complete texts, attribution, alternatives and207unknowns', () =>
  fixture(async ({ options, text }) => {
    const first = await assembleNotices(options),
      second = await assembleNotices(options);
    assert.deepEqual(first, second);
    assert.ok(first.text.includes(text));
    assert.ok(first.text.includes('Original NOTICE\r\n'));
    assert.equal(first.assembly.records.length, 1);
    assert.equal(first.assembly.records[0].licenseDeclaration, 'MIT OR Apache-2.0');
    assert.equal(first.assembly.originalUnknownCount, 207);
    assert.equal(first.assembly.originalSupplementalGapCount, 1);
    assert.equal(first.assembly.releaseAcceptance, false);
    assert.equal(first.assembly.records[0].reviewRequired, true);
    assert.match(first.text, /MPL source availability/);
    assert.match(first.text, /NOT EXACT LINKED SHIPPING CLOSURE/);
    const android = await assembleNotices({ ...options, target: 'android' });
    assert.equal(android.assembly.supplements.length, 0);
    assert.equal(android.assembly.records[0].id, 'cargo:other-target@1.0.0');
    assert.doesNotMatch(android.text, /Complete MIT license/);
  }));
test('hash tamper and missing originals fail without output', () =>
  fixture(async ({ options, root }) => {
    await writeFile(path.join(root, 'LICENSE.txt'), 'Tampered');
    await assert.rejects(writeDraftNotices(options), /hash mismatch/);
    await assert.rejects(readFile(path.join(options.outputDir, 'receipt.json')), /ENOENT/);
    await rm(path.join(root, 'LICENSE.txt'));
    await assert.rejects(assembleNotices(options), /ENOENT/);
  }));
test('inventory or graph input hash changes fail closed', () =>
  fixture(async ({ options }) => {
    await writeFile(options.targetReview, (await readFile(options.targetReview, 'utf8')) + ' ');
    await assert.rejects(assembleNotices(options), /hash mismatch/);
    await writeFile(options.inventory, '{}');
    await assert.rejects(assembleNotices(options), /schema/);
  }));
test('paths, links and undeclared record identities refused', () =>
  fixture(async ({ options, root, manifest, save }) => {
    manifest.entries[0].file = '../LICENSE.txt';
    await save();
    await assert.rejects(assembleNotices(options), /outside/);
    manifest.entries[0].file = 'link/LICENSE.txt';
    await mkdir(path.join(root, 'nested'));
    await symlink(path.join(root, 'nested'), path.join(root, 'link'), 'junction');
    await save();
    await assert.rejects(assembleNotices(options), /links/);
    manifest.entries[0].file = 'LICENSE.txt';
    manifest.entries[0].recordIds = ['cargo:missing@1'];
    await save();
    await assert.rejects(assembleNotices(options), /identity/);
  }));
test('new output only and receipt clearly draft, input files unchanged', () =>
  fixture(async ({ options }) => {
    const before = await readFile(options.inventory);
    await writeDraftNotices(options);
    const receipt = JSON.parse(
      await readFile(path.join(options.outputDir, 'receipt.json'), 'utf8'),
    );
    assert.equal(receipt.releaseAcceptance, false);
    assert.equal(receipt.exitCode, 0);
    assert.deepEqual(before, await readFile(options.inventory));
    await assert.rejects(writeDraftNotices(options), /EEXIST/);
  }));
test('invalid target, oversized text and source-provenance mismatch refused', () =>
  fixture(async ({ options, manifest, root, save }) => {
    await assert.rejects(assembleNotices({ ...options, target: 'linux' }), /target/);
    manifest.entries[0].provenance.sourceUrl = 'https://example.org/wrong';
    await save();
    await assert.rejects(assembleNotices(options), /provenance/);
    manifest.entries[0].provenance.sourceUrl = 'https://example.org/pinned/LICENSE';
    await save();
    await writeFile(path.join(root, 'LICENSE.txt'), 'x'.repeat(1048577));
    await assert.rejects(assembleNotices(options), /Bounded/);
  }));
