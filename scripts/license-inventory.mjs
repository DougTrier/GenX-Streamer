import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MAX_FILE = 1048576,
  MAX_OUTPUT = 16777216,
  MAX_PACKAGES = 5000;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function regular(filename, limit = MAX_FILE) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('Inventory input must be a bounded regular file.');
  const bytes = await readFile(filename);
  if (bytes.length > limit) throw new Error('Inventory input exceeded its bound.');
  return bytes;
}
function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
async function rootDirectory(dirname) {
  const absolute = path.resolve(dirname);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(absolute)) !== absolute)
    throw new Error('Inventory roots must be explicit normal directories.');
  return absolute;
}
async function inside(root, relative) {
  if (
    typeof relative !== 'string' ||
    relative.length > 2048 ||
    relative.includes('\\') ||
    relative.includes(':') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((s) => !s || s === '.' || s === '..')
  )
    throw new Error('Inventory path is outside its admitted root.');
  const parts = relative.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Inventory paths cannot follow symbolic links.');
  }
  if (!path.resolve(current).startsWith(root + path.sep))
    throw new Error('Inventory path escaped its root.');
  return current;
}
const PYTHON = String.raw`
import sys,json,tomllib,pathlib,re,hashlib,stat
p=json.load(sys.stdin)
def read(file,limit):
 f=pathlib.Path(file)
 if not f.is_file() or f.is_symlink() or getattr(f.lstat(),'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0) or f.stat().st_size>limit: raise ValueError('bounded regular TOML required')
 b=f.read_bytes()
 if len(b)>limit: raise ValueError('TOML limit')
 return tomllib.loads(b.decode('utf-8')),hashlib.sha256(b).hexdigest()
lock,lockhash=read(p['lock'],8388608);manifest,manifesthash=read(p['manifest'],1048576)
packages=lock.get('package',[])
if not isinstance(packages,list) or len(packages)>5000: raise ValueError('Cargo package limit')
def names(table):
 out=[]
 for alias,value in table.items():
  name=value.get('package',alias) if isinstance(value,dict) else alias
  if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',name): raise ValueError('dependency name invalid')
  out.append(name)
 return out
runtime=names(manifest.get('dependencies',{}));build=names(manifest.get('build-dependencies',{}))+names(manifest.get('dev-dependencies',{}))
for cfg in manifest.get('target',{}).values():
 runtime+=names(cfg.get('dependencies',{}));build+=names(cfg.get('build-dependencies',{}))+names(cfg.get('dev-dependencies',{}))
rows=[];root=pathlib.Path(p['registry'])
manifestroot=pathlib.Path(p['manifest']).parent
patches=manifest.get('patch',{}).get('crates-io',{})
if not isinstance(patches,dict):raise ValueError('patch table invalid')
pathpatches={}
for alias,value in patches.items():
 if not isinstance(value,dict):raise ValueError('patch descriptor invalid')
 if 'path' not in value:continue
 relative=value['path'];name=value.get('package',alias)
 if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',name) or name in pathpatches:raise ValueError('patch identity invalid')
 if not isinstance(relative,str) or len(relative)>2048 or '\\' in relative or ':' in relative or '\x00' in relative or pathlib.Path(relative).is_absolute() or any(s in ('','.','..') for s in relative.split('/')):raise ValueError('patch path invalid')
 folder=manifestroot
 for part in relative.split('/'):
  folder=folder/part;s=folder.lstat()
  if folder.is_symlink() or getattr(s,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0) or not folder.is_dir():raise ValueError('patch directory policy')
 if folder.resolve()!=folder:raise ValueError('patch root policy')
 metadata,digest=read(folder/'Cargo.toml',1048576);m=metadata.get('package',{})
 if not isinstance(m,dict) or m.get('name')!=name or not isinstance(m.get('version'),str):raise ValueError('patch metadata identity')
 pathpatches[name]=(relative,metadata,digest)
for pkg in packages:
 name=pkg.get('name');version=pkg.get('version')
 if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',name) or not isinstance(version,str) or not re.fullmatch(r'[A-Za-z0-9.+-]{1,128}',version): raise ValueError('Cargo lock identity invalid')
 deps=pkg.get('dependencies',[])
 if not isinstance(deps,list) or len(deps)>10000 or any(not isinstance(d,str) or len(d)>512 for d in deps): raise ValueError('Cargo dependency limit')
 source=pkg.get('source','');kind='registry' if source.startswith('registry+') else 'git' if source.startswith('git+') else 'workspace-or-local'
 row={'name':name,'version':version,'sourceKind':kind,'checksum':pkg.get('checksum'),'dependencies':deps,'metadata':None,'metadataStatus':'missing-package'}
 if kind=='registry':
  folder=root/(name+'-'+version);file=folder/'Cargo.toml'
  if folder.exists():
   if folder.is_symlink() or not folder.is_dir():raise ValueError('registry directory policy')
   if file.exists():
    metadata,digest=read(file,1048576);m=metadata.get('package',{})
    row['metadata']={'name':m.get('name'),'version':m.get('version'),'license':m.get('license'),'licenseFile':m.get('license-file'),'nativeLinks':m.get('links'),'procMacro':metadata.get('lib',{}).get('proc-macro',False),'sha256':digest}
    row['metadataStatus']='matched' if m.get('name')==name and m.get('version')==version else 'metadata-mismatch'
 elif kind=='workspace-or-local' and name in pathpatches:
  relative,metadata,digest=pathpatches[name];m=metadata['package']
  if m.get('version')!=version:raise ValueError('patch metadata version')
  row['sourceKind']='vendored-path-override';row['metadataRelativePath']=relative
  row['metadataOrigin']={'kind':'manifest-relative-crates-io-patch','path':relative,'manifestSha256':digest}
  row['metadata']={'name':m['name'],'version':m['version'],'license':m.get('license'),'licenseFile':m.get('license-file'),'nativeLinks':m.get('links'),'procMacro':metadata.get('lib',{}).get('proc-macro',False),'sha256':digest}
  row['metadataStatus']='matched'
 rows.append(row)
rootdeps=next((r['dependencies'] for r in rows if r['name']==manifest.get('package',{}).get('name') and r['version']==manifest.get('package',{}).get('version')),None)
def ids(declared):
 out=[]
 for d in (rootdeps if rootdeps is not None else declared):
  pieces=d.split(' ');name=pieces[0]
  if name not in declared:continue
  found=[r for r in rows if r['name']==name and (len(pieces)<2 or r['version']==pieces[1])]
  if len(found)==1:out.append(found[0]['name']+'@'+found[0]['version'])
 return sorted(set(out))
print(json.dumps({'packages':rows,'runtimeNames':sorted(set(runtime)),'buildNames':sorted(set(build)),'runtimeIds':ids(runtime),'buildIds':ids(build),'lockSha256':lockhash,'manifestSha256':manifesthash,'python':sys.version.split()[0]}))
`;
async function cargoData(payload, pythonExecutable = 'python') {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-B', '-X', 'utf8', '-c', PYTHON], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let oversized = false;
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', (b) => {
      output += b;
      if (output.length > 8388608) {
        oversized = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Python3.11+ with tomllib is required for offline inventory.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || oversized) reject(new Error('Bounded Cargo metadata inventory failed.'));
      else {
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new Error('Cargo inventory returned invalid metadata.'));
        }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
async function notices(root, folder, extra, supplements = []) {
  const filenames = (await readdir(folder)).filter((name) =>
    /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i.test(name),
  );
  if (extra) {
    if (typeof extra !== 'string') throw new Error('Explicit license-file path is invalid.');
    filenames.push(extra);
  }
  filenames.push(...supplements);
  const unique = [...new Set(filenames)].sort();
  if (unique.length > 32) throw new Error('License file count exceeds bound.');
  const result = [];
  for (const relative of unique) {
    try {
      const filename = await inside(root, relative);
      const bytes = await regular(filename);
      const text = decode(bytes);
      result.push({
        path: relative,
        sha256: hash(bytes),
        bytes: bytes.length,
        text,
        kind: /^notice(?:[._-]|$)/i.test(path.basename(relative))
          ? 'notice'
          : /^copyright(?:[._-]|$)/i.test(path.basename(relative))
            ? 'copyright'
            : 'license',
        ...(supplements.includes(relative)
          ? { provenance: { authority: 'explicit installed package path', sourcePath: relative } }
          : {}),
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        result.push({
          path: relative,
          status: 'missing-explicit-file',
          ...(supplements.includes(relative)
            ? { provenance: { authority: 'explicit installed package path', sourcePath: relative } }
            : {}),
        });
      } else if (error instanceof TypeError) {
        result.push({
          path: relative,
          status: 'unsupported-encoding',
          ...(supplements.includes(relative)
            ? { provenance: { authority: 'explicit installed package path', sourcePath: relative } }
            : {}),
        });
      } else throw error;
    }
  }
  return result;
}
async function sqliteNotice(folder) {
  const relative = 'sqlite3/sqlite3.h';
  const filename = await inside(folder, relative);
  const stat = await lstat(filename);
  const limit = 32 * 1048576;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('SQLite header must be a bounded regular file.');
  const handle = await open(filename, 'r');
  const digest = createHash('sha256');
  const chunk = Buffer.alloc(65536);
  let prefix;
  let length = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new Error('SQLite header exceeds bound.');
      const bytes = chunk.subarray(0, bytesRead);
      if (!prefix) prefix = Buffer.from(bytes);
      digest.update(bytes);
    }
  } finally {
    await handle.close();
  }
  if (length !== stat.size) throw new Error('SQLite header changed during inventory.');
  const start = prefix?.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0;
  if (!prefix || prefix.toString('ascii', start, start + 2) !== '/*')
    throw new Error('SQLite header notice is missing.');
  const end = prefix.indexOf(Buffer.from('*/'), start + 2);
  if (end < 0) throw new Error('SQLite header notice is incomplete or exceeds64KiB.');
  const bytes = prefix.subarray(start, end + 2);
  return {
    path: relative,
    kind: 'upstream-native-notice',
    bytes: bytes.length,
    sha256: hash(bytes),
    text: decode(bytes),
    provenance: {
      authority: 'complete first installed SQLite header comment',
      sourcePath: relative,
      sourceSha256: digest.digest('hex'),
      sourceBytes: length,
      byteStart: start,
      byteEndExclusive: end + 2,
    },
  };
}
function cleanDeclaration(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : null;
}
function npmName(relative) {
  return relative.slice(relative.lastIndexOf('node_modules/') + 13);
}
function cargoClosure(data) {
  const ids = new Set(data.runtimeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of data.packages)
      if (ids.has(`${row.name}@${row.version}`))
        for (const dependency of row.dependencies) {
          const [name, version] = dependency.split(' ');
          const found = data.packages.filter(
            (r) => r.name === name && (!version || r.version === version),
          );
          for (const candidate of found) {
            const id = `${candidate.name}@${candidate.version}`;
            if (!ids.has(id)) {
              ids.add(id);
              changed = true;
            }
          }
        }
  }
  return ids;
}
export async function collectLicenseInventory(options) {
  const nodeRoot = await rootDirectory(options.nodeModules);
  const registry = await rootDirectory(options.cargoRegistry);
  const lockBytes = await regular(options.npmLock, 8388608);
  const lock = JSON.parse(decode(lockBytes));
  if (
    lock.lockfileVersion !== 3 ||
    !lock.packages ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  )
    throw new Error('Supported npm lock version3 is required.');
  const entries = Object.entries(lock.packages)
    .filter(([relative]) => relative !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > MAX_PACKAGES) throw new Error('npm package limit exceeded.');
  const records = [];
  const direct = new Set(Object.keys(lock.packages['']?.dependencies ?? {}));
  for (const [relative, locked] of entries) {
    if (
      !relative.startsWith('node_modules/') ||
      typeof locked.version !== 'string' ||
      locked.version.length > 128
    )
      throw new Error('npm lock package identity is invalid.');
    const installedRelative = relative.slice(13);
    let folder;
    try {
      folder = await inside(nodeRoot, installedRelative);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const name = npmName(relative);
    const record = {
      ecosystem: 'npm',
      name,
      version: locked.version,
      lockPath: relative,
      scope:
        locked.dev === true
          ? 'development-only'
          : direct.has(name)
            ? 'direct-runtime'
            : 'runtime-candidate',
      optional: locked.optional === true,
      lockedLicenseDeclaration: cleanDeclaration(locked.license),
      licenseDeclaration: null,
      metadataStatus: 'missing-package',
      licenseFiles: [],
      reviewRequired: true,
    };
    if (folder) {
      let metadata;
      try {
        const bytes = await regular(await inside(nodeRoot, installedRelative + '/package.json'));
        metadata = JSON.parse(decode(bytes));
        record.metadataSha256 = hash(bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (metadata) {
        record.metadataStatus =
          metadata.name === name && metadata.version === locked.version
            ? 'matched'
            : 'metadata-mismatch';
        record.licenseDeclaration = cleanDeclaration(metadata.license);
        const explicit =
          typeof metadata.license === 'string'
            ? /^SEE LICENSE IN (.+)$/i.exec(metadata.license)?.[1]
            : undefined;
        record.licenseFiles = await notices(folder, folder, explicit);
      }
    }
    records.push(record);
  }
  const manifestRoot = await rootDirectory(path.dirname(path.resolve(options.cargoManifest)));
  const cargo = await cargoData(
    {
      lock: path.resolve(options.cargoLock),
      manifest: path.resolve(options.cargoManifest),
      registry,
    },
    options.pythonExecutable,
  );
  const closure = cargoClosure(cargo);
  for (const row of cargo.packages.sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  )) {
    const metadata = row.metadata;
    const folder =
      row.sourceKind === 'vendored-path-override'
        ? await rootDirectory(await inside(manifestRoot, row.metadataRelativePath))
        : path.join(registry, row.name + '-' + row.version);
    const ring =
      row.metadataStatus === 'matched' && row.name === 'ring' && row.version === '0.17.14';
    const supplements = ring
      ? [
          'third_party/fiat/LICENSE',
          'src/polyfill/once_cell/LICENSE-APACHE',
          'src/polyfill/once_cell/LICENSE-MIT',
        ]
      : [];
    const licenseFiles = metadata
      ? await notices(folder, folder, metadata.licenseFile, supplements)
      : [];
    const supplementalGaps = [];
    if (ring) {
      try {
        await regular(await inside(folder, 'third_party/fiat/AUTHORS'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        supplementalGaps.push({
          path: 'third_party/fiat/AUTHORS',
          status: 'missing-referenced-attribution',
          referencedBy: 'third_party/fiat/LICENSE',
        });
      }
    }
    if (
      row.metadataStatus === 'matched' &&
      row.name === 'libsqlite3-sys' &&
      row.version === '0.38.2'
    ) {
      try {
        licenseFiles.push(await sqliteNotice(folder));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        supplementalGaps.push({
          path: 'sqlite3/sqlite3.h',
          status: 'missing-upstream-native-notice',
        });
      }
    }
    if (licenseFiles.length > 32) throw new Error('License file count exceeds bound.');
    records.push({
      ecosystem: 'cargo',
      name: row.name,
      version: row.version,
      sourceKind: row.sourceKind,
      checksum: row.checksum ?? null,
      scope: metadata?.procMacro
        ? 'build-proc-macro'
        : cargo.runtimeIds.includes(`${row.name}@${row.version}`)
          ? 'direct-runtime-candidate'
          : cargo.buildIds.includes(`${row.name}@${row.version}`)
            ? 'direct-build-or-test'
            : closure.has(`${row.name}@${row.version}`)
              ? 'runtime-closure-candidate-all-targets'
              : 'locked-other-target-or-build',
      licenseDeclaration: cleanDeclaration(metadata?.license),
      metadataStatus: row.metadataStatus,
      metadataSha256: metadata?.sha256 ?? null,
      ...(row.metadataOrigin ? { metadataOrigin: row.metadataOrigin } : {}),
      nativeLinks: metadata?.nativeLinks ?? null,
      licenseFiles,
      supplementalGaps,
      reviewRequired: true,
    });
  }
  const inventory = {
    schemaVersion: 1,
    product: 'GenX Streamer',
    releaseAcceptance: false,
    inventoryAuthority:
      'lock declarations and installed package texts only; no exact shipped-binary proof',
    inputSha256: {
      npmLock: hash(lockBytes),
      cargoLock: cargo.lockSha256,
      cargoManifest: cargo.manifestSha256,
    },
    records,
    supplementalGapCount: records.reduce(
      (count, record) =>
        count +
        (record.supplementalGaps?.length ?? 0) +
        record.licenseFiles.filter((file) => file.provenance && file.text === undefined).length,
      0,
    ),
    unknownCount: records.filter(
      (r) =>
        r.metadataStatus !== 'matched' ||
        r.licenseDeclaration === null ||
        !r.licenseFiles.some((f) => f.kind === 'license' && f.text !== undefined),
    ).length,
    externalReview: [
      'Windows WebView2 runtime and platform codec terms are external, not bundled by this inventory',
      'Android system/runtime and platform codec terms need separate platform review',
      'Cargo.lock includes other targets, optional dependencies and build/proc-macro tools; exact Windows/Android target closure remains unverified',
      'Bundled native components (including SQLite and TLS crypto implementation) need upstream/native-component notice review beyond wrapper crate licenses',
      'ffmpeg-static is declared development-only fixture tooling; binary-specific FFmpeg licensing is not established by its npm wrapper LICENSE',
      'Package NOTICE files are preserved separately; candidate notices do not establish license obligations or complete compliance',
    ],
  };
  if (Buffer.byteLength(JSON.stringify(inventory)) > MAX_OUTPUT)
    throw new Error('Inventory output exceeds16MiB; no records were truncated.');
  return { inventory, runtime: { node: process.version, python: cargo.python } };
}
export function renderCandidateNotices(inventory) {
  let output =
    'GenX Streamer CANDIDATE dependency notices\nNOT RELEASE ACCEPTANCE; installed license texts only. Review unknowns, target/binary provenance and external components independently.\n\n';
  for (const row of inventory.records) {
    output += `=== ${row.ecosystem}: ${row.name}@${row.version} [${row.scope}] ===\nDeclared license: ${row.licenseDeclaration ?? 'UNKNOWN'}\nMetadata: ${row.metadataStatus}; complete legal review: NOT VERIFIED\n`;
    let present = false;
    for (const file of row.licenseFiles) {
      if (file.text !== undefined) {
        present ||= file.kind === 'license';
        output += `\n--- ${file.kind.toUpperCase()}: ${file.path}; SHA256 ${file.sha256} ---\n${file.text}`;
        if (file.provenance) output += `\nSOURCE PROVENANCE: ${JSON.stringify(file.provenance)}\n`;
        if (!file.text.endsWith('\n')) output += '\n';
      } else output += `\n${file.path}: ${file.status}\n`;
    }
    if (!present) output += 'LICENSE TEXT MISSING OR UNSUPPORTED; follow-up required.\n';
    for (const gap of row.supplementalGaps ?? [])
      output += `SUPPLEMENTAL GAP: ${gap.path}; ${gap.status}\n`;
    output += '\n';
  }
  output +=
    'EXTERNAL / INCOMPLETE REVIEW\n' +
    inventory.externalReview.map((s) => '- ' + s).join('\n') +
    '\n';
  if (Buffer.byteLength(output) > MAX_OUTPUT)
    throw new Error('Candidate notices exceed16MiB; no text was truncated.');
  return output;
}
export async function writeLicenseInventory(options) {
  const out = path.resolve(options.outputDir);
  await rootDirectory(path.dirname(out));
  const result = await collectLicenseInventory(options);
  const notice = renderCandidateNotices(result.inventory);
  await mkdir(out);
  await writeFile(
    path.join(out, 'inventory.json'),
    JSON.stringify(result.inventory, null, 2) + '\n',
    { flag: 'wx' },
  );
  await writeFile(path.join(out, 'DEPENDENCY-NOTICES.txt'), notice, { flag: 'wx' });
  await writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'node scripts/license-inventory.mjs',
        finishedUtc: new Date().toISOString(),
        exitCode: 0,
        releaseAcceptance: false,
        unknownCount: result.inventory.unknownCount,
        supplementalGapCount: result.inventory.supplementalGapCount,
        records: result.inventory.records.length,
        runtime: result.runtime,
        inputSha256: result.inventory.inputSha256,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  return result.inventory;
}
function cli(argv) {
  const allowed = [
    'npm-lock',
    'cargo-lock',
    'cargo-manifest',
    'node-modules',
    'cargo-registry',
    'output-dir',
    'python',
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
      throw new Error('Invalid inventory arguments.');
    args[key] = argv[i + 1];
  }
  for (const key of allowed.slice(0, 6))
    if (!args[key]) throw new Error('Explicit inventory roots and output are required.');
  return {
    npmLock: args['npm-lock'],
    cargoLock: args['cargo-lock'],
    cargoManifest: args['cargo-manifest'],
    nodeModules: args['node-modules'],
    cargoRegistry: args['cargo-registry'],
    outputDir: args['output-dir'],
    pythonExecutable: args.python,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeLicenseInventory(cli(process.argv.slice(2)))
      .then((result) =>
        console.log(
          JSON.stringify({
            records: result.records.length,
            unknownCount: result.unknownCount,
            releaseAcceptance: false,
          }),
        ),
      )
      .catch(() => {
        console.error(
          'Offline inventory failed. Check admitted roots, lockfiles, Python3.11+ and a new output directory.',
        );
        process.exitCode = 1;
      });
  } catch {
    console.error('Explicit inventory roots and output are required.');
    process.exitCode = 1;
  }
}
