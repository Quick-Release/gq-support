// Negative controls for the size gate: each check must fail on a violating build.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BUDGETS, checkBuild } from './size-gate.mjs';

const plugin = join(import.meta.dirname, '..', '..');

const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function emptyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gq-size-gate-'));
  fixtures.push(root);
  return root;
}

// A copy of the real build, so each control changes one thing.
function fixture() {
  const root = emptyFixture();
  cpSync(join(plugin, 'assets'), join(root, 'assets'), { recursive: true });
  return root;
}

// Incompressible bytes, so gzip cannot hide the growth.
const noise = (bytes) => `/*${randomBytes(bytes).toString('base64')}*/`;

test('the current build passes', () => {
  assert.deepEqual(checkBuild(plugin).failures, []);
});

for (const [file, budget] of Object.entries(BUDGETS)) {
  test(`fails when ${file} exceeds its gzip budget`, () => {
    const root = fixture();
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + noise(budget));
    assert.match(checkBuild(root).failures.join('\n'), new RegExp(file.replace(/[.]/g, '\\.')));
  });
}

test('fails when the app depends on a non-core script handle', () => {
  const root = fixture();
  const manifest = join(root, 'assets/dist/index.asset.php');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace("'wp-a11y',", "'wp-a11y',\n\t\t'react',"));
  assert.match(checkBuild(root).failures.join('\n'), /react/);
});

test('fails when the app bundles its own React', () => {
  const root = fixture();
  writeFileSync(join(root, 'assets/dist/index.js'), readFileSync(join(root, 'assets/dist/index.js'), 'utf8') + 'var x={__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED:{}};');
  assert.match(checkBuild(root).failures.join('\n'), /bundles React/);
});

for (const timer of ['setInterval(poll, 1000)', 'useQuery({ refetchInterval: 5000 })']) {
  test(`fails when shipped code polls with ${timer.split('(')[0]}`, () => {
    const root = fixture();
    writeFileSync(join(root, 'assets/launcher.js'), readFileSync(join(root, 'assets/launcher.js'), 'utf8') + timer);
    assert.match(checkBuild(root).failures.join('\n'), /poll/);
  });
}

test('fails when a budgeted file is missing', () => {
  assert.match(checkBuild(emptyFixture()).failures.join('\n'), /missing/);
});
