// Which required suites a change set triggers. Unknown paths must run everything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUITES, affectedSuites } from './affected-suites.mjs';

const suites = (paths) => affectedSuites(paths).suites;

test('a documentation-only change triggers no suite', () => {
  assert.deepEqual(suites(['docs/adr/0001-client-support-repository-boundary.md', 'README.md', 'contract/README.md', '.agents/skills/tdd/SKILL.md']), []);
});

test('a shared contract fixture runs the WordPress and Worker suites', () => {
  assert.deepEqual(suites(['contract/fixtures/signing.json']), ['wordpress', 'worker']);
});

test('signing code on either side runs both languages', () => {
  assert.deepEqual(suites(['worker/src/signature.ts']), ['lint', 'wordpress', 'worker']);
  assert.deepEqual(suites(['plugin/includes/class-gq-support-signer.php']), ['php', 'size', 'wordpress', 'worker']);
});

test('Worker-only code runs only the Worker suite and lint', () => {
  assert.deepEqual(suites(['worker/src/intake.ts', 'docs/support-api-contract.md']), ['lint', 'worker']);
});

test('shipped plugin PHP runs static analysis, the WordPress matrix and the package verification', () => {
  assert.deepEqual(suites(['plugin/includes/class-gq-support-access.php']), ['php', 'size', 'wordpress']);
  assert.deepEqual(suites(['plugin/gq-support.php']), ['php', 'size', 'wordpress']);
  assert.deepEqual(suites(['plugin/tests/integration/access.php']), ['php', 'wordpress']);
});

test('other shipped package files run the package verification and the WordPress matrix', () => {
  assert.deepEqual(suites(['plugin/readme.txt']), ['size', 'wordpress']);
  assert.deepEqual(suites(['plugin/languages/gq-support-pt_PT.mo']), ['size', 'wordpress']);
  assert.deepEqual(suites(['plugin/composer.json']), ['php', 'size', 'wordpress']);
});

test('app source runs lint, the WordPress matrix and the size gate', () => {
  assert.deepEqual(suites(['plugin/app/src/Requests.tsx']), ['lint', 'size', 'wordpress']);
});

test('browser specs and other test scripts run lint and the WordPress matrix', () => {
  assert.deepEqual(suites(['plugin/tests/browser/session.spec.ts']), ['lint', 'wordpress']);
  assert.deepEqual(suites(['plugin/tests/integration/helper.mjs']), ['lint', 'wordpress']);
  assert.deepEqual(suites(['plugin/tests/integration/run.sh']), ['wordpress']);
});

test('lint configuration and its negative controls run only lint', () => {
  assert.deepEqual(suites(['eslint.config.mjs', 'plugin/app/eslint.config.cjs', 'scripts/lint-gate.test.mjs']), ['lint']);
});

test('audit exceptions trigger no suite: the dependency audit runs on every change', () => {
  assert.deepEqual(suites(['.github/dependency-audit-exceptions.json']), []);
});

test('the root toolchain, CI scripts and runtime matrix run every suite', () => {
  for (const path of ['pnpm-lock.yaml', 'package.json', 'scripts/ci/required-validation.mjs', '.github/runtime-matrix.json', '.github/workflows/ci.yml', '.github/workflows/wordpress-lane.yml', '.github/actions/upload-scanned-artifact/action.yml', '.gitleaks.toml']) {
    assert.deepEqual(suites([path]), SUITES, path);
  }
});

test('an unclassified path runs every suite and is reported', () => {
  const result = affectedSuites(['tools/new-thing.sh']);
  assert.deepEqual(result.suites, SUITES);
  assert.deepEqual(result.unclassified, ['tools/new-thing.sh']);
});

test('an empty change set cannot prove irrelevance, so it runs every suite', () => {
  assert.deepEqual(suites([]), SUITES);
});

test('each triggered suite names the paths that triggered it', () => {
  assert.deepEqual(affectedSuites(['worker/src/intake.ts', 'contract/fixtures/list.json']).reasons, {
    lint: ['worker/src/intake.ts'],
    wordpress: ['contract/fixtures/list.json'],
    worker: ['worker/src/intake.ts', 'contract/fixtures/list.json'],
  });
});
