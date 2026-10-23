// Workflow hygiene: pinned actions, read-only pull-request tokens, no privileged pull-request
// trigger, and artifacts only through the secret-scanning upload with bounded retention.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRepository, checkWorkflow } from './workflow-policy.mjs';

const PINNED = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0';
const workflow = ({ on = 'pull_request:', permissions = 'permissions:\n  contents: read', steps = `      - uses: ${PINNED}` } = {}) =>
  `name: Test\n\non:\n  ${on}\n\n${permissions}\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
const check = (text, path = '.github/workflows/test.yml') => checkWorkflow(path, text);

test('a pinned, read-only pull-request workflow passes', () => {
  assert.deepEqual(check(workflow()), []);
});

test('the repository workflows and actions follow the policy', () => {
  assert.deepEqual(checkRepository(), []);
});

test('an action referenced by tag or branch fails', () => {
  for (const ref of ['actions/checkout@v4', 'actions/checkout@main', 'actions/checkout@11d5960a', 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262']) {
    const problems = check(workflow({ steps: `      - uses: ${ref}` }));
    assert.equal(problems.length, 1, ref);
    assert.match(problems[0], /full commit SHA/);
  }
});

test('local actions and reusable workflows need no pin', () => {
  assert.deepEqual(check(workflow({ steps: '      - uses: ./.github/actions/upload-scanned-artifact\n        with:\n          name: report\n          path: test-results/\n          retention-days: 30' })), []);
});

test('pull_request_target fails', () => {
  assert.match(check(workflow({ on: 'pull_request_target:' })).join('\n'), /pull_request_target/);
});

test('a pull-request workflow needs a read-only top-level token', () => {
  assert.match(check(workflow({ permissions: 'permissions:\n  contents: write' })).join('\n'), /read-only/);
  assert.match(check(workflow({ permissions: 'permissions: write-all' })).join('\n'), /read-only/);
  assert.match(check(workflow({ permissions: '' })).join('\n'), /top-level permissions/);
  assert.deepEqual(check(workflow({ permissions: 'permissions: {}' })), []);
});

test('a job in a pull-request workflow may not ask for a write token', () => {
  const job = (permissions) => `name: Test\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  publish:\n    runs-on: ubuntu-latest\n${permissions}    steps:\n      - uses: ${PINNED}\n`;
  assert.match(check(job('    permissions:\n      contents: write\n')).join('\n'), /`publish` .*write/);
  assert.match(check(job('    permissions: write-all\n')).join('\n'), /`publish` .*write/);
  assert.deepEqual(check(job('    # Never write here.\n    permissions:\n      contents: read # not write\n')), []);
  assert.deepEqual(check(job('    permissions:\n      contents: read\n').replace(`      - uses: ${PINNED}`, '      - run: echo write')), []);
});

test('only the manual-only simulation job may write in ci.yml', () => {
  const ci = `name: CI\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  simulation:\n    runs-on: ubuntu-latest\n    permissions:\n      actions: write\n    steps:\n      - run: true\n`;
  assert.deepEqual(check(ci, '.github/workflows/ci.yml'), []);
  assert.match(check(ci.replace('simulation:', 'php:'), '.github/workflows/ci.yml').join('\n'), /`php`/);
});

test('a workflow that never runs pull-request code may write', () => {
  assert.deepEqual(check(workflow({ on: 'workflow_dispatch:', permissions: 'permissions:\n  contents: write' })), []);
});

test('artifacts go only through the scanning upload, with a retention', () => {
  const direct = '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: report\n          path: report/\n          retention-days: 30';
  assert.match(check(workflow({ steps: direct })).join('\n'), /upload-scanned-artifact/);
  const unbounded = '      - uses: ./.github/actions/upload-scanned-artifact\n        with:\n          name: report\n          path: test-results/\n      - run: true';
  assert.match(check(workflow({ steps: unbounded })).join('\n'), /retention-days/);
});

test('artifacts may upload only allowlisted paths', () => {
  const upload = (path) => `      - uses: ./.github/actions/upload-scanned-artifact\n        with:\n          name: report\n          path: ${path}\n          retention-days: 30`;
  assert.deepEqual(check(workflow({ steps: upload('test-results/') })), []);
  assert.match(check(workflow({ steps: upload('.test-site/') })).join('\n'), /allowlisted/);
  assert.match(check(workflow({ steps: upload('.') })).join('\n'), /allowlisted/);
});

test('the scanning upload action itself may use upload-artifact', () => {
  const action = `name: Upload\nruns:\n  using: composite\n  steps:\n    - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n`;
  assert.deepEqual(checkWorkflow('.github/actions/upload-scanned-artifact/action.yml', action), []);
});

test('pull-request code reads a secret only in a job bound to an environment', () => {
  const lane = (environment) => `name: Lane\n\non:\n  workflow_call:\n\npermissions:\n  contents: read\n\njobs:\n  cell:\n    runs-on: ubuntu-latest\n${environment}    steps:\n      - run: install\n        env:\n          TOKEN: \${{ secrets.TOKEN }}\n`;
  const pullRequests = { pullRequestCode: true };
  assert.match(checkWorkflow('.github/workflows/lane.yml', lane(''), pullRequests).join('\n'), /`cell` reads a secret .*environment/);
  assert.deepEqual(checkWorkflow('.github/workflows/lane.yml', lane("    environment: ${{ inputs.real && 'sandbox' || '' }}\n"), pullRequests), []);
  // A reusable workflow no pull-request workflow calls, like a release-only one, may.
  assert.deepEqual(checkWorkflow('.github/workflows/lane.yml', lane('')), []);
  assert.match(check(workflow({ steps: '      - run: deploy\n        env:\n          TOKEN: ${{ secrets.TOKEN }}' })).join('\n'), /`test` reads a secret/);
});
