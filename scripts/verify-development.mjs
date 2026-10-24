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

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}
function inRun(value, startedMs, finishedMs) {
  return Number.isFinite(value) && value >= startedMs && value <= finishedMs;
}
export function validateUnitReport(report, startedMs, finishedMs) {
  requireEvidence(
    report && report.success === true && inRun(report.startTime, startedMs, finishedMs),
    'Unit success or run timestamp is missing/stale.',
  );
  requireEvidence(
    Number.isInteger(report.numTotalTests) &&
      report.numTotalTests > 0 &&
      report.numPassedTests === report.numTotalTests,
    'Unit test counts are empty or incomplete.',
  );
  for (const key of [
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ])
    requireEvidence(report[key] === 0, `Unit ${key} is nonzero or missing.`);
  requireEvidence(
    report.numTotalTestSuites > 0 &&
      report.numPassedTestSuites === report.numTotalTestSuites &&
      Array.isArray(report.testResults) &&
      report.testResults.length > 0,
    'Unit suites are incomplete.',
  );
  let assertions = 0;
  for (const suite of report.testResults) {
    requireEvidence(
      suite.status === 'passed' &&
        Array.isArray(suite.assertionResults) &&
        inRun(suite.startTime, startedMs, finishedMs) &&
        inRun(suite.endTime, startedMs, finishedMs),
      'Unit suite failed, missing, or stale.',
    );
    for (const assertion of suite.assertionResults) {
      requireEvidence(
        assertion.status === 'passed' &&
          Array.isArray(assertion.failureMessages) &&
          assertion.failureMessages.length === 0,
        'Unit assertion failed or was skipped.',
      );
      assertions++;
    }
  }
  requireEvidence(
    assertions === report.numTotalTests,
    'Unit summary disagrees with actual assertions.',
  );
  requireEvidence(
    report.snapshot?.failure !== true && !(report.snapshot?.unmatched > 0),
    'Unit snapshots failed.',
  );
  return { tests: assertions, files: report.testResults.length };
}
export function validateUiReport(report, startedMs, finishedMs) {
  requireEvidence(
    report && Array.isArray(report.errors) && report.errors.length === 0 && report.stats,
    'UI report has errors or missing statistics.',
  );
  const start = Date.parse(report.stats.startTime);
  requireEvidence(
    inRun(start, startedMs, finishedMs) &&
      Number.isFinite(report.stats.duration) &&
      report.stats.duration >= 0 &&
      start + report.stats.duration <= finishedMs,
    'UI run timestamp is missing/stale.',
  );
  for (const key of ['skipped', 'unexpected', 'flaky'])
    requireEvidence(report.stats[key] === 0, `UI ${key} is nonzero or missing.`);
  requireEvidence(
    Number.isInteger(report.stats.expected) &&
      report.stats.expected > 0 &&
      Array.isArray(report.suites),
    'UI expected test count is empty.',
  );
  let tests = 0;
  const visit = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        requireEvidence(
          test.status === 'expected' &&
            test.expectedStatus === 'passed' &&
            Array.isArray(test.results) &&
            test.results.length === 1,
          'UI test was skipped, failed, expected to fail, or retried.',
        );
        const result = test.results[0];
        requireEvidence(
          result.status === 'passed' &&
            result.retry === 0 &&
            Array.isArray(result.errors) &&
            result.errors.length === 0 &&
            inRun(Date.parse(result.startTime), startedMs, finishedMs),
          'UI result failed, retried, or is stale.',
        );
        tests++;
      }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  requireEvidence(
    tests === report.stats.expected,
    'UI summary disagrees with actual test results.',
  );
  return { tests };
}
export async function validateReportFile(file, kind, startedMs, finishedMs) {
  const metadata = await stat(file);
  requireEvidence(
    metadata.isFile() && metadata.size > 0 && metadata.size <= 20 * 1024 * 1024,
    'Required report is empty, not a file, or oversized.',
  );
  requireEvidence(
    inRun(Math.trunc(metadata.mtimeMs), startedMs, finishedMs),
    'Required report file is stale or outside this run.',
  );
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (kind === 'unit') return validateUnitReport(report, startedMs, finishedMs);
  if (kind === 'ui') return validateUiReport(report, startedMs, finishedMs);
  throw new Error('Unknown required report type.');
}
export async function validateStepEvidence(step) {
  requireEvidence(
    step.exitCode === 0 && !step.signal && !step.error,
    `Step ${step.name} did not exit successfully.`,
  );
  if (step.name === 'unit' || step.name === 'ui')
    requireEvidence(
      typeof step.report === 'string' && step.report.length > 0 && step.reportKind === step.name,
      `Step ${step.name} is missing its required report.`,
    );
  if (step.report)
    return validateReportFile(step.report, step.reportKind, step.startedMs, step.finishedMs);
  return {};
}

async function command(name, executable, args, directory, env = {}) {
  const startedMs = Date.now();
  const log = path.join(directory, `${name}.log`);
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  let bytes = 0;
  let spawnError;
  const capture = (chunk) => {
    bytes += chunk.length;
    if (bytes <= 8 * 1024 * 1024) output.push(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => {
    spawnError = error.message;
  });
  const deadline = setTimeout(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      spawnError = 'step-timeout';
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        // Target only this owned child tree; unrelated native/soak processes remain untouched.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          child.kill();
        });
      } else child.kill();
    },
    name === 'ui' ? 600_000 : 180_000,
  );
  const result = await new Promise((resolve) =>
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal })),
  );
  clearTimeout(deadline);
  if (bytes > 8 * 1024 * 1024) {
    output.push(Buffer.from('\nLog exceeded bounded capture; verification fails.\n'));
    spawnError = 'log-limit';
  }
  await writeFile(log, Buffer.concat(output));
  return {
    name,
    executable,
    args,
    startedMs,
    finishedMs: Date.now(),
    ...result,
    ...(spawnError ? { error: spawnError } : {}),
    log,
  };
}
export async function runDevelopmentVerification() {
  const directory = path.join(
    root,
    'artifacts',
    'development-verification',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const installedVersions = {};
  for (const name of [
    'typescript',
    'eslint',
    'prettier',
    'vitest',
    '@playwright/test',
    'vite',
    'hls.js',
  ]) {
    installedVersions[name] = JSON.parse(
      await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    ).version;
  }
  const receipt = {
    scope: 'DEVELOPMENT only; not native-device, invariant, soak, signing or release acceptance',
    status: 'FAIL',
    started: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    installedVersions,
    declaredDependencies: { ...manifest.dependencies, ...manifest.devDependencies },
    lockSha256: createHash('sha256')
      .update(await readFile(path.join(root, 'package-lock.json')))
      .digest('hex'),
    directory,
    steps: [],
  };
  const nodeTool = (relative, args = []) => ({
    executable: process.execPath,
    args: [path.join(root, 'node_modules', relative), ...args],
  });
  const unit = path.join(directory, 'unit.json');
  const ui = path.join(directory, 'ui.json');
  const plan = [
    { name: 'typecheck', ...nodeTool('typescript/bin/tsc', ['--noEmit']) },
    {
      name: 'format',
      ...nodeTool('prettier/bin/prettier.cjs', [
        '--check',
        'src',
        'tests',
        'scripts/*.mjs',
        '*.ts',
        '*.mjs',
        '*.json',
      ]),
    },
    {
      name: 'lint',
      ...nodeTool('eslint/bin/eslint.js', ['src', 'tests', 'scripts', '--no-warn-ignored']),
    },
    {
      name: 'unit',
      ...nodeTool('vitest/vitest.mjs', [
        'run',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${unit}`,
      ]),
      report: unit,
      reportKind: 'unit',
    },
    {
      name: 'ui',
      ...nodeTool('@playwright/test/cli.js', [
        'test',
        '--reporter=list,json',
        `--output=${path.join(directory, 'ui-output')}`,
      ]),
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: ui },
      report: ui,
      reportKind: 'ui',
    },
    {
      name: 'documentation',
      executable: 'python',
      args: ['-B', '-X', 'utf8', 'scripts/tmg.py', 'check'],
    },
    {
      // Refreshes Project Metrics.MD when a count changed (no-op otherwise).
      name: 'project-metrics',
      executable: 'python',
      args: ['-B', '-X', 'utf8', 'scripts/project-metrics.py'],
    },
    {
      name: 'verifier-regressions',
      executable: process.execPath,
      args: [
        '--test',
        'tests/tooling/verify-development.test.mjs',
        'tests/tooling/ui-source-server.test.mjs',
      ],
    },
    {
      name: 'packaging-regressions',
      executable: process.execPath,
      args: ['--test', 'tests/tooling/package-candidate.test.mjs'],
    },
    {
      name: 'license-inventory-regressions',
      executable: process.execPath,
      args: ['--test', 'tests/tooling/license-inventory.test.mjs'],
    },
    {
      name: 'soak-assessment-regressions',
      executable: process.execPath,
      args: ['--test', 'tests/tooling/assess-soak.test.mjs'],
    },
    {
      name: 'resource-measurement-regressions',
      executable: process.execPath,
      args: [
        '--test',
        'tests/tooling/windows-resources.test.mjs',
        'tests/tooling/android-resources.test.mjs',
        'tests/tooling/large-scan-fixture-server.test.mjs',
        'tests/tooling/large-scan-fixture-v17.test.mjs',
        'tests/native/guide-map-hydration-fixture.test.mjs',
      ],
    },
    {
      name: 'notice-assembly-regressions',
      executable: process.execPath,
      args: ['--test', 'tests/tooling/assemble-notices.test.mjs'],
    },
  ];
  try {
    for (const step of plan) {
      const actual = {
        ...(await command(step.name, step.executable, step.args, directory, step.env)),
        ...(step.report ? { report: step.report, reportKind: step.reportKind } : {}),
      };
      receipt.steps.push(actual);
      actual.evidence = await validateStepEvidence(actual);
    }
    receipt.status = 'PASS';
  } catch (error) {
    receipt.error = error.message;
  }
  receipt.finished = new Date().toISOString();
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDevelopmentVerification();
  console.log(
    JSON.stringify(
      { status: result.status, directory: result.directory, error: result.error },
      null,
      2,
    ),
  );
  if (result.status !== 'PASS') process.exitCode = 1;
}
