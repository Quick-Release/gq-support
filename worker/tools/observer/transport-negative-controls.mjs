// Mutate isolated copies only: each security regression must fail real assertions.
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
const original = readFileSync(join(root, 'https-transport.ts'), 'utf8');
for (const [name, before, after] of [
  ['body-cap-disabled', 'maxBytes = 65_536', 'maxBytes = 131_072'],
  ['redirect-following', 'redirect: "error"', 'redirect: "follow"'],
  ['readiness-token-forwarding', 'if (path === snapshot) headers.Authorization', 'if (true) headers.Authorization'],
]) {
  if (!original.includes(before)) throw new Error('transport_negative_anchor_missing');
  const temp = mkdtempSync(join(tmpdir(), 'gq-transport-negative-'));
  try {
    const observer = join(temp, 'tools/observer'); mkdirSync(observer, { recursive: true });
    writeFileSync(join(observer, 'https-transport.ts'), original.replace(before, after));
    for (const file of ['https-transport.test.ts', 'protocol.ts', 'snapshot-evidence.ts']) copyFileSync(join(root, file), join(observer, file));
    symlinkSync(join(root, '../../src'), join(temp, 'src'), 'dir');
    symlinkSync(join(root, '../../node_modules'), join(temp, 'node_modules'), 'dir');
    writeFileSync(join(temp, 'vitest.config.mjs'), `export default { root: ${JSON.stringify(temp)}, test: { include: ['tools/observer/https-transport.test.ts'], maxWorkers: 1 } };`);
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', join(temp, 'vitest.config.mjs')],
      { cwd: join(root, '../..'), encoding: 'utf8' });
    if (result.status !== 1 || !(result.stdout + result.stderr).includes('AssertionError:')) throw new Error(`transport_negative_not_detected:${name}`);
    console.log(`${name}: detected (real assertion failed)`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
