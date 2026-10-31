import { expect, it } from "vitest";
import { DRILLS, drillReport } from "../src/recovery-drills.ts";

const results = (status: "passed" | "failed") => DRILLS.flatMap((drill) => drill.local.map(({ file, test }) => ({ file, test, status })));
const at = "2026-10-31T12:00:00.000Z";

it("reports synthetic local drills as local evidence only, and staging as not run with its required real inputs", () => {
  const report = drillReport({ results: results("passed"), commit: "abc1234", generatedAt: at });
  expect(report).toMatchObject({ kind: "recovery-drill-evidence", commit: "abc1234", generated_at: at, staging_evidence: false,
    signed_off: false, local_passed: true });
  for (const drill of report.drills) {
    expect(drill.synthetic_local).toMatchObject({ state: "passed", environment: "local-d1-fake-github-controlled-clock" });
    expect(drill.staging.state).toBe("not_run");
    expect(drill.staging.required_inputs.length).toBeGreaterThan(0);
  }
  expect(report.drills.map(({ id }) => id)).toEqual(["maintenance_boundary", "provider_outage", "credential_revocation",
    "unknown_late_create", "d1_restore_suppression_replay", "poisoned_outbox", "privacy_exposure", "independent_outage_evidence"]);
});

it("a failed, missing or skipped local test fails its drill instead of passing it", () => {
  const all = results("passed");
  const [first, second] = [DRILLS[0]!.local[0]!, DRILLS[1]!.local[0]!];
  const report = drillReport({ commit: "abc1234", generatedAt: at, results: all
    .filter(({ test }) => test !== second.test)
    .map((result) => result.test === first.test ? { ...result, status: "failed" as const } : result) });
  expect(report.local_passed).toBe(false);
  expect(report.drills[0]!.synthetic_local).toMatchObject({ state: "failed", failed: [first.test] });
  expect(report.drills[1]!.synthetic_local).toMatchObject({ state: "failed", missing: [second.test] });
  const skipped = drillReport({ commit: "abc1234", generatedAt: at,
    results: all.map((result) => result.test === first.test ? { ...result, status: "skipped" as const } : result) });
  expect(skipped.drills[0]!.synthetic_local.state).toBe("failed");
});
