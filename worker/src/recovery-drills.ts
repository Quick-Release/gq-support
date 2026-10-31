/**
 * The recovery drill catalog and its evidence report (#146;
 * docs/runbooks/support-operations.md#drill-and-evidence-checklist).
 *
 * Each drill has a synthetic local rehearsal: named integration tests that run
 * the real Worker HTTP, scheduled and Operator entries over local D1 with fake
 * GitHub/Discord and a controlled clock. Passing them is local evidence only.
 * The staging rehearsal of each drill needs real, credentialed inputs that are
 * listed here and never invented; no staging executor exists, so the report
 * always shows staging as not run and is never a human sign-off.
 */
export interface LocalTest { readonly file: string; readonly test: string }
export interface Drill {
  readonly id: string;
  readonly title: string;
  readonly runbook: string;
  readonly local: readonly LocalTest[];
  /** What a credentialed staging rehearsal needs, none of which this repository holds. */
  readonly stagingInputs: readonly string[];
}

const COMMON_STAGING = ["Authorized staging fault-injection window and named human Operator",
  "Staging account, SupportDB and SupportLedger IDs with Operator credentials", "Reviewed staging deployment of this commit"];

export const DRILLS: readonly Drill[] = [
  { id: "maintenance_boundary", title: "Maintenance boundary blocks intake, writes, dispatch and unsafe Operator mutations",
    runbook: "#d1-restore-or-corrupting-migration", local: [
      { file: "test/maintenance.test.ts", test: "maintenance closes intake in every isolate at once, including one that just passed the gate" },
      { file: "test/maintenance.test.ts", test: "an unreachable ledger fails closed, even right after a passed check" },
      { file: "test/maintenance.test.ts", test: "concurrent maintenance begins transition once, and every attempt is audited" },
      { file: "test/maintenance.test.ts", test: "a scheduled tick during maintenance dispatches nothing, in any isolate" },
      { file: "test/maintenance.test.ts", test: "unsafe Operator mutations are refused during maintenance and before replay, while protective ones still apply" },
      { file: "test/maintenance.test.ts", test: "an unsafe Operator mutation is refused when the ledger cannot be read" },
      { file: "test/maintenance.test.ts", test: "a forged webhook at the deployed boundary is refused before any D1 access, and a verified one waits out maintenance" },
    ], stagingInputs: [...COMMON_STAGING, "Checker probe run showing maintenance active from outside the Worker"] },
  { id: "provider_outage", title: "GitHub provider outage: bounded retry of known non-creation, unrelated Slots progress",
    runbook: "#github-outage-or-stalled-delivery", local: [
      { file: "test/delivery.test.ts", test: "honours rate feedback across the shared installation then retries confirmed non-creation" },
      { file: "test/delivery.test.ts", test: "retries transient authentication transport failure which cannot have created an issue" },
      { file: "test/independent-check.test.ts", test: "separates a GitHub provider failure, which the healthy service records and announces itself" },
    ], stagingInputs: [...COMMON_STAGING, "Reviewed staging GitHub fault method (none is agreed yet)"] },
  { id: "credential_revocation", title: "Revoked report and update credentials stay revoked, including across restore",
    runbook: "#revoked-app-or-installation-credential", local: [
      { file: "test/ledger.test.ts", test: "runtime key revocations survive a restore" },
      { file: "test/native-updates.test.ts", test: "keeps update access through report disablement and Installation credential revocation, until update access itself is revoked" },
      { file: "test/maintenance.test.ts", test: "a restore is recorded and service resumes only through a drained, replayed and verified maintenance boundary" },
    ], stagingInputs: [...COMMON_STAGING, "Disposable staging installation enrolled for revocation"] },
  { id: "unknown_late_create", title: "Unknown and late GitHub creates are reconciled by marker, never re-posted or force-created",
    runbook: "#d1-restore-or-corrupting-migration", local: [
      { file: "test/delivery.test.ts", test: "reconciles an ambiguous side effect without another POST" },
      { file: "test/delivery.test.ts", test: "never recreates after a complete negative reconciliation or its automatic window" },
      { file: "test/delivery.test.ts", test: "a stale success cannot overwrite state but remains discoverable by reconciliation" },
      { file: "test/maintenance.test.ts", test: "a create in flight across a restore succeeds late without a duplicate, and its stale result is not persisted" },
      { file: "test/maintenance.test.ts", test: "an execution admitted before maintenance cannot authorize its create once maintenance begins" },
    ], stagingInputs: [...COMMON_STAGING, "Staging GitHub App installation and disposable repository"] },
  { id: "d1_restore_suppression_replay", title: "Main D1 restore with suppression ledger replay before resume",
    runbook: "#d1-restore-or-corrupting-migration", local: [
      { file: "test/maintenance.test.ts", test: "a restore is recorded and service resumes only through a drained, replayed and verified maintenance boundary" },
      { file: "test/ledger.test.ts", test: "a recorded restore replays erasures and suspensions and makes restored work uncertain before anything is served" },
      { file: "test/fleet-rollout.test.ts", test: "a restore that makes a withdrawn release current again blocks service until it is withdrawn again" },
      { file: "test/maintenance.test.ts", test: "an Operator resume is refused for a request the ledger suppresses, even when the main copy was lost" },
    ], stagingInputs: [...COMMON_STAGING, "Approved Time Travel restore point (bookmark or timestamp) for staging SupportDB only",
      "Provider restore command reviewed against current Cloudflare D1 documentation"] },
  { id: "poisoned_outbox", title: "Poisoned D1 records are isolated; other Clients progress; no blind outbox replay",
    runbook: "#github-outage-or-stalled-delivery", local: [
      { file: "test/maintenance.test.ts", test: "a poisoned D1 record is isolated on every tick, while another Client's reports are still delivered" },
    ], stagingInputs: [...COMMON_STAGING, "Reviewed method to place a malformed record in staging SupportDB"] },
  { id: "privacy_exposure", title: "Erasure and exposure handling: suppressed, purged, never revived",
    runbook: "#retention-erasure-or-private-data-exposure", local: [
      { file: "test/cleanup.test.ts", test: "erasure before dispatch suppresses the create and completes after purging" },
      { file: "test/cleanup.test.ts", test: "a delayed wake-up, the scheduler and Operator resume cannot revive erased delivery" },
      { file: "test/cleanup.test.ts", test: "restored rows stay suppressed and are purged again" },
      { file: "test/ledger.test.ts", test: "records an erasure in the ledger first, and the ledger alone stops a create" },
    ], stagingInputs: [...COMMON_STAGING, "Synthetic staging Reporter and request with no real personal data"] },
  { id: "independent_outage_evidence", title: "Independently reported outage evidence survives restore and is reopened for review",
    runbook: "#independent-outage-checks", local: [
      { file: "test/maintenance.test.ts", test: "an outage episode the service acknowledged survives a restore of the main database and is reopened for review" },
      { file: "test/maintenance.test.ts", test: "an episode is acknowledged only once the ledger also holds it, and its incident stands when the ledger write fails" },
      { file: "test/maintenance.test.ts", test: "the independent checker's probe observes maintenance without replaying or writing" },
      { file: "test/independent-check.test.ts", test: "keeps one resolvable incident when the runner's state is lost mid-outage or the outage outlasts its retention" },
    ], stagingInputs: [...COMMON_STAGING, "Configured independent checker runner, key and staging Discord destination"] },
];

export interface TestResult { readonly file: string; readonly test: string; readonly status: "passed" | "failed" | "skipped" }

/**
 * The evidence report: each drill's synthetic local result from the named
 * tests (a missing, skipped or failed test fails it), and its staging
 * rehearsal as not run with the real inputs it needs.
 */
export const drillReport = ({ results, commit, generatedAt }: { results: readonly TestResult[]; commit: string; generatedAt: string }) => {
  const drills = DRILLS.map((drill) => {
    const status = (local: LocalTest) => results.find((result) => result.file === local.file && result.test === local.test)?.status;
    const failed = drill.local.filter((local) => status(local) !== undefined && status(local) !== "passed").map(({ test }) => test);
    const missing = drill.local.filter((local) => status(local) === undefined).map(({ test }) => test);
    return { id: drill.id, title: drill.title, runbook: `docs/runbooks/support-operations.md${drill.runbook}`,
      synthetic_local: { state: failed.length === 0 && missing.length === 0 ? "passed" as const : "failed" as const,
        environment: "local-d1-fake-github-controlled-clock", tests: drill.local.map(({ file, test }) => `${file} > ${test}`), failed, missing },
      staging: { state: "not_run" as const, required_inputs: drill.stagingInputs } };
  });
  return { kind: "recovery-drill-evidence", commit, generated_at: generatedAt,
    note: "Synthetic local rehearsal only. Not staging evidence, not production evidence and not a human sign-off.",
    local_passed: drills.every((drill) => drill.synthetic_local.state === "passed"),
    staging_evidence: false, signed_off: false, drills };
};
