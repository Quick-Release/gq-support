import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pins from "../deploy/protected-resources.json" with { type: "json" };
import { stageCentralTargets } from "../src/central-deployment.ts";
import { stageInventories, type StageInventory } from "../src/inventory.ts";
import { evidenceDigest, REQUIRED_DRILLS, runReadiness, SIGN_OFF_REVIEWERS, MEASURED_SIGNALS, type ReadinessConfig, type ReadinessIO,
  type ReadinessReads, type RunListing } from "../src/readiness.ts";
import { stageReleaseEnforcement } from "../src/release-policy.ts";
import type { WorkflowRun } from "../src/release-gates.ts";
import { stageMappings } from "../src/repository-mappings.ts";
import { githubReadiness } from "../scripts/release-evidence.ts";

// #148: the production readiness check, driven through its command entry (`pnpm readiness`).
// Every fixture here is synthetic: the reviewer, Slot, runs, digests and dates are invented
// for the test and are not evidence of any real stage, Client or person.
const COMMIT = "c".repeat(40), RELEASE_COMMIT = "a".repeat(40), TIPME = "8f38791a8c37b182239af2a385ab3c31";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const REF = "https://github.com/Quick-Release/gq-support/actions/runs/900";
const REVIEWER = "synthetic-reviewer";
const SECRET = "sentinel-secret-never-reported";
const ROUTE = "synthetic contact route text";

const migrations = { SupportDB: readdirSync(new URL("../migrations/", import.meta.url).pathname).filter((name) => name.endsWith(".sql")).sort(),
  SupportLedger: readdirSync(new URL("../ledger-migrations/", import.meta.url).pathname).filter((name) => name.endsWith(".sql")).sort() };

/** This checkout's real reviewed configuration for prod. */
const repositoryConfig: ReadinessConfig = { enforcement: stageReleaseEnforcement.prod, pins: (pins as Record<string, ReadinessConfig["pins"]>).prod,
  mappings: stageMappings.prod, centralTargets: stageCentralTargets.prod, inventory: stageInventories.prod, reviewers: SIGN_OFF_REVIEWERS, migrations };

const PINS = { SupportDB: { databaseId: "00000000-0000-4000-8000-000000000001" }, SupportLedger: { databaseId: "00000000-0000-4000-8000-000000000002" },
  Worker: { workerName: "synthetic-worker-prod" } };
const custody: StageInventory = { ...stageInventories.prod, credentials: stageInventories.prod.credentials.map((credential) => ({ ...credential,
  owner: "synthetic-owner", expires: "2027-06-30", rotated: { at: "2026-10-01", evidence: REF } })) };
/** A synthetic configuration where every repository gate holds. */
const readyConfig: ReadinessConfig = { enforcement: "enforced", pins: PINS, centralTargets: [], inventory: custody, reviewers: [REVIEWER], migrations,
  mappings: [{ slot: "synthetic-client/prod", client: "synthetic-client", project: "synthetic", environment: "prod", repositoryId: 1,
    githubInstallationId: 2, defaultDeveloper: "synthetic", deployment: "native", responsibleTeam: "synthetic-team" }] };

const applied = (hoursAgo: number) => [...migrations.SupportDB.map((name) => ({ database: "SupportDB", name, applied_at: at(hoursAgo) })),
  ...migrations.SupportLedger.map((name) => ({ database: "SupportLedger", name, applied_at: at(hoursAgo) }))];
const drill = { observed_at: at(48), environment: "staging", commit: COMMIT, operator: "synthetic-operator", incident: null, result: "passed", reference: REF };

/** A complete, fresh synthetic evidence file for COMMIT; the sign-off is added by `signed`. */
const evidence = (): Record<string, unknown> => ({
  schema: "gq-support.readiness-evidence/v1", stage: "prod", account_id: TIPME, commit: COMMIT, captured_at: at(2), captured_by: "synthetic-operator",
  release: { observed_at: at(30), release_run: "101", release_commit: RELEASE_COMMIT, ci_run: "102", staging_run: "103", package_version: "0.2.0",
    package_sha256: "d".repeat(64), signing: "signed", approved_release_id: 2, reference: REF },
  production: { observed_at: at(20), deploy_run: "104", migrations: applied(26), reference: REF },
  staging: { observed_at: at(40), deploy_run: "103", migrations: applied(50), reference: REF,
    fleet: { release_id: 2, version: "0.2.0", converged: true, verified: 1, not_verified: 0 } },
  validation: { observed_at: at(30), ci_run: "105" },
  access: { observed_at: at(10), environment: "prod", staff_roster: 3, dashboard_keys: 1, operator_holders: 2, operator_separate_from_staff: true,
    claim_audit_incident: "00000000-0000-4000-8000-0000000000aa", reference: REF },
  notifications: { observed_at: at(10), environment: "prod", configured: ["support_requests", "operational_incidents"], reference: REF },
  monitor: { observed_at: at(3), run: "106", reference: REF },
  retention: { observed_at: at(10), environment: "prod", workers_logs_retention_days: 7, logs_access: "restricted", reference: "https://dash.cloudflare.com/synthetic" },
  thresholds: { observed_at: at(5), environment: "staging", window_from: at(24 * 9), window_to: at(5), reference: REF,
    signals: MEASURED_SIGNALS.map((signal) => ({ signal, threshold: 15, unit: "minutes", basis: REF })) },
  slots: [{ slot: "synthetic-client/prod", observed_at: at(10), contact_method: "separate-device-drill", contact_verified_at: at(24),
    contact_evidence: `sha256:${"e".repeat(64)}`, update_access: "granted", reference: REF }],
  drills: Object.fromEntries(REQUIRED_DRILLS.map((id) => [id, drill])),
  banquinha: { observed_at: at(20), repository: "Quick-Release/banquinha", commit: "b".repeat(40), ci_reference: "https://github.com/Quick-Release/banquinha/actions/runs/1",
    signed_in_e2e_reference: "https://github.com/Quick-Release/banquinha/actions/runs/2",
    live_smoke: { environment: "staging", observed_at: at(20), reference: "https://github.com/Quick-Release/banquinha/actions/runs/3" } },
});
const signed = async (file: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  ({ ...file, sign_off: { reviewer: REVIEWER, signed_at: at(1), comment: "777", evidence_digest: await evidenceDigest(file), ...overrides } });
const drillReport = (overrides: Record<string, unknown> = {}) => JSON.stringify({ kind: "recovery-drill-evidence", commit: COMMIT,
  generated_at: at(1), local_passed: true, staging_evidence: false, signed_off: false, drills: [], ...overrides });

const run = (id: number, path: string, commit: string, jobs: string[], extra: Partial<WorkflowRun> = {}): WorkflowRun => ({ id, path,
  repository: "Quick-Release/gq-support", head_sha: commit, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  html_url: `https://github.com/Quick-Release/gq-support/actions/runs/${id}`, jobs: jobs.map((name) => ({ name, conclusion: "success" })), ...extra });
const DEPLOY = ".github/workflows/deploy-worker.yml";
const CI_JOBS = ["Secret scan", "Dependency audit", "PHPCS + PHPStan", "Worker typecheck + tests", "Required validation", "Asset size gate"];

/** GitHub's records for the synthetic evidence, as a controlled provider; `change` edits them per test. */
const github = (change: { runs?: Record<string, Partial<WorkflowRun> | null>; plan?: Record<string, unknown>; deployments?: RunListing[];
  checks?: RunListing[]; issue?: { state: string; state_reason: string | null }; comment?: Record<string, unknown> | null } = {}) => {
  const digestOf = async () => (await evidenceDigest(evidence()));
  const runs: Record<string, WorkflowRun> = {
    101: run(101, ".github/workflows/release-plugin.yml", RELEASE_COMMIT, ["Build the release candidate", "Installed package (native)", "Pre-release compatibility"],
      { event: "workflow_dispatch" }),
    102: run(102, ".github/workflows/ci.yml", RELEASE_COMMIT, CI_JOBS),
    103: run(103, DEPLOY, COMMIT, ["plan", "deploy"], { event: "workflow_dispatch" }),
    104: run(104, DEPLOY, COMMIT, ["plan", "deploy"], { event: "workflow_dispatch" }),
    105: run(105, ".github/workflows/ci.yml", COMMIT, CI_JOBS),
    106: run(106, ".github/workflows/independent-check.yml", "f".repeat(40), ["Plan stages", "Check prod"], { event: "schedule" }),
  };
  const artifacts = (id: string, stage: string) => ({
    plan: { schema: "gq-support.deploy-plan/v1", verdict: "safe", stage, commit: COMMIT, digest: "9".repeat(64),
      resources: stage === "prod" ? Object.entries(PINS).map(([fqn, identity]) => ({ fqn, identity })) : [], ...(stage === "prod" ? change.plan : {}) },
    applied: { schema: "gq-support.deploy-applied/v1", outcome: "applied", stage, commit: COMMIT, planDigest: "9".repeat(64),
      appliedAt: id === "104" ? at(24) : at(48), provenance: { runId: id } },
  });
  const reads: ReadinessReads = {
    async run(id) {
      if (change.runs && id in change.runs) return change.runs[id] === null ? null : { ...runs[id]!, ...change.runs[id] };
      return runs[id] ?? null;
    },
    async artifact(id, prefix, file) {
      const stage = id === "104" ? "prod" : id === "103" ? "staging" : null;
      if (!stage || !prefix.startsWith(`deploy-plan-${stage}-${id}-`)) return null;
      return file === "plan.json" ? artifacts(id, stage).plan : file === "applied.json" ? artifacts(id, stage).applied : null;
    },
    async runs(workflow) {
      if (workflow === DEPLOY) return change.deployments ?? [
        { id: 103, name: "Deploy Support Worker (staging, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(48) },
        { id: 104, name: "Deploy Support Worker (prod, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(24) },
        { id: 99, name: "Deploy Support Worker (prod, plan) ", event: "workflow_dispatch", conclusion: "success", created_at: at(23) }];
      return change.checks ?? [{ id: 106, name: "Independent service check", event: "schedule", conclusion: "success", created_at: at(3) },
        { id: 107, name: "Independent service check", event: "schedule", conclusion: "success", created_at: at(0.1) }];
    },
    async issue() { return change.issue ?? { state: "closed", state_reason: "completed" }; },
    async comment(id) {
      if (id !== "777" || change.comment === null) return null;
      return { repository: "Quick-Release/gq-support", author: REVIEWER, author_type: "User", via_app: false,
        body: `Signed off: ${await digestOf()}`, created_at: at(1), ...change.comment };
    },
  };
  return reads;
};

/** Runs `pnpm readiness` with these files; returns the exit code and parsed report. */
const check = async ({ config = readyConfig, file, drills = drillReport(), trusted = true, reads = github(), dirty = false, now = NOW, args = [] as string[] }:
  { config?: ReadinessConfig; file?: Record<string, unknown> | string; drills?: string; trusted?: boolean; reads?: ReadinessReads; dirty?: boolean;
    now?: number; args?: string[] } = {}) => {
  const files: Record<string, string> = { "drills.json": drills };
  if (file !== undefined) files["evidence.json"] = typeof file === "string" ? file : JSON.stringify(file);
  const lines: string[] = [];
  let trustedCalls = 0;
  const io: ReadinessIO = { config, checkout: { commit: COMMIT, dirty }, now: () => new Date(now), readFile: (path) => files[path],
    writeFile: (path, text) => { files[path] = text; }, log: (line) => lines.push(line), trusted: () => { trustedCalls++; return reads; } };
  const code = await runReadiness(["--stage", "prod", ...(file !== undefined ? ["--evidence", "evidence.json"] : []), "--drill-report", "drills.json",
    ...(trusted ? ["--trusted"] : []), ...args], io);
  const output = lines.join("\n");
  const report = code === 1 ? null : JSON.parse(output) as { verdict: string; mode: string; authoritative: boolean; evidence_digest: string | null;
    local_tests: { state: string }; gates: { id: string; state: string; authority: string[]; blockers: { code: string; action: string }[] }[];
    review_risks: { code: string; open: boolean }[] };
  const gate = (id: string) => report!.gates.find((entry) => entry.id === id)!;
  const codes = (id: string) => gate(id).blockers.map(({ code }) => code);
  return { code, report: report!, output, gate, codes, files, trustedCalls };
};

describe("production readiness", () => {
  it("the current repository state is not ready, naming every real blocker with its action", async () => {
    const { code, report, codes, gate, trustedCalls } = await check({ config: repositoryConfig, trusted: false, drills: drillReport() });
    expect(code).toBe(2);
    expect(trustedCalls).toBe(0);
    expect(report).toMatchObject({ verdict: "not_ready", mode: "offline", authoritative: false, evidence_digest: null });
    expect(report.gates.every((entry) => entry.state !== "passed")).toBe(true);
    expect(codes("evidence")).toEqual(["evidence_missing"]);
    expect(codes("release_enforcement")).toEqual(["release_enforcement_staged"]);
    expect(codes("production_deployment")).toEqual(["deployment_missing"]);
    expect(codes("slots")).toEqual(["no_prod_slots"]);
    expect(codes("sign_off")).toEqual(["no_reviewed_sign_off_reviewers", "sign_off_missing"]);
    expect(codes("access_audit")).toEqual(["access_missing"]);
    expect(codes("lifecycle_gate")).toEqual(["trusted_read_required"]);
    expect(gate("lifecycle_gate").state).toBe("unverified");
    expect(codes("custody")).toEqual(expect.arrayContaining(["custody_owner_missing:github-app-private-key",
      "custody_expiry_unknown:discord-operational-incidents-webhook", "custody_rotation_unrecorded:update-package-read-token"]));
    for (const entry of report.gates) for (const blocker of entry.blockers) expect(blocker.action).not.toBe("See the runbook.");
    expect(report.review_risks.every((risk) => risk.open)).toBe(true);
  });

  it("is ready only from fresh, complete, pinned evidence verified against GitHub's records and signed off by a named human", async () => {
    const { code, report } = await check({ file: await signed(evidence()) });
    expect(report.gates.filter((entry) => entry.state !== "passed")).toEqual([]);
    expect(report).toMatchObject({ verdict: "ready", mode: "trusted", authoritative: true, local_tests: { state: "passed" } });
    expect(report.review_risks.every((risk) => !risk.open)).toBe(true);
    expect(code).toBe(0);
  });

  it("offline, the same evidence is never ready: GitHub-backed gates stay unverified", async () => {
    const { code, report, gate } = await check({ file: await signed(evidence()), trusted: false });
    expect(code).toBe(2);
    expect(report).toMatchObject({ verdict: "not_ready", mode: "offline", authoritative: false });
    for (const id of ["release_provenance", "production_deployment", "staging_deployment", "ci_validation", "lifecycle_gate", "independent_monitor", "sign_off"]) {
      expect(gate(id)).toMatchObject({ state: "unverified", blockers: [{ code: "trusted_read_required" }] });
    }
    expect(gate("access_audit").state).toBe("passed");
  });

  it.each([
    ["release", "release_provenance", "release_missing"], ["production", "production_deployment", "deployment_missing"],
    ["staging", "staging_deployment", "deployment_missing"], ["validation", "ci_validation", "validation_missing"],
    ["access", "access_audit", "access_missing"], ["notifications", "notifications", "notifications_missing"],
    ["monitor", "independent_monitor", "monitor_missing"], ["retention", "retention_logs", "retention_missing"],
    ["thresholds", "thresholds", "thresholds_missing"], ["slots", "slots", "contact_unverified"], ["drills", "recovery_drills", "staging_drill_missing"],
    ["banquinha", "banquinha_consumer", "banquinha_missing"],
  ])("blocks when the %s evidence is missing", async (key, id, blocker) => {
    const file = evidence();
    delete file[key];
    const { code, report, codes } = await check({ file: await signed(file) });
    expect(code).toBe(2);
    expect(report.verdict).toBe("not_ready");
    expect(codes(id)).toContain(blocker);
  });

  it("blocks without a sign-off, and on each missing repository gate", async () => {
    expect((await check({ file: evidence() })).codes("sign_off")).toEqual(["sign_off_missing"]);
    const file = await signed(evidence());
    const blocked = async (config: Partial<ReadinessConfig>) => check({ file, config: { ...readyConfig, ...config } });
    expect((await blocked({ enforcement: "staged" })).codes("release_enforcement")).toEqual(["release_enforcement_staged"]);
    expect((await blocked({ pins: undefined })).codes("production_deployment")).toEqual(["prod_pins_missing"]);
    expect((await blocked({ mappings: [] })).codes("slots")).toEqual(["no_prod_slots"]);
    expect((await blocked({ reviewers: [] })).codes("sign_off")).toEqual(["no_reviewed_sign_off_reviewers"]);
    expect((await blocked({ inventory: stageInventories.prod })).codes("custody")).toContain("custody_owner_missing:github-app-private-key");
    const central = await blocked({ mappings: [{ ...readyConfig.mappings[0]!, deployment: "central" }],
      centralTargets: [{ slot: "synthetic-client/prod", runner: [], wp: ["wp"], pluginDirectory: "/x/gq-support", uploadDirectory: "/x", source: "composer" }] });
    expect(central.codes("slots")).toEqual(["central_composer_unreviewed:synthetic-client/prod"]);
    expect((await blocked({ mappings: [{ ...readyConfig.mappings[0]!, deployment: "central" }] })).codes("slots"))
      .toEqual(["central_target_missing:synthetic-client/prod"]);
    expect((await blocked({ mappings: [{ ...readyConfig.mappings[0]!, deployment: undefined, responsibleTeam: undefined }] })).codes("slots"))
      .toEqual(["responsible_team_unset:synthetic-client/prod", "deployment_method_unset:synthetic-client/prod"]);
    const lifecycle = await check({ file, reads: github({ issue: { state: "open", state_reason: null } }) });
    expect(lifecycle.codes("lifecycle_gate")).toEqual(["lifecycle_gate_open"]);
  });

  it("refuses evidence for another stage, account or commit, or from a dirty checkout, and ignores its sections", async () => {
    for (const [change, blocker] of [[{ stage: "staging" }, "wrong_stage"], [{ account_id: "0".repeat(32) }, "wrong_account"],
      [{ commit: "e".repeat(40) }, "wrong_commit"]] as const) {
      const { report, codes } = await check({ file: await signed({ ...evidence(), ...change }) });
      expect(codes("evidence")).toEqual([blocker]);
      expect(codes("access_audit")).toEqual(["evidence_missing"]);
      expect(report.verdict).toBe("not_ready");
    }
    expect((await check({ file: await signed(evidence()), dirty: true })).codes("evidence")).toEqual(["checkout_dirty"]);
  });

  it("refuses runs at the wrong commit or stage, an unsafe plan, mismatched pins and a superseded deployment", async () => {
    const file = await signed(evidence());
    const wrongCommit = await check({ file, reads: github({ runs: { 104: { head_sha: "e".repeat(40) } } }) });
    expect(wrongCommit.codes("production_deployment")).toEqual(["deployment_unverified"]);
    const ci = await check({ file, reads: github({ runs: { 105: { jobs: [{ name: "Worker typecheck + tests", conclusion: "failure" }] } } }) });
    expect(ci.codes("ci_validation")).toEqual(["validation_failed"]);
    const release = await check({ file, reads: github({ runs: { 103: { conclusion: "failure" } } }) });
    expect(release.codes("release_provenance")).toEqual(["release_gate_failed:staging"]);
    expect(release.codes("staging_deployment")).toEqual(["deployment_unverified"]);
    const stagingAsProd = await check({ file: await signed({ ...evidence(), production: { ...(evidence().production as object), deploy_run: "103" } }) });
    expect(stagingAsProd.codes("production_deployment")).toEqual(["deployment_unverified"]);
    const pinsDiffer = await check({ file, reads: github({ plan: { resources: [{ fqn: "SupportDB", identity: { databaseId: "00000000-0000-4000-8000-0000000000ff" } }] } }) });
    expect(pinsDiffer.codes("production_deployment")).toEqual(["plan_identity_mismatch"]);
    const superseded = await check({ file, reads: github({ deployments: [
      { id: 104, name: "Deploy Support Worker (prod, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(24) },
      { id: 108, name: "Deploy Support Worker (prod, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(4) },
      { id: 103, name: "Deploy Support Worker (staging, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(48) }] }) });
    expect(superseded.codes("production_deployment")).toEqual(["not_latest_deployment"]);
    const late = evidence();
    (late.production as { migrations: { name: string; applied_at: string }[] }).migrations.find((row) => row.name === "0004_offboarding.sql")!.applied_at = at(22);
    expect((await check({ file: await signed(late) })).codes("production_deployment")).toEqual(["migration_after_code:SupportLedger/0004_offboarding.sql"]);
    const missing = evidence();
    (missing.staging as { migrations: unknown[] }).migrations = applied(50).filter((row) => row.name !== "0031_offboarding_retention.sql");
    expect((await check({ file: await signed(missing) })).codes("staging_deployment")).toEqual(["migration_missing:SupportDB/0031_offboarding_retention.sql"]);
    const unconverged = evidence();
    (unconverged.staging as { fleet: Record<string, unknown> }).fleet = { release_id: 2, version: "0.2.0", converged: true, verified: 1, not_verified: 2 };
    expect((await check({ file: await signed(unconverged) })).codes("staging_deployment")).toEqual(["staging_fleet_not_converged"]);
    const legacy = await check({ file: await signed({ ...evidence(), release: { ...(evidence().release as object), signing: "unsigned-legacy" } }) });
    expect(legacy.codes("release_provenance")).toEqual(["legacy_unsigned_package"]);
    const monitor = await check({ file, reads: github({ checks: [{ id: 106, name: "Independent service check", event: "schedule", conclusion: "success", created_at: at(3) }] }) });
    expect(monitor.codes("independent_monitor")).toEqual(["monitor_not_current"]);
  });

  it("refuses a typed ready boolean, local results presented as live evidence and an edited drill report", async () => {
    const forged = await check({ file: { ...(await signed(evidence())), ready: true } });
    expect(forged.codes("evidence")).toEqual(["evidence_malformed"]);
    expect(forged.report.verdict).toBe("not_ready");
    const gateBoolean = await check({ file: await signed({ ...evidence(), access: { ...(evidence().access as object), passed: true } }) });
    expect(gateBoolean.codes("access_audit")).toEqual(["evidence_malformed"]);
    const drills = evidence();
    (drills.drills as Record<string, unknown>).d1_restore_suppression_replay = { ...drill, environment: "local" };
    expect((await check({ file: await signed(drills) })).codes("recovery_drills")).toEqual(["local_evidence_not_live:d1_restore_suppression_replay"]);
    const asDrill = evidence();
    (asDrill.drills as Record<string, unknown>).provider_outage = { kind: "recovery-drill-evidence", local_passed: true };
    expect((await check({ file: await signed(asDrill) })).codes("recovery_drills")).toEqual(["evidence_malformed"]);
    const smoke = evidence();
    (smoke.banquinha as { live_smoke: Record<string, unknown> }).live_smoke.environment = "local";
    expect((await check({ file: await signed(smoke) })).codes("banquinha_consumer")).toEqual(["local_evidence_not_live"]);
    const file = await signed(evidence());
    expect((await check({ file, drills: drillReport({ staging_evidence: true }) })).codes("recovery_drills")).toEqual(["drill_report_forged"]);
    expect((await check({ file, drills: drillReport({ local_passed: false }) })).codes("recovery_drills")).toEqual(["local_drills_failed"]);
    expect((await check({ file, drills: drillReport({ commit: `${COMMIT}-dirty` }) })).codes("recovery_drills")).toEqual(["local_drill_report_other_commit"]);
    const noLocal = await check({ file, drills: "not json" });
    expect(noLocal.codes("recovery_drills")).toEqual(["local_drill_report_missing"]);
    const otherCommit = evidence();
    (otherCommit.drills as Record<string, unknown>).offboarding = { ...drill, commit: "e".repeat(40) };
    expect((await check({ file: await signed(otherCommit) })).codes("recovery_drills")).toEqual(["wrong_commit:offboarding"]);
    const attested = evidence();
    (attested.slots as Record<string, unknown>[])[0]!.contact_method = "attestation";
    expect((await check({ file: await signed(attested) })).codes("slots")).toEqual(["contact_unverified:synthetic-client/prod"]);
  });

  it("blocks stale evidence on every gate it ages", async () => {
    const later = NOW + 95 * 86_400_000;
    const { codes, report } = await check({ file: await signed(evidence()), now: later,
      reads: github({ checks: [{ id: 106, name: "Independent service check", event: "schedule", conclusion: "success", created_at: new Date(later).toISOString() }] }) });
    expect(report.verdict).toBe("not_ready");
    expect(codes("evidence")).toEqual(["stale"]);
    const fresh = evidence();
    fresh.captured_at = at(1);
    (fresh.thresholds as Record<string, unknown>).window_from = at(24 * 3);
    (fresh.slots as Record<string, unknown>[])[0]!.contact_verified_at = at(24 * 91);
    (fresh.monitor as Record<string, unknown>).observed_at = at(30);
    const stale = await check({ file: await signed(fresh, { signed_at: at(0.5) }) });
    expect(stale.codes("thresholds")).toEqual(["measurement_window_too_short"]);
    expect(stale.codes("slots")).toEqual(["stale:synthetic-client/prod"]);
    expect(stale.codes("independent_monitor")).toEqual(["stale"]);
    const future = evidence();
    (future.access as Record<string, unknown>).observed_at = at(-2);
    expect((await check({ file: await signed(future, { signed_at: at(-3) }) })).codes("access_audit")).toEqual(["evidence_from_future"]);
  });

  it("counts only a named reviewer's own human GitHub comment of the current evidence digest", async () => {
    const file = evidence();
    expect((await check({ file: await signed(file, { reviewer: "someone-else" }) })).codes("sign_off")).toContain("reviewer_not_authorized");
    const edited = { ...(await signed(file)), access: { ...(file.access as object), staff_roster: 4 } };
    expect((await check({ file: edited })).codes("sign_off")).toContain("sign_off_digest_mismatch");
    const early = await signed(file, { signed_at: at(3) });
    expect((await check({ file: early, reads: github({ comment: { created_at: at(3) } }) })).codes("sign_off")).toEqual(["sign_off_before_evidence"]);
    const ready = await signed(file);
    expect((await check({ file: ready, reads: github({ comment: null }) })).codes("sign_off")).toEqual(["sign_off_comment_missing"]);
    expect((await check({ file: ready, reads: github({ comment: { repository: "Quick-Release/other" } }) })).codes("sign_off")).toEqual(["sign_off_comment_missing"]);
    expect((await check({ file: ready, reads: github({ comment: { author: "agent-login" } }) })).codes("sign_off")).toEqual(["sign_off_author_mismatch"]);
    expect((await check({ file: ready, reads: github({ comment: { author_type: "Bot" } }) })).codes("sign_off")).toEqual(["sign_off_not_human"]);
    expect((await check({ file: ready, reads: github({ comment: { via_app: true } }) })).codes("sign_off")).toEqual(["sign_off_not_human"]);
    expect((await check({ file: ready, reads: github({ comment: { body: "LGTM" } }) })).codes("sign_off")).toEqual(["sign_off_digest_absent"]);
    expect((await check({ file: ready, reads: github({ comment: { created_at: at(0.5) } }) })).codes("sign_off")).toEqual(["sign_off_time_mismatch"]);
  });

  it("refuses unverifiable references and secret-like values without reporting them", async () => {
    const local = evidence();
    (local.retention as Record<string, unknown>).reference = "file:///tmp/screenshot.png";
    expect((await check({ file: await signed(local) })).codes("retention_logs")).toEqual(["evidence_malformed"]);
    const query = evidence();
    (query.access as Record<string, unknown>).reference = `${REF}?token=${SECRET}`;
    const queried = await check({ file: await signed(query) });
    expect(queried.codes("access_audit")).toEqual(["evidence_malformed"]);
    expect(queried.output).not.toContain(SECRET);
    for (const value of [`ghp_${"A".repeat(36)}`, "https://discord.com/api/webhooks/1/synthetic", "responder@example.com"]) {
      const leaked = evidence();
      (leaked.slots as Record<string, unknown>[])[0]!.contact_evidence = value;
      const { codes, output } = await check({ file: JSON.stringify(leaked) });
      expect(codes("evidence")).toEqual(["secret_like_value"]);
      expect(output).not.toContain(value);
    }
    const contact = evidence();
    (contact.slots as Record<string, unknown>[])[0]!.route = ROUTE;
    const routed = await check({ file: await signed(contact) });
    expect(routed.codes("slots")).toEqual(["evidence_malformed"]);
    expect(routed.output).not.toContain(ROUTE);
    expect((await check({ file: "{not json" })).codes("evidence")).toEqual(["evidence_malformed"]);
  });

  it("writes the report it prints, and refuses other stages, unknown flags and unreadable files", async () => {
    const { files, output } = await check({ file: await signed(evidence()), args: ["--out", "report.json"] });
    expect(files["report.json"]).toBe(`${output}\n`);
    const lines: string[] = [];
    const io = { config: readyConfig, checkout: { commit: COMMIT, dirty: false }, now: () => new Date(NOW), readFile: () => undefined,
      writeFile: () => {}, log: (line: string) => lines.push(line), trusted: () => github() } satisfies ReadinessIO;
    expect(await runReadiness(["--stage", "staging"], io)).toBe(1);
    expect(await runReadiness(["--stage", "prod", "--ready"], io)).toBe(1);
    expect(await runReadiness(["--stage", "prod", "--evidence", "absent.json"], io)).toBe(1);
    expect(lines.join("\n")).toContain("Cannot read");
  });
});

it("the gh adapter only reads: listed runs, the issue and the comment author, never writing to GitHub", async () => {
  const calls: (readonly string[])[] = [];
  const reads = githubReadiness((args) => {
    calls.push(args);
    const path = args[1] ?? "";
    if (path.startsWith("repos/Quick-Release/gq-support/actions/workflows/deploy-worker.yml/runs?")) {
      return JSON.stringify({ workflow_runs: [{ id: 5, display_title: "Deploy Support Worker (prod, deploy) ", event: "workflow_dispatch",
        conclusion: "success", created_at: at(1), actor: { login: "someone" } }] });
    }
    if (path === "repos/Quick-Release/gq-support/issues/29") return JSON.stringify({ state: "open", state_reason: null, body: "untrusted" });
    if (path === "repos/Quick-Release/gq-support/issues/comments/777") {
      return JSON.stringify({ user: { login: REVIEWER, type: "User" }, body: "digest", created_at: at(1), performed_via_github_app: { slug: "an-app" } });
    }
    return null;
  });
  expect(await reads.runs(DEPLOY)).toEqual([{ id: 5, name: "Deploy Support Worker (prod, deploy) ", event: "workflow_dispatch", conclusion: "success", created_at: at(1) }]);
  expect(await reads.runs("../../etc")).toBeNull();
  expect(await reads.issue(29)).toEqual({ state: "open", state_reason: null });
  expect(await reads.comment("777")).toEqual({ repository: "Quick-Release/gq-support", author: REVIEWER, author_type: "User", via_app: true,
    body: "digest", created_at: at(1) });
  expect(await reads.comment("1;rm")).toBeNull();
  expect(calls.every((args) => args[0] === "api" && args.length === 2)).toBe(true);
});
