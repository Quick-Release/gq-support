import { stageForSlug, type DeployedStage } from "./repository-mappings.ts";
import { PLUGIN_VERSION } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Plugin release policy (ADR 0021, docs/support-operations-design.md#release-and-compatibility-procedure).
 * Only the approved production release takes new intake, with the previous approved
 * release for up to 24 hours from the approved release's recorded fleet dispatch.
 * Accepted work, retries of it, reads, privacy routes and the installation check
 * are never gated (src/installation-api.ts).
 *
 * - `enforced`: the service refuses new intake from any other version, and fails
 *   closed when no well-formed approved release is recorded.
 * - `staged`: evaluated and reported, but not enforced. It exists only so that
 *   deploying this Worker does not stop installations before a release is
 *   approved; a production stage still `staged` fails readiness.
 */
export type ReleaseEnforcement = "enforced" | "staged";

/**
 * Each deployed stage's reviewed enforcement, changed by reviewed PR. Both stay
 * `staged` until their first approved release and dispatch are recorded
 * (docs/runbooks/support-operations.md#approved-releases-and-intake-enforcement).
 */
export const stageReleaseEnforcement: Readonly<Record<DeployedStage, ReleaseEnforcement>> = { staging: "staged", prod: "staged" };

/** The Worker's own stage's enforcement; any other slug, including none, has none, and new intake fails closed. */
export const releaseEnforcementForSlug = (slug: string): ReleaseEnforcement | null => {
  const stage = stageForSlug(slug);
  return stage ? stageReleaseEnforcement[stage] : null;
};

/** The support API contract versions this Worker serves: an approved release outside them takes no intake. */
export const SUPPORTED_CONTRACTS = { min: 1, max: 1 } as const;
export const COMPATIBILITY_WINDOW_MS = 24 * 3_600_000;

/** One approval with its immutable candidate and recorded dispatch, if any. */
export interface ReleaseRow {
  sequence: number;
  package_version: string;
  kind: string;
  previous_sequence: number | null;
  evidence: string;
  approved_by: string;
  approved_at: number;
  package_sha256: string | null;
  provenance: string | null;
  worker_commit: string | null;
  contract_version: number | null;
  schema_from: number | null;
  schema_to: number | null;
  signs_version: number | null;
  dispatched_at: number | null;
  compatibility_expires_at: number | null;
  dispatch_evidence: string | null;
  dispatched_by: string | null;
}

const RELEASES = `SELECT a.sequence, a.package_version, a.kind, a.previous_sequence, a.evidence, a.approved_by, a.approved_at,
  c.package_sha256, c.provenance, c.worker_commit, c.contract_version, c.schema_from, c.schema_to, c.signs_version,
  d.dispatched_at, d.compatibility_expires_at, d.evidence AS dispatch_evidence, d.recorded_by AS dispatched_by
  FROM release_approval a LEFT JOIN release_candidate c ON c.package_version = a.package_version
  LEFT JOIN release_dispatch d ON d.sequence = a.sequence`;

/** The approved production release and the previous approved one, as recorded. */
export const approvedReleases = async (db: QueryDatabase) => {
  const current = await db.prepare(`${RELEASES} WHERE a.sequence = (SELECT MAX(sequence) FROM release_approval)`).bind().first<ReleaseRow>();
  const previous = current?.previous_sequence == null ? null
    : await db.prepare(`${RELEASES} WHERE a.sequence = ?`).bind(current.previous_sequence).first<ReleaseRow>();
  return { current, previous };
};

/**
 * The staff view of the stage's releases, for the inventory: what is approved and
 * when it was dispatched. A malformed record shows as no approved release.
 */
export const releaseSummary = async (db: QueryDatabase, enforcement: ReleaseEnforcement | null | undefined) => {
  const { current, previous } = await approvedReleases(db);
  const valid = current && wellFormed(current) && (current.previous_sequence === null || (previous && wellFormed(previous)));
  const time = (value: number | null) => value === null ? null : new Date(value).toISOString();
  return {
    enforcement: enforcement ?? "unconfigured",
    approved: valid ? { release_id: current.sequence, package_version: current.package_version, kind: current.kind,
      approved_at: time(current.approved_at), dispatched_at: time(current.dispatched_at),
      compatibility_expires_at: time(current.compatibility_expires_at) } : null,
    previous: valid && previous ? { release_id: previous.sequence, package_version: previous.package_version } : null,
  };
};

const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);

/** Whether a recorded release is complete and consistent; anything else is never trusted. */
const wellFormed = (row: ReleaseRow) => integer(row.sequence) && row.sequence >= 1 &&
  PLUGIN_VERSION.test(row.package_version) && ["production", "recovery"].includes(row.kind) &&
  row.previous_sequence === (row.sequence > 1 ? row.sequence - 1 : null) &&
  /^[a-f0-9]{64}$/.test(row.package_sha256 ?? "") && /^[a-f0-9]{40}$/.test(row.worker_commit ?? "") &&
  typeof row.provenance === "string" && row.provenance !== "" && integer(row.contract_version) &&
  integer(row.schema_from) && integer(row.schema_to) && row.schema_from! <= row.schema_to! && [0, 1].includes(row.signs_version!) &&
  (row.dispatched_at === null ? row.compatibility_expires_at === null
    : integer(row.dispatched_at) && row.compatibility_expires_at === row.dispatched_at + COMPATIBILITY_WINDOW_MS);

/**
 * The release native installations are offered (src/update-access.ts): the
 * approved release once its fleet dispatch is recorded, and only while the
 * record is well formed. A withdrawn release is never offered again.
 */
export const offeredRelease = async (db: QueryDatabase): Promise<ReleaseRow | null> => {
  const { current, previous } = await approvedReleases(db);
  const valid = current && wellFormed(current) && (current.previous_sequence === null || (previous && wellFormed(previous)));
  return valid && current.dispatched_at !== null ? current : null;
};

/** Why new intake is open or closed for a plugin version. */
export type IntakeReason = "current" | "previous" | "unsupported" | "expired" | "unavailable";

/**
 * The policy for one installation's plugin version: what the service enforces,
 * and what WordPress caches for its local controls. `compatible_until` is set
 * only while an enforced previous release's window is running.
 */
export interface ReleasePolicy {
  readonly enforcement: ReleaseEnforcement | "unconfigured";
  readonly intake: "open" | "closed";
  readonly reason: IntakeReason;
  readonly plugin_version: string | null;
  readonly approved_version: string | null;
  readonly compatible_until: string | null;
}

const supported = (row: ReleaseRow) => row.contract_version! >= SUPPORTED_CONTRACTS.min && row.contract_version! <= SUPPORTED_CONTRACTS.max;

/**
 * A signed version matches only a release whose package signs it. A legacy
 * plugin's version is unknown (src/signature.ts), so it matches only a release
 * recorded as a legacy package: any legacy plugin then counts as that release.
 */
const runs = (row: ReleaseRow, pluginVersion: string | null) =>
  pluginVersion === null ? row.signs_version === 0 : row.signs_version === 1 && row.package_version === pluginVersion;

const decide = (current: ReleaseRow, previous: ReleaseRow | null, pluginVersion: string | null, now: number):
  { reason: IntakeReason; until: number | null } => {
  if (runs(current, pluginVersion)) return { reason: supported(current) ? "current" : "unsupported", until: null };
  if (!previous || !runs(previous, pluginVersion) || !supported(previous)) return { reason: "unsupported", until: null };
  // Until the approved release is dispatched, the fleet still runs the previous one.
  if (current.compatibility_expires_at === null) return { reason: "previous", until: null };
  return now < current.compatibility_expires_at ? { reason: "previous", until: current.compatibility_expires_at } : { reason: "expired", until: null };
};

/**
 * Evaluates the recorded policy. When enforced, a storage failure throws: an
 * outage is not a policy. A staged policy never blocks, so it reports one as unavailable.
 */
export const releasePolicy = async (db: QueryDatabase, enforcement: ReleaseEnforcement | null | undefined,
  pluginVersion: string | null, now: number): Promise<ReleasePolicy> => {
  const recorded = enforcement === "staged" ? approvedReleases(db).catch(() => ({ current: null, previous: null })) : approvedReleases(db);
  const { current, previous } = await recorded;
  const valid = current && wellFormed(current) && (current.previous_sequence === null || (previous && wellFormed(previous)));
  const decision = valid ? decide(current, previous, pluginVersion, now) : { reason: "unavailable" as const, until: null };
  const open = decision.reason === "current" || decision.reason === "previous";
  const shown = { plugin_version: pluginVersion, approved_version: valid ? current.package_version : null };
  if (!enforcement) return { enforcement: "unconfigured", intake: "closed", reason: "unavailable", ...shown, compatible_until: null };
  if (enforcement === "staged") return { enforcement, intake: "open", reason: decision.reason, ...shown, compatible_until: null };
  return { enforcement, intake: open ? "open" : "closed", reason: decision.reason, ...shown,
    compatible_until: open && decision.until !== null ? new Date(decision.until).toISOString() : null };
};
