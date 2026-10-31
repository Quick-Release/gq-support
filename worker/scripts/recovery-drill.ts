import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { DRILLS, drillReport, type TestResult } from "../src/recovery-drills.ts";

/**
 * Runs the synthetic local recovery drills and prints their evidence report
 * (src/recovery-drills.ts; docs/runbooks/support-operations.md). Local only:
 * `--stage staging` runs nothing, since no staging fault injection is
 * authorized or configured here; it prints the real inputs each staging
 * rehearsal needs and exits 2.
 */
const usage = "Usage: pnpm recovery-drill [--stage local|staging] [--out <report.json>]";
const root = new URL("..", import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), "gq-support-drill-"));
try {
  const { values } = parseArgs({ options: { stage: { type: "string", default: "local" }, out: { type: "string" } } });
  if (values.stage === "staging") {
    console.log(JSON.stringify({ kind: "recovery-drill-evidence", staging_evidence: false, state: "not_run",
      reason: "No staging fault injection, Time Travel restore or live provider change is authorized or configured from this tool.",
      drills: DRILLS.map(({ id, runbook, stagingInputs }) => ({ id, runbook: `docs/runbooks/support-operations.md${runbook}`,
        required_inputs: stagingInputs })) }, null, 2));
    process.exitCode = 2;
  } else if (values.stage !== "local") {
    throw new Error(usage);
  } else {
    const output = join(directory, "results.json");
    const files = [...new Set(DRILLS.flatMap((drill) => drill.local.map(({ file }) => file)))];
    spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...files, "--reporter=json", `--outputFile=${output}`],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 });
    const json = JSON.parse(readFileSync(output, "utf8")) as { testResults: { name: string; assertionResults: { title: string; status: string }[] }[] };
    const results: TestResult[] = json.testResults.flatMap((file) => file.assertionResults.map((assertion) => ({
      file: relative(root, file.name), test: assertion.title,
      status: assertion.status === "passed" ? "passed" as const : assertion.status === "failed" ? "failed" as const : "skipped" as const })));
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "";
    const report = drillReport({ results, commit: `${head}${dirty ? "-dirty" : ""}`, generatedAt: new Date().toISOString() });
    const text = JSON.stringify(report, null, 2);
    if (values.out) writeFileSync(values.out, text + "\n", { mode: 0o600 });
    console.log(text);
    if (!report.local_passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery drill failed");
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
