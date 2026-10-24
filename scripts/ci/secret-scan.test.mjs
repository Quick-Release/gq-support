// The secret scan (scripts/ci/gitleaks.sh with .gitleaks.toml) catches a synthetic canary of every
// secret this project handles, in the places a leak would land, and lets the expected fixtures
// through; the artifact scan (scripts/ci/scan-artifact.sh) withholds a leaking upload. Every
// canary is generated here at run time, so none is ever committed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'gq-secret-scan-'));
after(() => rmSync(work, { recursive: true, force: true }));

const hex = (bytes) => randomBytes(bytes).toString('hex');
const alphanumeric = (length) => randomBytes(length * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, length);
const signingKey = () => randomBytes(64).toString('base64');
const FIXTURE_KEY = JSON.parse(readFileSync(join(ROOT, 'contract', 'fixtures', 'signing.json'), 'utf8')).secret_key;

function tree(name, files) {
  const dir = join(work, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Scans `target` and returns each finding's file (relative to the target) and rule. */
function scan(mode, target) {
  const report = join(work, `${mode}-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync(join(ROOT, 'scripts', 'ci', 'gitleaks.sh'), [mode, '--verbose', '--report-format', 'json', '--report-path', report, target], { encoding: 'utf8' });
  assert.ok([0, 1].includes(result.status), `gitleaks failed to run: ${result.stderr}`);
  const text = readFileSync(report, 'utf8');
  const findings = JSON.parse(text).map((finding) => ({ file: finding.File.replace(`${target}/`, ''), rule: finding.RuleID }));
  assert.equal(result.status, findings.length > 0 ? 1 : 0, 'the exit code must say whether anything leaked');
  return { findings, text, output: result.stdout + result.stderr };
}

const appPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const canaries = {
  'App PEM in a log': ['logs/worker.log', `GitHub App key rejected: ${appPem}`, 'private-key'],
  'escaped App PEM in a captured response': ['responses/provider.json', JSON.stringify({ body: appPem }), 'private-key'],
  'generated signing key in the option, as JSON': ['wp/option.json', JSON.stringify({ active: { secret: signingKey() } }), 'gq-support-signing-key'],
  'generated signing key in a database dump': ['wp/options.sql', `INSERT INTO wp_options VALUES ('gq_support_signing_key','a:1:{s:6:"active";a:1:{s:6:"secret";s:88:"${signingKey()}";}}','off');`, 'gq-support-signing-key'],
  'signing key under its contract field name': ['keys/installation.json', JSON.stringify({ secret_key: signingKey() }), 'gq-support-signing-key'],
  'constant-backed signing key': ['wp/wp-config.php', `<?php\ndefine( 'GQ_SUPPORT_SIGNING_KEY', '${signingKey()}' );\n`, 'gq-support-signing-key'],
  'webhook secret': ['worker/.dev.vars', `GITHUB_WEBHOOK_SECRET=${randomBytes(32).toString('base64url')}\n`, 'gq-support-webhook-secret'],
  'previous webhook secret': ['worker/state.json', JSON.stringify({ GITHUB_WEBHOOK_PREVIOUS_SECRET: randomBytes(32).toString('base64url') }), 'gq-support-webhook-secret'],
  'WordPress auth cookie': ['trace/network.txt', `Cookie: wordpress_logged_in_${hex(16)}=admin%7C1790000000%7C${alphanumeric(43)}%7C${hex(32)}\n`, 'wordpress-auth-cookie'],
  'nonce header': ['trace/request.txt', `X-WP-Nonce: ${hex(5)}\n`, 'wordpress-nonce'],
  'nonce in bootstrap HTML': ['pages/admin.html', `<script>var wpApiSettings = {"root":"https://shop.example/wp-json/","nonce":"${hex(5)}"};</script>`, 'wordpress-nonce'],
  'nonce in a URL': ['logs/access.log', `GET /wp-admin/admin-post.php?action=gq_support&_wpnonce=${hex(5)} 302\n`, 'wordpress-nonce'],
  'Submitted text canary in test results': ['test-results/junit.xml', `<failure>Expected description "My order failed gqcanary_${alphanumeric(24).toLowerCase()}"</failure>`, 'gq-support-canary'],
  'provider token': ['logs/delivery.log', `authorization: token ghs_${alphanumeric(36)}\n`, 'github-app-token'],
};

test('every synthetic canary fails the scan, without its value in the output', () => {
  const dir = tree('canaries', Object.fromEntries(Object.values(canaries).map(([path, content]) => [path, content])));
  const { findings, text, output } = scan('dir', dir);
  for (const [name, [path, , rule]] of Object.entries(canaries)) {
    assert.ok(findings.some((finding) => finding.file === path && finding.rule === rule), `${name}: expected ${rule} in ${path}, found ${JSON.stringify(findings.filter((finding) => finding.file === path))}`);
  }
  for (const secret of [appPem.split('\n')[1], ...Object.values(canaries).map(([, content]) => content.match(/gqcanary_[a-z0-9]+|ghs_[A-Za-z0-9]+/)?.[0]).filter(Boolean)]) {
    assert.ok(!text.includes(secret) && !output.includes(secret), 'a canary value reached the report or log');
  }
});

test('expected fixtures and code that only handles secrets pass', () => {
  const dir = tree('expected', {
    'contract/fixtures/signing.json': readFileSync(join(ROOT, 'contract', 'fixtures', 'signing.json')),
    'keys/public.json': JSON.stringify({ public_key: randomBytes(32).toString('base64'), signature: randomBytes(64).toString('base64') }),
    'wp/wp-config.php': "<?php\ndefine( 'GQ_SUPPORT_SIGNING_KEY', getenv( 'GQ_SUPPORT_SIGNING_KEY' ) );\n",
    'tests/session.spec.ts': "await page.request.get(endpoint, { headers: { 'X-WP-Nonce': session.nonce } });\nconst text = `gqcanary_${suffix}`;\n",
    'tests/webhook.test.ts': 'const env = { GITHUB_WEBHOOK_SECRET: "test-current-webhook-secret" };\n',
  });
  assert.deepEqual(scan('dir', dir).findings, []);
});

test('the signing fixture is allowed only at its path and with its value', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'contract', 'fixtures', 'signing.json'), 'utf8'));
  const dir = tree('fixture-scope', {
    'contract/fixtures/signing.json': JSON.stringify({ ...fixture, secret_key: signingKey() }, null, 4),
    'plugin/tests/keys.json': JSON.stringify({ secret_key: FIXTURE_KEY }),
  });
  const found = scan('dir', dir).findings.filter((finding) => finding.rule === 'gq-support-signing-key').map((finding) => finding.file).sort();
  assert.deepEqual(found, ['contract/fixtures/signing.json', 'plugin/tests/keys.json']);
});

test('history scanning finds a secret that a later commit removed', () => {
  const repo = tree('history', { 'README.md': 'clean\n' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Canary', '-c', 'user.email=canary@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'clean');
  writeFileSync(join(repo, 'wp-config.php'), `<?php\ndefine( 'GQ_SUPPORT_SIGNING_KEY', '${signingKey()}' );\n`);
  git('add', '.');
  git('commit', '--quiet', '-m', 'leak');
  rmSync(join(repo, 'wp-config.php'));
  git('add', '-A');
  git('commit', '--quiet', '-m', 'remove');
  assert.deepEqual(scan('git', repo).findings, [{ file: 'wp-config.php', rule: 'gq-support-signing-key' }]);
});

test('the artifact scan fails on a leak inside an archive and passes clean diagnostics', () => {
  const clean = tree('artifact-clean', { 'junit.xml': '<testsuite tests="1" failures="0"/>' });
  const leaking = tree('artifact-leak', { 'trace/network.txt': `X-WP-Nonce: ${hex(5)}\n`, 'junit.xml': '<testsuite/>' });
  execFileSync('zip', ['-qr', 'trace.zip', 'trace'], { cwd: leaking });
  rmSync(join(leaking, 'trace'), { recursive: true });
  const run = (paths) => spawnSync(join(ROOT, 'scripts', 'ci', 'scan-artifact.sh'), [paths], { encoding: 'utf8' });

  assert.equal(run(`${clean}/\n${join(work, 'missing')}`).status, 0);
  const leak = run(`${clean}\n${leaking}/`);
  assert.equal(leak.status, 1);
  assert.match(leak.stdout + leak.stderr, /wordpress-nonce/);
  assert.equal(run(`${clean}/*.xml`).status, 2, 'a glob must be refused');
  assert.equal(run(`${clean}\n!${leaking}`).status, 2, 'an exclusion must be refused');
});
