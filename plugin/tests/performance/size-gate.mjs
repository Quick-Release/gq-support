#!/usr/bin/env node
// Static performance gate for the built plugin assets (budgets B5 and B7 in
// docs/research/idle-performance-budgets.md). Run after `pnpm build:app`:
//   node plugin/tests/performance/size-gate.mjs [plugin-dir]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// Gzip -9 bytes. Raising a budget needs a PR that says why.
export const BUDGETS = {
  'assets/launcher.js': 1536,
  'assets/launcher.css': 1024,
  'assets/dist/index.js': 10240,
  'assets/dist/index.css': 4096,
  'assets/dist/index-rtl.css': 4096,
};

const SHIPPED_JS = ['assets/launcher.js', 'assets/dist/index.js'];

// React's internals objects, present only when React itself is bundled.
const BUNDLED_REACT = /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE/;

// Background polling is never allowed: the launcher and panel only act on user input.
const POLLING = /\bsetInterval\s*\(|\brefetchInterval\b/;

/**
 * @param {string} root The plugin directory.
 * @returns {{ sizes: Record<string, number>, failures: string[] }}
 */
export function checkBuild(root) {
  const sizes = {};
  const failures = [];

  for (const [file, budget] of Object.entries(BUDGETS)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      failures.push(`${file} is missing; run pnpm build:app first`);
      continue;
    }
    sizes[file] = gzipSync(readFileSync(path), { level: 9 }).length;
    if (sizes[file] > budget) failures.push(`${file} is ${sizes[file]} B gzip, over its ${budget} B budget`);
  }

  const manifest = join(root, 'assets/dist/index.asset.php');
  if (existsSync(manifest)) {
    const block = /'dependencies'\s*=>\s*array\(([^)]*)\)/.exec(readFileSync(manifest, 'utf8'))?.[1] ?? '';
    for (const [, handle] of block.matchAll(/'([^']+)'/g)) {
      if (!handle.startsWith('wp-')) failures.push(`the app depends on "${handle}"; only core wp-* handles are allowed`);
    }
  }

  for (const file of SHIPPED_JS) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (BUNDLED_REACT.test(source)) failures.push(`${file} bundles React; use the core wp-element handle`);
    if (POLLING.test(source)) failures.push(`${file} can poll (setInterval or refetchInterval)`);
  }

  return { sizes, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..'));
  const { sizes, failures } = checkBuild(root);
  const rows = Object.entries(BUDGETS).map(([file, budget]) => `| \`${file}\` | ${sizes[file] ?? '—'} | ${budget} |`);
  const report = ['| File | gzip bytes | Budget |', '|---|---:|---:|', ...rows].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Plugin asset sizes\n\n${report}\n`);
  }
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}
