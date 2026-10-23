import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// @ts-expect-error The standalone Node CLI has no generated declaration; runtime admission is tested here.
import { validateMetricEvidence, validateMetricFiles } from '../../scripts/metric-evidence.mjs';

const source = 'a'.repeat(64),
  binary = 'b'.repeat(64),
  evidence = 'c'.repeat(64);
const pins = [{ path: 'proof.json', sha256: evidence }];
const gate = () => ({
  schemaVersion: 1,
  metricId: 'search-latency',
  kind: 'release',
  mandatory: true,
  scope: 'physical-device',
  platform: 'android',
  hardwareRequired: true,
  device: { id: 'flip2-fixture', model: 'Fixture physical device' },
  subject: { sourceSha256: source, binarySha256: binary },
  unit: 'ms',
  statistic: 'p95',
  threshold: { comparator: '<=', value: 200 },
  minimumSamples: 30,
  minimumDurationMs: 60000,
  cleanupRequiredCounts: ['processes', 'workers', 'fixtures'],
});
const record = () => ({
  ...gate(),
  command: 'controlled search fixture',
  fixtureSeed: 'channels-100000-v1',
  device: { id: 'flip2-fixture', model: 'Fixture physical device', physical: true },
  toolchain: [{ name: 'runner', version: '1.0' }],
  timestamp: '2026-10-10T12:02:00Z',
  window: { start: '2026-10-10T12:00:00Z', end: '2026-10-10T12:01:00Z' },
  samples: Array.from({ length: 30 }, (_, index) => 30 + Math.min(index, 15)),
  sampleCount: 30,
  observed: 45,
  outcome: 'PASS',
  evidence: pins,
  cleanup: {
    confirmed: true,
    counts: { processes: 0, workers: 0, fixtures: 0 },
    evidencePath: 'proof.json',
  },
});

describe('metric evidence admission, not hardware or legal acceptance', () => {
  it('rejects malformed policy authority at the CLI while preserving well-formed advisory measurements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genx-policy-'));
    try {
      const digest = createHash('sha256').update('evidence').digest('hex');
      await writeFile(join(root, 'proof.json'), 'evidence');
      const subject = {
        sourcePath: 'proof.json',
        sourceSha256: digest,
        binaryPath: 'proof.json',
        binarySha256: digest,
      };
      const recordsPath = join(root, 'records.json'),
        policyPath = join(root, 'policy.json');
      const r = { ...record(), subject, evidence: [{ path: 'proof.json', sha256: digest }] };
      const p = { ...gate(), subject };
      await writeFile(recordsPath, JSON.stringify({ schemaVersion: 1, records: [r] }));
      const cli = () =>
        spawnSync(
          process.execPath,
          [
            join(process.cwd(), 'scripts/metric-evidence.mjs'),
            '--records',
            recordsPath,
            '--policy',
            policyPath,
          ],
          { cwd: root, encoding: 'utf8' },
        );
      for (const malformed of [
        { ...p, mandatory: undefined },
        { ...p, mandatory: 'false' },
        { ...p, kind: 'unreviewed' },
        { ...p, schemaVersion: 2 },
        { ...p, mandatory: false, resourceBudget: 'unreviewed-authority' },
      ]) {
        await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, gates: [malformed] }));
        await expect(validateMetricFiles(recordsPath, policyPath, root)).rejects.toThrow(
          'invalid-policy',
        );
        const output = cli();
        expect(output.status).toBe(2);
        expect(output.stdout).toBe('');
        expect(output.stderr).toContain('input is invalid or unavailable');
        expect(output.stderr).not.toContain(root);
      }
      await writeFile(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          gates: [{ ...p, mandatory: false, kind: 'advisory', hardwareRequired: false }],
        }),
      );
      await writeFile(
        recordsPath,
        JSON.stringify({
          schemaVersion: 1,
          records: [{ ...r, kind: 'advisory', outcome: 'MEASUREMENTS_ONLY' }],
        }),
      );
      expect(cli().status).toBe(0);
      const advisory = await validateMetricFiles(recordsPath, policyPath, root);
      expect(advisory.results[0].outcome).toBe('MEASUREMENTS_ONLY');
      expect(advisory.releaseAcceptance).toBe(false);
      await writeFile(
        policyPath,
        JSON.stringify({ schemaVersion: 1, gates: [{ ...p, threshold: null }] }),
      );
      await writeFile(
        recordsPath,
        JSON.stringify({
          schemaVersion: 1,
          records: [{ ...r, threshold: null, outcome: 'INCOMPLETE' }],
        }),
      );
      expect(cli().status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('enforces prospective sample and duration minima instead of accepting short sparse runs', () => {
    expect(
      validateMetricEvidence({ ...record(), samples: [45], sampleCount: 1 }, gate(), pins).issues,
    ).toContain('sample-budget');
    expect(
      validateMetricEvidence(record(), { ...gate(), minimumDurationMs: 7200000 }, pins).issues,
    ).toContain('duration-budget');
    expect(
      validateMetricEvidence(record(), { ...gate(), minimumSamples: undefined }, pins).issues,
    ).toContain('sample-budget');
    expect(
      validateMetricEvidence(record(), { ...gate(), minimumDurationMs: undefined }, pins).issues,
    ).toContain('duration-budget');
  });
  it('requires each declared cleanup counter and cannot substitute irrelevant zero counts', () => {
    const result = validateMetricEvidence(
      { ...record(), cleanup: { ...record().cleanup, counts: { bananas: 0 } } },
      gate(),
      pins,
    );
    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.issues).toContain('cleanup-counters');
    expect(
      validateMetricEvidence(record(), { ...gate(), cleanupRequiredCounts: [] }, pins).issues,
    ).toContain('cleanup-counters');
  });
  it('requires a prospective budget for resource-soak even if the policy omits it', () => {
    const result = validateMetricEvidence(
      { ...record(), scope: 'resource-soak' },
      { ...gate(), scope: 'resource-soak' },
      pins,
    );
    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.issues).toContain('prospective-budget');
  });
  it('admits only scope-matched measured facts and the existing 200ms threshold', () => {
    expect(validateMetricEvidence(record(), gate(), pins)).toMatchObject({
      outcome: 'PASS',
      issues: [],
      releaseAcceptance: false,
    });
    expect(
      validateMetricEvidence(
        record(),
        { ...gate(), subject: { sourceSha256: source, binarySha256: 'd'.repeat(64) } },
        pins,
      ).issues,
    ).toContain('binary-subject');
  });
  it('refuses missing thresholds, hashes, hardware and unsupported scope', () => {
    const valid = record();
    for (const [value, issue] of [
      [{ ...valid, threshold: null }, 'threshold'],
      [{ ...valid, device: null }, 'hardware'],
      [{ ...valid, device: { ...valid.device, id: 'different-device' } }, 'hardware'],
      [{ ...valid, subject: { sourceSha256: source } }, 'binary-subject'],
      [{ ...valid, subject: { ...valid.subject, sourceSha256: binary } }, 'source-subject'],
      [{ ...valid, scope: 'all-devices' }, 'scope'],
      [{ ...valid, evidence: [] }, 'evidence'],
      [{ ...valid, cleanup: { ...valid.cleanup, counts: {} } }, 'cleanup'],
    ] as const) {
      const result = validateMetricEvidence(value, gate(), pins);
      expect(result.outcome).not.toBe('PASS');
      expect(result.issues).toContain(issue);
    }
    expect(validateMetricEvidence(record(), gate(), []).issues).toContain('evidence-unverified');
  });
  it('recomputes statistics, rejects nonfinite or vacuous samples and enforces failure', () => {
    expect(
      validateMetricEvidence({ ...record(), samples: [], sampleCount: 0 }, gate(), pins).issues,
    ).toContain('samples');
    expect(validateMetricEvidence({ ...record(), samples: [NaN] }, gate(), pins).issues).toContain(
      'samples',
    );
    expect(validateMetricEvidence({ ...record(), observed: 1 }, gate(), pins).issues).toContain(
      'observed',
    );
    expect(
      validateMetricEvidence(
        { ...record(), samples: [300], sampleCount: 1, observed: 300 },
        gate(),
        pins,
      ).outcome,
    ).toBe('FAIL');
    expect(
      validateMetricEvidence(
        { ...record(), cleanup: { ...record().cleanup, counts: { processes: 1 } } },
        gate(),
        pins,
      ).issues,
    ).toContain('cleanup');
  });
  it('never promotes failed, incomplete or measurements-only reports', () => {
    for (const outcome of ['FAIL', 'INCOMPLETE', 'MEASUREMENTS_ONLY'])
      expect(validateMetricEvidence({ ...record(), outcome }, gate(), pins).outcome).toBe(outcome);
  });
  it('requires matching prospective resource budget and rejects retrospective adoption', () => {
    const budget = {
      id: 'device-resource-v1',
      sha256: 'e'.repeat(64),
      adoptedAt: '2026-10-10T11:00:00Z',
    };
    expect(
      validateMetricEvidence(
        { ...record(), resourceBudget: budget },
        { ...gate(), resourceBudget: budget },
        pins,
      ).outcome,
    ).toBe('PASS');
    for (const resourceBudget of [
      undefined,
      { ...budget, sha256: binary },
      { ...budget, adoptedAt: '2026-10-10T12:01:00Z' },
    ])
      expect(
        validateMetricEvidence(
          { ...record(), resourceBudget },
          { ...gate(), resourceBudget: budget },
          pins,
        ).issues,
      ).toContain('prospective-budget');
  });
  it('rejects impossible calendar timestamps and arbitrary diagnostics without exposing them', () => {
    const result = validateMetricEvidence(
      {
        ...record(),
        timestamp: '2026-02-30T12:02:00Z',
        command: 'https://provider.invalid/private?token=secret',
        evidence: { some: 'secret' },
      },
      gate(),
      pins,
    );
    expect(result.issues).toContain('timestamp');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('provider');
  });
  it('checks actual files and returns nonzero for mandatory gaps with redacted CLI output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genx-metric-'));
    try {
      const digest = (text: string) => createHash('sha256').update(text).digest('hex');
      await writeFile(join(root, 'source.json'), 'source');
      await writeFile(join(root, 'app.bin'), 'binary');
      await writeFile(join(root, 'proof.json'), 'proof');
      const subject = {
        sourcePath: 'source.json',
        sourceSha256: digest('source'),
        binaryPath: 'app.bin',
        binarySha256: digest('binary'),
      };
      const files = [{ path: 'proof.json', sha256: digest('proof') }];
      const r = { ...record(), subject, evidence: files };
      const p = { ...gate(), subject };
      const recordsPath = join(root, 'records.json'),
        policyPath = join(root, 'policy.json');
      await writeFile(recordsPath, JSON.stringify({ schemaVersion: 1, records: [r] }));
      await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, gates: [p] }));
      expect((await validateMetricFiles(recordsPath, policyPath, root)).success).toBe(true);
      await writeFile(join(root, 'app.bin'), 'tampered');
      const invalid = await validateMetricFiles(recordsPath, policyPath, root);
      expect(invalid.success).toBe(false);
      expect(invalid.results[0].issues).toContain('binary-file');
      const cli = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'scripts/metric-evidence.mjs'),
          '--records',
          recordsPath,
          '--policy',
          policyPath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(cli.status).toBe(1);
      expect(cli.stdout).not.toContain(root);
      expect(cli.stdout).not.toContain('controlled search fixture');
      await writeFile(recordsPath, JSON.stringify({ schemaVersion: 1, records: [] }));
      expect((await validateMetricFiles(recordsPath, policyPath, root)).success).toBe(false);
      expect(await readFile(join(root, 'source.json'), 'utf8')).toBe('source');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
