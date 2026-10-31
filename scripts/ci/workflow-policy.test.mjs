// Workflow hygiene: pinned actions, read-only pull-request tokens, no privileged pull-request
// trigger, and artifacts only through the secret-scanning upload with bounded retention.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRepository, checkWorkflow, workerSuiteRunnerProblems } from './workflow-policy.mjs';

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

test('pull-request code may pass a secret by name to a reusable workflow, which binds the environment', () => {
  const caller = (secrets) => `name: CI\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  cells:\n    uses: ./.github/workflows/lane.yml\n    with:\n      cell: x\n${secrets}`;
  assert.deepEqual(check(caller('    secrets:\n      TOKEN: ${{ secrets.TOKEN }}\n')), []);
  assert.match(check(caller('    secrets: inherit\n')).join('\n'), /`cells` .*secret/);
});

test('a workflow deploys a stage only through the plan gate and never runs a destructive command', () => {
  const dispatch = (run) => check(workflow({ on: 'workflow_dispatch:', steps: `      - run: ${run}` }));
  for (const run of [
    'pnpm exec alchemy deploy --stage prod --yes',
    'npx alchemy destroy --stage staging --yes',
    'pnpm exec alchemy plan --stage prod && pnpm exec alchemy deploy --stage prod --yes',
    'alchemy unsafe nuke',
    'pnpm exec alchemy state delete --stage prod',
    'pnpm deploy:worker',
    'pnpm run deploy --stage prod',
    'pnpm exec wrangler d1 delete gqsupportworker-supportdb-prod',
    'pnpm exec wrangler delete --name gqsupportworker-worker-prod',
  ]) assert.match(dispatch(run).join('\n'), /deploy gate|destructive/, run);
  for (const run of [
    'pnpm exec alchemy deploy --help',
    'node scripts/verify-github-app.ts "$DEPLOY_STAGE"',
    'pnpm run destroy --stage dev_valerio',
    'echo "Deploy with Alchemy" # alchemy deploy is not run here',
  ]) assert.deepEqual(dispatch(run), [], run);
});

test('a workflow applies a stage only after retaining its plan', () => {
  const upload = '      - uses: ./.github/actions/upload-scanned-artifact\n        with:\n          name: plan\n          path: worker/deploy-plan/\n          retention-days: 90';
  const steps = (...lines) => check(workflow({ on: 'workflow_dispatch:', steps: lines.join('\n') }));
  const plan = '      - run: pnpm deploy-gate plan --stage "$STAGE" --out deploy-plan';
  const apply = '      - run: pnpm deploy-gate apply --stage "$STAGE" --evidence deploy-plan';
  assert.deepEqual(steps(plan, upload, apply), []);
  assert.match(steps(apply).join('\n'), /retained plan/);
  assert.match(steps(plan, apply).join('\n'), /retained plan/);
  assert.match(steps(apply, plan, upload).join('\n'), /retained plan/);
});

test('every job that runs the Worker suite uses the runner CI sizes it for', () => {
  const job = (name, runner, steps = '      - run: pnpm test') =>
    `name: X\n\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\njobs:\n  ${name}:\n    runs-on: ${runner}\n    defaults:\n      run:\n        working-directory: worker\n    steps:\n${steps}\n`;
  const ci = job('worker', 'blacksmith-4vcpu-ubuntu-2404');
  const texts = (deploy) => new Map([['.github/workflows/ci.yml', ci], ['.github/workflows/deploy-worker.yml', deploy]]);
  // The deploy gate's plan job runs the full suite; on a 2-vCPU runner its integration tests time out
  // and the stage cannot be planned (runs 41187455102 and 41187494530).
  assert.match(workerSuiteRunnerProblems(texts(job('plan', 'ubuntu-latest'))).join('\n'), /deploy-worker\.yml:\d+: job `plan` runs the Worker suite on `ubuntu-latest`.*blacksmith-4vcpu-ubuntu-2404/);
  assert.deepEqual(workerSuiteRunnerProblems(texts(job('plan', 'blacksmith-4vcpu-ubuntu-2404'))), []);
  // A job that does not run the Worker suite may use any runner.
  assert.deepEqual(workerSuiteRunnerProblems(texts(job('deploy', 'ubuntu-latest', '      - run: pnpm install --frozen-lockfile'))), []);
  assert.match(workerSuiteRunnerProblems(new Map([['.github/workflows/deploy-worker.yml', job('plan', 'ubuntu-latest')]])).join('\n'), /ci\.yml.*`worker` job/);
});
