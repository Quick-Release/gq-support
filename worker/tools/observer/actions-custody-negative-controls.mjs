// Each isolated broken custody copy must fail real private-files/GitHub assertions.
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = import.meta.dirname;
for (const [name, file, before, after] of [
  ['stale-actions-dispatch', 'actions-review-loader.ts', 'await verify(); fresh();\n            // Exact source', 'fresh();\n            // Exact source'],
  ['missing-actions-final-verification', 'actions-review-loader.ts', 'await verify(); fresh(); // source catch', 'fresh(); // source catch'],
  ['worker-token-as-actions', 'actions-review-loader.ts', '/^[a-f0-9]{64}$/.test(actionsReadToken) || ', ''],
  ['missing-durable-read-claim', 'private-launcher.ts', 'claim(journal, p, purpose, io);', 'void purpose;'],
]) {
  const original = readFileSync(join(root, file), 'utf8');
  if (!original.includes(before)) throw new Error('actions_custody_negative_anchor_missing');
  const temp = mkdtempSync(join(tmpdir(), 'gq-actions-custody-negative-'));
  try {
    const observer = join(temp, 'tools/observer'); mkdirSync(observer, { recursive: true });
    for (const p of readdirSync(root).filter(p => p.endsWith('.ts'))) copyFileSync(join(root, p), join(observer, p));
    writeFileSync(join(observer, file), original.replace(before, after));
    symlinkSync(join(root, '../../src'), join(temp, 'src'), 'dir');
    symlinkSync(join(root, '../../node_modules'), join(temp, 'node_modules'), 'dir');
    writeFileSync(join(temp, 'vitest.config.mjs'), `export default { root: ${JSON.stringify(temp)}, test: { include: ['tools/observer/actions-private-launcher.test.ts'], maxWorkers: 1 } };`);
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', join(temp, 'vitest.config.mjs')],
      { cwd: join(root, '../..'), encoding: 'utf8' });
    if (result.status !== 1 || !(result.stdout + result.stderr).includes('AssertionError:')) throw new Error(`actions_custody_negative_not_detected:${name}`);
    console.log(`${name}: detected (real assertion failed)`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
