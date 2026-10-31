import { DRILLS } from "./recovery-drills.ts";
import { checkRun, deploymentEvidence, GateRefusal, REPOSITORY, verifyReleaseGates, type ReleaseEvidence } from "./release-gates.ts";
import type { CentralTarget } from "./central-deployment.ts";
import type { StageInventory } from "./inventory.ts";
import type { ReleaseEnforcement } from "./release-policy.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";

/**
 * The production readiness check (#148; docs/runbooks/production-readiness.md).
 * Before any Client is onboarded to production it links, for this exact
 * commit, stage and account, the evidence each operations gate needs and a
 * named human's sign-off of that evidence. It fails closed: missing, malformed,
 * stale, mismatched, local-only or unverifiable evidence blocks readiness, and
 * every block names its code and the action that clears it.
 *
 * Evidence has four authorities, shown on each gate:
 * - `repository`: reviewed configuration in this checkout (release enforcement,
 *   protected-resource pins, Slot mappings, central targets, credential custody,
 *   sign-off reviewers). Changed only by reviewed PR.
 * - `trusted`: GitHub's own records (workflow runs, retained plan artifacts,
 *   issue and comment authors), read with the Operator's `gh` login in
 *   `--trusted` mode. Offline, these gates are `unverified`, never passed.
 * - `captured`: sanitized Operator CLI or provider-console output recorded in the
 *   evidence file, each with when, where and a verifiable reference. The check
 *   validates shape, pinning and freshness only; the human sign-off attests to it.
 * - `external`: another repository's evidence (Banquinha), captured the same way.
 *
 * Only `--trusted` mode is authoritative and only it can report `ready`. The
 * check contacts no Worker, D1, Discord or Client, applies nothing and starts no
 * workflow. Nothing in it is a sign-off: that is a named reviewer's GitHub comment.
 */

export const EVIDENCE_SCHEMA = "gq-support.readiness-evidence/v1";
const TIPME_ACCOUNT_ID = "8f38791a8c37b182239af2a385ab3c31";

/**
 * GitHub logins authorized to sign off production readiness, added by reviewed
 * PR. None is named yet, so no sign-off can count. An agent is never one.
 */
export const SIGN_OFF_REVIEWERS: readonly string[] = [];

/** Drills beyond the recovery-drill catalog that need staging evidence too (docs/runbooks/support-operations.md#drill-and-evidence-checklist). */
const EXTRA_DRILLS = ["broken_webhook", "worker_d1_outage", "bad_plugin_update", "release_window", "local_failsafe", "discord_outage",
  "banquinha_outage"] as const;
export const REQUIRED_DRILLS: readonly string[] = [...DRILLS.map(({ id }) => id), ...EXTRA_DRILLS];

/** Measured initial signals the thresholds gate needs; the 15-minute ledger-mirror alert is provisional until its lag is measured. */
export const MEASURED_SIGNALS = ["ledger_mirror_lag", "delivery_delay", "oldest_pending", "status_freshness", "auth_rejection_rate",
  "intake_failure_rate", "scheduler_lag"] as const;

/** Migrations that must be applied before the Worker code that needs them (#146, #147). */
const BEFORE_CODE = [["SupportLedger", "0003_maintenance.sql"], ["SupportLedger", "0004_offboarding.sql"],
  ["SupportDB", "0031_offboarding_retention.sql"]] as const;

/** Maximum evidence age in days, per gate; the sign-off must also follow all the evidence it covers. */
export const FRESHNESS_DAYS = { evidence: 14, release_provenance: 30, production_deployment: 30, staging_deployment: 30, ci_validation: 30,
  access_audit: 30, notifications: 30, independent_monitor: 1, retention_logs: 90, thresholds: 30, slots: 90, recovery_drills: 90,
  banquinha_consumer: 30, sign_off: 14, custody_expiry_margin: 30, measurement_window_min: 7 } as const;
/** The newest scheduled independent check must be this recent; GitHub delays schedules. */
const MONITOR_CURRENT_MS = 2 * 3_600_000;
const DAY = 86_400_000;

/** Reviewed configuration from this checkout. */
export interface ReadinessConfig {
  readonly enforcement: ReleaseEnforcement;
  readonly pins: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  readonly mappings: readonly RepositoryMapping[];
  readonly centralTargets: readonly CentralTarget[];
  readonly inventory: StageInventory;
  readonly reviewers: readonly string[];
  /** Reviewed migration file names in this checkout, per database. */
  readonly migrations: Readonly<Record<"SupportDB" | "SupportLedger", readonly string[]>>;
}

export interface RunListing { readonly id: number; readonly name: string; readonly event: string; readonly conclusion: string | null; readonly created_at: string }
export interface IssueComment { readonly repository: string; readonly author: string; readonly author_type: string; readonly via_app: boolean;
  readonly body: string; readonly created_at: string }

/** GitHub's own records, read-only, with the Operator's access; tests use a controlled provider. */
export interface ReadinessReads extends ReleaseEvidence {
  /** Recent completed runs of a workflow file, or null if unreadable. */
  runs(workflow: string): Promise<readonly RunListing[] | null>;
  issue(number: number): Promise<{ readonly state: string; readonly state_reason: string | null } | null>;
  comment(id: string): Promise<IssueComment | null>;
}

export interface ReadinessIO {
  readonly config: ReadinessConfig;
  /** The checkout under review: its HEAD commit and whether it has uncommitted changes. */
  readonly checkout: { readonly commit: string; readonly dirty: boolean };
  /** GitHub reads for `--trusted` mode; never called otherwise. */
  readonly trusted: () => ReadinessReads;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, text: string) => void;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

type Authority = "repository" | "trusted" | "captured" | "external";
interface Gate { id: string; title: string; authority: readonly Authority[]; runbook: string; state: "passed" | "blocked" | "unverified";
  codes: string[]; evidence?: Record<string, unknown> }

/** What clears each blocker code (the part before any `:`). */
const ACTIONS: Readonly<Record<string, string>> = {
  evidence_missing: "Capture the evidence file (docs/runbooks/production-readiness.md#evidence-file) and pass --evidence.",
  evidence_malformed: "Fix the evidence file to the exact v1 shape: only the listed fields, each in its documented format.",
  secret_like_value: "Remove the secret, webhook URL or contact detail from the evidence file; reference restricted records instead.",
  wrong_stage: "Capture evidence for the prod stage.",
  wrong_account: "Capture evidence for the Tipme account.",
  wrong_commit: "Capture evidence for this exact commit, or check out the commit the evidence is for.",
  checkout_dirty: "Run the check from a clean checkout of the reviewed commit.",
  stale: "Re-run and re-capture the stale evidence within its freshness limit.",
  evidence_from_future: "Correct the evidence time: it is later than now.",
  reference_not_verifiable: "Reference a GitHub Quick-Release URL, a Cloudflare dashboard URL or a sha256: digest of a restricted record.",
  wrong_environment: "Capture this evidence from the environment the gate names.",
  local_evidence_not_live: "Rehearse on the named live stage; a local or synthetic run is not live evidence.",
  trusted_read_required: "Re-run with --trusted so GitHub's own records are read.",
  trusted_read_failed: "Check the Operator's gh login and the cited run, issue or comment, then re-run with --trusted.",
  release_missing: "Record the approved release: its release run, CI and staging runs, package hash and approval (pnpm operator release-status).",
  legacy_unsigned_package: "Approve a signed (gq-support-v2) package; an unsigned-legacy package cannot be distinguished by version.",
  release_gate_failed: "Fix the named release gate and record a release whose runs pass at the exact commits.",
  release_enforcement_staged: "Set prod to enforced in src/release-policy.ts by reviewed PR after the approved release is dispatched.",
  prod_pins_missing: "Pin prod SupportDB, SupportLedger and Worker from reviewed plan evidence in deploy/protected-resources.json.",
  deployment_missing: "Run the gated deployment (Deploy Support Worker) for this commit and record its run.",
  deployment_unverified: "Cite a deploy-worker run of this commit that applied a safe, retained plan to the named stage.",
  plan_identity_mismatch: "The applied plan's protected identities differ from the reviewed pins: stop and review before anything else.",
  not_latest_deployment: "Cite the stage's latest successful gated deployment; a later deployment supersedes this evidence.",
  migration_missing: "Apply and capture the stage's migration list (wrangler d1 migrations list) including every checkout migration.",
  migration_after_code: "The migration was applied after the Worker code that needs it: re-verify that stage under the maintenance boundary.",
  staging_fleet_not_converged: "Converge the staging fleet on the approved release (pnpm operator fleet-status) before prod readiness.",
  staging_fleet_other_release: "Capture staging fleet status for the release being approved.",
  validation_missing: "Cite a CI push run on main at this commit.",
  validation_failed: "The full CI run, including the whole Worker suite, must pass at this commit; fix and re-run it.",
  lifecycle_gate_open: "Complete the Support lifecycle verification gate #29; this check links it and does not replace it.",
  access_missing: "Capture the prod staff roster, dashboard key and Operator holder counts and an audited incident claim.",
  operator_not_separated: "Hold Operator credentials separately from staff dashboard access before onboarding.",
  notifications_missing: "Capture prod notification destinations (pnpm operator notifications).",
  discord_destination_unconfigured: "Configure and evidence the named prod Discord destination (runbook: Discord notification setup).",
  monitor_missing: "Enable the independent checker for prod and cite a successful scheduled run.",
  monitor_unverified: "Cite a successful scheduled independent-check run on main whose Check prod job passed.",
  monitor_not_current: "The latest scheduled independent check is missing, failed or late: restore the schedule and re-run.",
  retention_missing: "Record the actual configured Workers Logs retention and access policy from the Cloudflare dashboard.",
  thresholds_missing: "Measure initial behavior over at least 7 days and record each threshold with its basis.",
  measurement_window_too_short: "Measure for at least 7 days.",
  threshold_unmeasured: "Measure and record the named signal; never invent a threshold or SLA.",
  custody_owner_missing: "Name the credential's reviewed owner in src/inventory.ts.",
  custody_expiry_unknown: "Record the credential's expiry (or never) in src/inventory.ts from the provider.",
  custody_expiring: "Rotate the credential and record its new expiry and rotation evidence.",
  custody_rotation_unrecorded: "Record the credential's last verified rotation or creation with its evidence.",
  no_prod_slots: "Add the first Client's prod Slot mapping by reviewed PR (src/repository-mappings.ts).",
  deployment_method_unset: "Record the Slot's reviewed deployment method (central or native).",
  deployment_manual: "A manual Slot gets no fleet updates; use central or native deployment.",
  central_target_missing: "Add the Slot's reviewed central target (src/central-deployment.ts).",
  central_composer_unreviewed: "A Composer-managed site needs a reviewed lock adapter; until then it cannot be centrally updated.",
  native_access_missing: "Grant and evidence the Slot's native update access (pnpm operator update-access-status).",
  delivery_unapproved: "Record the Slot's GitHub App installation in its reviewed mapping.",
  responsible_team_unset: "Record the Slot's reviewed responsible team.",
  contact_unverified: "Run the Client's separate-device contact drill and record it (pnpm operator inventory-contact ... separate-device-drill).",
  unknown_slot: "Remove evidence for Slots that have no prod mapping.",
  local_drill_report_missing: "Run pnpm recovery-drill --out <file> at this commit and pass --drill-report.",
  local_drill_report_other_commit: "Re-run pnpm recovery-drill at this clean commit.",
  local_drills_failed: "Fix the failing synthetic local drills.",
  drill_report_forged: "Use the unedited pnpm recovery-drill report: it never claims staging evidence or sign-off.",
  staging_drill_missing: "Rehearse the named drill on staging at this commit with a named Operator and record its evidence.",
  staging_drill_failed: "Repair the recovery path and rehearse the drill again.",
  banquinha_missing: "Capture Banquinha's commit, CI, signed-in browser E2E and live staging smoke against this service.",
  sign_off_missing: "A reviewer named in SIGN_OFF_REVIEWERS comments the evidence digest on a gq-support issue; record it under sign_off.",
  no_reviewed_sign_off_reviewers: "Name the human sign-off reviewers in SIGN_OFF_REVIEWERS (src/readiness.ts) by reviewed PR.",
  reviewer_not_authorized: "The sign-off must be by a reviewer named in SIGN_OFF_REVIEWERS.",
  sign_off_digest_mismatch: "The evidence changed after sign-off: the reviewer signs the current evidence_digest.",
  sign_off_before_evidence: "Sign off after all evidence is captured.",
  sign_off_comment_missing: "Cite the reviewer's sign-off comment ID on a Quick-Release/gq-support issue.",
  sign_off_author_mismatch: "The sign-off comment must be written by the named reviewer.",
  sign_off_not_human: "A sign-off is a human's own comment, never a bot, App or agent.",
  sign_off_digest_absent: "The sign-off comment must quote the evidence digest.",
  sign_off_time_mismatch: "Record the sign-off comment's own creation time as signed_at.",
};

/** Known review risks: each stays open until the gate that guards it passes, and `guarded_by` is the blocker it raises. */
export const REVIEW_RISKS = [
  { code: "staging_gate_worker_only", summary: "The release staging gate proves a staging Worker deployment, not staging fleet convergence.", gate: "staging_deployment", guarded_by: "staging_fleet_not_converged" },
  { code: "infra_gate_not_latest", summary: "A gated deployment run does not by itself prove it is the stage's latest deployment.", gate: "production_deployment", guarded_by: "not_latest_deployment" },
  { code: "prod_review_unnamed", summary: "A reviewed_plan_digest names no reviewer; only a named human sign-off covers the prod plan.", gate: "sign_off", guarded_by: "sign_off_missing" },
  { code: "legacy_unsigned_version", summary: "Unsigned-legacy packages cannot be told apart by version.", gate: "release_provenance", guarded_by: "legacy_unsigned_package" },
  { code: "ledger_alert_provisional", summary: "The 15-minute ledger-mirror alert is unmeasured and provisional.", gate: "thresholds", guarded_by: "threshold_unmeasured:ledger_mirror_lag" },
  { code: "log_retention_unrecorded", summary: "No actual Workers Logs retention or access policy is recorded.", gate: "retention_logs", guarded_by: "retention_missing" },
  { code: "central_composer_unconfigured", summary: "No reviewed central or Composer lock adapter target exists.", gate: "slots", guarded_by: "central_target_missing" },
  { code: "worker_suite_parallel_timeout", summary: "The full Worker suite has an unresolved parallel-load timeout; only a passing CI run at the commit counts.", gate: "ci_validation", guarded_by: "validation_failed" },
] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HEX40 = /^[a-f0-9]{40}$/, HEX64 = /^[a-f0-9]{64}$/, RUN = /^[1-9][0-9]{0,19}$/;
const ACTOR = /^[A-Za-z0-9_-]{1,64}$/, LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/, SLOT = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
/** Where captured evidence lives: GitHub or the Cloudflare dashboard, no query string, or the digest of a restricted record. */
const REFERENCE = /^(https:\/\/(github\.com\/Quick-Release\/[A-Za-z0-9._-]+|dash\.cloudflare\.com)(\/[A-Za-z0-9._~%/@:+-]*)?(#[A-Za-z0-9._-]+)?|sha256:[a-f0-9]{64})$/;
/** Never in an evidence file: keys, tokens, webhook URLs, email addresses. */
const SECRET_LIKE = /-----BEGIN|\bgh[pousr]_[A-Za-z0-9]{16,}|github_pat_|xox[abprs]-|\/api\/webhooks\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

class Malformed extends Error {}
type Check<T> = (value: unknown) => T;
const fail = (): never => { throw new Malformed(); };
const text = (pattern: RegExp): Check<string> => (value) => typeof value === "string" && pattern.test(value) ? value : fail();
const time: Check<number> = (value) => { const at = Date.parse(text(ISO)(value)); return Number.isFinite(at) ? at : fail(); };
const integer = (min: number, max: number): Check<number> => (value) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fail();
const one = <T extends string>(...options: readonly T[]): Check<T> => (value) => options.includes(value as T) ? value as T : fail();
const flag: Check<boolean> = (value) => typeof value === "boolean" ? value : fail();
const list = <T>(item: Check<T>, max = 200): Check<T[]> => (value) => Array.isArray(value) && value.length <= max ? value.map(item) : fail();
/** Exactly these fields, each valid: an unknown field, such as a typed `ready: true`, is malformed. */
const shape = <T extends Record<string, unknown>>(spec: { [K in keyof T]: Check<T[K]> }): Check<T> => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(key in spec))) fail();
  return Object.fromEntries(Object.entries(spec).map(([key, check]) => [key, (check as Check<unknown>)(record[key])])) as T;
};

const environment = one("local", "staging", "prod");
const migration = shape({ database: one("SupportDB", "SupportLedger"), name: text(/^[0-9]{4}_[a-z0-9_]{1,64}\.sql$/), applied_at: time });
const SECTIONS = {
  release: shape({ observed_at: time, release_run: text(RUN), release_commit: text(HEX40), ci_run: text(RUN), staging_run: text(RUN),
    package_version: text(VERSION), package_sha256: text(HEX64), signing: one("signed", "unsigned-legacy"), approved_release_id: integer(1, 2 ** 31),
    reference: text(REFERENCE) }),
  production: shape({ observed_at: time, deploy_run: text(RUN), migrations: list(migration), reference: text(REFERENCE) }),
  staging: shape({ observed_at: time, deploy_run: text(RUN), migrations: list(migration), reference: text(REFERENCE),
    fleet: shape({ release_id: integer(1, 2 ** 31), version: text(VERSION), converged: flag, verified: integer(0, 1e6), not_verified: integer(0, 1e6) }) }),
  validation: shape({ observed_at: time, ci_run: text(RUN) }),
  access: shape({ observed_at: time, environment, staff_roster: integer(0, 1e4), dashboard_keys: integer(0, 100), operator_holders: integer(0, 100),
    operator_separate_from_staff: flag, claim_audit_incident: text(UUID), reference: text(REFERENCE) }),
  notifications: shape({ observed_at: time, environment, configured: list(one("support_requests", "operational_incidents"), 2),
    reference: text(REFERENCE) }),
  monitor: shape({ observed_at: time, run: text(RUN), reference: text(REFERENCE) }),
  retention: shape({ observed_at: time, environment, workers_logs_retention_days: integer(1, 3650), logs_access: one("restricted"),
    reference: text(REFERENCE) }),
  thresholds: shape({ observed_at: time, environment, window_from: time, window_to: time, reference: text(REFERENCE),
    signals: list(shape({ signal: one(...MEASURED_SIGNALS), threshold: integer(1, 1e9), unit: one("seconds", "minutes", "count", "per_hour", "percent"),
      basis: text(REFERENCE) }), 50) }),
  slots: list(shape({ slot: text(SLOT), observed_at: time, contact_method: one("separate-device-drill", "attestation"), contact_verified_at: time,
    contact_evidence: text(REFERENCE), update_access: one("granted", "none", "not_applicable"), reference: text(REFERENCE) }), 1000),
  drills: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const drill = shape({ observed_at: time, environment, commit: text(HEX40), operator: text(ACTOR), incident: (id: unknown) => id === null ? null : text(UUID)(id),
      result: one("passed", "failed"), reference: text(REFERENCE) });
    return Object.fromEntries(Object.entries(value).map(([id, entry]) => [REQUIRED_DRILLS.includes(id) ? id : fail(), drill(entry)]));
  },
  banquinha: shape({ observed_at: time, repository: one("Quick-Release/banquinha"), commit: text(HEX40), ci_reference: text(REFERENCE),
    signed_in_e2e_reference: text(REFERENCE), live_smoke: shape({ environment, observed_at: time, reference: text(REFERENCE) }) }),
  sign_off: shape({ reviewer: text(LOGIN), signed_at: time, comment: text(RUN), evidence_digest: text(HEX64) }),
};
type Sections = { [K in keyof typeof SECTIONS]: ReturnType<(typeof SECTIONS)[K]> };
const HEADER = shape({ schema: one(EVIDENCE_SCHEMA), stage: environment, account_id: text(/^[a-f0-9]{32}$/), commit: text(HEX40), captured_at: time,
  captured_by: text(ACTOR) });

/** A stable digest of the evidence a sign-off covers: everything except the sign-off itself. */
export const evidenceDigest = async (evidence: Record<string, unknown>) => {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  const { sign_off: _signOff, ...covered } = evidence;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(covered))));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const DEPLOY_WORKFLOW = ".github/workflows/deploy-worker.yml", CHECK_WORKFLOW = ".github/workflows/independent-check.yml";
const CI_RULE = { workflow: ".github/workflows/ci.yml", branch: "main", event: "push",
  jobs: [/^Worker typecheck \+ tests$/, /^Required validation$/, /^Secret scan$/, /^PHPCS \+ PHPStan$/, /^Asset size gate$/] };
const MONITOR_RULE = { workflow: CHECK_WORKFLOW, branch: "main", event: "schedule", jobs: [/^Check prod$/] };

/** Evaluates every gate. `reads` is null offline: trusted gates are then unverified, never passed. */
const evaluate = async (raw: string | undefined, drillRaw: string | undefined, io: ReadinessIO, reads: ReadinessReads | null, now: number) => {
  const { config, checkout } = io;
  const gates: Gate[] = [];
  const gate = (id: string, title: string, authority: readonly Authority[], runbook: string) => {
    const entry: Gate = { id, title, authority, runbook: `docs/runbooks/${runbook}`, state: "blocked", codes: [] };
    gates.push(entry);
    return entry;
  };
  /** Every evidence time checked, which the sign-off must follow. */
  const observed: number[] = [];
  const age = (entry: Gate, at: number, days: number, label = "") => {
    if (entry.id !== "sign_off") observed.push(at);
    if (at > now + 60_000) entry.codes.push(`evidence_from_future${label}`);
    else if (now - at > days * DAY) entry.codes.push(`stale${label}`);
  };

  // The evidence file: present, shaped, free of secrets, and pinned to this stage, account and commit.
  const file = gate("evidence", "Evidence file pinned to the prod stage, Tipme account and this commit", ["captured"], "production-readiness.md#evidence-file");
  let header: ReturnType<typeof HEADER> | null = null;
  let parsed: Record<string, unknown> | null = null;
  let digest: string | null = null;
  if (raw === undefined) file.codes.push("evidence_missing");
  else if (SECRET_LIKE.test(raw)) file.codes.push("secret_like_value");
  else {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((key) => !(key in SECTIONS) && !(key in { schema: 1, stage: 1, account_id: 1, commit: 1, captured_at: 1, captured_by: 1 }))) fail();
      header = HEADER(Object.fromEntries(Object.entries(record).filter(([key]) => !(key in SECTIONS))));
      parsed = record;
      digest = await evidenceDigest(record);
    } catch {
      file.codes.push("evidence_malformed");
    }
  }
  if (header) {
    if (header.stage === "local") file.codes.push("local_evidence_not_live");
    else if (header.stage !== "prod") file.codes.push("wrong_stage");
    if (header.account_id !== TIPME_ACCOUNT_ID) file.codes.push("wrong_account");
    if (header.commit !== checkout.commit) file.codes.push("wrong_commit");
    age(file, header.captured_at, FRESHNESS_DAYS.evidence);
  }
  if (checkout.dirty) file.codes.push("checkout_dirty");
  // Sections are trusted only from an intact, pinned file.
  const usable = header !== null && file.codes.length === 0;
  const section = <K extends keyof Sections>(entry: Gate, key: K, missing: string): Sections[K] | null => {
    if (!usable || parsed?.[key] === undefined) { entry.codes.push(usable || raw === undefined ? missing : "evidence_missing"); return null; }
    try { return SECTIONS[key](parsed[key]) as Sections[K]; } catch { entry.codes.push("evidence_malformed"); return null; }
  };
  const live = (entry: Gate, value: "local" | "staging" | "prod", expected: "staging" | "prod", label = "") => {
    if (value === "local") entry.codes.push(`local_evidence_not_live${label}`);
    else if (value !== expected) entry.codes.push(`wrong_environment${label}`);
  };
  const trusted = async (entry: Gate, read: (reads: ReadinessReads) => Promise<void>) => {
    if (!reads) { entry.codes.push("trusted_read_required"); return; }
    try { await read(reads); } catch { entry.codes.push("trusted_read_failed"); }
  };
  const latest = async (entry: Gate, reads: ReadinessReads, stage: "staging" | "prod", run: string) => {
    const runs = await reads.runs(DEPLOY_WORKFLOW);
    if (!runs) throw new Error("unreadable");
    const deployed = runs.filter((listing) => listing.name.startsWith(`Deploy Support Worker (${stage}, deploy)`) && listing.conclusion === "success")
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (String(deployed[0]?.id) !== run) entry.codes.push("not_latest_deployment");
  };
  const ordered = (entry: Gate, migrations: readonly ReturnType<typeof migration>[], appliedAt: number | null) => {
    for (const database of ["SupportDB", "SupportLedger"] as const) {
      for (const name of config.migrations[database]) {
        if (!migrations.some((row) => row.database === database && row.name === name)) entry.codes.push(`migration_missing:${database}/${name}`);
      }
    }
    if (appliedAt === null) return;
    for (const [database, name] of BEFORE_CODE) {
      const row = migrations.find((candidate) => candidate.database === database && candidate.name === name);
      if (row && row.applied_at >= appliedAt) entry.codes.push(`migration_after_code:${database}/${name}`);
    }
  };

  const release = gate("release_provenance", "Approved signed release, its package provenance and release gates at this Worker commit",
    ["captured", "trusted"], "support-operations.md#approved-releases-and-intake-enforcement");
  const approved = section(release, "release", "release_missing");
  if (approved) {
    age(release, approved.observed_at, FRESHNESS_DAYS.release_provenance);
    if (approved.signing !== "signed") release.codes.push("legacy_unsigned_package");
    release.evidence = { release_run: approved.release_run, release_commit: approved.release_commit, package_version: approved.package_version,
      package_sha256: approved.package_sha256, approved_release_id: approved.approved_release_id, reference: approved.reference };
    await trusted(release, async (reads) => {
      try {
        await verifyReleaseGates(reads, { provenance: `release-plugin run ${approved.release_run} at ${approved.release_commit}`, worker_commit: checkout.commit },
          { ci: approved.ci_run, staging: approved.staging_run });
      } catch (error) {
        if (!(error instanceof GateRefusal)) throw error;
        release.codes.push(...Object.keys(error.failures).map((key) => `release_gate_failed:${key}`));
      }
    });
  }

  const enforcement = gate("release_enforcement", "Prod release enforcement is enforced, not staged", ["repository"],
    "support-operations.md#approved-releases-and-intake-enforcement");
  enforcement.evidence = { prod: config.enforcement };
  if (config.enforcement !== "enforced") enforcement.codes.push("release_enforcement_staged");

  const production = gate("production_deployment", "Latest gated prod deployment of this commit: safe plan, reviewed pins, migrations before code",
    ["repository", "trusted", "captured"], "support-operations.md#deployment-plan-gate");
  const pins = config.pins;
  const pinned = !!pins && !!pins.SupportDB?.databaseId && !!pins.SupportLedger?.databaseId && !!pins.Worker?.workerName;
  if (!pinned) production.codes.push("prod_pins_missing");
  const prod = section(production, "production", "deployment_missing");
  if (prod) {
    age(production, prod.observed_at, FRESHNESS_DAYS.production_deployment);
    ordered(production, prod.migrations, null);
    production.evidence = { deploy_run: prod.deploy_run, reference: prod.reference };
    await trusted(production, async (reads) => {
      const deployed = await deploymentEvidence(reads, prod.deploy_run, "prod", checkout.commit);
      if (typeof deployed === "string") { production.codes.push("deployment_unverified"); production.evidence!.detail = deployed; return; }
      production.evidence = { ...production.evidence, plan_digest: deployed.plan_digest, applied_at: deployed.applied_at, covers: deployed.covers };
      ordered(production, prod.migrations, Date.parse(deployed.applied_at));
      const plan = await reads.artifact(prod.deploy_run, `deploy-plan-prod-${prod.deploy_run}-`, "plan.json") as
        { resources?: { fqn?: string; identity?: Record<string, string> }[] } | null;
      if (pinned && Object.entries(pins!).some(([logicalId, fields]) => Object.entries(fields).some(([field, expected]) =>
        plan?.resources?.find((row) => row.fqn === logicalId)?.identity?.[field] !== expected))) production.codes.push("plan_identity_mismatch");
      await latest(production, reads, "prod", prod.deploy_run);
    });
  }

  const staging = gate("staging_deployment", "Latest gated staging deployment of this commit, migrations before code, staging fleet converged",
    ["trusted", "captured"], "support-operations.md#fleet-rollout-and-recovery");
  const stage = section(staging, "staging", "deployment_missing");
  if (stage) {
    age(staging, stage.observed_at, FRESHNESS_DAYS.staging_deployment);
    ordered(staging, stage.migrations, null);
    if (!stage.fleet.converged || stage.fleet.not_verified > 0 || stage.fleet.verified === 0) staging.codes.push("staging_fleet_not_converged");
    if (approved && (stage.fleet.release_id !== approved.approved_release_id || stage.fleet.version !== approved.package_version)) {
      staging.codes.push("staging_fleet_other_release");
    }
    staging.evidence = { deploy_run: stage.deploy_run, fleet: stage.fleet, reference: stage.reference };
    await trusted(staging, async (reads) => {
      const deployed = await deploymentEvidence(reads, stage.deploy_run, "staging", checkout.commit);
      if (typeof deployed === "string") { staging.codes.push("deployment_unverified"); staging.evidence!.detail = deployed; return; }
      ordered(staging, stage.migrations, Date.parse(deployed.applied_at));
      await latest(staging, reads, "staging", stage.deploy_run);
    });
  }

  const validation = gate("ci_validation", "Full CI at this commit on main: whole Worker suite, required validation, security and size gates",
    ["trusted"], "../support-lifecycle-verification.md");
  const ci = section(validation, "validation", "validation_missing");
  if (ci) {
    age(validation, ci.observed_at, FRESHNESS_DAYS.ci_validation);
    validation.evidence = { ci_run: ci.ci_run };
    await trusted(validation, async (reads) => {
      const checked = checkRun(await reads.run(ci.ci_run), CI_RULE, checkout.commit);
      if (typeof checked === "string") { validation.codes.push("validation_failed"); validation.evidence!.detail = checked; }
    });
  }

  const lifecycle = gate("lifecycle_gate", "Related: the complete Support lifecycle verification gate (#29) is complete", ["trusted"],
    "../support-lifecycle-verification.md");
  lifecycle.evidence = { issue: `https://github.com/${REPOSITORY}/issues/29` };
  await trusted(lifecycle, async (reads) => {
    const issue = await reads.issue(29);
    if (!issue) throw new Error("unreadable");
    lifecycle.evidence!.state = issue.state;
    if (issue.state !== "closed" || issue.state_reason !== "completed") lifecycle.codes.push("lifecycle_gate_open");
  });

  const access = gate("access_audit", "Prod staff roster and dashboard keys, separate Operator credentials, an audited claim", ["captured"],
    "support-operations.md#common-procedure");
  const roster = section(access, "access", "access_missing");
  if (roster) {
    age(access, roster.observed_at, FRESHNESS_DAYS.access_audit);
    live(access, roster.environment, "prod");
    if (roster.staff_roster === 0 || roster.dashboard_keys === 0 || roster.operator_holders === 0) access.codes.push("access_missing");
    if (!roster.operator_separate_from_staff) access.codes.push("operator_not_separated");
    access.evidence = { staff_roster: roster.staff_roster, dashboard_keys: roster.dashboard_keys, operator_holders: roster.operator_holders,
      claim_audit_incident: roster.claim_audit_incident, reference: roster.reference };
  }

  const notifications = gate("notifications", "Prod Discord destinations configured; incident and notification durability drilled", ["captured"],
    "support-operations.md#discord-notification-setup");
  const destinations = section(notifications, "notifications", "notifications_missing");
  if (destinations) {
    age(notifications, destinations.observed_at, FRESHNESS_DAYS.notifications);
    live(notifications, destinations.environment, "prod");
    for (const name of ["support_requests", "operational_incidents"] as const) {
      if (!destinations.configured.includes(name)) notifications.codes.push(`discord_destination_unconfigured:${name}`);
    }
    notifications.evidence = { configured: destinations.configured, reference: destinations.reference };
  }

  const monitor = gate("independent_monitor", "Independent checker runs on schedule for prod, outside Cloudflare", ["trusted"],
    "support-operations.md#independent-outage-checks");
  const checker = section(monitor, "monitor", "monitor_missing");
  if (checker) {
    age(monitor, checker.observed_at, FRESHNESS_DAYS.independent_monitor);
    monitor.evidence = { run: checker.run, reference: checker.reference };
    await trusted(monitor, async (reads) => {
      // Any main commit's scheduled run counts: the checker probes the deployed service, not this checkout.
      const run = await reads.run(checker.run);
      if (typeof checkRun(run, MONITOR_RULE, run?.head_sha ?? "") === "string") monitor.codes.push("monitor_unverified");
      const runs = await reads.runs(CHECK_WORKFLOW);
      if (!runs) throw new Error("unreadable");
      const cited = runs.find((listing) => String(listing.id) === checker.run);
      if (!cited) monitor.codes.push("monitor_unverified");
      else age(monitor, Date.parse(cited.created_at), FRESHNESS_DAYS.independent_monitor);
      const newest = runs.filter((listing) => listing.event === "schedule").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (!newest || newest.conclusion !== "success" || now - Date.parse(newest.created_at) > MONITOR_CURRENT_MS) monitor.codes.push("monitor_not_current");
    });
  }

  const retention = gate("retention_logs", "Actual Workers Logs retention and access policy recorded; no assumed duration", ["captured"],
    "../support-privacy-design.md");
  const logs = section(retention, "retention", "retention_missing");
  if (logs) {
    age(retention, logs.observed_at, FRESHNESS_DAYS.retention_logs);
    live(retention, logs.environment, "prod");
    retention.evidence = { workers_logs_retention_days: logs.workers_logs_retention_days, logs_access: logs.logs_access, reference: logs.reference };
  }

  const thresholds = gate("thresholds", "Measured initial thresholds over at least 7 days, including the ledger-mirror lag", ["captured"],
    "../support-operations-design.md#alert-rules-and-availability-boundaries");
  const measured = section(thresholds, "thresholds", "thresholds_missing");
  if (measured) {
    age(thresholds, measured.window_to, FRESHNESS_DAYS.thresholds);
    if (measured.environment === "local") thresholds.codes.push("local_evidence_not_live");
    if (measured.window_to - measured.window_from < FRESHNESS_DAYS.measurement_window_min * DAY) thresholds.codes.push("measurement_window_too_short");
    for (const signal of MEASURED_SIGNALS) {
      if (!measured.signals.some((entry) => entry.signal === signal)) thresholds.codes.push(`threshold_unmeasured:${signal}`);
    }
    thresholds.evidence = { environment: measured.environment, window_from: new Date(measured.window_from).toISOString(),
      window_to: new Date(measured.window_to).toISOString(), signals: measured.signals };
  }

  const custody = gate("custody", "Every prod credential has a reviewed owner, known expiry and recorded rotation", ["repository"],
    "github-app-key-custody.md");
  for (const credential of config.inventory.credentials) {
    if (credential.owner === null) custody.codes.push(`custody_owner_missing:${credential.id}`);
    if (credential.expires === null) custody.codes.push(`custody_expiry_unknown:${credential.id}`);
    else if (credential.expires !== "never" && !(Date.parse(credential.expires) - now > FRESHNESS_DAYS.custody_expiry_margin * DAY)) {
      custody.codes.push(`custody_expiring:${credential.id}`);
    }
    if (credential.rotated === null) custody.codes.push(`custody_rotation_unrecorded:${credential.id}`);
  }
  custody.evidence = { credentials: config.inventory.credentials.length };

  const slots = gate("slots", "Every prod Slot: reviewed mapping, deployment target and a verified independent contact", ["repository", "captured"],
    "support-operations.md#inventory-and-credential-custody");
  if (config.mappings.length === 0) slots.codes.push("no_prod_slots");
  const records = config.mappings.length === 0 ? null : section(slots, "slots", "contact_unverified");
  for (const mapping of config.mappings) {
    const label = `:${mapping.slot}`;
    if (mapping.githubInstallationId === undefined) slots.codes.push(`delivery_unapproved${label}`);
    if (!mapping.responsibleTeam) slots.codes.push(`responsible_team_unset${label}`);
    if (!mapping.deployment) slots.codes.push(`deployment_method_unset${label}`);
    else if (mapping.deployment === "manual") slots.codes.push(`deployment_manual${label}`);
    const target = config.centralTargets.find((candidate) => candidate.slot === mapping.slot);
    if (mapping.deployment === "central" && !target) slots.codes.push(`central_target_missing${label}`);
    if (mapping.deployment === "central" && target?.source === "composer") slots.codes.push(`central_composer_unreviewed${label}`);
    const record = records?.find((entry) => entry.slot === mapping.slot);
    if (!records) continue;
    if (!record || record.contact_method !== "separate-device-drill") slots.codes.push(`contact_unverified${label}`);
    else age(slots, record.contact_verified_at, FRESHNESS_DAYS.slots, label);
    if (mapping.deployment === "native" && record?.update_access !== "granted") slots.codes.push(`native_access_missing${label}`);
  }
  for (const record of records ?? []) if (!config.mappings.some((mapping) => mapping.slot === record.slot)) slots.codes.push("unknown_slot");
  slots.evidence = { mapped: config.mappings.map(({ slot }) => slot) };

  // Synthetic local drills are their own, separately reported result; they never stand in for staging.
  const local = (() => {
    if (drillRaw === undefined) return { state: "missing" as const };
    try {
      const report = JSON.parse(drillRaw) as Record<string, unknown>;
      if (report.kind !== "recovery-drill-evidence" || !Array.isArray(report.drills)) return { state: "malformed" as const };
      if (report.staging_evidence !== false || report.signed_off !== false) return { state: "forged" as const };
      if (report.commit !== checkout.commit) return { state: "other_commit" as const, commit: typeof report.commit === "string" && /^[a-f0-9-]{7,48}$/.test(report.commit) ? report.commit : null };
      return { state: report.local_passed === true ? "passed" as const : "failed" as const, commit: checkout.commit,
        generated_at: typeof report.generated_at === "string" && ISO.test(report.generated_at) ? report.generated_at : null };
    } catch {
      return { state: "malformed" as const };
    }
  })();
  const drills = gate("recovery_drills", "Every recovery drill rehearsed on staging at this commit, after its synthetic local rehearsal passed",
    ["captured"], "support-operations.md#drill-and-evidence-checklist");
  if (local.state === "missing" || local.state === "malformed") drills.codes.push("local_drill_report_missing");
  else if (local.state === "forged") drills.codes.push("drill_report_forged");
  else if (local.state === "other_commit") drills.codes.push("local_drill_report_other_commit");
  else if (local.state === "failed") drills.codes.push("local_drills_failed");
  const rehearsed = section(drills, "drills", "staging_drill_missing");
  for (const id of REQUIRED_DRILLS) {
    if (!rehearsed) break;
    const drill = rehearsed[id];
    const label = `:${id}`;
    if (!drill) { drills.codes.push(`staging_drill_missing${label}`); continue; }
    live(drills, drill.environment, "staging", label);
    if (drill.commit !== checkout.commit) drills.codes.push(`wrong_commit${label}`);
    if (drill.result !== "passed") drills.codes.push(`staging_drill_failed${label}`);
    age(drills, drill.observed_at, FRESHNESS_DAYS.recovery_drills, label);
  }
  drills.evidence = { required: REQUIRED_DRILLS, staging: rehearsed ? Object.fromEntries(Object.entries(rehearsed).map(([id, drill]) =>
    [id, { observed_at: new Date(drill.observed_at).toISOString(), environment: drill.environment, operator: drill.operator, incident: drill.incident,
      result: drill.result, reference: drill.reference }])) : {} };

  const banquinha = gate("banquinha_consumer", "Banquinha dashboard: its commit, CI, signed-in browser E2E and live staging smoke against this service",
    ["external"], "support-operations.md#common-procedure");
  const dashboard = section(banquinha, "banquinha", "banquinha_missing");
  if (dashboard) {
    age(banquinha, dashboard.observed_at, FRESHNESS_DAYS.banquinha_consumer);
    live(banquinha, dashboard.live_smoke.environment, "staging");
    age(banquinha, dashboard.live_smoke.observed_at, FRESHNESS_DAYS.banquinha_consumer);
    banquinha.evidence = { commit: dashboard.commit, ci_reference: dashboard.ci_reference, signed_in_e2e_reference: dashboard.signed_in_e2e_reference,
      live_smoke_reference: dashboard.live_smoke.reference };
  }

  const signOff = gate("sign_off", "A named human reviewer's GitHub comment signing off this exact evidence digest", ["repository", "trusted"],
    "production-readiness.md#human-sign-off");
  if (config.reviewers.length === 0) signOff.codes.push("no_reviewed_sign_off_reviewers");
  const signed = section(signOff, "sign_off", "sign_off_missing");
  if (signed) {
    if (config.reviewers.length > 0 && !config.reviewers.includes(signed.reviewer)) signOff.codes.push("reviewer_not_authorized");
    if (signed.evidence_digest !== digest) signOff.codes.push("sign_off_digest_mismatch");
    if (observed.some((at) => at > signed.signed_at)) signOff.codes.push("sign_off_before_evidence");
    age(signOff, signed.signed_at, FRESHNESS_DAYS.sign_off);
    signOff.evidence = { reviewer: signed.reviewer, signed_at: new Date(signed.signed_at).toISOString(), comment: signed.comment };
    await trusted(signOff, async (reads) => {
      const comment = await reads.comment(signed.comment);
      if (!comment || comment.repository !== REPOSITORY) { signOff.codes.push("sign_off_comment_missing"); return; }
      if (comment.author !== signed.reviewer) signOff.codes.push("sign_off_author_mismatch");
      if (comment.author_type !== "User" || comment.via_app) signOff.codes.push("sign_off_not_human");
      if (digest === null || !comment.body.includes(digest)) signOff.codes.push("sign_off_digest_absent");
      if (Math.abs(Date.parse(comment.created_at) - signed.signed_at) > 5 * 60_000) signOff.codes.push("sign_off_time_mismatch");
    });
  }

  for (const entry of gates) {
    entry.codes = [...new Set(entry.codes)];
    entry.state = entry.codes.length === 0 ? "passed" : entry.codes.every((code) => code === "trusted_read_required") ? "unverified" : "blocked";
  }
  return { gates, digest, local };
};

/** The full report: every gate with its blockers and actions, the separate local result, review risks and the related #29 gate. */
export const readinessReport = async (raw: string | undefined, drillRaw: string | undefined, io: ReadinessIO, reads: ReadinessReads | null) => {
  const now = io.now().getTime();
  const { gates, digest, local } = await evaluate(raw, drillRaw, io, reads, now);
  const ready = reads !== null && gates.every((entry) => entry.state === "passed");
  return {
    kind: "gq-support-production-readiness", stage: "prod", account_id: TIPME_ACCOUNT_ID, commit: io.checkout.commit, dirty: io.checkout.dirty,
    generated_at: new Date(now).toISOString(), mode: reads ? "trusted" as const : "offline" as const, authoritative: reads !== null,
    verdict: ready ? "ready" as const : "not_ready" as const, evidence_digest: digest,
    note: reads ? "Trusted mode: GitHub's own run, artifact, issue and comment records were read. Captured evidence is checked for shape, pinning and freshness, and attested by the human sign-off."
      : "Offline mode: captured evidence checked for shape, pinning and freshness only. Not authoritative and never ready; re-run with --trusted.",
    local_tests: { ...local, scope: "Synthetic local rehearsal (local D1, fake GitHub/Discord, controlled clock): not staging or production verification." },
    gates: gates.map(({ id, title, authority, runbook, state, codes: gateCodes, evidence }) => ({ id, title, authority, runbook, state,
      blockers: gateCodes.map((code) => ({ code, action: ACTIONS[code.split(":")[0]!] ?? "See the runbook." })), ...(evidence ? { evidence } : {}) })),
    summary: { passed: gates.filter((entry) => entry.state === "passed").length, blocked: gates.filter((entry) => entry.state === "blocked").length,
      unverified: gates.filter((entry) => entry.state === "unverified").length },
    review_risks: REVIEW_RISKS.map((risk) => ({ ...risk, open: gates.find((entry) => entry.id === risk.gate)?.state !== "passed" })),
    related: [{ issue: `https://github.com/${REPOSITORY}/issues/29`, relation: "Complete Support lifecycle verification gate; linked, not duplicated or changed." }],
  };
};

const USAGE = "Usage: pnpm readiness --stage prod [--evidence <evidence.json>] [--drill-report <recovery-drill.json>] [--trusted] [--out <report.json>]";

/**
 * `pnpm readiness`: prints the report and returns the exit code: 0 ready
 * (trusted mode, every gate passed), 2 not ready, 1 a usage or file error.
 */
export async function runReadiness(argv: readonly string[], io: ReadinessIO): Promise<number> {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--trusted" && !("trusted" in flags)) { flags.trusted = true; continue; }
    const value = argv[index + 1];
    if (!["--stage", "--evidence", "--drill-report", "--out"].includes(flag) || value === undefined || value.startsWith("--") || flag.slice(2) in flags) {
      io.log(USAGE);
      return 1;
    }
    flags[flag.slice(2)] = value;
    index++;
  }
  if (flags.stage !== "prod") {
    io.log(`${USAGE}\nProduction readiness is checked for the prod stage only.`);
    return 1;
  }
  const read = (path: string | true | undefined) => typeof path === "string" ? io.readFile(path) : undefined;
  const evidence = read(flags.evidence), drill = read(flags["drill-report"]);
  if ((typeof flags.evidence === "string" && evidence === undefined) || (typeof flags["drill-report"] === "string" && drill === undefined)) {
    io.log("Cannot read the named evidence or drill report file.");
    return 1;
  }
  const report = await readinessReport(evidence, drill, io, flags.trusted ? io.trusted() : null);
  const output = JSON.stringify(report, null, 2);
  if (typeof flags.out === "string") io.writeFile(flags.out, `${output}\n`);
  io.log(output);
  return report.verdict === "ready" ? 0 : 2;
}
