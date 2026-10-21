// The aggregate required check: every failing, cancelled or wrongly skipped dependency fails it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './required-validation.mjs';

const jobs = { plan: 'always', php: 'php', worker: 'worker', wordpress: 'wordpress', size: 'size' };
const passing = { plan: 'success', php: 'success', worker: 'success', wordpress: 'success', size: 'success' };
const needs = (results) => Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]));
const verdict = (results, affected = ['php', 'size', 'wordpress', 'worker']) => evaluate({ needs: needs(results), jobs, affected });
const failedJobs = (result) => result.rows.filter((row) => !row.ok).map((row) => row.job);

test('passes when every dependency succeeded', () => {
  assert.equal(verdict(passing).ok, true);
});

for (const result of ['failure', 'cancelled']) {
  test(`fails when a dependency is ${result}`, () => {
    const outcome = verdict({ ...passing, wordpress: result });
    assert.equal(outcome.ok, false);
    assert.deepEqual(failedJobs(outcome), ['wordpress']);
  });
}

test('a suite the change does not affect may be skipped', () => {
  assert.equal(verdict({ ...passing, worker: 'skipped', php: 'skipped' }, ['size', 'wordpress']).ok, true);
});

test('a documentation-only change passes with every suite skipped', () => {
  assert.equal(verdict({ plan: 'success', php: 'skipped', worker: 'skipped', wordpress: 'skipped', size: 'skipped' }, []).ok, true);
});

test('fails when an affected suite was skipped', () => {
  const outcome = verdict({ ...passing, worker: 'skipped' }, ['worker']);
  assert.equal(outcome.ok, false);
  assert.match(outcome.rows.find((row) => row.job === 'worker').reason, /skipped although/);
});

test('an always-required job may never be skipped', () => {
  assert.deepEqual(failedJobs(verdict({ ...passing, plan: 'skipped' }, [])), ['plan']);
});

test('without a valid plan every skip is unexpected', () => {
  const outcome = evaluate({ needs: needs({ ...passing, plan: 'failure', php: 'skipped' }), jobs, affected: undefined });
  assert.deepEqual(failedJobs(outcome), ['plan', 'php']);
});

test('fails on a dependency nobody classified, and on a classified job missing from needs', () => {
  const { size, ...withoutSize } = passing;
  const outcome = evaluate({ needs: needs({ ...withoutSize, surprise: 'success' }), jobs, affected: [] });
  assert.deepEqual(failedJobs(outcome).sort(), ['size', 'surprise']);
});
