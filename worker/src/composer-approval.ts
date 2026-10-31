import { filesDigest, packageContents } from "./central-deployment.ts";
import { boundaryFloor, readLiveSchema, WITHDRAWN } from "./fleet-rollout.ts";
import { ledgerOffboarded, NOT_OFFBOARDED } from "./offboarding.ts";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { verifiedPackage } from "./release-operator.ts";
import { currentRelease, SUPPORTED_CONTRACTS } from "./release-policy.ts";
import { mappingFor } from "./repository-mappings.ts";

/**
 * The Composer rollout approval record (`gq-support.composer-approval/v1`): what a
 * Composer-managed central Slot may install, for the site deployment tooling that
 * changes its lock and verifies the install (gq-site). The Operator CLI only, read
 * with the Operator's own Cloudflare and GitHub access: no endpoint, signing key or
 * secret exists for it, and the command writes nothing.
 *
 * Nothing is typed in or taken on trust. The record is derived from:
 *
 * - the live service state: serving, the restore replayed, the Slot central and not
 *   offboarded in the main database or the suppression ledger, and the named
 *   release the current approved, verified, signed release, not withdrawn, with a
 *   served contract and a live reviewed schema within its tested range;
 * - the approved release's exact ZIP, whose SHA-256 must be the approved package
 *   hash and whose manifest and provenance must agree with it and with the
 *   approval: its files, their digest and the Composer package name come from those
 *   bytes, never from a manifest;
 * - the published `v<version>` Composer tag in this repository, read through an
 *   authenticated adapter, whose git tree must hold exactly those files. Only then
 *   is the tag's commit reported.
 *
 * `prepare` may run before the fleet dispatch, to prepare a lock change; `deploy`
 * also needs the dispatch, and is a point-in-time observation: the caller runs it
 * again just before each install. Three identities stay distinct: the source commit
 * the release was built from (provenance), the Composer tag's package commit, and
 * the approved ZIP's bytes (a registry may repack its own dist ZIP).
 */

export const COMPOSER_APPROVAL_SCHEMA = "gq-support.composer-approval/v1";
/** The file normalization (src/central-deployment.ts filesDigest): every runtime file, raw bytes, sorted `path NUL sha256 LF`. */
export const FILES_NORMALIZATION = "gq-support.files/v1";
export const COMPOSER_PACKAGE = "getquick/gq-support";

/** One git tree entry as GitHub reports it (`git/trees/<sha>?recursive=1`). */
export interface TreeEntry { readonly path: string; readonly mode: string; readonly type: string; readonly sha: string }
/** A published tag as GitHub records it: the commit it resolves to, and that commit's full tree. */
export interface PublishedTag { readonly commit: string; readonly truncated: boolean; readonly entries: readonly TreeEntry[] }
/** Reads this repository's published tags with the Operator's authenticated GitHub access; null when absent or unreadable. */
export interface PackageTags { read(tag: string): Promise<PublishedTag | null> }

export interface ComposerApproval {
  readonly schema: typeof COMPOSER_APPROVAL_SCHEMA;
  readonly stage: string;
  readonly slot: string;
  readonly phase: "prepare" | "deploy";
  readonly release_id: number;
  readonly package: { readonly name: typeof COMPOSER_PACKAGE; readonly version: string; readonly zip_sha256: string };
  readonly provenance: { readonly source_commit: string; readonly release_run: string };
  readonly published_tag: { readonly name: string; readonly commit: string };
  readonly files: Readonly<Record<string, string>>;
  readonly files_digest: string;
  readonly normalization: typeof FILES_NORMALIZATION;
  readonly observed_at: string;
}

/** Refused: no record is printed, and nothing was changed. */
export class ComposerApprovalRefusal extends Error {
  constructor(reason: string) { super(`Refused: ${reason}. No Composer approval record; nothing was changed.`); }
}

const RELEASE_ID = /^[1-9][0-9]{0,8}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const USAGE = "Usage: operator composer-approval <slot> <release-id> <artifact-directory> <prepare|deploy>";

const hex = async (algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
/** Git's blob object ID for these bytes. */
const gitBlob = (content: Uint8Array) => {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const object = new Uint8Array(header.length + content.length);
  object.set(header);
  object.set(content, header.length);
  return hex("SHA-1", object);
};

/** Whether the tag's tree holds exactly these files, as regular files with these bytes. */
const treeMatches = async (tag: PublishedTag, files: ReadonlyMap<string, Uint8Array>) => {
  if (tag.truncated !== false || !Array.isArray(tag.entries)) return false;
  const blobs = new Map<string, string>();
  for (const entry of tag.entries) {
    if (entry.type === "tree" && entry.mode === "040000") continue;
    // Symlinks (120000), submodules (160000) and anything else are never the package's files.
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || blobs.has(entry.path)) return false;
    blobs.set(entry.path, entry.sha);
  }
  if (blobs.size !== files.size) return false;
  for (const [path, content] of files) if (blobs.get(path) !== await gitBlob(content)) return false;
  return true;
};

/** Everything the record depends on, read at once; read again at the end, it must not have changed. */
const observe = async (options: OperatorOptions, ledger: OperatorOptions["query"], slot: string) => {
  const { query } = options;
  const [fence] = await ledger(`SELECT e.epoch, m.generation, m.state FROM ledger_epoch e, maintenance m WHERE e.id = 1 AND m.id = 1`, []);
  const [restore] = await query("SELECT epoch FROM restore_state WHERE id = 1", []);
  const current = await currentRelease(asQueryDatabase(query));
  const [main] = await query(`SELECT NOT (${NOT_OFFBOARDED("?")}) AS offboarded`, [slot, slot]);
  const [withdrawn] = current ? await query(`SELECT ${WITHDRAWN} AS withdrawn FROM release_candidate c WHERE c.package_version = ?`, [current.package_version]) : [];
  const ledgerWithdrawn = current ? await ledger("SELECT 1 FROM release_withdrawal WHERE package_version = ?", [current.package_version]) : [];
  return {
    fence: fence ? { epoch: Number(fence.epoch), generation: Number(fence.generation), state: String(fence.state) } : null,
    replayed: restore ? Number(restore.epoch) : null,
    offboarded: Number(main?.offboarded ?? 1) === 1 || await ledgerOffboarded(asQueryDatabase(ledger), slot),
    current,
    withdrawn: Number(withdrawn?.withdrawn ?? 0) === 1 || ledgerWithdrawn.length > 0,
  };
};

/** The approval record for one Slot and release (see the module comment), or a refusal. */
export const composerApproval = async (args: readonly string[], options: OperatorOptions): Promise<ComposerApproval> => {
  const [, slot, releaseId, directory, phase] = args;
  if (args.length !== 5 || !RELEASE_ID.test(releaseId!) || !directory || (phase !== "prepare" && phase !== "deploy")) throw new Error(USAGE);
  const { stage, ledger, readArtifact, packageTags, migrations, now = Date.now() } = options;
  if (!stage) throw new ComposerApprovalRefusal("this Operator command has no reviewed target stage");
  if (!ledger) throw new ComposerApprovalRefusal("the suppression ledger is required (--ledger-database-id)");
  if (!readArtifact) throw new ComposerApprovalRefusal("this Operator boundary cannot read release artifacts");
  if (!packageTags) throw new ComposerApprovalRefusal("this Operator boundary cannot read the published Composer tags");
  const mapping = mappingFor(options.mappings, slot!);
  if (!mapping) throw new ComposerApprovalRefusal("unknown Slot; add its Repository mapping by reviewed PR first");
  if (mapping.deployment !== "central") throw new ComposerApprovalRefusal("this Slot's reviewed deployment method is not central");

  const state = await observe(options, ledger, slot!).catch(() => null);
  if (!state || !state.fence || state.replayed === null) throw new ComposerApprovalRefusal("the maintenance boundary, restore epoch or release records cannot be read");
  if (state.replayed < state.fence.epoch) throw new ComposerApprovalRefusal("a recorded restore is not replayed yet; see maintenance-status");
  if (state.fence.state !== "serving") throw new ComposerApprovalRefusal("maintenance is in effect; see maintenance-status");
  if (state.offboarded) throw new ComposerApprovalRefusal("this Slot is offboarded; check offboard-status");
  const release = state.current;
  if (!release || release.sequence !== Number(releaseId)) {
    throw new ComposerApprovalRefusal("only the current approved release has a record; check release-status for its release ID");
  }
  if (state.withdrawn) throw new ComposerApprovalRefusal("this release was withdrawn");
  if (release.signs_version !== 1) throw new ComposerApprovalRefusal("an unsigned legacy package is never rolled out by Composer");
  if (release.contract_version! < SUPPORTED_CONTRACTS.min || release.contract_version! > SUPPORTED_CONTRACTS.max) {
    throw new ComposerApprovalRefusal("this Worker does not serve the release's contract version");
  }
  if (release.files_sha256 === null) throw new ComposerApprovalRefusal("no verified release gates are recorded for these bytes; run release-verify");
  if (phase === "deploy" && release.dispatched_at === null) throw new ComposerApprovalRefusal("the release's fleet dispatch is not recorded; only prepare is possible");
  const schema = await readLiveSchema(options.query, migrations);
  if (schema.state !== "ok") throw new ComposerApprovalRefusal(`the live schema is not the reviewed one (${schema.reason})`);
  if (schema.live! < release.schema_from! || schema.live! > release.schema_to!) {
    throw new ComposerApprovalRefusal(`the live schema ${schema.live} is outside the release's tested range ${release.schema_from}-${release.schema_to}`);
  }
  const floor = await boundaryFloor(options.query);
  if (schema.destructive.some((number) => number < floor || floor === 0)) {
    throw new ComposerApprovalRefusal("a live destructive migration has no rollback boundary allowing it");
  }

  // The approved bytes, and only them: every value below is derived from the ZIP itself.
  const artifact = await readArtifact(directory).catch(() => null);
  if (!artifact) throw new ComposerApprovalRefusal("the release artifact cannot be read");
  const verified = await verifiedPackage(artifact).catch(() => null);
  if (!verified) throw new ComposerApprovalRefusal("the artifact's bytes, manifest and provenance do not agree");
  if (verified.sha256 !== release.package_sha256 || verified.version !== release.package_version || verified.provenance !== release.provenance) {
    throw new ComposerApprovalRefusal("the artifact is not the approved release's package");
  }
  const contents = await packageContents(artifact.zip).catch(() => null);
  if (!contents) throw new ComposerApprovalRefusal("the approved package is not a plain gq-support/ ZIP of regular files");
  const files = new Map(await Promise.all([...contents].map(async ([path, content]) => [path, await hex("SHA-256", content)] as const)));
  const digest = await filesDigest(files);
  if (digest !== release.files_sha256) throw new ComposerApprovalRefusal("the package's files are not the verified ones");
  const composer = (() => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(contents.get("composer.json"))) as { name?: unknown }; } catch { return null; }
  })();
  if (composer?.name !== COMPOSER_PACKAGE) throw new ComposerApprovalRefusal(`the package's composer.json does not name ${COMPOSER_PACKAGE}`);

  const tagName = `v${release.package_version}`;
  const tag = await packageTags.read(tagName).catch(() => null);
  if (!tag) throw new ComposerApprovalRefusal(`the published Composer tag ${tagName} cannot be read`);
  if (!COMMIT.test(tag.commit) || !await treeMatches(tag, contents)) {
    throw new ComposerApprovalRefusal(`the published Composer tag ${tagName} does not hold exactly the approved files`);
  }

  // Nothing it depends on changed while it was read.
  const after = await observe(options, ledger, slot!).catch(() => null);
  if (!after || JSON.stringify(after) !== JSON.stringify(state)) throw new ComposerApprovalRefusal("the service or release state changed during the read; run it again");

  return {
    schema: COMPOSER_APPROVAL_SCHEMA, stage, slot: slot!, phase, release_id: release.sequence,
    package: { name: COMPOSER_PACKAGE, version: release.package_version, zip_sha256: verified.sha256 },
    provenance: { source_commit: verified.commit, release_run: verified.run },
    published_tag: { name: tagName, commit: tag.commit },
    files: Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    files_digest: digest, normalization: FILES_NORMALIZATION, observed_at: new Date(now).toISOString(),
  };
};

export const runComposerApprovalOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> =>
  JSON.stringify(await composerApproval(args, options));
