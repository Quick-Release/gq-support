// Five fixed, deliberately broken copies must each fail the real protocol vectors.
// The implementation files are never modified. Temporary copies are always removed.
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
const original = readFileSync(join(root, 'protocol.ts'), 'utf8');
const variants = [
  ['empty-as-healthy', '// Zero, even with complete coverage, is never affirmative recovery.',
    'if (a.rows.every(x => x.errors === 0)) put("worker_errors", "clear", e);'],
  ['completion-from-start', 't.terminal === null && c.now - t.start >= proposals.completion',
    'false'],
  ['stale-recovery', 'return { ...old };', 'return { ...old, active: false };'],
  ['duplicate-failure-count', 'old.count + Number(!old.active || s.at > old.watermark)', 'old.count + 1'],
  ['unknown-receipt-reset', 'previous === "dispatching" || previous === "blocked_unknown" || observed === "dispatching"', 'observed === "dispatching"'],
];
for (const [name, before, after] of variants) {
  if (!original.includes(before)) throw new Error('negative_control_anchor_missing');
  const temp = mkdtempSync(join(tmpdir(), 'gq-observer-negative-'));
  try {
    writeFileSync(join(temp, 'protocol.ts'), original.replace(before, after));
    for (const file of ['protocol.test.ts', 'analytics-wire.ts']) copyFileSync(join(root, file), join(temp, file));
    symlinkSync(join(root, '../../node_modules'), join(temp, 'node_modules'), 'dir');
    writeFileSync(join(temp, 'vitest.config.mjs'), `export default { root: ${JSON.stringify(temp)}, test: { include: ['protocol.test.ts'], maxWorkers: 1 } };`);
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
      join(temp, 'vitest.config.mjs')], { cwd: join(root, '../..'), encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    if (result.status !== 1 || !output.includes('AssertionError:')) throw new Error(`negative_control_not_detected:${name}`);
    console.log(`${name}: detected (real assertion failed)`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
