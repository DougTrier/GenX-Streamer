#!/usr/bin/env node
// Clean release repository (owner plan, October 23, 2026): copy only what is
// necessary into a new folder with fresh history, so no private leftovers move.
//
//   node scripts/clean-repo.mjs list            the files that would be copied
//   node scripts/clean-repo.mjs scan            privacy scan of exactly those files
//   node scripts/clean-repo.mjs copy <folder>   copy them (the folder must be empty)
//
// Only git-tracked files are considered: never build output, caches or local
// data. The scan blocks credentials, keys, databases, user-profile paths and
// private network addresses, and lists emails for review.
//   - Owner-specific values (device serials, LAN, share and drive names, email)
//     live in an untracked .private-patterns.json at the repository root:
//     { "block": [[label, regex], ...], "review": [[label, regex], ...] }.
//     They always block; no review can allow them.
//   - Lines a person reviewed as harmless fixtures are listed by file and line
//     hash in scripts/clean-repo-allow.json; an edited line needs a new review.
// Exit 0 clean, 1 when the scan blocks, 2 on bad use.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Owner-approved copy rules (October 23, 2026). */
const ROOT_FILES = new Set([
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'eslint.config.mjs',
  'playwright.config.ts',
  'Engineering Spec.MD',
  'README.md',
  'TASKS.md',
  '.gitattributes',
]);
const FOLDERS = ['src/', 'src-tauri/', 'assets/', 'tests/', 'scripts/'];
const DOCS = new Set(['docs/user-guide.md', 'docs/research-reviewed-providers.json']);
/** Inside the copied folders: tooling tied to this machine's backups or the old project ledger. */
const EXCLUDED = [
  /^scripts\/checkpoint\.ps1$/,
  /^scripts\/backup-project\.py$/,
  /^scripts\/tmg\.py$/,
  /^scripts\/project-metrics\.py$/,
  /^tests\/tooling\/test_(tmg|backup_project|project_metrics)\.py$/,
];

export function selectFiles(tracked) {
  return tracked
    .filter(
      (file) =>
        ROOT_FILES.has(file) ||
        DOCS.has(file) ||
        (FOLDERS.some((folder) => file.startsWith(folder)) &&
          !EXCLUDED.some((pattern) => pattern.test(file))),
    )
    .sort();
}

const BLOCK = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['address with a password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@[^\s'"]+/i],
  [
    'Xtream-style credentials',
    /\/(?:live|movie|series)\/[A-Za-z0-9._%-]{3,}\/[A-Za-z0-9._%-]{3,}\/\d+/,
  ],
  ['username/password query', /[?&](?:username|user)=[^&\s'"]+&(?:password|pass)=[^&\s'"]+/i],
  [
    'user profile path',
    /\b[A-Z]:[\\/]Users[\\/](?!Public\b|Default\b|WDAGUtilityAccount\b)[A-Za-z0-9._-]+/i,
  ],
  [
    'private network address',
    /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
  ],
  ['Paid TV account id', /\baccount-[0-9a-f]{32}\b/],
];
const REVIEW = [['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/]];
const BINARY_BLOCK = [
  ['SQLite database', (bytes) => bytes.subarray(0, 16).toString('latin1') === 'SQLite format 3\0'],
  ['keystore or certificate bundle', (bytes, file) => /\.(?:jks|keystore|p12|pfx)$/i.test(file)],
];
const TEXT =
  /\.(?:[cm]?[jt]sx?|json|md|MD|txt|html|css|rs|toml|kt|kts|java|xml|gradle|properties|ps1|py|sh|yml|yaml|svg|pro|cfg|conf|ini|gitignore|prettierignore|m3u8?|xmltv)$/;

export const lineHash = (file, line) =>
  createHash('sha256').update(`${file}\n${line.trim()}`).digest('hex');

function localPatterns() {
  const file = path.join(ROOT, '.private-patterns.json');
  if (!existsSync(file)) return { block: [], review: [] };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const compile = (rows) => (rows ?? []).map(([label, source]) => [label, new RegExp(source, 'i')]);
  return { block: compile(data.block), review: compile(data.review) };
}
function reviewedLines() {
  const file = path.join(ROOT, 'scripts', 'clean-repo-allow.json');
  if (!existsSync(file)) return new Set();
  return new Set(JSON.parse(readFileSync(file, 'utf8')).reviewed.map((row) => row.sha256));
}

export function scanText(file, text, local = { block: [], review: [] }, reviewed = new Set()) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const hash = lineHash(file, line);
    const at = { file, line: index + 1, hash };
    for (const [label, pattern] of local.block)
      if (pattern.test(line)) findings.push({ level: 'block', label, ...at });
    if (reviewed.has(hash)) return;
    for (const [label, pattern] of BLOCK)
      if (pattern.test(line)) findings.push({ level: 'block', label, ...at });
    for (const [label, pattern] of [...REVIEW, ...local.review])
      if (pattern.test(line)) findings.push({ level: 'review', label, ...at });
  });
  return findings;
}

function tracked() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);
}
function scan(files) {
  const local = localPatterns();
  const reviewed = reviewedLines();
  const findings = [];
  for (const file of files) {
    const bytes = readFileSync(path.join(ROOT, file));
    for (const [label, test] of BINARY_BLOCK)
      if (test(bytes, file)) findings.push({ level: 'block', label, file, line: 0 });
    if (TEXT.test(file) && bytes.length <= 8 * 1024 * 1024)
      findings.push(...scanText(file, bytes.toString('utf8'), local, reviewed));
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target] = process.argv.slice(2);
  const files = selectFiles(tracked());
  if (command === 'list') {
    const bytes = files.reduce((sum, file) => sum + statSync(path.join(ROOT, file)).size, 0);
    const top = {};
    for (const file of files) {
      const key = file.includes('/') ? file.split('/')[0] + '/' : '(root)';
      top[key] = (top[key] ?? 0) + 1;
    }
    console.log(
      JSON.stringify(
        { files: files.length, megabytes: Math.round(bytes / 1048576), byFolder: top },
        null,
        1,
      ),
    );
  } else if (command === 'scan') {
    const findings = scan(files);
    const summary = {};
    for (const finding of findings) {
      const key = `${finding.level}: ${finding.label}`;
      summary[key] = (summary[key] ?? 0) + 1;
    }
    console.log(JSON.stringify({ scanned: files.length, summary, findings }, null, 1));
    process.exitCode = findings.some((finding) => finding.level === 'block') ? 1 : 0;
  } else if (command === 'copy' && target) {
    const destination = path.resolve(target);
    if (!existsSync(destination) || readdirSync(destination).length) {
      console.error('The destination folder must exist and be empty.');
      process.exit(2);
    }
    const blocked = scan(files).filter((finding) => finding.level === 'block');
    if (blocked.length) {
      console.error(`Privacy scan blocks the copy (${blocked.length} findings); run scan.`);
      process.exit(1);
    }
    for (const file of files) {
      mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
      copyFileSync(path.join(ROOT, file), path.join(destination, file));
    }
    writeFileSync(path.join(destination, '.clean-repo-manifest.txt'), files.join('\n') + '\n');
    console.log(JSON.stringify({ copied: files.length, destination }));
  } else {
    console.error('usage: clean-repo.mjs list | scan | copy <empty folder>');
    process.exit(2);
  }
}
