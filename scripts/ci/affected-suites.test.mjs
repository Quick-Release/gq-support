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
  assert.deepEqual(suites(['worker/src/signature.ts']), ['wordpress', 'worker']);
  assert.deepEqual(suites(['plugin/includes/class-gq-support-signer.php']), ['php', 'wordpress', 'worker']);
});

test('Worker-only code runs only the Worker suite', () => {
  assert.deepEqual(suites(['worker/src/intake.ts', 'docs/support-api-contract.md']), ['worker']);
});

test('plugin PHP runs static analysis and the WordPress matrix', () => {
  assert.deepEqual(suites(['plugin/includes/class-gq-support-access.php']), ['php', 'wordpress']);
});

test('app source runs the WordPress matrix and the size gate', () => {
  assert.deepEqual(suites(['plugin/app/src/Requests.tsx']), ['size', 'wordpress']);
});

test('the root toolchain, CI scripts and runtime matrix run every suite', () => {
  for (const path of ['pnpm-lock.yaml', 'package.json', 'scripts/ci/required-validation.mjs', '.github/runtime-matrix.json', '.github/workflows/ci.yml', '.github/workflows/wordpress-lane.yml']) {
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
    wordpress: ['contract/fixtures/list.json'],
    worker: ['worker/src/intake.ts', 'contract/fixtures/list.json'],
  });
});
