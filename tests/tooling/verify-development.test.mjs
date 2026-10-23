import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateStepEvidence, validateUnitReport, validateUiReport } from '../../scripts/verify-development.mjs';

const unit = () => ({ success: true, startTime: 1001, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: [{ status: 'passed', startTime: 1002, endTime: 1003, assertionResults: [{ status: 'passed', failureMessages: [] }] }] });
const ui = () => ({ errors: [], stats: { startTime: new Date(1001).toISOString(), duration: 2, expected: 1, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: [{ tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed', retry: 0, errors: [], startTime: new Date(1002).toISOString() }] }] }] }] });
async function temporary(work) {
  const parent = path.resolve(tmpdir()); const directory = await mkdtemp(path.join(parent, 'tmg-verifier-test-'));
  try { await work(directory); }
  finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^tmg-verifier-test-/);
    await rm(resolved, { recursive: true, force: true });
  }
}
test('accepts successful actual assertions and UI results inside the current run', () => {
  assert.deepEqual(validateUnitReport(unit(), 1000, 1010), { tests: 1, files: 1 });
  assert.deepEqual(validateUiReport(ui(), 1000, 1010), { tests: 1 });
});
test('nonzero command, termination or spawn error cannot pass with a report', async () => {
  for (const extra of [{ exitCode: 1 }, { exitCode: 0, signal: 'SIGTERM' }, { exitCode: 0, error: 'spawn-failed' }]) await assert.rejects(validateStepEvidence({ name: 'test', ...extra }), /did not exit successfully/);
});
test('missing required report fails even after a zero command exit', async () => {
  await assert.rejects(validateStepEvidence({ name: 'unit', exitCode: 0 }), /missing its required report/);
  await assert.rejects(validateStepEvidence({ name: 'ui', exitCode: 0, report: '', reportKind: 'ui' }), /missing its required report/);
  await temporary(async directory => { await assert.rejects(validateStepEvidence({ name: 'unit', exitCode: 0, report: path.join(directory, 'missing.json'), reportKind: 'unit', startedMs: 1000, finishedMs: 1010 })); });
});
test('malformed or empty required report fails', async () => {
  await temporary(async directory => {
    const file = path.join(directory, 'report.json'); const startedMs = Date.now() - 10;
    for (const value of ['{invalid', '']) {
      await writeFile(file, value); await assert.rejects(validateStepEvidence({ name: 'unit', exitCode: 0, report: file, reportKind: 'unit', startedMs, finishedMs: Date.now() + 10 }));
    }
  });
});
test('fresh file containing stale report timestamps fails', () => {
  assert.throws(() => validateUnitReport(unit(), 2000, 3000), /stale/);
  assert.throws(() => validateUiReport(ui(), 2000, 3000), /stale/);
});
test('old report file fails before its contents are trusted', async () => {
  await temporary(async directory => {
    const file = path.join(directory, 'report.json'); await writeFile(file, JSON.stringify(unit())); await utimes(file, new Date(0), new Date(0));
    await assert.rejects(validateStepEvidence({ name: 'unit', exitCode: 0, report: file, reportKind: 'unit', startedMs: Date.now() - 100, finishedMs: Date.now() + 100 }), /outside this run/);
  });
});
test('passing summary cannot mask failed or missing actual assertions', () => {
  const failed = unit(); failed.testResults[0].assertionResults[0].status = 'failed'; assert.throws(() => validateUnitReport(failed, 1000, 1010), /assertion/);
  const absent = unit(); absent.testResults[0].assertionResults = []; assert.throws(() => validateUnitReport(absent, 1000, 1010), /disagrees/);
  const empty = unit(); empty.numTotalTests = empty.numPassedTests = 0; assert.throws(() => validateUnitReport(empty, 1000, 1010), /empty/);
});
test('pending, todo, skipped, flaky and expected-failure tests cannot pass verification', () => {
  for (const key of ['numPendingTests', 'numTodoTests', 'numFailedTestSuites']) { const report = unit(); report[key] = 1; assert.throws(() => validateUnitReport(report, 1000, 1010)); }
  for (const key of ['skipped', 'flaky', 'unexpected']) { const report = ui(); report.stats[key] = 1; assert.throws(() => validateUiReport(report, 1000, 1010)); }
  const expectedFailure = ui(); expectedFailure.suites[0].specs[0].tests[0].expectedStatus = 'failed'; assert.throws(() => validateUiReport(expectedFailure, 1000, 1010));
});
test('UI summary cannot mask failed retries or missing actual results', () => {
  const failed = ui(); failed.suites[0].specs[0].tests[0].results[0].status = 'failed'; assert.throws(() => validateUiReport(failed, 1000, 1010));
  const retry = ui(); retry.suites[0].specs[0].tests[0].results[0].retry = 1; assert.throws(() => validateUiReport(retry, 1000, 1010));
  const absent = ui(); absent.suites = []; assert.throws(() => validateUiReport(absent, 1000, 1010), /disagrees/);
});
