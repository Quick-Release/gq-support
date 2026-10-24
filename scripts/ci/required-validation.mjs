#!/usr/bin/env node
// The verdict of the one required pull-request check, `Required validation` in
// .github/workflows/ci.yml. That job runs with `if: always()` and passes only when every
// dependency succeeded or was skipped because the change does not affect its suite.
//   NEEDS='${{ toJSON(needs) }}' JOBS='{"job":"suite"|"always"}' AFFECTED='["php"]' [TITLE=…] node scripts/ci/required-validation.mjs
// compatibility.yml reuses it for `Compatibility result`, with release tiers in place of suites.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {object} input
 * @param {Record<string, { result: string }>} input.needs The workflow's `needs` context.
 * @param {Record<string, string>} input.jobs Each dependency's suite, or `always` when it may never skip.
 * @param {string[] | undefined} input.affected Suites the plan found affected; anything else means no valid plan.
 * @returns {{ ok: boolean, rows: { job: string, suite: string, result: string, ok: boolean, reason: string }[] }}
 */
export function evaluate({ needs, jobs, affected }) {
  const planned = Array.isArray(affected) ? new Set(affected) : null;
  const rows = [];

  for (const [job, suite] of Object.entries(jobs)) {
    const result = needs[job]?.result ?? 'missing';
    rows.push({ job, suite, result, ...judge(result, suite, planned) });
  }
  for (const [job, { result }] of Object.entries(needs)) {
    if (!(job in jobs)) rows.push({ job, suite: '—', result, ok: false, reason: 'not classified as `always` or a suite in JOBS' });
  }

  return { ok: rows.every((row) => row.ok), rows };
}

function judge(result, suite, planned) {
  switch (result) {
    case 'success':
      return { ok: true, reason: 'passed' };
    case 'skipped':
      if (suite === 'always') return { ok: false, reason: 'skipped although it must always run' };
      if (!planned) return { ok: false, reason: 'skipped without a valid plan of affected suites' };
      if (planned.has(suite)) return { ok: false, reason: `skipped although the change affects \`${suite}\`` };
      return { ok: true, reason: `skipped: the change does not affect \`${suite}\`` };
    case 'missing':
      return { ok: false, reason: 'not listed in `needs`' };
    default:
      return { ok: false, reason: result };
  }
}

function parse(name, fallback) {
  try {
    return JSON.parse(process.env[name] ?? '');
  } catch {
    return fallback;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { ok, rows } = evaluate({ needs: parse('NEEDS', {}), jobs: parse('JOBS', {}), affected: parse('AFFECTED', undefined) });
  const table = ['| Job | Suite | Result | Verdict |', '|---|---|---|---|', ...rows.map((row) => `| ${row.job} | ${row.suite} | ${row.result} | ${row.ok ? '✅' : '❌'} ${row.reason} |`)].join('\n');
  console.log(table);
  const title = process.env.TITLE ?? 'Required validation';
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${table}\n`);
  for (const row of rows.filter((row) => !row.ok)) console.error(`::error title=${title}::${row.job}: ${row.reason}`);
  process.exit(ok ? 0 : 1);
}
