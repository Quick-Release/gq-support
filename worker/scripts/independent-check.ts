// The independent checker's runner entry (src/independent-checker.ts), for the
// `Independent service check` workflow: reads the previous run's state file,
// checks once and writes the next state and a sanitized summary, which the
// workflow keeps as its artifact. Neither file nor any output holds a URL,
// credential, response body or request data.
//   node scripts/independent-check.ts --state <previous-state.json> --out <directory>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runIndependentCheck } from "../src/independent-checker.ts";

try {
  const { values } = parseArgs({ options: { state: { type: "string" }, out: { type: "string" } } });
  if (!values.out) throw new Error("Usage: node scripts/independent-check.ts --state <file> --out <directory>");
  let previous: unknown = null;
  if (values.state && existsSync(values.state)) {
    try { previous = JSON.parse(readFileSync(values.state, "utf8")); } catch { previous = "unreadable"; }
  }
  const { state, summary, exitCode } = await runIndependentCheck({ env: process.env, state: previous });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "state.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(values.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  const lines = [
    `### Independent service check (${summary.stage ?? "unconfigured"}) at ${summary.observed_at}`, "",
    "| Component | State | Code |", "|---|---|---|",
    ...summary.components.map(({ component, state, code }) => `| ${component} | ${state} | ${code} |`), "",
    `Reconciliation: ${summary.reconciliation}`,
    ...summary.episodes.map((episode) => `- Episode ${episode.id}: ${episode.component} ${episode.code}, ${episode.first_failed_at} to ` +
      `${episode.recovered_at ?? "ongoing"}; incident ${episode.incident_id ?? "not reconciled"}; notice ${episode.notice}`),
    ...summary.expired.map((id) => `- Expired unreconciled episode ${id}: follow up from this run's evidence`),
    ...summary.problems.map((problem) => `- Problem: ${problem}`),
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith("Usage") ? error.message : "Independent check failed");
  process.exitCode = 1;
}
