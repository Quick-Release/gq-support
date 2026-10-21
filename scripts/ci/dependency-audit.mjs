#!/usr/bin/env node
// The dependency audit gate in .github/workflows/ci.yml. It audits the frozen pnpm and Composer
// lockfiles, production and development dependencies alike, because build tools run in CI.
// A high or critical advisory fails it, and so does a scanner that did not return a report or a
// composer.json that fails `composer validate --strict`.
// Exceptions live in .github/dependency-audit-exceptions.json; see the README.
//   node scripts/ci/dependency-audit.mjs [report-dir]    default report-dir: audit-results
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Anything else, including a missing or unknown severity, blocks.
const REVIEW = new Set(['info', 'low', 'moderate', 'medium']);
// An exception is a dated decision to revisit, not a permanent waiver.
const MAX_EXCEPTION_DAYS = 120;

/**
 * @param {object} input
 * @param {Record<'pnpm' | 'composer' | 'validate', { exitCode: number | null, stdout: string, stderr?: string }>} input.scans
 *   `pnpm audit --json`, `composer audit --locked --format=json` and `composer validate --strict`.
 * @param {object[]} input.exceptions Entries of .github/dependency-audit-exceptions.json.
 * @param {string} input.today ISO date the exceptions' expiry is judged against.
 */
export function evaluate({ scans, exceptions, today }) {
  const findings = [];
  const problems = [];
  let abandoned = [];

  for (const [tool, { exitCodes, parse }] of Object.entries(SCANNERS)) {
    const scan = scans[tool];
    const report = json(scan?.stdout);
    const parsed = exitCodes.includes(scan?.exitCode) && report ? parse(report) : null;
    if (!parsed) {
      const detail = scan?.exitCode === null ? 'timed out or was killed' : `exited ${scan?.exitCode} without an audit report`;
      const stderr = scan?.stderr?.replace(/\s+/g, ' ').trim().slice(0, 300);
      problems.push(`${tool}: ${detail}${stderr ? `: ${stderr}` : ''}`);
      continue;
    }
    findings.push(...parsed.findings);
    if (parsed.abandoned) abandoned = parsed.abandoned;
  }
  const valid = exceptions.filter((entry) => {
    const problem = invalid(entry, today);
    if (problem) problems.push(`exception ${entry.advisory || '(no advisory)'} for ${entry.package || '(no package)'}: ${problem}`);
    return !problem;
  });
  const used = new Set();
  for (const finding of findings) {
    if (REVIEW.has(finding.severity)) {
      finding.verdict = 'review';
      continue;
    }
    const entry = valid.find((candidate) => covers(candidate, finding));
    finding.verdict = entry ? 'excepted' : 'blocking';
    if (entry) {
      finding.exception = entry;
      used.add(entry);
    }
  }
  if (scans.validate?.exitCode !== 0) {
    const output = `${scans.validate?.stderr ?? ''} ${scans.validate?.stdout ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 300);
    problems.push(`composer validate --strict: ${output || `exited ${scans.validate?.exitCode}`}`);
  }
  const unused = valid.filter((entry) => !used.has(entry));

  return { ok: problems.length === 0 && findings.every((finding) => finding.verdict !== 'blocking'), findings, abandoned, unused, problems };
}

function invalid(entry, today) {
  if (!(entry.tool in SCANNERS)) return `tool must be one of ${Object.keys(SCANNERS).join(', ')}`;
  for (const field of ['advisory', 'package', 'owner', 'reason']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) return `${field} is required`;
  }
  // pnpm reaches a package through many parents; the exception names the one it was judged for.
  if (entry.tool === 'pnpm' && (typeof entry.via !== 'string' || !entry.via.trim())) return 'via (the dependency path prefix it is scoped to) is required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '') || Number.isNaN(Date.parse(entry.expires))) return 'expires must be a YYYY-MM-DD date';
  if (entry.expires < today) return `expired on ${entry.expires}`;
  if ((Date.parse(entry.expires) - Date.parse(today)) / 86_400_000 > MAX_EXCEPTION_DAYS) return `expires more than ${MAX_EXCEPTION_DAYS} days ahead`;
  return '';
}

// For pnpm, every path that reaches the package must start with `via`; no paths prove nothing.
const covers = (entry, finding) => entry.tool === finding.tool && entry.package === finding.package && finding.ids.includes(entry.advisory)
  && (entry.tool !== 'pnpm' || (finding.paths.length > 0 && finding.paths.every((path) => path.startsWith(entry.via))));

// Each scanner's exit codes that still come with a complete report, and how to read that report.
const SCANNERS = {
  pnpm: {
    // 1: vulnerabilities found.
    exitCodes: [0, 1],
    parse: (report) => isObject(report.advisories) && isObject(report.metadata?.vulnerabilities) ? { findings: Object.values(report.advisories).map((advisory) => ({
      tool: 'pnpm',
      advisory: advisory.github_advisory_id,
      ids: [advisory.github_advisory_id, ...(advisory.cves ?? [])].filter(Boolean),
      package: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      versions: [...new Set(advisory.findings.map((finding) => finding.version))],
      paths: [...new Set(advisory.findings.flatMap((finding) => finding.paths))],
    })) } : null,
  },
  composer: {
    // A bit mask: 1 vulnerable packages, 2 abandoned packages.
    exitCodes: [0, 1, 2, 3],
    parse: (report) => isObject(report.advisories) && isObject(report.abandoned) ? { findings: Object.values(report.advisories).flat().map((advisory) => ({
      tool: 'composer',
      advisory: advisory.advisoryId,
      ids: [advisory.advisoryId, advisory.cve, ...(advisory.sources ?? []).map((source) => source.remoteId)].filter(Boolean),
      package: advisory.packageName,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.link,
      versions: [advisory.affectedVersions],
      paths: [],
    })), abandoned: Object.keys(report.abandoned) } : null,
  },
};

// Composer prints an empty list as `[]`, a non-empty one as an object.
const isObject = (value) => typeof value === 'object' && value !== null;

function json(text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

const ROOT = join(import.meta.dirname, '..', '..');
const LOCKFILES = ['pnpm-lock.yaml', 'plugin/composer.lock'];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.error ? String(result.error) : result.stderr ?? '' };
}

const firstLine = (text) => text.trim().split('\n')[0] ?? '';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2] ?? 'audit-results';
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = JSON.parse(readFileSync(join(ROOT, '.github', 'dependency-audit-exceptions.json'), 'utf8')).exceptions;
  const result = evaluate({
    scans: {
      pnpm: run('pnpm', ['audit', '--json']),
      composer: run('composer', ['--working-dir=plugin', 'audit', '--locked', '--format=json', '--no-interaction']),
      validate: run('composer', ['--working-dir=plugin', 'validate', '--strict', '--no-interaction']),
    },
    exceptions,
    today,
  });

  // Record what was audited and with which tools, so a result can be reproduced.
  const report = {
    date: today,
    ok: result.ok,
    tools: {
      node: process.version,
      pnpm: firstLine(run('pnpm', ['--version']).stdout),
      composer: firstLine(run('composer', ['--version', '--no-ansi']).stdout),
      php: firstLine(run('php', ['-r', 'echo PHP_VERSION;']).stdout),
    },
    lockfiles: Object.fromEntries(LOCKFILES.map((path) => [path, `sha256:${createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')}`])),
    ...result,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'dependency-audit.json'), `${JSON.stringify(report, null, 2)}\n`);

  const row = (finding) => `| ${finding.verdict} | ${finding.tool} | ${finding.package} ${finding.versions.join(', ')} | ${finding.severity ?? 'unrated'} | [${finding.advisory}](${finding.url}) | ${finding.exception ? `${finding.exception.owner}, until ${finding.exception.expires}` : ''} |`;
  const listed = result.findings.filter((finding) => finding.verdict !== 'review');
  const review = result.findings.filter((finding) => finding.verdict === 'review');
  const summary = [
    `### Dependency audit: ${result.ok ? 'passed' : 'failed'}`,
    '',
    `Tools: ${Object.entries(report.tools).map(([tool, version]) => `${tool} \`${version}\``).join(', ')}.`,
    `Lockfiles: ${Object.entries(report.lockfiles).map(([path, digest]) => `\`${path}\` ${digest.slice(0, 19)}…`).join(', ')}.`,
    '',
    ...(listed.length > 0 ? ['| Verdict | Tool | Package | Severity | Advisory | Exception |', '|---|---|---|---|---|---|', ...listed.map(row), ''] : []),
    `${review.length} lower-severity advisories kept for review in the report artifact${result.abandoned.length > 0 ? `; abandoned Composer packages: ${result.abandoned.join(', ')}` : ''}.`,
    ...result.problems.map((problem) => `- ❌ ${problem}`),
    ...result.unused.map((entry) => `- ⚠️ Unused exception ${entry.advisory} for ${entry.package}: remove it.`),
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const finding of result.findings.filter((finding) => finding.verdict === 'blocking')) {
    console.log(`::error title=Dependency audit::${finding.tool} ${finding.package}: ${finding.severity ?? 'unrated'} ${finding.advisory} ${finding.title}`);
  }
  for (const problem of result.problems) console.log(`::error title=Dependency audit::${problem}`);
  for (const entry of result.unused) console.log(`::warning title=Dependency audit::Unused exception ${entry.advisory} for ${entry.package}`);
  process.exit(result.ok ? 0 : 1);
}
