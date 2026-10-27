// CI-only startup evidence. No provider operations, credentials or raw child output.
// The kernel, bwrap, runtime, source and installed dependencies remain trusted.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function diagnosePlanningStartup(run = spawnSync) {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const node = realpathSync(process.execPath);
  const namespace = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev'];
  const confined = `import { runOfflineModule } from './deploy/planning-execution.ts';
    try {
      const result = await runOfflineModule(${JSON.stringify(repo)}, 'test/fixtures/planning-startup-probe.ts', {});
      process.exitCode = result === '{"status":"started"}' ? 0 : 1;
    } catch { process.exitCode = 1; }`;
  const probes = [
    ['bubblewrap', '/usr/bin/bwrap', ['--version']],
    ['namespace', '/usr/bin/bwrap', [...namespace, '--', '/usr/bin/true']],
    ['node', '/usr/bin/bwrap', [...namespace, '--ro-bind', dirname(node), '/runtime', '--', '/runtime/node', '--eval', 'process.exit(0)']],
    // Use the real tracked-source copy, mounts, environment, loader and guard.
    ['confined-loader-guard-dependencies', node, ['--import', './deploy/planning-loader.mjs', '--input-type=module', '--eval', confined]],
  ];
  const results = [];
  for (const [stage, command, args] of probes) {
    let child;
    try {
      child = run(command, args, { cwd: resolve(repo, 'worker'), env: {}, stdio: 'ignore',
        timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 });
    } catch { child = { error: { code: 'UNKNOWN' } }; }
    // Never stringify errors, signals, stdout, stderr, arguments or environment.
    const exit = Number.isInteger(child.status) && child.status >= 0 && child.status <= 255 ? child.status : null;
    const errors = new Map([['ENOENT', 'missing'], ['EACCES', 'denied'], ['ETIMEDOUT', 'timeout']]);
    const reason = child.error ? (errors.get(child.error.code) ?? 'launch-error')
      : child.signal ? 'signal' : exit === 0 ? 'passed' : 'exit';
    results.push({ stage, reason, exit });
    if (reason !== 'passed') break;
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = diagnosePlanningStartup();
    console.log(JSON.stringify({ diagnostic: 'planning-startup-v1', results }));
    process.exitCode = results.every(({ reason }) => reason === 'passed') ? 0 : 1;
  } catch {
    console.log('{"diagnostic":"planning-startup-v1","reason":"preparation-failed"}');
    process.exitCode = 1;
  }
}
