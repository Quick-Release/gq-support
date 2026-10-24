// Negative controls for the JS/TS lint gate (`pnpm lint:js`): a planted violation in each lint
// scope fails it, and clean code passes. It needs the installed workspace, so CI runs it in the
// lint job rather than with the scripts/ci tests in the plan job.
//   pnpm test:lint
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const ROOT = join(import.meta.dirname, '..');
const app = new ESLint({ cwd: join(ROOT, 'plugin', 'app') });
const rest = new ESLint({ cwd: ROOT });

async function errors(eslint, filePath, code) {
  assert.equal(await eslint.isPathIgnored(filePath), false, `${filePath} is ignored by the lint gate`);
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.severity === 2).map((message) => message.ruleId);
}

test('the app fails on a hook called conditionally and a foreign text domain', async () => {
  const code = [
    'import { useState } from "@wordpress/element";',
    'import { __ } from "@wordpress/i18n";',
    'export function Canary({ open }: { open: boolean }) {',
    '  if (open) useState(0);',
    '  return __("Canary", "other-plugin");',
    '}',
    '',
  ].join('\n');
  const rules = await errors(app, join(ROOT, 'plugin/app/src/Canary.tsx'), code);
  assert.ok(rules.includes('react-hooks/rules-of-hooks'), rules.join(', '));
  assert.ok(rules.includes('@wordpress/i18n-text-domain'), rules.join(', '));
});

test('the Worker, scripts, tests and launcher fail on unused and undefined bindings', async () => {
  for (const file of ['worker/src/canary.ts', 'worker/test/canary.test.ts', 'scripts/ci/canary.mjs', 'plugin/tests/browser/canary.spec.ts', 'plugin/assets/canary.js']) {
    const rules = await errors(rest, join(ROOT, file), 'const unused = missing;\n');
    assert.ok(rules.includes('@typescript-eslint/no-unused-vars'), `${file}: ${rules.join(', ')}`);
  }
  assert.ok((await errors(rest, join(ROOT, 'scripts/ci/canary.mjs'), 'export const value = missing;\n')).includes('no-undef'));
});

test('clean code passes in every scope', async () => {
  assert.deepEqual(await errors(app, join(ROOT, 'plugin/app/src/Canary.tsx'), 'import { __ } from "@wordpress/i18n";\n\nexport const label = () => __("Canary", "gq-support");\n'), []);
  for (const file of ['worker/src/canary.ts', 'scripts/ci/canary.mjs', 'plugin/assets/canary.js']) {
    assert.deepEqual(await errors(rest, join(ROOT, file), 'export const value = 1;\n'), [], file);
  }
});
