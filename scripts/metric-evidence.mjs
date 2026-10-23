import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(v);
const text = (v, limit = 256) => typeof v === 'string' && v.trim().length > 0 && v.length <= limit;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const instant = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === (v.includes('.') ? v : v.replace('Z', '.000Z'));
const kinds = ['developer', 'release', 'advisory'];
const outcomes = ['PASS', 'FAIL', 'INCOMPLETE', 'MEASUREMENTS_ONLY'];
const scopes = [
  'source-fixture',
  'browser-fixture',
  'native-fixture',
  'physical-device',
  'process-owners',
  'resource-soak',
  'release-artifact',
];
const statistics = ['maximum', 'minimum', 'mean', 'median', 'p95', 'last', 'count'];
const compare = (value, threshold) =>
  ({
    '<=': () => value <= threshold.value,
    '<': () => value < threshold.value,
    '>=': () => value >= threshold.value,
    '>': () => value > threshold.value,
    '==': () => value === threshold.value,
  })[threshold.comparator]?.() === true;

function statistic(samples, name) {
  const sorted = [...samples].sort((a, b) => a - b);
  switch (name) {
    case 'maximum':
      return sorted.at(-1);
    case 'minimum':
      return sorted[0];
    case 'mean':
      return samples.reduce((sum, v) => sum + v / samples.length, 0);
    case 'median':
      return (
        (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
      );
    case 'p95':
      return sorted[Math.ceil(sorted.length * 0.95) - 1]; // Nearest rank, explicitly defined.
    case 'last':
      return samples.at(-1);
    case 'count':
      return samples.length;
  }
}

/** Policy is a separately reviewed gate contract, never inferred from a measurement. */
export function validateMetricEvidence(record, policy, verifiedEvidence = []) {
  const issues = new Set();
  const require = (condition, code) => {
    if (!condition) issues.add(code);
  };
  require(record?.schemaVersion === 1 && policy?.schemaVersion === 1, 'schema');
  require(identifier(record?.metricId) && record.metricId === policy?.metricId, 'metric');
  require(kinds.includes(record?.kind) && record.kind === policy?.kind, 'kind');
  require(typeof policy?.mandatory === 'boolean', 'policy');
  require(scopes.includes(record?.scope) && record.scope === policy?.scope, 'scope');
  require(['windows', 'android', 'browser', 'node'].includes(record?.platform) &&
    record.platform === policy?.platform, 'platform');
  const hardware =
    record?.kind === 'release' ||
    policy?.hardwareRequired === true ||
    policy?.resourceBudget !== undefined ||
    record?.scope === 'resource-soak';
  require(typeof policy?.hardwareRequired === 'boolean', 'policy');
  if (hardware)
    require(record?.device?.physical === true &&
      identifier(record.device.id) &&
      text(record.device.model) &&
      record.device.id === policy?.device?.id &&
      record.device.model === policy?.device?.model, 'hardware');
  require(hash(record?.subject?.sourceSha256) &&
    record.subject.sourceSha256 === policy?.subject?.sourceSha256, 'source-subject');
  if (record?.kind === 'release' || hardware || policy?.subject?.binarySha256 !== undefined)
    require(hash(record?.subject?.binarySha256) &&
      record.subject.binarySha256 === policy?.subject?.binarySha256, 'binary-subject');
  require(text(record?.command, 4096), 'command');
  require(Array.isArray(record?.toolchain) &&
    record.toolchain.length > 0 &&
    record.toolchain.length <= 32 &&
    record.toolchain.every(
      (tool) => identifier(tool?.name) && text(tool.version, 80),
    ), 'toolchain');
  require(identifier(record?.fixtureSeed), 'fixture');
  require(instant(record?.timestamp), 'timestamp');
  const window = record?.window;
  require(instant(window?.start) &&
    instant(window?.end) &&
    Date.parse(window.end) > Date.parse(window.start) &&
    Date.parse(record?.timestamp) >= Date.parse(window?.end), 'window');
  require(Number.isSafeInteger(policy?.minimumDurationMs) &&
    policy.minimumDurationMs > 0 &&
    Date.parse(window?.end) - Date.parse(window?.start) >=
      policy.minimumDurationMs, 'duration-budget');
  require(identifier(record?.unit) &&
    record.unit === policy?.unit &&
    statistics.includes(record?.statistic) &&
    record.statistic === policy?.statistic, 'measurement-contract');
  const samples = record?.samples;
  const measured =
    Array.isArray(samples) &&
    samples.length > 0 &&
    samples.length <= 10000 &&
    samples.every(finite);
  require(measured &&
    record?.sampleCount === samples.length &&
    Number.isSafeInteger(record.sampleCount), 'samples');
  require(Number.isSafeInteger(policy?.minimumSamples) &&
    policy.minimumSamples > 0 &&
    policy.minimumSamples <= 10000 &&
    measured &&
    samples.length >= policy.minimumSamples, 'sample-budget');
  const observed = measured ? statistic(samples, record?.statistic) : undefined;
  require(finite(record?.observed) &&
    finite(observed) &&
    Math.abs(record.observed - observed) <= Math.max(1, Math.abs(observed)) * 1e-12, 'observed');
  if (record?.outcome === 'PASS' || policy?.mandatory) {
    const threshold = record?.threshold,
      expected = policy?.threshold;
    require(finite(threshold?.value) &&
      finite(expected?.value) &&
      threshold.value === expected.value &&
      threshold.comparator === expected.comparator &&
      ['<=', '<', '>=', '>', '=='].includes(threshold.comparator), 'threshold');
    if (
      finite(observed) &&
      finite(threshold?.value) &&
      ['<=', '<', '>=', '>', '=='].includes(threshold.comparator)
    )
      require(compare(observed, threshold), 'measurement-failed');
  }
  const paths = record?.evidence;
  const validPath = (v) => text(v?.path, 1024) && hash(v.sha256);
  require(Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= 32 &&
    paths.every(validPath) &&
    new Set(paths.map((v) => v.path)).size === paths.length, 'evidence');
  if (Array.isArray(paths))
    require(paths.every((item) =>
      verifiedEvidence.some(
        (verified) => item?.path === verified.path && item.sha256 === verified.sha256,
      ),
    ), 'evidence-unverified');
  const cleanup = record?.cleanup;
  const counts = cleanup?.counts;
  const requiredCounts = policy?.cleanupRequiredCounts;
  require(Array.isArray(requiredCounts) &&
    requiredCounts.length > 0 &&
    requiredCounts.length <= 40 &&
    requiredCounts.every(identifier) &&
    new Set(requiredCounts).size === requiredCounts.length &&
    counts &&
    requiredCounts.every(
      (name) => Object.hasOwn(counts, name) && counts[name] === 0,
    ), 'cleanup-counters');
  require(cleanup?.confirmed === true &&
    counts &&
    typeof counts === 'object' &&
    !Array.isArray(counts) &&
    Object.keys(counts).length > 0 &&
    Object.keys(counts).length <= 40 &&
    Object.entries(counts).every(
      ([key, value]) => identifier(key) && Number.isSafeInteger(value) && value === 0,
    ) &&
    Array.isArray(paths) &&
    paths.some((item) => item?.path === cleanup.evidencePath), 'cleanup');
  if (
    policy?.resourceBudget ||
    record?.scope === 'resource-soak' ||
    policy?.scope === 'resource-soak'
  ) {
    const budget = record?.resourceBudget,
      approved = policy?.resourceBudget;
    require(identifier(budget?.id) &&
      budget.id === approved?.id &&
      hash(budget.sha256) &&
      budget.sha256 === approved.sha256 &&
      instant(budget.adoptedAt) &&
      budget.adoptedAt === approved.adoptedAt &&
      Date.parse(budget.adoptedAt) < Date.parse(window?.start), 'prospective-budget');
  }
  require(outcomes.includes(record?.outcome), 'outcome');
  // Never promote an explicitly incomplete/failed/advisory measurement receipt.
  const outcome = issues.size
    ? issues.has('measurement-failed') || record?.outcome === 'FAIL'
      ? 'FAIL'
      : 'INCOMPLETE'
    : record.outcome;
  return {
    metricId: identifier(record?.metricId)
      ? record.metricId
      : identifier(policy?.metricId)
        ? policy.metricId
        : 'invalid-metric',
    kind: kinds.includes(record?.kind) ? record.kind : 'unknown',
    outcome,
    mandatory: policy?.mandatory === true,
    issues: [...issues].sort(),
    releaseAcceptance: false,
  };
}

async function regularFile(filename, limit) {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size === 0 ||
    metadata.size > limit
  )
    throw new Error('invalid-input');
}
async function jsonFile(filename) {
  await regularFile(filename, 2 * 1024 * 1024);
  const bytes = await readFile(filename);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('invalid-input');
  return JSON.parse(bytes.toString('utf8'));
}
async function verifyFile(root, item) {
  if (!text(item?.path, 1024) || !hash(item?.sha256) || path.isAbsolute(item.path)) return false;
  const filename = path.resolve(root, item.path);
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    await regularFile(filename, 512 * 1024 * 1024);
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(filename)) {
      size += chunk.length;
      if (size > 512 * 1024 * 1024) return false;
      digest.update(chunk);
    }
    return digest.digest('hex') === item.sha256;
  } catch {
    return false;
  }
}
function validPolicyGate(gate) {
  const counters = gate?.cleanupRequiredCounts;
  const threshold = gate?.threshold;
  const budget = gate?.resourceBudget;
  return (
    gate?.schemaVersion === 1 &&
    identifier(gate.metricId) &&
    kinds.includes(gate.kind) &&
    typeof gate.mandatory === 'boolean' &&
    scopes.includes(gate.scope) &&
    ['windows', 'android', 'browser', 'node'].includes(gate.platform) &&
    typeof gate.hardwareRequired === 'boolean' &&
    identifier(gate.unit) &&
    statistics.includes(gate.statistic) &&
    hash(gate.subject?.sourceSha256) &&
    (gate.subject?.binarySha256 === undefined || hash(gate.subject.binarySha256)) &&
    Number.isSafeInteger(gate.minimumSamples) &&
    gate.minimumSamples > 0 &&
    gate.minimumSamples <= 10000 &&
    Number.isSafeInteger(gate.minimumDurationMs) &&
    gate.minimumDurationMs > 0 &&
    Array.isArray(counters) &&
    counters.length > 0 &&
    counters.length <= 40 &&
    counters.every(identifier) &&
    new Set(counters).size === counters.length &&
    (gate.device === undefined || (identifier(gate.device?.id) && text(gate.device?.model))) &&
    (budget == null ||
      (identifier(budget.id) &&
        hash(budget.sha256) &&
        instant(budget.adoptedAt) &&
        text(budget.path, 1024))) &&
    // A pending, absent threshold remains explicit INCOMPLETE evidence, not an invented budget.
    (threshold == null ||
      (finite(threshold.value) && ['<=', '<', '>=', '>', '=='].includes(threshold.comparator)))
  );
}
export async function validateMetricFiles(recordsPath, policyPath, root = process.cwd()) {
  const input = await jsonFile(recordsPath),
    policy = await jsonFile(policyPath);
  if (
    input?.schemaVersion !== 1 ||
    policy?.schemaVersion !== 1 ||
    !Array.isArray(input.records) ||
    !Array.isArray(policy.gates) ||
    input.records.length > 100 ||
    policy.gates.length === 0 ||
    policy.gates.length > 100
  )
    throw new Error('invalid-input');
  if (!policy.gates.every(validPolicyGate)) throw new Error('invalid-policy');
  if (
    new Set(input.records.map((r) => r?.metricId)).size !== input.records.length ||
    new Set(policy.gates.map((g) => g?.metricId)).size !== policy.gates.length
  )
    throw new Error('invalid-input');
  const results = [];
  for (const gate of policy.gates) {
    const record = input.records.find((r) => r?.metricId === gate?.metricId);
    const verified = [];
    for (const item of Array.isArray(record?.evidence) ? record.evidence.slice(0, 32) : [])
      if (await verifyFile(root, item)) verified.push(item);
    const result = validateMetricEvidence(record, gate, verified);
    // Current scope pins require concrete local source snapshot and binary witnesses.
    for (const [key, issue] of [
      ['source', 'source-file'],
      ['binary', 'binary-file'],
    ]) {
      if (key === 'binary' && !gate?.subject?.binarySha256) continue;
      if (
        !(await verifyFile(root, {
          path: gate?.subject?.[`${key}Path`],
          sha256: gate?.subject?.[`${key}Sha256`],
        }))
      ) {
        result.issues.push(issue);
        if (result.outcome !== 'FAIL') result.outcome = 'INCOMPLETE';
      }
    }
    if (
      (gate?.resourceBudget || gate?.scope === 'resource-soak') &&
      !(await verifyFile(root, gate?.resourceBudget))
    ) {
      result.issues.push('budget-file');
      if (result.outcome !== 'FAIL') result.outcome = 'INCOMPLETE';
    }
    results.push(result);
  }
  if (
    input.records.some(
      (record) => !policy.gates.some((gate) => gate?.metricId === record?.metricId),
    )
  )
    throw new Error('invalid-input');
  return {
    schemaVersion: 1,
    results,
    success: results.every((r) => !r.mandatory || r.outcome === 'PASS'),
    releaseAcceptance: false,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--records' || args[2] !== '--policy') {
    console.error('Metric evidence requires --records FILE --policy FILE.');
    process.exitCode = 2;
  } else {
    try {
      const result = await validateMetricFiles(args[1], args[3]);
      console.log(JSON.stringify(result));
      process.exitCode = result.success ? 0 : 1;
    } catch {
      console.error('Metric evidence input is invalid or unavailable.');
      process.exitCode = 2;
    }
  }
}
