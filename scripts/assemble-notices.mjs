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

import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { renderCandidateNotices } from './license-inventory.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const id = (record) => `${record.ecosystem}:${record.name}@${record.version}`;
const platforms = { windows: 'x86_64-pc-windows-msvc', android: 'aarch64-linux-android' };
async function read(filename, limit = 16777216) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('Bounded normal input file required.');
  const bytes = await readFile(filename);
  if (bytes.length > limit) throw new Error('Input limit exceeded.');
  return bytes;
}
async function admitted(root, relative) {
  if (
    typeof relative !== 'string' ||
    relative.length > 2048 ||
    relative.includes('\\') ||
    relative.includes(':') ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Supplement path is outside admitted root.');
  let current = path.resolve(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Supplement paths cannot follow links.');
  }
  return current;
}
function sourceUrl(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    raw.length > 2048
  )
    throw new Error('Explicit public HTTPS provenance required.');
  return raw;
}
function pin(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('SHA256 pin required.');
  return value;
}
export async function assembleNotices(options) {
  if (!platforms[options.target]) throw new Error('Explicit Windows or Android target required.');
  const names = ['inventory', 'targetReview', 'upstreamReport', 'supplementManifest'];
  const buffers = await Promise.all(names.map((name) => read(options[name])));
  const [inventory, review, upstream, manifest] = buffers.map((bytes) =>
    JSON.parse(decoder.decode(bytes)),
  );
  if (
    [inventory, review, upstream, manifest].some(
      (data) => data.schemaVersion !== 1 || data.releaseAcceptance !== false,
    )
  )
    throw new Error('Reviewed draft schemas required; release acceptance cannot be inferred.');
  if (
    !Array.isArray(inventory.records) ||
    inventory.records.length > 10000 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 100 ||
    !Array.isArray(upstream.materials) ||
    upstream.materials.length > 100 ||
    !Array.isArray(manifest.unresolved) ||
    manifest.unresolved.length > 100
  )
    throw new Error('Inventory/supplement count bound exceeded.');
  const inputSha256 = Object.fromEntries(names.map((name, index) => [name, hash(buffers[index])]));
  for (const name of names.slice(0, 3))
    if (pin(manifest.inputSha256?.[name]) !== inputSha256[name])
      throw new Error('Input provenance hash mismatch.');
  for (const name of ['npmLock', 'cargoLock', 'cargoManifest'])
    if (review.currentInputSha256?.[name] !== inventory.inputSha256?.[name])
      throw new Error('Target graph and inventory lock provenance differ.');
  const graph = review.targetMetadata?.find((row) => row.platform === platforms[options.target]);
  if (
    !graph ||
    graph.exitCode !== 0 ||
    !Array.isArray(graph.runtimeCandidates) ||
    graph.runtimeCandidates.length > 5000
  )
    throw new Error('Successful bounded filtered target graph required.');
  const wanted = new Set(graph.runtimeCandidates.map((row) => `cargo:${row.name}@${row.version}`));
  const records = inventory.records.filter((row) =>
    row.ecosystem === 'cargo'
      ? wanted.has(id(row))
      : row.ecosystem === 'npm' && ['direct-runtime', 'runtime-candidate'].includes(row.scope),
  );
  const existing = new Set(inventory.records.map(id));
  for (const record of wanted)
    if (!existing.has(record)) throw new Error('Target candidate absent from inventory.');
  const selected = new Set(records.map(id));
  const additions = [];
  const supplementIds = new Set();
  for (const entry of manifest.entries) {
    if (
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) ||
      supplementIds.has(entry.id) ||
      !Array.isArray(entry.recordIds) ||
      entry.recordIds.length < 1 ||
      entry.recordIds.length > 100 ||
      entry.recordIds.some((record) => !existing.has(record)) ||
      !Array.isArray(entry.targets) ||
      entry.targets.length < 1 ||
      entry.targets.some((target) => !platforms[target]) ||
      typeof entry.kind !== 'string' ||
      !['license', 'copyright', 'authors', 'source-notice'].includes(entry.kind)
    )
      throw new Error('Explicit supplement identity/scope invalid.');
    supplementIds.add(entry.id);
    const source = sourceUrl(entry.provenance?.sourceUrl);
    if (entry.sourceMaterialKey) {
      const material = upstream.materials.find((row) => row.key === entry.sourceMaterialKey);
      if (
        !material ||
        material.status !== 'fetched' ||
        material.url !== source ||
        material.sha256 !== entry.provenance.sourceSha256
      )
        throw new Error('Upstream material provenance differs.');
      const original = await read(
        await admitted(path.dirname(options.upstreamReport), material.file),
        1048576,
      );
      if (hash(original) !== pin(material.sha256))
        throw new Error('Original upstream material hash mismatch.');
    }
    const bytes = await read(
      await admitted(path.dirname(options.supplementManifest), entry.file),
      1048576,
    );
    if (hash(bytes) !== pin(entry.sha256)) throw new Error('Supplement text hash mismatch.');
    if (!entry.sourceMaterialKey && pin(entry.provenance.sourceSha256) !== entry.sha256)
      throw new Error('Direct supplement source hash differs.');
    const text = decoder.decode(bytes);
    if (
      entry.targets.includes(options.target) &&
      entry.recordIds.some((record) => selected.has(record))
    )
      additions.push({ ...entry, text, sourceUrl: source });
  }
  const unresolved = manifest.unresolved.filter((row) => {
    if (
      !Array.isArray(row.targets) ||
      row.targets.some((target) => !platforms[target]) ||
      typeof row.text !== 'string' ||
      row.text.length < 1 ||
      row.text.length > 4096
    )
      throw new Error('Unresolved review item invalid.');
    return row.targets.includes(options.target);
  });
  let text = `GenX Streamer ${options.target.toUpperCase()} DRAFT THIRD-PARTY NOTICES\nFILTERED RUNTIME GRAPH CANDIDATES; NOT EXACT LINKED SHIPPING CLOSURE; NOT LEGAL RELEASE ACCEPTANCE.\nOriginal inventory follow-ups: ${inventory.unknownCount}; supplemental gaps: ${inventory.supplementalGapCount ?? 0}. No review flags or unknowns were cleared.\n\n`;
  text += renderCandidateNotices({ ...inventory, records });
  for (const entry of additions)
    text += `\n=== REVIEWED UPSTREAM TEXT SUPPLEMENT: ${entry.id} [${entry.kind}] ===\nApplies to candidate IDs: ${entry.recordIds.join(', ')}\nSource provenance: ${JSON.stringify(entry.provenance)}\nText SHA256: ${entry.sha256}\n${entry.text}${entry.text.endsWith('\n') ? '' : '\n'}`;
  text +=
    '\nUNRESOLVED SHIPPING / SOURCE-OBLIGATION REVIEW\n' +
    unresolved.map((row) => '- ' + row.text).join('\n') +
    '\n';
  if (Buffer.byteLength(text) > 16777216)
    throw new Error('Draft notice output exceeds16MiB; no truncation.');
  const assembly = {
    schemaVersion: 1,
    product: 'GenX Streamer',
    target: options.target,
    platform: platforms[options.target],
    releaseAcceptance: false,
    authority: 'filtered runtime graph candidates; not exact linked shipping closure',
    inputSha256,
    originalUnknownCount: inventory.unknownCount,
    originalSupplementalGapCount: inventory.supplementalGapCount ?? 0,
    records: records.map((row) => ({
      id: id(row),
      reviewRequired: row.reviewRequired,
      metadataStatus: row.metadataStatus,
      licenseDeclaration: row.licenseDeclaration,
    })),
    supplements: additions.map((entry) => {
      const copy = { ...entry };
      delete copy.text;
      return copy;
    }),
    unresolved,
    noticeSha256: hash(Buffer.from(text)),
  };
  return { text, assembly };
}
export async function writeDraftNotices(options) {
  const result = await assembleNotices(options);
  const out = path.resolve(options.outputDir);
  const parent = await lstat(path.dirname(out));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Normal existing output parent required.');
  await mkdir(out);
  await writeFile(path.join(out, 'THIRD-PARTY-NOTICES.txt'), result.text, { flag: 'wx' });
  await writeFile(
    path.join(out, 'assembly.json'),
    JSON.stringify(result.assembly, null, 2) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'node scripts/assemble-notices.mjs',
        finishedUtc: new Date().toISOString(),
        exitCode: 0,
        releaseAcceptance: false,
        target: options.target,
        records: result.assembly.records.length,
        supplements: result.assembly.supplements.length,
        noticeSha256: result.assembly.noticeSha256,
        inputSha256: result.assembly.inputSha256,
        node: process.version,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  return result.assembly;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = {
    inventory: 'inventory',
    'target-review': 'targetReview',
    'upstream-report': 'upstreamReport',
    'supplement-manifest': 'supplementManifest',
    target: 'target',
    'output-dir': 'outputDir',
  };
  const args = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]?.slice(2)];
      if (
        !key ||
        !process.argv[index].startsWith('--') ||
        args[key] ||
        !process.argv[index + 1] ||
        process.argv[index + 1].startsWith('--')
      )
        throw new Error('Explicit arguments required.');
      args[key] = process.argv[index + 1];
    }
    if (Object.values(names).some((key) => !args[key]))
      throw new Error('All explicit paths and target required.');
    await writeDraftNotices(args);
  } catch {
    console.error(
      'Draft assembly failed: verify explicit target, pinned inputs, bounded normal files and a new output directory.',
    );
    process.exitCode = 1;
  }
}
