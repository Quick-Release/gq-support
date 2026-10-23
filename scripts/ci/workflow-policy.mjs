#!/usr/bin/env node
// Workflow hygiene for every file under .github/workflows and .github/actions:
// - third-party actions are pinned to a full commit SHA, with the reviewed release in a comment;
// - no `pull_request_target`, and no job of a workflow that runs on pull requests gets a write token;
// - artifacts are uploaded only through ./.github/actions/upload-scanned-artifact, which
//   secret-scans them first, from an allowlisted path and with an explicit `retention-days`.
// A line-based check: these files keep one key per line, which is all it needs.
//   node scripts/ci/workflow-policy.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED_UPLOAD = './.github/actions/upload-scanned-artifact';
// Report directories that only ever hold test and scan output, and the release candidate.
const UPLOAD_PATHS = new Set(['audit-results/', 'benchmark-results/', 'package-zip/', 'plugin/phpcs-report.xml', 'runtime-results/', 'runtime-results/resolved-matrix.json', 'secret-scan/', 'test-results/']);
// Jobs that may write although their workflow runs on pull requests, and why.
const WRITERS = {
  // Runs only on a manual `simulate` dispatch, to cancel its own run.
  '.github/workflows/ci.yml': ['simulation'],
};

/** @returns {string[]} Problems, each prefixed with the file and line. */
export function checkWorkflow(path, text) {
  const lines = text.split('\n');
  const problems = [];
  const report = (index, message) => problems.push(`${path}:${index + 1}: ${message}`);

  lines.forEach((line, index) => {
    const uses = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
    if (!uses) return;
    const [, ref, rest] = uses;
    if (ref.startsWith('./')) {
      if (ref !== SCANNED_UPLOAD) return;
      const step = stepBlock(lines, index);
      if (!step.some((line) => /^\s*retention-days:\s*\S/.test(line))) report(index, 'an artifact upload needs `retention-days`');
      const path = step.map((line) => line.match(/^\s*path:\s*(\S+)\s*$/)?.[1]).find(Boolean);
      if (!UPLOAD_PATHS.has(path)) report(index, `upload path \`${path}\` is not allowlisted in scripts/ci/workflow-policy.mjs`);
      return;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref) || !/^\s+#\s*v?\d/.test(rest)) {
      report(index, `\`${ref}\` must be pinned to a full commit SHA with its release in a comment, like \`owner/action@<sha> # v1.2.3\``);
    }
    if (ref.startsWith('actions/upload-artifact@') && !path.startsWith('.github/actions/upload-scanned-artifact/')) {
      report(index, `upload artifacts with \`${SCANNED_UPLOAD}\`, which secret-scans them first`);
    }
  });

  if (!path.startsWith('.github/workflows/')) return problems;
  const on = topLevelBlock(lines, 'on');
  if (on.some((line) => /\bpull_request_target\b/.test(line))) report(0, '`pull_request_target` would run pull-request code with a privileged token');
  const permissions = topLevelBlock(lines, 'permissions');
  if (permissions.length === 0) report(0, 'set explicit top-level permissions');
  if (!on.some((line) => /^\s*pull_request\s*:/.test(line) || /^on:\s*\[?.*\bpull_request\b/.test(line))) return problems;

  if (permissions.some(grantsWrite)) report(lines.indexOf(permissions[0]), 'a workflow that runs on pull requests needs a read-only top-level token');
  let job = '';
  lines.forEach((line, index) => {
    job = line.match(/^ {2}([\w-]+):\s*$/)?.[1] ?? job;
    if (!/^ {4}permissions:/.test(line) || (WRITERS[path] ?? []).includes(job)) return;
    if ([line, ...children(lines, index)].some(grantsWrite)) report(index, `job \`${job}\` asks for a write token in a workflow that runs on pull requests`);
  });
  return problems;
}

const grantsWrite = (line) => /write/.test(line.replace(/#.*/, ''));

/** The lines of a top-level key, its own line included; empty when absent. */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The lines nested under the key on line `index`. */
function children(lines, index) {
  const indent = lines[index].search(/\S/);
  const end = lines.findIndex((line, at) => at > index && line.trim() && line.search(/\S/) <= indent);
  return lines.slice(index + 1, end < 0 ? undefined : end);
}

/** The rest of the step whose `uses:` is on line `index`. */
function stepBlock(lines, index) {
  const indent = lines[index].search(/\S/);
  const block = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && (line.search(/\S/) < indent || /^\s*-\s/.test(line) && line.search(/\S/) <= indent)) break;
    block.push(line);
  }
  return block;
}

export function checkRepository(root = ROOT) {
  const files = [
    ...readdirSync(join(root, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`),
    ...readdirSync(join(root, '.github', 'actions')).map((name) => `.github/actions/${name}/action.yml`),
  ];
  return files.flatMap((path) => checkWorkflow(path, readFileSync(join(root, path), 'utf8')));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = checkRepository();
  for (const problem of problems) console.error(`::error title=Workflow policy::${problem}`);
  if (problems.length === 0) console.log('Workflow policy: every action is pinned, pull-request tokens are read-only, and every artifact is scanned and bounded.');
  process.exit(problems.length === 0 ? 0 : 1);
}
