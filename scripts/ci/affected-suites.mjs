#!/usr/bin/env node
// Maps a change set to the required suites it affects, for the `Required validation` check in
// .github/workflows/ci.yml. A suite may be skipped only when no changed path triggers it; a path
// no rule classifies runs every suite, so a new directory can never silently bypass validation.
//   git diff --name-only BASE HEAD | node scripts/ci/affected-suites.mjs
//   node scripts/ci/affected-suites.mjs --all    no reliable diff: every suite
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Every required suite, in the order reports list them. */
export const SUITES = ['lint', 'php', 'size', 'wordpress', 'worker'];

// First match wins. Each rule says why its suites are the complete set for those paths.
export const RULES = [
  // Prose, agent instructions and decisions; nothing executes them.
  { pattern: /(^|\/)[^/]+\.md$|^docs\/|^\.agents\/|^\.claude\/|^skills-lock\.json$|^\.gitignore$/, suites: [] },
  // Local-only hooks and operator tools; CI never runs them on a pull request.
  { pattern: /^lefthook\.yml$|^scripts\/(phpcs-staged|pre-push-browser|sync-project-status)\.sh$|^scripts\/github-webhook-staging\.py$/, suites: [] },
  // Workflows that are not part of pull-request validation run and report on their own.
  { pattern: /^\.github\/workflows\/(benchmark|compatibility|deploy-worker|dispatch-registry|github-app-spike|github-webhook-spike|project-status|release-plugin)\.yml$/, suites: [] },
  // Read only by the dependency audit, which runs on every change.
  { pattern: /^\.github\/dependency-audit-exceptions\.json$/, suites: [] },
  // Shared toolchain, the runtime matrix, the secret-scanning upload every job uses and this
  // validation itself reach every consumer.
  { pattern: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.gitleaks\.toml)$|^scripts\/ci\/|^\.github\/actions\/|^\.github\/runtime-matrix\.json$|^\.github\/workflows\/(ci|wordpress-lane)\.yml$/, suites: SUITES },
  // Lint configuration and its negative controls change only what the lint suite reports.
  { pattern: /^eslint\.config\.mjs$|^plugin\/app\/eslint\.config\.cjs$|^scripts\/lint-gate\.test\.mjs$/, suites: ['lint'] },
  // Shared contract fixtures and both signing implementations must agree in both languages.
  { pattern: /^contract\//, suites: ['wordpress', 'worker'] },
  { pattern: /^plugin\/includes\/class-gq-support-sign(er|ing-key)\.php$/, suites: ['php', 'size', 'wordpress', 'worker'] },
  { pattern: /^worker\/src\/signature\.ts$/, suites: ['lint', 'wordpress', 'worker'] },
  { pattern: /^worker\//, suites: ['lint', 'worker'] },
  // Files the release package ships: the size job packs and verifies the installable ZIP.
  { pattern: /^plugin\/(gq-support\.php|uninstall\.php|composer\.json|includes\/.*\.php)$/, suites: ['php', 'size', 'wordpress'] },
  { pattern: /^plugin\/(readme\.txt|languages\/)/, suites: ['size', 'wordpress'] },
  { pattern: /^plugin\/.*\.php$|^plugin\/(composer\.(json|lock)|\.phpcs\.xml\.dist|phpstan\.neon\.dist)$/, suites: ['php', 'wordpress'] },
  { pattern: /^plugin\/(app|assets|tests\/performance)\//, suites: ['lint', 'size', 'wordpress'] },
  { pattern: /^plugin\/tests\/.*\.(?:[cm]?js|ts)$/, suites: ['lint', 'wordpress'] },
  { pattern: /^plugin\/|^\.ddev\//, suites: ['wordpress'] },
];

/**
 * @param {string[]} paths Changed repository paths.
 * @returns {{ suites: string[], reasons: Record<string, string[]>, unclassified: string[] }}
 */
export function affectedSuites(paths) {
  const reasons = {};
  const unclassified = [];
  const trigger = (suite, path) => (reasons[suite] ??= []).push(path);

  for (const path of paths) {
    const rule = RULES.find(({ pattern }) => pattern.test(path));
    if (!rule) unclassified.push(path);
    for (const suite of rule ? rule.suites : SUITES) trigger(suite, path);
  }
  // No changed paths cannot prove that any suite is irrelevant.
  if (paths.length === 0) for (const suite of SUITES) reasons[suite] = [];

  const suites = SUITES.filter((suite) => suite in reasons);
  return { suites, reasons: Object.fromEntries(suites.map((suite) => [suite, reasons[suite]])), unclassified };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const all = process.argv.includes('--all');
  const result = all ? { suites: SUITES, reasons: {}, unclassified: [] } : affectedSuites(readFileSync(0, 'utf8').split('\n').filter(Boolean));
  const lines = SUITES.map((suite) => {
    if (!result.suites.includes(suite)) return `- \`${suite}\`: skipped, no changed path affects it`;
    if (all) return `- \`${suite}\`: runs, this event has no reliable diff`;
    const paths = result.reasons[suite];
    return `- \`${suite}\`: runs, ${paths.length === 0 ? 'the change set is empty' : `triggered by ${paths.slice(0, 5).map((path) => `\`${path}\``).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`}`;
  });
  if (result.unclassified.length > 0) lines.push(`- Unclassified paths run every suite: ${result.unclassified.map((path) => `\`${path}\``).join(', ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Affected suites\n\n${lines.join('\n')}\n`);
  console.error(lines.join('\n'));
  process.stdout.write(`${JSON.stringify(result.suites)}\n`);
}
