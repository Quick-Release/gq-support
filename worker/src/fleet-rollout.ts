import { applyCentralRelease, CENTRAL_LEASE_MS, CentralRefusal, filesDigest, packageFiles, targetProblem, artifactPackages,
  type CentralResult, type CentralTarget } from "./central-deployment.ts";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { approvedReleases, COMPATIBILITY_WINDOW_MS, offeredRelease, SUPPORTED_CONTRACTS, type ReleaseRow } from "./release-policy.ts";
import { deploymentEvidence, GateRefusal, verifyReleaseGates, type ReleaseEvidence } from "./release-gates.ts";
import type { DeployedStage, DeploymentMethod, RepositoryMapping } from "./repository-mappings.ts";
import { PLUGIN_VERSION } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Fleet rollout and compatible recovery (#144, ADR 0021,
 * docs/support-operations-design.md#release-and-compatibility-procedure).
 *
 * 1. `release-verify` records a candidate's gates from GitHub's own run records
 *    (src/release-gates.ts), with the digest of the files in its exact bytes.
 * 2. `fleet-launch` dispatches the approved release to every eligible Slot
 *    together, only after the compatible Worker and its additive migrations are
 *    deployed: the gated deployment of the release's Worker commit to this stage,
 *    a live migration state of reviewed migrations within the release's tested
 *    range, and a compatible recovery package (or a recorded rollback boundary).
 *    The dispatch time is the actual start, and the previous release's 24 hours
 *    run from it. There are no cohorts or per-installation approvals.
 * 3. Each Slot's outcome is tracked separately (`fleet-status`): central
 *    applications by their verified read-back of every file, native ones by the
 *    signed digest of their installed files. Dispatch, an attempt or a matching
 *    version alone is never completion, and stale or unreachable Slots are unknown.
 *    `fleet-run` applies the release to central Slots with bounded concurrency and
 *    attempts, reconciling unknown or abandoned applications by read-back first.
 * 4. `release-withdraw` stops distributing a bad release at once and dispatches a
 *    previously verified, launched package compatible with the live contract and
 *    schema as the approved recovery release. Nothing reverses migrations or
 *    restores D1; with no compatible package, it refuses: repair forward.
 * 5. `release-boundary` records that rollback below the current release is given
 *    up from a schema migration on, only once every Slot verified that release
 *    and its previous release's window ended. Only then may a destructive migration
 *    at or after that floor be live for a launch.
 */

/** Migrations through 0029 predate any approved release: their table rebuilds needed no rollback boundary. */
export const FLEET_SCHEMA_BASELINE = 29;
/** Central applications of one release to one Slot that may have changed it, before an Operator must look. */
export const MAX_CENTRAL_ATTEMPTS = 3;
/** Central applications run at once by `fleet-run`. */
export const FLEET_CONCURRENCY = 4;
/**
 * A native Slot that has not signed a request for this long is unknown, not pending: the
 * inventory's display rule (OBSERVATION_STALE_MS in src/inventory.ts), not a service objective.
 */
export const NATIVE_STALE_MS = 24 * 3_600_000;

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const RELEASE_ID = /^[1-9][0-9]{0,8}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;

/** One reviewed migration as the Operator's checkout holds it (worker/migrations, checksums.txt). */
export interface ReviewedMigration { readonly name: string; readonly sha256: string; readonly sql: string }

const numberOf = (name: string) => /^(\d{4})_[a-z0-9_]+(\.sql)?$/.exec(name) ? Number(name.slice(0, 4)) : null;
/** Removes or rewrites existing structures or data: needs a rollback boundary once past the baseline. */
export const isDestructive = (sql: string) => /\b(DROP\s+(TABLE|COLUMN|VIEW|INDEX)|RENAME\b|DELETE\s+FROM|UPDATE\s+\w+\s+SET)/i
  .test(sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n"));

export interface LiveSchema {
  readonly state: "ok" | "unreviewed" | "mismatch" | "unreadable";
  readonly live: number | null;
  readonly reason: string | null;
  /** Post-baseline destructive migrations that are live. */
  readonly destructive: readonly number[];
}

/**
 * The live migration state from Alchemy's own record of applied migrations
 * (`__alchemy_migrations`: name and SHA-256 of each applied file), compared
 * with the reviewed migrations. Only a gapless run of reviewed migrations with
 * their reviewed checksums is `ok`; anything else is never compatible.
 */
export const readLiveSchema = async (query: OperatorOptions["query"], reviewed: readonly ReviewedMigration[] | undefined): Promise<LiveSchema> => {
  const fail = (state: LiveSchema["state"], reason: string): LiveSchema => ({ state, live: null, reason, destructive: [] });
  if (!reviewed || reviewed.length === 0) return fail("unreadable", "no reviewed migrations were given to this Operator command");
  const applied = await query("SELECT name, hash FROM __alchemy_migrations ORDER BY id", []).catch(() => null);
  if (!applied) return fail("unreadable", "the live migration record could not be read");
  const byNumber = new Map(reviewed.map((migration) => [numberOf(migration.name), migration]));
  const seen: number[] = [];
  for (const row of applied) {
    const number = typeof row.name === "string" ? numberOf(row.name) : null;
    const migration = number === null ? undefined : byNumber.get(number);
    if (!migration || migration.name.replace(/\.sql$/, "") !== String(row.name).replace(/\.sql$/, "")) return fail("unreviewed", "a live migration is not a reviewed one");
    if (row.hash !== migration.sha256) return fail("mismatch", `live migration ${String(number).padStart(4, "0")} differs from its reviewed checksum`);
    seen.push(number!);
  }
  if (seen.length === 0 || seen.some((number, index) => number !== index + 1)) return fail("mismatch", "the live migrations are not a gapless run from 0001");
  const live = seen.length;
  const destructive = seen.filter((number) => number > FLEET_SCHEMA_BASELINE && isDestructive(byNumber.get(number)!.sql));
  return { state: "ok", live, reason: null, destructive };
};

const recordSchema = (query: OperatorOptions["query"], schema: LiveSchema, actor: string, now: number) =>
  query("INSERT INTO schema_observation (observed_at, state, live_schema, reason, observed_by) VALUES (?, ?, ?, ?, ?)",
    [now, schema.state, schema.live ?? -1, schema.reason ?? "", actor]).then(() => undefined);

interface Package { package_version: string; contract_version: number; schema_from: number; schema_to: number }
const served = (row: Package) => row.contract_version >= SUPPORTED_CONTRACTS.min && row.contract_version <= SUPPORTED_CONTRACTS.max;

/** The highest recorded rollback boundary's schema floor, or 0. */
const boundaryFloor = async (query: OperatorOptions["query"]) =>
  Number((await query("SELECT COALESCE(MAX(schema_floor), 0) AS floor FROM rollback_boundary", []))[0]?.floor ?? 0);

/**
 * Why a package cannot be the recovery release on this live schema, or null.
 * It must serve this Worker's contract, have been verified against a schema no
 * newer than the live one, not be below a rollback boundary, and every live
 * migration past its tested range must be additive.
 */
export const recoveryProblem = (row: Package, schema: LiveSchema, floor: number): string | null => {
  if (schema.state !== "ok" || schema.live === null) return `the live schema is ${schema.state}`;
  if (!served(row)) return "this Worker does not serve its contract version";
  if (row.schema_from > schema.live) return `it needs schema ${row.schema_from}, newer than the live ${schema.live}`;
  if (row.schema_to < floor) return `it is below the recorded rollback boundary at schema ${floor}`;
  const unsafe = schema.destructive.find((number) => number > row.schema_to);
  return unsafe === undefined ? null : `live migration ${String(unsafe).padStart(4, "0")} removes structures it was not verified without`;
};

// ---------------------------------------------------------------------------------------------
// Per-Slot rollout state.

export type SlotRolloutState = "verified" | "failed" | "unknown" | "applying" | "attempted" | "pending" | "unreachable" | "blocked" | "offboarded";
export interface SlotRollout {
  readonly slot: string;
  readonly method: DeploymentMethod | null;
  readonly desired_version: string;
  readonly state: SlotRolloutState;
  readonly reason: string | null;
  /** The last attempt at this release on this Slot, if any. */
  readonly attempted_at: string | null;
  /** When the installed files were verified to be exactly this release's. */
  readonly verified_at: string | null;
}

interface Launch { sequence: number; package_version: string; kind: string; package_sha256: string; files_sha256: string;
  dispatched_at: number | null; compatibility_expires_at: number | null; launched_at: number }

const iso = (time: number | null | undefined) => time === null || time === undefined ? null : new Date(Number(time)).toISOString();

/** A release's launch record with what verifies it, or null if it was not launched. */
const launchOf = async (db: QueryDatabase, sequence: number) => db.prepare(`SELECT a.sequence, a.package_version, a.kind, c.package_sha256,
    v.files_sha256, d.dispatched_at, d.compatibility_expires_at, f.launched_at FROM release_approval a
    JOIN release_candidate c ON c.package_version = a.package_version JOIN release_verification v ON v.package_version = a.package_version
    JOIN fleet_launch f ON f.sequence = a.sequence LEFT JOIN release_dispatch d ON d.sequence = a.sequence WHERE a.sequence = ?`)
  .bind(sequence).first<Launch>();

/**
 * Every mapped Slot's state for one launched release. `targets`, when given, are
 * the stage's reviewed central targets, so a missing or unsupported one shows
 * as blocked rather than pending.
 */
export const rolloutStatus = async (db: QueryDatabase, mappings: readonly RepositoryMapping[], sequence: number, now: number,
  targets?: readonly CentralTarget[]) => {
  const launch = await launchOf(db, sequence);
  if (!launch) return null;
  const all = <T>(sql: string, ...values: (string | number)[]) => db.prepare(sql).bind(...values).all<T>().then((result) => result.results);
  const [central, files, attempts, signed, grants, offboarded, later] = await Promise.all([
    all<{ slot: string; outcome: string | null; reason: string | null; started_at: number; finished_at: number | null; installed: number }>(
      `SELECT slot, outcome, reason, started_at, finished_at, installed FROM central_deployment WHERE release_sequence = ? ORDER BY started_at, rowid`, sequence),
    all<{ slot: string; version: string; files_sha256: string; observed_at: number }>(`SELECT slot, version, files_sha256, observed_at FROM slot_installed_files
      WHERE observed_at >= ?`, launch.launched_at),
    all<{ slot: string; version: string; attempted_at: number }>("SELECT slot, version, attempted_at FROM slot_update_attempt"),
    all<{ slot: string; version: string; observed_at: number }>("SELECT slot, version, observed_at FROM slot_signed_version"),
    all<{ slot: string; active: number }>(`SELECT g.slot, (g.expires_at > ? AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)) AS active
      FROM update_access_grant g WHERE NOT EXISTS (SELECT 1 FROM update_access_grant n WHERE n.slot = g.slot AND n.rowid > g.rowid)`, now),
    all<{ slot: string }>(`SELECT slot FROM offboarding UNION SELECT reference FROM delivery_suppression WHERE scope = 'slot' AND reason = 'offboarding'`),
    // A later central read-back of another version: the Slot changed since it was verified.
    all<{ slot: string; finished_at: number; observed_version: string }>(`SELECT slot, finished_at, observed_version FROM central_deployment
      WHERE observed_version IS NOT NULL AND release_sequence <> ?`, sequence),
  ]);
  const version = launch.package_version;
  const slotOf = (mapping: RepositoryMapping): SlotRollout => {
    const base = { slot: mapping.slot, method: mapping.deployment ?? null, desired_version: version, attempted_at: null, verified_at: null };
    const shape = (state: SlotRolloutState, reason: string | null = null, extra: Partial<SlotRollout> = {}): SlotRollout => ({ ...base, state, reason, ...extra });
    if (offboarded.some((row) => row.slot === mapping.slot)) return shape("offboarded");
    if (mapping.deployment === "central") {
      const target = targets?.find((candidate) => candidate.slot === mapping.slot);
      const rows = central.filter((row) => row.slot === mapping.slot);
      const latest = rows.at(-1);
      const attempted = iso(rows.filter((row) => row.installed === 1 || row.outcome === null).at(-1)?.started_at);
      if (!latest) {
        if (targets && !target) return shape("blocked", "no_central_target");
        if (target && target.source !== "plugin-directory") return shape("blocked", "managed_source_unsupported");
        if (target && targetProblem(target)) return shape("blocked", "invalid_central_target");
        return shape("pending");
      }
      const at = { attempted_at: attempted };
      if (latest.outcome === "verified") {
        const changed = later.find((row) => row.slot === mapping.slot && row.finished_at > latest.finished_at! && row.observed_version !== version);
        return changed ? shape("unknown", "changed_since_verified", at) : shape("verified", null, { ...at, verified_at: iso(latest.finished_at) });
      }
      if (latest.outcome === null) return latest.started_at > now - CENTRAL_LEASE_MS ? shape("applying", null, at) : shape("unknown", "abandoned", at);
      if (latest.outcome === "unknown") return shape("unknown", latest.reason, at);
      if (latest.outcome === "failed") return shape("failed", latest.reason, at);
      if (latest.outcome === "unreachable") return shape("unreachable", latest.reason, at);
      return latest.reason === "superseded" ? shape("pending", null, at) : shape("blocked", latest.reason, at);
    }
    if (mapping.deployment === "native") {
      const grant = grants.find((row) => row.slot === mapping.slot);
      const attempt = attempts.find((row) => row.slot === mapping.slot && row.version === version && row.attempted_at >= launch.launched_at);
      const at = { attempted_at: iso(attempt?.attempted_at) };
      const observed = files.filter((row) => row.slot === mapping.slot).at(-1);
      if (observed?.version === version) {
        return observed.files_sha256 === launch.files_sha256 ? shape("verified", null, { ...at, verified_at: iso(observed.observed_at) })
          : shape("failed", "files_mismatch", at);
      }
      if (Number(grant?.active ?? 0) !== 1) return shape("blocked", "no_update_access", at);
      const contact = Math.max(observed?.observed_at ?? 0, signed.find((row) => row.slot === mapping.slot)?.observed_at ?? 0);
      const signedVersion = signed.find((row) => row.slot === mapping.slot && row.observed_at >= launch.launched_at)?.version;
      // A matching signed version without its files' digest is not a verified package (a plugin before gq-support-update-v2).
      if (signedVersion === version) return shape("unknown", "files_unreported", at);
      if (now - Math.max(contact, launch.launched_at) > NATIVE_STALE_MS) return shape("unknown", "stale", at);
      return attempt ? shape("attempted", null, at) : shape("pending");
    }
    // A manual install has no automated path to update or verify it.
    return shape("blocked", mapping.deployment === "manual" ? "manual_deployment" : "no_deployment_method");
  };
  const slots = mappings.map(slotOf);
  const scope = slots.filter((slot) => slot.state !== "offboarded");
  const counts = Object.fromEntries(["verified", "failed", "unknown", "applying", "attempted", "pending", "unreachable", "blocked", "offboarded"]
    .map((state) => [state, slots.filter((slot) => slot.state === state).length]));
  const expires = launch.compatibility_expires_at;
  return {
    release_id: launch.sequence, version, kind: launch.kind, package_sha256: launch.package_sha256,
    launched_at: iso(launch.launched_at), dispatched_at: iso(launch.dispatched_at), compatibility_expires_at: iso(expires),
    // The previous approved release keeps new intake until exactly this time (src/release-policy.ts).
    previous_window: expires === null ? "not_dispatched" : now < expires ? "open" : "expired",
    counts,
    // Every Slot still served verified exactly this release: unknown, stale, unreachable or blocked Slots are not done.
    converged: scope.length > 0 && scope.every((slot) => slot.state === "verified"),
    slots,
  };
};

// ---------------------------------------------------------------------------------------------
// Operator commands.

const USAGE = "Usage: operator release-verify <package-version> <artifact-directory> <ci-run-id> <staging-deploy-run-id> <opaque-actor>"
  + " | fleet-launch <release-id> <deploy-run-id> <opaque-actor> | fleet-status [release-id] | fleet-run <release-id> <artifact-directory> <opaque-actor>"
  + " | release-withdraw <release-id> <recovery-version> <deploy-run-id> <opaque-actor> | release-boundary <release-id> <schema-floor> <opaque-actor>";

/** Refused before any change; the message says exactly what is missing. */
export class FleetRefusal extends Error {}

const need = <T>(value: T | undefined | null, missing: string): T => {
  if (value === undefined || value === null) throw new FleetRefusal(`Not configured: ${missing}. Nothing was changed.`);
  return value;
};

const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A withdrawn version: one a recovery approval replaced. It is never offered or recovered to again. */
const WITHDRAWN = `EXISTS (SELECT 1 FROM release_approval w JOIN release_approval r ON r.previous_sequence = w.sequence AND r.kind = 'recovery'
  WHERE w.package_version = c.package_version)`;

/**
 * Writes the launch, then the dispatch that starts distribution: one conditional
 * statement each, so the release must still be the approved one, verified with
 * these bytes. A launch whose dispatch was lost is completed by running it again.
 */
const launch = async (query: OperatorOptions["query"], sequence: number, live: number, evidence: object, actor: string, now: number) => {
  await query(`INSERT INTO fleet_launch (sequence, live_schema, evidence, launched_by, launched_at)
    SELECT a.sequence, ?, ?, ?, ? FROM release_approval a JOIN release_candidate c ON c.package_version = a.package_version
    JOIN release_verification v ON v.package_version = c.package_version AND v.package_sha256 = c.package_sha256
    WHERE a.sequence = ? AND a.sequence = (SELECT MAX(sequence) FROM release_approval)
    ON CONFLICT (sequence) DO NOTHING`, [live, JSON.stringify(evidence), actor, now, sequence]);
  const [dispatched] = await query(`INSERT INTO release_dispatch (sequence, dispatched_at, compatibility_expires_at, evidence, recorded_by, recorded_at)
    SELECT f.sequence, ?, ?, 'fleet-launch', ?, ? FROM fleet_launch f WHERE f.sequence = ? AND f.sequence = (SELECT MAX(sequence) FROM release_approval)
    ON CONFLICT (sequence) DO NOTHING RETURNING sequence`, [now, now + COMPATIBILITY_WINDOW_MS, actor, now, sequence]);
  if (!dispatched) throw new FleetRefusal("Not dispatched: the release is no longer the approved one, or its dispatch is already recorded; check fleet-status.");
};

/** The Slots a launch targets: every mapped, not offboarded Slot, recorded with its deployment method. */
const targetsOf = (mappings: readonly RepositoryMapping[]) => mappings.map((mapping) => ({ slot: mapping.slot, method: mapping.deployment ?? null }));

/**
 * Runs `work` over `items` with at most `limit` at once, stopping new work once
 * `halt` says so; whatever already started finishes and is recorded.
 */
const pool = async <T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>, halt: () => boolean) => {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !halt()) results.push(await work(items[next++]!));
  }));
  return results;
};

export const runFleetOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, mappings, now = Date.now() } = options;
  const db = asQueryDatabase(query);
  const [command] = args;

  if (command === "release-verify" && args.length === 6) {
    const [, version, directory, ci, staging, actor] = args;
    if (!PLUGIN_VERSION.test(version!) || !RUN_ID.test(ci!) || !RUN_ID.test(staging!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const evidence = need(options.evidence, "GitHub workflow evidence access for this Operator command");
    const readArtifact = need(options.readArtifact, "release artifact access for this Operator command");
    const [candidate] = await query("SELECT package_sha256, provenance, worker_commit FROM release_candidate WHERE package_version = ?", [version!]);
    if (!candidate) throw new FleetRefusal("No published candidate records this version; record it with release-candidate first.");
    const artifact = await readArtifact(directory!);
    if (await hex(artifact.zip) !== candidate.package_sha256) throw new FleetRefusal("The artifact's bytes are not the candidate's; nothing was recorded.");
    const files = await filesDigest(await packageFiles(artifact.zip));
    const gates = await verifyReleaseGates(evidence, { provenance: String(candidate.provenance), worker_commit: String(candidate.worker_commit) },
      { ci: ci!, staging: staging! });
    const [recorded] = await query(`INSERT INTO release_verification (package_version, package_sha256, files_sha256, evidence, verified_by, verified_at)
      SELECT package_version, package_sha256, ?, ?, ?, ? FROM release_candidate WHERE package_version = ? AND package_sha256 = ?
      ON CONFLICT (package_version) DO NOTHING RETURNING package_version`,
    [files, JSON.stringify(gates), actor!, now, version!, String(candidate.package_sha256)]);
    if (!recorded) {
      const [existing] = await query("SELECT files_sha256 FROM release_verification WHERE package_version = ?", [version!]);
      if (existing?.files_sha256 !== files) throw new FleetRefusal("This version's gates are already recorded for other files.");
    }
    return JSON.stringify({ package_version: version, files_sha256: files, gates });
  }

  if (command === "fleet-launch" && args.length === 4) {
    const [, release, run, actor] = args;
    if (!RELEASE_ID.test(release!) || !RUN_ID.test(run!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const stage = need(options.stage, "the Operator's target stage");
    const evidence = need(options.evidence, "GitHub workflow evidence access for this Operator command");
    const { current, previous } = await approvedReleases(db);
    if (!current || current.sequence !== Number(release)) throw new FleetRefusal("Only the approved release is launched; check release-status for its release ID.");
    if (current.dispatched_at !== null) throw new FleetRefusal("This release's fleet dispatch is already recorded; check fleet-status.");
    if (current.kind !== "production") throw new FleetRefusal("A recovery release is launched by release-withdraw.");
    const [verified] = await query("SELECT files_sha256 FROM release_verification WHERE package_version = ? AND package_sha256 = ?",
      [current.package_version, current.package_sha256 ?? ""]);
    const failures: Record<string, string> = {};
    if (!verified) failures.gates = "no verified release gates are recorded for these bytes; run release-verify";
    const deployment = await deploymentEvidence(evidence, run!, stage, current.worker_commit!);
    if (typeof deployment === "string") failures.infrastructure = `the ${stage} deployment run ${deployment}`;
    const schema = await readLiveSchema(query, options.migrations);
    await recordSchema(query, schema, actor!, now);
    const floor = await boundaryFloor(query);
    const row = current as unknown as Package;
    if (schema.state !== "ok") failures.schema = schema.reason!;
    else if (!served(row)) failures.compatibility = "this Worker does not serve the release's contract version";
    else if (schema.live! < row.schema_from || schema.live! > row.schema_to) {
      failures.compatibility = `the live schema ${schema.live} is outside the release's tested range ${row.schema_from}-${row.schema_to}`;
    } else {
      const unbounded = schema.destructive.find((number) => number < floor || floor === 0);
      if (unbounded !== undefined) failures.compatibility = `live migration ${String(unbounded).padStart(4, "0")} is destructive and no rollback boundary allows it`;
    }
    // The approved recovery path: the previous approved release, unless a recorded boundary gave it up.
    const recovery = previous === null ? "none: first approved release; recover with the local fail-safe or forward repair"
      : previous.schema_to! < floor ? `none: below the rollback boundary at schema ${floor}; repair forward`
      : recoveryProblem(previous as unknown as Package, schema, floor);
    if (previous !== null && previous.schema_to! >= floor && recovery !== null) failures.recovery = `previous release ${previous.package_version}: ${recovery}`;
    if (Object.keys(failures).length > 0) throw new GateRefusal(failures);
    await launch(query, current.sequence, schema.live!, { deployment, targets: targetsOf(mappings),
      recovery: previous && recovery === null ? { release_id: previous.sequence, version: previous.package_version } : recovery }, actor!, now);
    return JSON.stringify(await rolloutStatus(db, mappings, current.sequence, now, options.central?.targets));
  }

  if (command === "fleet-status" && args.length <= 2) {
    const sequence = args[1] ?? String((await offeredRelease(db))?.sequence ?? "");
    if (!RELEASE_ID.test(sequence)) return JSON.stringify({ release: null, reason: "no dispatched approved release" });
    const status = await rolloutStatus(db, mappings, Number(sequence), now, options.central?.targets);
    if (!status) throw new FleetRefusal("This release was not launched.");
    return JSON.stringify(status);
  }

  if (command === "fleet-run" && args.length === 4) {
    const [, release, directory, actor] = args;
    if (!RELEASE_ID.test(release!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const central = need(options.central, "a central deployment transport for this Operator command");
    const readArtifact = need(options.readArtifact, "release artifact access for this Operator command");
    const offered = await offeredRelease(db);
    if (!offered || offered.sequence !== Number(release)) throw new FleetRefusal("Only the dispatched approved release is applied; check fleet-status.");
    const status = (await rolloutStatus(db, mappings, offered.sequence, now, central.targets))!;
    const packages = central.packages ?? artifactPackages(readArtifact, directory!);
    let halted = false;
    const due = status.slots.filter((slot) => slot.method === "central" && ["pending", "unreachable", "failed", "unknown"].includes(slot.state));
    const results = await pool(due, FLEET_CONCURRENCY, async (slot) => {
      // An install that may have happened is read back first, never repeated blindly.
      const mode = slot.state === "unknown" ? "reconcile" as const : "apply" as const;
      if (mode === "apply") {
        const [{ attempts }] = await query(`SELECT COUNT(*) AS attempts FROM central_deployment WHERE slot = ? AND release_sequence = ?
          AND (installed = 1 OR outcome IS NULL)`, [slot.slot, offered.sequence]) as [{ attempts: number }];
        if (Number(attempts) >= MAX_CENTRAL_ATTEMPTS) return { slot: slot.slot, action: "skipped", reason: "attempts_exhausted" };
      }
      try {
        const result: CentralResult = await applyCentralRelease({ slot: slot.slot, releaseId: offered.sequence, actor: actor!, mappings,
          targets: central.targets, transport: central.transport, packages, query, now, mode });
        // Withdrawn or superseded meanwhile: start nothing more for this release.
        if (!result.still_approved) halted = true;
        return { slot: slot.slot, action: mode, outcome: result.outcome, reason: result.reason, still_approved: result.still_approved };
      } catch (error) {
        if (error instanceof CentralRefusal) return { slot: slot.slot, action: "refused", reason: error.message };
        throw error;
      }
    }, () => halted);
    return JSON.stringify({ release_id: offered.sequence, halted, applications: results,
      status: await rolloutStatus(db, mappings, offered.sequence, now, central.targets) });
  }

  if (command === "release-withdraw" && args.length === 5) {
    const [, release, version, run, actor] = args;
    if (!RELEASE_ID.test(release!) || !PLUGIN_VERSION.test(version!) || !RUN_ID.test(run!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const stage = need(options.stage, "the Operator's target stage");
    const evidence = need(options.evidence, "GitHub workflow evidence access for this Operator command");
    const { current } = await approvedReleases(db);
    if (!current || current.sequence !== Number(release)) throw new FleetRefusal("Only the approved release is withdrawn; check release-status for its release ID.");
    if (current.package_version === version) throw new FleetRefusal("The recovery package must be another version than the withdrawn one.");
    const [candidate] = await query(`SELECT c.package_version, c.contract_version, c.schema_from, c.schema_to, ${WITHDRAWN} AS withdrawn,
        EXISTS (SELECT 1 FROM release_verification v WHERE v.package_version = c.package_version AND v.package_sha256 = c.package_sha256) AS verified,
        EXISTS (SELECT 1 FROM release_approval a JOIN fleet_launch f ON f.sequence = a.sequence WHERE a.package_version = c.package_version) AS launched
      FROM release_candidate c WHERE c.package_version = ?`, [version!]);
    // Never because an older version merely exists: it must have passed its gates and been launched before.
    if (!candidate || Number(candidate.verified) !== 1 || Number(candidate.launched) !== 1) {
      throw new FleetRefusal("Refused: the recovery package must be a verified release launched before; nothing was changed.");
    }
    if (Number(candidate.withdrawn) === 1) throw new FleetRefusal("Refused: that version was itself withdrawn; nothing was changed.");
    const schema = await readLiveSchema(query, options.migrations);
    await recordSchema(query, schema, actor!, now);
    const problem = recoveryProblem(candidate as unknown as Package, schema, await boundaryFloor(query));
    if (problem) {
      throw new FleetRefusal(`Refused: ${version} is not compatible with the live service (${problem}). Nothing was changed; migrations and D1 are never rolled back. Repair forward.`);
    }
    // The live Worker that will serve the recovery package, at whatever commit it runs.
    const deployed = await evidence.run(run!);
    const deployment = await deploymentEvidence(evidence, run!, stage, deployed?.head_sha ?? "");
    if (typeof deployment === "string") throw new GateRefusal({ infrastructure: `the ${stage} deployment run ${deployment}` });
    // The suppression ledger first (ledger-migrations/0003): a restore of the main database can then never make the
    // withdrawn version current again unnoticed, since service cannot resume while it is (src/maintenance.ts).
    if (options.ledger) {
      await options.ledger(`INSERT INTO release_withdrawal (package_version, release_sequence, withdrawn_by, withdrawn_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (package_version) DO NOTHING`, [current.package_version, current.sequence, actor!, now]);
    }
    // One statement: the bad release is still the approved one, and the recovery package still qualifies. From here the
    // bad release is withdrawn: nothing offers or serves it, though the recovery is not dispatched until the launch below.
    const [approved] = await query(`INSERT INTO release_approval (sequence, package_version, kind, previous_sequence, evidence, approved_by, approved_at)
      SELECT ? + 1, c.package_version, 'recovery', ?, ?, ?, ? FROM release_candidate c
      WHERE c.package_version = ? AND (SELECT MAX(sequence) FROM release_approval) = ? AND NOT ${WITHDRAWN}
        AND EXISTS (SELECT 1 FROM release_verification v WHERE v.package_version = c.package_version AND v.package_sha256 = c.package_sha256)
        AND EXISTS (SELECT 1 FROM release_approval a JOIN fleet_launch f ON f.sequence = a.sequence WHERE a.package_version = c.package_version)
      RETURNING sequence`, [current.sequence, current.sequence, `withdraws release ${current.sequence}`, actor!, now, version!, current.sequence]);
    if (!approved) throw new FleetRefusal("The approved release changed meanwhile; check release-status.");
    const sequence = Number(approved.sequence);
    await launch(query, sequence, schema.live!, { deployment, targets: targetsOf(mappings), withdraws: current.sequence }, actor!, now);
    return JSON.stringify({ withdrawn: { release_id: current.sequence, version: current.package_version },
      recovery: await rolloutStatus(db, mappings, sequence, now, options.central?.targets) });
  }

  if (command === "release-boundary" && args.length === 4) {
    const [, release, floor, actor] = args;
    if (!RELEASE_ID.test(release!) || !/^[0-9]{1,4}$/.test(floor!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const offered = await offeredRelease(db);
    if (!offered || offered.sequence !== Number(release)) throw new FleetRefusal("Only the dispatched approved release can set a rollback boundary.");
    const status = (await rolloutStatus(db, mappings, offered.sequence, now, options.central?.targets))!;
    if (!status.converged) throw new FleetRefusal("Refused: not every Slot verified this release; unknown, stale, unreachable and blocked Slots are not confirmation.");
    if (status.previous_window !== "expired") throw new FleetRefusal("Refused: the previous release's 24-hour window is still open.");
    if (Number(floor) <= FLEET_SCHEMA_BASELINE || Number(floor) > (offered.schema_to ?? 0) + 1) {
      throw new FleetRefusal(`The schema floor must be after ${FLEET_SCHEMA_BASELINE} and at most one past this release's tested range.`);
    }
    await query(`INSERT INTO rollback_boundary (sequence, schema_floor, evidence, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sequence) DO NOTHING`, [offered.sequence, Number(floor), JSON.stringify({ verified: status.counts.verified }), actor!, now]);
    return JSON.stringify({ release_id: offered.sequence, schema_floor: Number(floor), verified_slots: status.counts.verified });
  }
  throw new Error(USAGE);
};

export type { ReleaseRow, DeployedStage, ReleaseEvidence };
