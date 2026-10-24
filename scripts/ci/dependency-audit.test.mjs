// The dependency audit gate: high and critical advisories in either lockfile fail it, and so does
// any scanner that did not return a report. Only a valid, unexpired, exactly scoped exception lets
// a blocking advisory through.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './dependency-audit.mjs';

const TODAY = '2026-10-21';

const pnpmReport = (...advisories) => JSON.stringify({
  advisories: Object.fromEntries(advisories.map((advisory, index) => [String(index + 1), advisory])),
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
});
const pnpmAdvisory = ({ ghsa = 'GHSA-aaaa-bbbb-cccc', name = 'braces', severity = 'high', paths = ['plugin__app>@wordpress/scripts>braces'] } = {}) => ({
  id: 1, github_advisory_id: ghsa, module_name: name, severity, title: `${name} advisory`, url: `https://github.com/advisories/${ghsa}`,
  vulnerable_versions: '<=3.0.3', findings: [{ version: '3.0.3', paths, dev: true }],
});
const composerReport = (advisories = [], abandoned = []) => JSON.stringify({
  advisories: advisories.length === 0 ? [] : Object.groupBy(advisories, (advisory) => advisory.packageName),
  abandoned: abandoned.length === 0 ? [] : Object.fromEntries(abandoned.map((name) => [name, null])),
  filter: [],
});
const composerAdvisory = ({ id = 'PKSA-1111-2222-3333', name = 'phpunit/phpunit', severity = 'high', ghsa = 'GHSA-dddd-eeee-ffff' } = {}) => ({
  advisoryId: id, packageName: name, affectedVersions: '<9.6.20', title: `${name} advisory`, cve: 'CVE-2026-0001',
  link: `https://github.com/advisories/${ghsa}`, reportedAt: '2026-10-01T00:00:00+00:00', sources: [{ name: 'GitHub', remoteId: ghsa }], severity,
});

const clean = { pnpm: { exitCode: 0, stdout: pnpmReport() }, composer: { exitCode: 0, stdout: composerReport() }, validate: { exitCode: 0, stdout: './composer.json is valid' } };
const audit = (scans = {}, exceptions = []) => evaluate({ scans: { ...clean, ...scans }, exceptions, today: TODAY });
const exception = (overrides = {}) => ({
  tool: 'pnpm', advisory: 'GHSA-aaaa-bbbb-cccc', package: 'braces', via: 'plugin__app>@wordpress/scripts>',
  owner: 'vvaz', expires: '2026-12-31', reason: 'No patched release; only expands patterns from repository config.', ...overrides,
});

test('clean reports from both lockfiles pass', () => {
  const result = audit();
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.problems, []);
});

test('a high pnpm advisory fails the gate', () => {
  const result = audit({ pnpm: { exitCode: 1, stdout: pnpmReport(pnpmAdvisory()) } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => [finding.tool, finding.advisory, finding.package, finding.verdict]), [['pnpm', 'GHSA-aaaa-bbbb-cccc', 'braces', 'blocking']]);
});

test('a critical Composer advisory fails the gate', () => {
  const result = audit({ composer: { exitCode: 1, stdout: composerReport([composerAdvisory({ severity: 'critical' })]) } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => [finding.tool, finding.advisory, finding.verdict]), [['composer', 'PKSA-1111-2222-3333', 'blocking']]);
});

test('an advisory without a severity blocks rather than passing unrated', () => {
  const result = audit({ composer: { exitCode: 1, stdout: composerReport([composerAdvisory({ severity: null })]) } });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].verdict, 'blocking');
});

test('lower-severity advisories are kept for review without failing', () => {
  const result = audit({
    pnpm: { exitCode: 1, stdout: pnpmReport(pnpmAdvisory({ severity: 'moderate' }), pnpmAdvisory({ ghsa: 'GHSA-low0-low0-low0', severity: 'low' })) },
    composer: { exitCode: 2, stdout: composerReport([], ['abandoned/package']) },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings.map((finding) => [finding.severity, finding.verdict]), [['moderate', 'review'], ['low', 'review']]);
  assert.deepEqual(result.abandoned, ['abandoned/package']);
});

// The advisory endpoint being unreachable is an infrastructure failure, never a clean audit.
for (const [name, scan] of [
  ['timed out', { exitCode: null, stdout: '' }],
  ['printed no report', { exitCode: 1, stdout: '' }],
  ['printed an error object', { exitCode: 1, stdout: JSON.stringify({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }) }],
  ['exited with an error code beside a report', { exitCode: 100, stdout: composerReport() }],
]) {
  test(`fails when a scanner ${name}`, () => {
    for (const tool of ['pnpm', 'composer']) {
      const result = audit({ [tool]: { ...scan, stderr: 'request to the advisory endpoint failed' } });
      assert.equal(result.ok, false, tool);
      assert.equal(result.problems.length, 1, tool);
      assert.match(result.problems[0], new RegExp(`^${tool}: `));
    }
  });
}

const blockedBraces = { pnpm: { exitCode: 1, stdout: pnpmReport(pnpmAdvisory()) } };

test('a valid exception lets exactly its advisory through', () => {
  const result = audit(blockedBraces, [exception()]);
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].verdict, 'excepted');
  assert.equal(result.findings[0].exception.owner, 'vvaz');
});

test('an exception does not cover the advisory reached through another dependency path', () => {
  const paths = ['plugin__app>@wordpress/scripts>braces', 'worker>vitest>braces'];
  const result = audit({ pnpm: { exitCode: 1, stdout: pnpmReport(pnpmAdvisory({ paths })) } }, [exception()]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].verdict, 'blocking');
});

test('an exception for another advisory or package covers nothing and is reported unused', () => {
  for (const other of [exception({ advisory: 'GHSA-zzzz-zzzz-zzzz' }), exception({ package: 'micromatch' }), exception({ tool: 'composer' })]) {
    const result = audit(blockedBraces, [other]);
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].verdict, 'blocking');
    assert.equal(result.unused.length, 1);
  }
});

test('an expired exception fails the gate even when it would match', () => {
  const result = audit(blockedBraces, [exception({ expires: '2026-10-20' })]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].verdict, 'blocking');
  assert.match(result.problems.join('\n'), /expired on 2026-10-20/);
});

test('an exception stays valid through its expiry date', () => {
  assert.equal(audit(blockedBraces, [exception({ expires: TODAY })]).ok, true);
});

test('an exception needs an owner, reason, advisory ID, exact scope and a bounded expiry', () => {
  for (const [field, value] of [['owner', ''], ['reason', undefined], ['advisory', ''], ['package', undefined], ['via', ''], ['expires', 'soon'], ['expires', '2027-10-21'], ['tool', 'npm']]) {
    const result = audit(blockedBraces, [exception({ [field]: value })]);
    assert.equal(result.ok, false, `${field}=${value}`);
    assert.equal(result.findings[0].verdict, 'blocking', `${field}=${value}`);
    assert.match(result.problems.join('\n'), /exception/, `${field}=${value}`);
  }
});

test('a Composer exception matches the advisory by any of its IDs', () => {
  const composer = { exitCode: 1, stdout: composerReport([composerAdvisory()]) };
  const scoped = { tool: 'composer', package: 'phpunit/phpunit', via: undefined };
  for (const advisory of ['PKSA-1111-2222-3333', 'GHSA-dddd-eeee-ffff', 'CVE-2026-0001']) {
    assert.equal(audit({ composer }, [exception({ ...scoped, advisory })]).ok, true, advisory);
  }
});

test('an invalid composer.json fails the gate', () => {
  const result = audit({ validate: { exitCode: 2, stdout: '', stderr: './composer.json is valid but your composer.lock has some errors' } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /^composer validate --strict: .*composer\.lock has some errors/);
});

test('a pnpm exception does not cover a finding whose dependency paths are unknown', () => {
  const result = audit({ pnpm: { exitCode: 1, stdout: pnpmReport(pnpmAdvisory({ paths: [] })) } }, [exception()]);
  assert.equal(result.findings[0].verdict, 'blocking');
});
