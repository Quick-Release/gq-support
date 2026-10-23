#!/usr/bin/env node
// Workflow hygiene for every file under .github/workflows and .github/actions:
// - third-party actions are pinned to a full commit SHA, with the reviewed release in a comment;
// - no `pull_request_target`, and no job of a workflow that runs on pull requests gets a write token;
// - pull-request code (a pull-request workflow, or a reusable one it calls) reads a secret only in a
//   job bound to an environment, which scopes the secret to that job, or passes it by name to a local
//   reusable workflow, which is checked the same way; never `secrets: inherit`; forks receive none;
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

/**
 * @param {boolean} options.pullRequestCode A pull-request workflow calls this reusable workflow.
 * @returns {string[]} Problems, each prefixed with the file and line.
 */
export function checkWorkflow(path, text, { pullRequestCode = false } = {}) {
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
  if (!pullRequestCode && !runsOnPullRequests(on)) return problems;

  if (permissions.some(grantsWrite)) report(lines.indexOf(permissions[0]), 'a workflow that runs on pull requests needs a read-only top-level token');
  const owner = jobNames(lines);
  lines.forEach((line, index) => {
    if (!/^ {4}permissions:/.test(line) || (WRITERS[path] ?? []).includes(owner[index])) return;
    if ([line, ...children(lines, index)].some(grantsWrite)) report(index, `job \`${owner[index]}\` asks for a write token in a workflow that runs on pull requests`);
  });
  const jobsStart = lines.findIndex((line) => line.startsWith('jobs:'));
  const jobsWith = (pattern) => new Set(lines.flatMap((line, index) => (index > jobsStart && pattern.test(line) ? [owner[index]] : [])));
  const environments = jobsWith(/^ {4}environment:\s*\S/);
  // An environment secret reaches a reusable workflow's job only when the caller passes its name.
  const callers = jobsWith(/^ {4}uses:\s*\.\/\.github\/workflows\//);
  lines.forEach((line, index) => {
    if (index <= jobsStart) return;
    const code = line.replace(/#.*/, '');
    const inherits = /\bsecrets:\s*inherit\b/.test(code);
    if (!inherits && !/\bsecrets\.(?!GITHUB_TOKEN\b)/.test(code)) return;
    if (!inherits && (environments.has(owner[index]) || callers.has(owner[index]))) return;
    report(index, inherits
      ? `job \`${owner[index]}\` passes every secret with \`secrets: inherit\` in pull-request code: pass each by name`
      : `job \`${owner[index]}\` reads a secret in pull-request code without an \`environment\` that scopes it to the job`);
  });
  return problems;
}

const runsOnPullRequests = (on) => on.some((line) => /^\s*pull_request\s*:/.test(line) || /^on:\s*\[?.*\bpull_request\b/.test(line));

/** The job each line belongs to: the latest two-space key above it. */
function jobNames(lines) {
  let job = '';
  return lines.map((line) => (job = line.match(/^ {2}([\w-]+):\s*$/)?.[1] ?? job));
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
  const texts = new Map(files.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  // Reusable workflows that pull-request workflows call, directly or through another one.
  const called = new Set();
  const queue = [...texts].filter(([, text]) => runsOnPullRequests(topLevelBlock(text.split('\n'), 'on'))).map(([path]) => path);
  while (queue.length > 0) {
    for (const [, callee] of (texts.get(queue.shift()) ?? '').matchAll(/^\s*uses:\s*\.\/(\.github\/workflows\/\S+\.ya?ml)\s*$/gm)) {
      if (called.has(callee)) continue;
      called.add(callee);
      queue.push(callee);
    }
  }
  return [...texts].flatMap(([path, text]) => checkWorkflow(path, text, { pullRequestCode: called.has(path) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = checkRepository();
  for (const problem of problems) console.error(`::error title=Workflow policy::${problem}`);
  if (problems.length === 0) console.log('Workflow policy: every action is pinned, pull-request tokens are read-only, pull-request secrets are environment-scoped, and every artifact is scanned and bounded.');
  process.exit(problems.length === 0 ? 0 : 1);
}
