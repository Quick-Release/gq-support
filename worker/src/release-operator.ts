import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { approvedReleases, SIGNED_AFTER_BOOTSTRAP, SUPPORTED_CONTRACTS, type ReleaseRow } from "./release-policy.ts";
import { PLUGIN_VERSION } from "./signature.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
/** A reference to where the evidence lives, such as a reviewed PR or CI run URL; never a credential. */
const EVIDENCE = /^[\x21-\x7e]{1,256}$/;
const COMMIT = /^[a-f0-9]{40}$/;

/** The release workflow's output (scripts/ci/release-package.mjs): the ZIP's bytes and its two JSON records. */
export interface ReleaseArtifact { readonly zip: Uint8Array; readonly manifest: string; readonly provenance: string }

const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const parsed = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release artifact records must be JSON objects");
  return value as Record<string, unknown>;
};

/**
 * Only what the artifacts prove: the version both records name and the SHA-256
 * of the actual bytes, which both records must agree with. Nothing is typed in.
 */
export const verifiedPackage = async (artifact: ReleaseArtifact) => {
  const manifest = parsed(artifact.manifest);
  const provenance = parsed(artifact.provenance);
  const zip = manifest.zip as { size?: unknown; sha256?: unknown } | undefined;
  const digest = await hex(artifact.zip);
  if (manifest.name !== "gq-support" || typeof manifest.version !== "string" || !PLUGIN_VERSION.test(manifest.version) ||
    provenance.version !== manifest.version || zip?.sha256 !== digest || provenance.zip_sha256 !== digest || zip?.size !== artifact.zip.length ||
    typeof provenance.commit !== "string" || !COMMIT.test(provenance.commit) || typeof provenance.run !== "string" || !/^[1-9][0-9]{0,19}$/.test(provenance.run)) {
    throw new Error("The package bytes, manifest and provenance do not agree; record only a verified release workflow's artifacts");
  }
  return { version: manifest.version, sha256: digest, commit: provenance.commit as string, run: provenance.run as string,
    provenance: `release-plugin run ${provenance.run} at ${provenance.commit}` };
};

/** The full restricted record of an approval, for the Operator only. */
const record = (row: ReleaseRow | null) => row && {
  release_id: row.sequence, package_version: row.package_version, kind: row.kind, package_sha256: row.package_sha256,
  provenance: row.provenance, worker_commit: row.worker_commit, contract_version: row.contract_version,
  schema: row.schema_from === null ? null : { from: row.schema_from, to: row.schema_to }, signs_version: row.signs_version === 1,
  previous_release_id: row.previous_sequence, approved_by: row.approved_by, approved_at: new Date(row.approved_at).toISOString(),
  evidence: row.evidence,
  dispatch: row.dispatched_at === null ? null : { dispatched_at: new Date(row.dispatched_at).toISOString(),
    compatibility_expires_at: new Date(row.compatibility_expires_at!).toISOString(), evidence: row.dispatch_evidence, recorded_by: row.dispatched_by },
};

const USAGE = "Usage: operator release-status | release-candidate <artifact-directory> <worker-commit> <contract-version> <schema-from>-<schema-to> <signed|unsigned-legacy> <opaque-actor>"
  + " | release-approve <package-version> production <expected-current-release-id|none> <evidence-ref> <opaque-actor>"
  + "; release-verify, fleet-launch and release-withdraw (src/fleet-rollout.ts) dispatch and recover";

/**
 * The Operator CLI for approved releases (src/release-policy.ts). Each mutation is
 * one append, its own audit row with actor, time and evidence, and never edited:
 *
 * - `release-candidate` records a published package from the release workflow's
 *   verified artifacts, with the Worker commit, contract version and schema
 *   migration range it was verified with. A candidate is not approved.
 * - `release-approve` makes a candidate the approved production release, if the
 *   approved release is still `expected` (so a concurrent approval loses) and
 *   was dispatched.
 *
 * Dispatch and recovery approvals are not typed in here: `fleet-launch` records a
 * dispatch only from verified gates and deployment evidence, at its actual start,
 * and `release-withdraw` approves only a verified, compatible recovery package
 * (src/fleet-rollout.ts).
 */
export const runReleaseOperator = async (args: readonly string[], { query, now = Date.now(), readArtifact, release }: OperatorOptions): Promise<string> => {
  const db = asQueryDatabase(query);
  const [command] = args;
  if (command === "release-status" && args.length === 1) {
    const { current, previous } = await approvedReleases(db);
    const candidates = await query(`SELECT package_version, package_sha256, contract_version, signs_version, recorded_by, recorded_at
      FROM release_candidate ORDER BY recorded_at DESC LIMIT 20`, []);
    return JSON.stringify({ enforcement: release ?? "unconfigured", current: record(current), previous: record(previous),
      candidates: candidates.map((row) => ({ ...row, signs_version: row.signs_version === 1, recorded_at: new Date(Number(row.recorded_at)).toISOString() })) });
  }
  if (command === "release-candidate" && args.length === 7) {
    const [, directory, workerCommit, contract, schema, claim, actor] = args;
    const range = /^(\d{4})-(\d{4})$/.exec(schema!);
    if (!COMMIT.test(workerCommit!) || !/^[1-9][0-9]{0,2}$/.test(contract!) || !range || Number(range[1]) > Number(range[2]) ||
      !["signed", "unsigned-legacy"].includes(claim!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    if (!readArtifact) throw new Error("This Operator boundary cannot read release artifacts");
    const verified = await verifiedPackage(await readArtifact(directory!));
    const [inserted] = await query(`INSERT INTO release_candidate (package_version, package_sha256, provenance, worker_commit, contract_version,
      schema_from, schema_to, signs_version, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (package_version) DO NOTHING RETURNING package_version`, [verified.version, verified.sha256, verified.provenance,
      workerCommit!, Number(contract), Number(range[1]), Number(range[2]), claim === "signed" ? 1 : 0, actor!, now]);
    if (!inserted) {
      // A retry after a lost response finds its own record; other bytes for the same version are refused.
      const [existing] = await query("SELECT package_sha256 FROM release_candidate WHERE package_version = ?", [verified.version]);
      if (existing?.package_sha256 !== verified.sha256) throw new Error("This version is already recorded with other package bytes");
    }
    return JSON.stringify({ package_version: verified.version, package_sha256: verified.sha256, provenance: verified.provenance, state: "candidate" });
  }
  if (command === "release-dispatch") {
    throw new Error("release-dispatch no longer records a dispatch from a typed time and reference: launch the approved release with fleet-launch");
  }
  if (command === "release-approve" && args[2] === "recovery") {
    throw new Error("A recovery release is approved only by release-withdraw, which checks the package is verified and compatible with the live service");
  }
  if (command === "release-approve" && args.length === 6) {
    const [, version, kind, expected, evidence, actor] = args;
    if (!PLUGIN_VERSION.test(version!) || !["production", "recovery"].includes(kind!) || !/^(none|[1-9][0-9]{0,8})$/.test(expected!) ||
      !EVIDENCE.test(evidence!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const [candidate] = await query("SELECT contract_version, signs_version FROM release_candidate WHERE package_version = ?", [version!]);
    if (!candidate) throw new Error("No published candidate records this version; record its verified artifacts with release-candidate first");
    if (Number(candidate.contract_version) < SUPPORTED_CONTRACTS.min || Number(candidate.contract_version) > SUPPORTED_CONTRACTS.max) {
      throw new Error("This Worker does not serve the candidate's contract version; it cannot be approved");
    }
    const base = expected === "none" ? 0 : Number(expected);
    if (Number(candidate.signs_version) !== 1 && (await query(`SELECT 1 FROM release_approval a JOIN release_candidate c
      ON c.package_version = a.package_version WHERE c.signs_version = 1 LIMIT 1`, [])).length) {
      throw new Error("An unsigned legacy release cannot be approved after a signed release; use a signed compatible package");
    }
    // One statement: the compare-and-set on the approved release, the kind's rule and the audit row commit together or not at all.
    const [approved] = await query(`INSERT INTO release_approval (sequence, package_version, kind, previous_sequence, evidence, approved_by, approved_at)
      SELECT ? + 1, c.package_version, ?, NULLIF(?, 0), ?, ?, ? FROM release_candidate c
      WHERE c.package_version = ? AND (SELECT COALESCE(MAX(sequence), 0) FROM release_approval) = ? AND ${SIGNED_AFTER_BOOTSTRAP}
        AND ${kind === "production"
    ? "NOT EXISTS (SELECT 1 FROM release_approval WHERE package_version = c.package_version) AND (? = 0 OR EXISTS (SELECT 1 FROM release_dispatch WHERE sequence = ?))"
    : "EXISTS (SELECT 1 FROM release_approval WHERE package_version = c.package_version) AND NOT EXISTS (SELECT 1 FROM release_approval WHERE sequence = ? AND package_version = c.package_version)"}
      RETURNING sequence`, [base, kind!, base, evidence!, actor!, now, version!, base, ...(kind === "production" ? [base, base] : [base])]);
    if (!approved) {
      const [latest] = await query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM release_approval", []);
      if (Number(latest?.sequence) !== base) throw new Error(`The approved release is now ${latest?.sequence}, not ${expected}; check release-status`);
      throw new Error(kind === "production"
        ? "A production approval needs a version never approved before, after the approved release's dispatch is recorded"
        : "A recovery approval needs an earlier approved version other than the approved release");
    }
    return JSON.stringify({ release_id: approved.sequence, package_version: version, kind, previous_release_id: base || null, approved_at: new Date(now).toISOString() });
  }
  throw new Error(USAGE);
};
