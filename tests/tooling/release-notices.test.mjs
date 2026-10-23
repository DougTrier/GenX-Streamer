import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotices } from '../../scripts/release-notices.mjs';

const record = (ecosystem, name, version, scope, texts) => ({
  ecosystem,
  name,
  version,
  scope,
  licenseDeclaration: 'MIT',
  licenseFiles: texts.map((text, index) => ({ path: `LICENSE-${index}`, kind: 'license', text })),
});
const inventory = {
  schemaVersion: 1,
  records: [
    record('cargo', 'shipped-a', '1.0.0', 'runtime-closure-candidate-all-targets', ['MIT text\n']),
    record('cargo', 'shipped-b', '2.0.0', 'runtime-closure-candidate-all-targets', ['MIT text\n']),
    record('cargo', 'shipped-gap', '0.1.0', 'runtime-closure-candidate-all-targets', []),
    record('cargo', 'not-shipped', '9.9.9', 'build-proc-macro', ['Other text\n']),
    record('npm', 'player', '1.2.3', 'direct-runtime', ['Apache text\n']),
    record('npm', 'linter', '4.5.6', 'development-only', ['Dev text\n']),
  ],
};

test('only shipped components, each distinct text once, gaps listed', () => {
  const result = releaseNotices(
    inventory,
    ['shipped-a@1.0.0', 'shipped-b@2.0.0', 'shipped-gap@0.1.0'],
    'Fixture product',
  );
  assert.equal(result.shipped, 4);
  assert.equal(result.distinct, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.text.split('MIT text').length - 1, 1, 'shared text printed once');
  assert.match(result.text, /used by: cargo:shipped-a@1\.0\.0 \(LICENSE-0\); cargo:shipped-b@2\.0\.0/);
  assert.ok(!result.text.includes('not-shipped') && !result.text.includes('linter'));
  assert.match(result.text, /NO LICENSE TEXT FOUND[^]*cargo:shipped-gap@0\.1\.0/);
  // Deterministic for identical inputs.
  assert.equal(
    releaseNotices(inventory, ['shipped-gap@0.1.0', 'shipped-b@2.0.0', 'shipped-a@1.0.0'], 'Fixture product')
      .text,
    result.text,
  );
});

test('a pinned supplement fills a gap; crates absent from the inventory are reported', () => {
  const result = releaseNotices(
    inventory,
    ['shipped-gap@0.1.0', 'missing@1.0.0'],
    'Fixture product',
    [{ id: 'gap-license', kind: 'license', recordIds: ['cargo:shipped-gap@0.1.0'], text: 'Supplied\n' }],
  );
  assert.equal(result.missing, 0);
  assert.match(result.text, /supplement gap-license/);
  assert.deepEqual(result.absent, ['missing@1.0.0']);
});
