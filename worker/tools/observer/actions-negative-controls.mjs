// Isolated broken adapters must fail the actual fake-HTTP/evaluator assertions.
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = import.meta.dirname;
const original = readFileSync(join(root, 'github-actions.ts'), 'utf8');
for (const [name, before, after] of [
  ['missing-workflow-join', 'r.workflow_id !== workflow.id ||', 'false ||'],
  ['missing-head-join', 'r.head_sha !== e.head ||', 'false ||'],
  ['cancel-as-success', 'conclusion: r.conclusion };', 'conclusion: r.conclusion === "cancelled" ? "success" : r.conclusion };'],
  ['empty-as-success', 'const coverage: Read["coverage"] = complete ?', `if (!reads.length) reads.push({ source: "workflow", observed: i.observation, at: last, from: 0, to: last,
    account: c.account, stage: c.stage, candidate: c.candidate, generation: c.generation, status: "ok", coverage: "complete", pages: 0,
    body: encode({ expectation: c.expected[0], created: 0, started: 1, updated: last, status: "completed", conclusion: "success" }) });
    const coverage: Read["coverage"] = complete ?`],
]) {
  if (!original.includes(before)) throw new Error('actions_negative_anchor_missing');
  const temp = mkdtempSync(join(tmpdir(), 'gq-actions-negative-'));
  try {
    const observer = join(temp, 'tools/observer'); mkdirSync(observer, { recursive: true });
    writeFileSync(join(observer, 'github-actions.ts'), original.replace(before, after));
    for (const file of ['github-actions.test.ts', 'protocol.ts', 'snapshot-evidence.ts']) copyFileSync(join(root, file), join(observer, file));
    symlinkSync(join(root, '../../src'), join(temp, 'src'), 'dir');
    symlinkSync(join(root, '../../node_modules'), join(temp, 'node_modules'), 'dir');
    writeFileSync(join(temp, 'vitest.config.mjs'), `export default { root: ${JSON.stringify(temp)}, test: { include: ['tools/observer/github-actions.test.ts'], maxWorkers: 1 } };`);
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', join(temp, 'vitest.config.mjs')],
      { cwd: join(root, '../..'), encoding: 'utf8' });
    if (result.status !== 1 || !(result.stdout + result.stderr).includes('AssertionError:')) throw new Error(`actions_negative_not_detected:${name}`);
    console.log(`${name}: detected (real assertion failed)`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
