#!/usr/bin/env node
// Release notices for one shipped artifact (owner request, October 23, 2026).
// From an offline license inventory (scripts/license-inventory.mjs) and the
// exact list of crates compiled into the artifact (`cargo tree --target <triple>
// -e normal`), writes THIRD-PARTY-NOTICES.txt holding:
//   - every shipped component with its declared license;
//   - each distinct license/notice text once, naming the components that use it;
//   - shipped components whose license text was not found, as follow-ups.
// Deterministic for identical inputs; no network, build or license selection.
//
//   node scripts/release-notices.mjs --inventory <inventory.json>
//     --crates <name@version per line> --product "<name>" --output <new file>
//     [--supplements <supplement-manifest.json> --target windows|android]
// Supplements (scripts/assemble-notices.mjs manifests) add hash-pinned texts for
// shipped components whose packages lack them; a hash mismatch stops the run.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function releaseNotices(inventory, crates, product, supplements = []) {
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.records))
    throw new Error('A schema 1 license inventory is required.');
  const wanted = new Set(crates);
  const shipped = inventory.records
    .filter((row) =>
      row.ecosystem === 'cargo'
        ? wanted.has(`${row.name}@${row.version}`)
        : row.ecosystem === 'npm' && ['direct-runtime', 'runtime-candidate'].includes(row.scope),
    )
    .sort((a, b) =>
      compare(`${a.ecosystem}:${a.name}@${a.version}`, `${b.ecosystem}:${b.name}@${b.version}`),
    );
  const found = new Set(
    inventory.records
      .filter((row) => row.ecosystem === 'cargo')
      .map((row) => `${row.name}@${row.version}`),
  );
  const absent = [...wanted].filter((id) => !found.has(id)).sort(compare);
  const texts = new Map();
  const missing = [];
  for (const row of shipped) {
    const id = `${row.ecosystem}:${row.name}@${row.version}`;
    const present = [
      ...(row.licenseFiles ?? []),
      ...supplements
        .filter((entry) => entry.recordIds.includes(id))
        .map((entry) => ({ path: `supplement ${entry.id}`, kind: entry.kind, text: entry.text })),
    ].filter((file) => typeof file.text === 'string');
    row.noticeFiles = present;
    if (!present.some((file) => file.kind === 'license')) missing.push(row);
    for (const file of present) {
      const key = hash(file.text);
      if (!texts.has(key)) texts.set(key, { text: file.text, kind: file.kind, users: [] });
      texts.get(key).users.push(`${id} (${file.path})`);
    }
  }
  const ordered = [...texts.entries()].sort((a, b) => compare(a[1].users[0], b[1].users[0]));
  const textId = new Map(
    ordered.map(([key], index) => [key, `T${String(index + 1).padStart(3, '0')}`]),
  );
  let out =
    `${product}: THIRD-PARTY NOTICES\n\n` +
    'Components compiled into or bundled with this artifact, their declared licenses, and the\n' +
    'license and notice texts found in their installed packages. Each distinct text appears once.\n\n' +
    `Components: ${shipped.length}. Distinct texts: ${ordered.length}. Without a license text: ${missing.length}.\n\n` +
    '== COMPONENTS ==\n';
  for (const row of shipped) {
    const ids = row.noticeFiles.map((file) => textId.get(hash(file.text)));
    out += `${row.ecosystem}:${row.name}@${row.version}  license: ${row.licenseDeclaration ?? 'UNKNOWN'}  texts: ${ids.join(', ') || 'none found'}\n`;
  }
  out += '\n== LICENSE AND NOTICE TEXTS ==\n';
  for (const [key, entry] of ordered) {
    out += `\n--- ${textId.get(key)} (${entry.kind}) used by: ${entry.users.join('; ')} ---\n${entry.text}`;
    if (!entry.text.endsWith('\n')) out += '\n';
  }
  out += '\n== FOLLOW-UP: NO LICENSE TEXT FOUND IN THE INSTALLED PACKAGE ==\n';
  for (const row of missing)
    out += `${row.ecosystem}:${row.name}@${row.version}  declared: ${row.licenseDeclaration ?? 'UNKNOWN'}\n`;
  if (!missing.length) out += 'none\n';
  if (absent.length) {
    out += '\n== SHIPPED CRATES ABSENT FROM THE INVENTORY ==\n';
    out += absent.map((id) => `cargo:${id}\n`).join('');
  }
  return {
    text: out,
    shipped: shipped.length,
    distinct: ordered.length,
    missing: missing.length,
    absent,
  };
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())
) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2)
    args[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
  if (!args.inventory || !args.crates || !args.product || !args.output) {
    console.error('usage: --inventory <file> --crates <file> --product <name> --output <new file>');
    process.exit(1);
  }
  const inventory = JSON.parse(readFileSync(args.inventory, 'utf8'));
  const crates = readFileSync(args.crates, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('tmg-tv@'));
  const supplements = [];
  if (args.supplements) {
    const manifest = JSON.parse(readFileSync(args.supplements, 'utf8'));
    const base = path.dirname(args.supplements);
    for (const entry of manifest.entries ?? []) {
      if (!entry.targets?.includes(args.target)) continue;
      const text = readFileSync(`${base}/${entry.file}`, 'utf8');
      if (hash(text) !== entry.sha256) throw new Error(`Supplement hash mismatch: ${entry.id}`);
      supplements.push({ id: entry.id, kind: entry.kind, recordIds: entry.recordIds, text });
    }
  }
  const result = releaseNotices(inventory, crates, args.product, supplements);
  writeFileSync(args.output, result.text, { flag: 'wx' });
  console.log(
    JSON.stringify({
      output: args.output,
      bytes: Buffer.byteLength(result.text),
      sha256: hash(result.text),
      components: result.shipped,
      distinctTexts: result.distinct,
      withoutLicenseText: result.missing,
      absentFromInventory: result.absent.length,
    }),
  );
}
