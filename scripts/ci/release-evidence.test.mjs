import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { ACCOUNT, checkTarget, checkApprovalEnvironment, checkProvenance, requireSafePlan } from './release-evidence.mjs';

test('only explicit durable stages in Tipme are eligible', () => {
  for (const stage of ['prod', 'staging']) assert.doesNotThrow(() => checkTarget(stage, ACCOUNT));
  for (const stage of [undefined, '', 'production', 'dev_test']) assert.throws(() => checkTarget(stage, ACCOUNT));
  assert.throws(() => checkTarget('prod', 'another-account'));
});

test('unavailable safe plan blocks every apply, regardless of supplied environment or input', () => {
  for (const stage of ['prod', 'staging']) assert.throws(() => requireSafePlan(stage, ACCOUNT), /no verified non-mutating/);
  const result = spawnSync(process.execPath, ['scripts/ci/release-evidence.mjs', 'plan', 'prod'], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SupportDB AND SupportLedger/);
});

test('required human reviewers must exist; names alone and unrelated reviewers do not suffice', () => {
  const environment = { name: 'prod', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'vvaz' } }] }] };
  assert.doesNotThrow(() => checkApprovalEnvironment(environment, 'prod'));
  for (const invalid of [null, {}, { name: 'staging' }, { name: 'prod', protection_rules: [] }, { name: 'prod', protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }]) {
    assert.throws(() => checkApprovalEnvironment(invalid, 'prod'));
  }
  environment.protection_rules[0].reviewers.push({ type: 'User', reviewer: { login: 'someone-else' } });
  assert.throws(() => checkApprovalEnvironment(environment, 'prod'));
});

test('unavailable environment API blocks release without logging child-process output', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/release-evidence.mjs', 'approval', 'prod'], {
    env: { ...process.env, PATH: '', GITHUB_REPOSITORY: 'Quick-Release/gq-support' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Release evidence unavailable or malformed; release blocked');
});

test('candidate is bound to this version, source, run, ZIP and frozen lockfiles', () => {
  const expected = { version: '0.1.0', commit: 'a'.repeat(40), run: '123', zip_sha256: 'b'.repeat(64), lockfiles: { 'pnpm-lock.yaml': 'c'.repeat(64), 'plugin/composer.lock': 'd'.repeat(64) } };
  assert.doesNotThrow(() => checkProvenance(structuredClone(expected), expected));
  for (const key of ['version', 'commit', 'run', 'zip_sha256']) {
    assert.throws(() => checkProvenance({ ...expected, [key]: 'swapped' }, expected));
    assert.throws(() => checkProvenance(expected, { ...expected, [key]: undefined }));
  }
  assert.throws(() => checkProvenance({ ...expected, lockfiles: {} }, expected));
  assert.throws(() => checkProvenance(null, expected));
});
