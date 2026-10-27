import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagnosePlanningStartup } from '../../worker/scripts/planning-startup-diagnostic.mjs';

const stages = ['bubblewrap', 'namespace', 'node', 'confined-loader-guard-dependencies'];
test('startup probe stops at each failing boundary and discards private child output', () => {
  for (let failure = 0; failure < stages.length; failure++) {
    let calls = 0;
    const results = diagnosePlanningStartup((_command, _args, options) => {
      assert.deepEqual(options.env, {});
      assert.equal(options.stdio, 'ignore');
      assert.equal(options.timeout, 60_000);
      return { status: calls++ === failure ? 1 : 0, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' };
    });
    assert.equal(calls, failure + 1);
    assert.deepEqual(results, stages.slice(0, failure + 1).map((stage, index) => ({ stage, reason: index === failure ? 'exit' : 'passed', exit: index === failure ? 1 : 0 })));
    assert.doesNotMatch(JSON.stringify(results), /PRIVATE/);
  }
});

test('launch errors and signals emit only finite categories and bounded exits', () => {
  assert.deepEqual(diagnosePlanningStartup(() => { throw new Error('PRIVATE_ERROR'); }),
    [{ stage: 'bubblewrap', reason: 'launch-error', exit: null }]);
  for (const [child, reason, exit] of [
    [{ error: { code: 'ENOENT', message: 'PRIVATE_ERROR' } }, 'missing', null],
    [{ error: { code: 'EACCES' } }, 'denied', null],
    [{ error: { code: 'ETIMEDOUT' }, signal: 'SIGKILL' }, 'timeout', null],
    [{ error: { code: 'PRIVATE_ERROR' } }, 'launch-error', null],
    [{ error: { code: '__proto__' } }, 'launch-error', null],
    [{ error: { code: 'constructor' } }, 'launch-error', null],
    [{ signal: 'PRIVATE_SIGNAL', status: -1 }, 'signal', null],
    [{ status: 256 }, 'exit', null],
    [{ status: 23 }, 'exit', 23],
  ]) {
    assert.deepEqual(diagnosePlanningStartup(() => child), [{ stage: 'bubblewrap', reason, exit }]);
  }
});

test('all startup stages pass without invoking providers or weakening the namespace', () => {
  const calls = [];
  const results = diagnosePlanningStartup((command, args) => { calls.push({ command, args }); return { status: 0 }; });
  assert.deepEqual(results, stages.map((stage) => ({ stage, reason: 'passed', exit: 0 })));
  for (const { command, args } of calls.slice(1, 3)) {
    assert.equal(command, '/usr/bin/bwrap');
    assert.deepEqual(args.slice(0, 8), ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr']);
  }
  assert.match(calls[3].args.at(-1), /runOfflineModule/);
  assert.match(calls[3].args.at(-1), /test\/fixtures\/planning-startup-probe.ts/);
});

test('CI runs diagnostic before mandatory Worker tests on the same runner, even after probe failure', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const worker = workflow.split('\n  worker:\n')[1].split('\n  size:\n')[0];
  assert.match(worker, /runs-on: blacksmith-4vcpu-ubuntu-2404/);
  assert.match(worker, /name: Diagnose offline planner startup\n\s+continue-on-error: true\n\s+run: node scripts\/planning-startup-diagnostic.mjs\n\s+- run: pnpm test/);
});

test('Worker CI installs required namespace tooling before diagnostic and tests', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const worker = workflow.split('\n  worker:\n')[1].split('\n  size:\n')[0];
  const install = worker.indexOf('sudo apt-get install --yes --no-install-recommends bubblewrap');
  assert.ok(install >= 0, 'the hosted runner must provision the required /usr/bin/bwrap');
  assert.ok(install < worker.indexOf('run: node scripts/planning-startup-diagnostic.mjs'));
  assert.ok(install < worker.indexOf('run: pnpm test'));
});
