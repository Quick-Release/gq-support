// Security regressions in isolated copies must fail actual offline assertions.
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
const original = readFileSync(join(root, 'review-loader.ts'), 'utf8');
for (const [name, before, after] of [
  ['missing-verification', 'await verify();', 'await Promise.resolve();'],
  ['stale-dispatch-authority', 'await verify(); fresh();\n          return worker(url, init);', 'fresh();\n          return worker(url, init);'],
]) {
  if (!original.includes(before)) throw new Error('review_negative_anchor_missing');
  const temp = mkdtempSync(join(tmpdir(), 'gq-review-negative-'));
  try {
    const observer = join(temp, 'tools/observer'); mkdirSync(observer, { recursive: true });
    writeFileSync(join(observer, 'review-loader.ts'), original.replaceAll(before, after));
    for (const file of ['review-loader.test.ts', 'https-transport.ts', 'protocol.ts', 'snapshot-evidence.ts'])
      copyFileSync(join(root, file), join(observer, file));
    symlinkSync(join(root, '../../src'), join(temp, 'src'), 'dir');
    symlinkSync(join(root, '../../node_modules'), join(temp, 'node_modules'), 'dir');
    writeFileSync(join(temp, 'vitest.config.mjs'), `export default { root: ${JSON.stringify(temp)}, test: { include: ['tools/observer/review-loader.test.ts'], maxWorkers: 1 } };`);
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', join(temp, 'vitest.config.mjs')],
      { cwd: join(root, '../..'), encoding: 'utf8' });
    if (result.status !== 1 || !(result.stdout + result.stderr).includes('AssertionError:')) throw new Error(`review_negative_not_detected:${name}`);
    console.log(`${name}: detected (real assertion failed)`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
