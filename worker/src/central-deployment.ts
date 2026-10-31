import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import type { PackageSource } from "./package-source.ts";
import { offeredRelease, SUPPORTED_CONTRACTS } from "./release-policy.ts";
import { mappingFor, type DeployedStage, type RepositoryMapping } from "./repository-mappings.ts";

/**
 * Central deployment of approved releases (#143): an Operator applies the approved
 * release to one centrally managed Slot (`deployment: "central"`) through the
 * hosting access GETQUICK already holds for that installation, running WP-CLI there.
 * Nothing is installed on the site to do this, so it keeps working when report
 * submission is disabled or the Installation credential is revoked, and hosting
 * credentials never leave the Operator's machine: the runner (for example `ssh`
 * with the Operator's own agent and configuration) authenticates itself.
 *
 * The adapter, per installation, for the fleet coordinator (#144) as well as the CLI:
 *
 * 1. Refuses unless the Slot is reviewed as central with a reviewed target, the
 *    named release is the approved, dispatched one, its contract is served and its
 *    bytes match the approved SHA-256.
 * 2. Records the application in one statement that rechecks the release is still
 *    approved and the Slot is not offboarded or already being applied to.
 * 3. Reads the installation's version (an unreachable host stops here, unchanged),
 *    uploads the verified bytes, checks their digest there, rechecks approval, then
 *    asks WordPress to install exactly that upload.
 * 4. Verifies by reading back the version and every file's SHA-256 against the
 *    approved ZIP's own entries, and records the outcome once: `verified`,
 *    `failed`, `unknown` (the transport was lost after a possible change),
 *    `unreachable` (nothing changed) or `refused` (the target was unsuitable).
 *
 * A version string alone never verifies: the files must be the approved package's.
 */

/**
 * One reviewed central target. Every value is a literal argv token, checked
 * against a shell-safe pattern, because remote runners such as ssh join their
 * arguments into a remote shell command. No credential belongs here.
 */
export interface CentralTarget {
  readonly slot: string;
  /** The command that reaches the installation's host, such as `["ssh", "-o", "BatchMode=yes", "<reviewed-alias>"]`; empty for a local host. */
  readonly runner: readonly string[];
  /** The runner's own connection failure exit status (255 for ssh), which is no answer from the host. */
  readonly runnerFailureExit?: number;
  /** WP-CLI on that host, with its reviewed `--path`. */
  readonly wp: readonly string[];
  /** The installed plugin's absolute directory, ending in `/gq-support`. */
  readonly pluginDirectory: string;
  /** An absolute directory on the host for the uploaded package, removed after install. */
  readonly uploadDirectory: string;
}

/**
 * Each stage's reviewed central targets, added by reviewed PR with the hosting
 * reference that reaches each installation. None is known yet: no central
 * deployment host, alias or path is recorded in this repository, so every
 * central application refuses until one is reviewed.
 */
export const stageCentralTargets: Readonly<Record<DeployedStage, readonly CentralTarget[]>> = { staging: [], prod: [] };

/** What a command did: its exit status and bounded stdout, or no answer at all (spawn failure, timeout, oversize output). */
export type CommandResult = { readonly kind: "exit"; readonly code: number; readonly stdout: string } | { readonly kind: "lost" };

/** Runs one argv on the target, never through a local shell, within the timeout. */
export interface CentralTransport {
  run(argv: readonly string[], options?: { readonly stdin?: Uint8Array; readonly timeoutMs?: number }): Promise<CommandResult>;
}

export type CentralOutcome = "verified" | "failed" | "unknown" | "unreachable" | "refused";

const COMMAND_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 300_000;
/**
 * Longer than one application can run (about ten commands, each bounded): an
 * unfinished record older than this belongs to an Operator process that ended,
 * and no longer blocks a new application. It still counts as attempted.
 */
export const CENTRAL_LEASE_MS = 30 * 60_000;
const TOKEN = /^[A-Za-z0-9@%+=:,./_-]{1,256}$/;
const DIRECTORY = /^(\/[A-Za-z0-9._-]+)+$/;
const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const RELEASE_ID = /^[1-9][0-9]{0,8}$/;
/** A package file path relative to the plugin directory: plain segments only. */
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_FILES = 2_000;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/** Why a reviewed target cannot be used, or null. */
export const targetProblem = (target: CentralTarget): string | null => {
  const tokens = [...target.runner, ...target.wp];
  if (target.wp.length === 0 || !tokens.every((token) => TOKEN.test(token))) return "Its runner and WP-CLI must be shell-safe literal tokens";
  if (target.runnerFailureExit !== undefined && !(Number.isInteger(target.runnerFailureExit) && target.runnerFailureExit > 0 && target.runnerFailureExit < 256)) {
    return "Its runner failure exit status must be 1-255";
  }
  const directories = [target.pluginDirectory, target.uploadDirectory];
  if (!directories.every((path) => DIRECTORY.test(path) && !path.split("/").some((segment) => segment === "." || segment === ".."))) {
    return "Its directories must be absolute plain paths";
  }
  return target.pluginDirectory.endsWith("/gq-support") ? null : "Its plugin directory must be the installed gq-support directory";
};

const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const inflate = async (bytes: Uint8Array) => new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
  .pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());

/**
 * The SHA-256 of every file in an approved release ZIP, by path under its single
 * `gq-support/` root, read from the verified bytes themselves rather than from a
 * separately published manifest. Anything unusual refuses the package.
 */
export const packageFiles = async (zip: Uint8Array): Promise<Map<string, string>> => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const refuse = (): never => { throw new Error("The approved package is not a plain gq-support/ ZIP; it is not applied"); };
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) refuse();
  const count = view.getUint16(end + 10, true);
  if (count === 0xffff || count > MAX_FILES) refuse();
  const files = new Map<string, string>();
  let at = view.getUint32(end + 16, true);
  let unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) refuse();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const mode = view.getUint8(at + 5) === 3 ? view.getUint32(at + 38, true) >>> 16 : 0;
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + skip;
    if ((flags & 1) !== 0 || (mode & 0o170000) === 0o120000) refuse();
    if (name === "gq-support/") continue;
    if (!name.startsWith("gq-support/")) refuse();
    const path = name.slice("gq-support/".length);
    if (path.endsWith("/")) { if (!FILE.test(path.slice(0, -1))) refuse(); continue; }
    if (!FILE.test(path) || files.has(path) || (unpacked += size) > MAX_UNPACKED_BYTES) refuse();
    if (offset + 30 > zip.length || view.getUint32(offset, true) !== 0x04034b50) refuse();
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start + packed > zip.length) refuse();
    const data = zip.subarray(start, start + packed);
    const content = method === 0 ? data : method === 8 ? await inflate(data).catch(refuse) : refuse();
    if (content.length !== size) refuse();
    files.set(path, await hex(content));
  }
  if (!files.has("gq-support.php")) refuse();
  return files;
};

/** Dotted numeric versions compared by segment; anything else is incomparable (null). */
const compare = (left: string, right: string): number | null => {
  if (!/^\d+(\.\d+)*$/.test(left) || !/^\d+(\.\d+)*$/.test(right)) return left === right ? 0 : null;
  const [a, b] = [left.split(".").map(Number), right.split(".").map(Number)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

export interface CentralApplication {
  readonly slot: string;
  /** The approved release the Operator named; anything else refuses. */
  readonly releaseId: number;
  readonly actor: string;
  readonly mappings: readonly RepositoryMapping[];
  readonly targets: readonly CentralTarget[];
  readonly transport: CentralTransport;
  /** Where the approved bytes come from (src/package-source.ts); they must match the approved SHA-256. */
  readonly packages: PackageSource;
  readonly query: OperatorOptions["query"];
  readonly now: number;
  readonly clock?: () => number;
}

/** What one application did, safe to print: versions, digests and bounded codes only. */
export interface CentralResult {
  readonly deployment_id: string;
  readonly slot: string;
  readonly release_id: number;
  readonly kind: string;
  readonly desired_version: string;
  readonly package_sha256: string;
  readonly previous_version: string | null;
  readonly outcome: CentralOutcome;
  readonly reason: string | null;
  readonly observed_version: string | null;
  readonly installed: boolean;
  /** Whether the release was still the approved one when the outcome was recorded. */
  readonly still_approved: boolean;
}

/** Refused before anything was recorded or sent to the installation. */
export class CentralRefusal extends Error {}

/** Applies the approved release to one central Slot and records its outcome (see the module comment). */
export const applyCentralRelease = async (application: CentralApplication): Promise<CentralResult> => {
  const { slot, releaseId, actor, transport, query, now, clock = Date.now } = application;
  const db = asQueryDatabase(query);
  if (!ACTOR.test(actor)) throw new CentralRefusal("Invalid actor");
  const mapping = mappingFor(application.mappings, slot);
  if (!mapping) throw new CentralRefusal("Unknown Slot; add its Repository mapping by reviewed PR first.");
  if (mapping.deployment !== "central") throw new CentralRefusal("This Slot's reviewed deployment method is not central; set it by reviewed PR first.");
  const target = application.targets.find((candidate) => candidate.slot === slot);
  if (!target) throw new CentralRefusal("No reviewed central deployment target reaches this Slot; add its hosting reference by reviewed PR first.");
  const problem = targetProblem(target);
  if (problem) throw new CentralRefusal(`The Slot's central target is invalid: ${problem}.`);
  const release = await offeredRelease(db);
  if (!release || release.sequence !== releaseId) {
    throw new CentralRefusal("Only the approved release with a recorded dispatch is applied; check release-status for its release ID.");
  }
  if (release.contract_version! < SUPPORTED_CONTRACTS.min || release.contract_version! > SUPPORTED_CONTRACTS.max) {
    throw new CentralRefusal("This Worker does not serve the approved release's contract version.");
  }
  const sha256 = release.package_sha256!;
  const read = await application.packages.read(release.package_version, sha256);
  if (!("bytes" in read)) throw new CentralRefusal(`The approved package bytes are not available (${read.failure}); nothing was applied.`);
  if (await hex(read.bytes) !== sha256) throw new CentralRefusal("The package bytes do not match the approved SHA-256; nothing was applied.");
  const expected = await packageFiles(read.bytes);

  const id = crypto.randomUUID();
  // Write-ahead, in one statement: the release is still the approved, dispatched one with
  // these bytes, the Slot is not offboarded, and no other application to it is running.
  const [recorded] = await query(`INSERT INTO central_deployment (id, slot, release_sequence, package_version, package_sha256, actor, started_at)
    SELECT ?, ?, a.sequence, a.package_version, c.package_sha256, ?, ? FROM release_approval a
    JOIN release_candidate c ON c.package_version = a.package_version
    WHERE a.sequence = ? AND a.sequence = (SELECT MAX(sequence) FROM release_approval) AND c.package_sha256 = ?
      AND EXISTS (SELECT 1 FROM release_dispatch d WHERE d.sequence = a.sequence)
      AND NOT EXISTS (SELECT 1 FROM offboarding WHERE slot = ?)
      AND NOT EXISTS (SELECT 1 FROM delivery_suppression WHERE scope = 'slot' AND reference = ? AND reason = 'offboarding')
      AND NOT EXISTS (SELECT 1 FROM central_deployment o WHERE o.slot = ? AND o.outcome IS NULL AND o.started_at > ?)
    RETURNING id`, [id, slot, actor, now, releaseId, sha256, slot, slot, slot, now - CENTRAL_LEASE_MS]);
  if (!recorded) {
    throw new CentralRefusal("Not applied: the release is no longer the approved one, the Slot is offboarded, or another application to it is running; check central-status.");
  }
  const stillApproved = async () => (await query(`SELECT 1 AS current FROM central_deployment x
    WHERE x.id = ? AND x.release_sequence = (SELECT MAX(sequence) FROM release_approval)
      AND NOT EXISTS (SELECT 1 FROM offboarding WHERE slot = x.slot)
      AND NOT EXISTS (SELECT 1 FROM delivery_suppression WHERE scope = 'slot' AND reference = x.slot AND reason = 'offboarding')`, [id])).length === 1;

  const run = async (argv: readonly string[], options: { stdin?: Uint8Array; timeoutMs?: number } = {}): Promise<CommandResult> => {
    // A transport that throws gave no answer either.
    const result = await transport.run([...target.runner, ...argv], { timeoutMs: COMMAND_TIMEOUT_MS, ...options })
      .catch((): CommandResult => ({ kind: "lost" }));
    return result.kind === "exit" && result.code === target.runnerFailureExit ? { kind: "lost" } : result;
  };
  const wp = (...argv: string[]) => run([...target.wp, ...argv]);
  const versionOf = (result: CommandResult) => {
    if (result.kind !== "exit") return undefined;
    const version = result.stdout.trim();
    return result.code === 0 && TOKEN.test(version) ? version : result.code === 1 ? null : undefined;
  };
  const upload = `${target.uploadDirectory}/gq-support-${sha256}.zip`;
  let uploaded = false;
  let installed = false;
  let previous: string | null = null;

  const finish = async (outcome: CentralOutcome, reason: string | null, observed: string | null): Promise<CentralResult> => {
    // Best effort: a leftover upload is inert, and its removal never changes the outcome.
    if (uploaded) await run(["rm", "-f", "--", upload]);
    const current = await stillApproved().catch(() => false);
    await query(`UPDATE central_deployment SET outcome = ?, reason = NULLIF(?, ''), observed_version = NULLIF(?, ''), finished_at = ?
      WHERE id = ? AND outcome IS NULL`, [outcome, reason ?? "", observed ?? "", clock(), id]);
    return { deployment_id: id, slot, release_id: releaseId, kind: release.kind, desired_version: release.package_version, package_sha256: sha256,
      previous_version: previous, outcome, reason, observed_version: observed, installed, still_approved: current };
  };

  /** Reads the installation back: its version, whether it is active, and whether its files are exactly the approved package's. */
  const readBack = async (wasActive: boolean): Promise<{ lost: true } | { lost: false; version: string | null; problem: string | null }> => {
    const version = versionOf(await wp("plugin", "get", "gq-support", "--field=version"));
    if (version === undefined) return { lost: true };
    if (version === null) return { lost: false, version, problem: "plugin_unavailable" };
    const active = await wp("plugin", "is-active", "gq-support");
    const links = await run(["find", target.pluginDirectory, "-type", "l", "-print"]);
    const listed = await run(["find", target.pluginDirectory, "-type", "f", "-print"]);
    const paths = [...expected.keys()].map((path) => `${target.pluginDirectory}/${path}`);
    const digests = await run(["sha256sum", "--", ...paths]);
    if ([active, links, listed, digests].some((result) => result.kind !== "exit")) return { lost: true };
    const [isActive, symlinks, files, sums] = [active, links, listed, digests] as Extract<CommandResult, { kind: "exit" }>[];
    const lines = (text: string) => text.split("\n").filter((line) => line !== "");
    const found = new Set(lines(files!.stdout));
    const summed = new Map(lines(sums!.stdout).map((line) => [line.slice(66), line.slice(0, 64)]));
    const exact = files!.code === 0 && sums!.code === 0 && found.size === paths.length && paths.every((path) => found.has(path)) &&
      [...expected].every(([path, digest]) => summed.get(`${target.pluginDirectory}/${path}`) === digest);
    const problem = version !== release.package_version ? "version_mismatch"
      : symlinks!.code !== 0 || lines(symlinks!.stdout).length > 0 || !exact ? "files_mismatch"
      : wasActive && isActive!.code !== 0 ? "deactivated" : null;
    return { lost: false, version, problem };
  };

  // Before anything changes: a host that does not answer is unreachable and stays as it was.
  const link = await run(["test", "!", "-L", target.pluginDirectory]);
  const before = versionOf(await wp("plugin", "get", "gq-support", "--field=version"));
  if (link.kind !== "exit" || before === undefined) return finish("unreachable", "unreachable", null);
  // A symlinked plugin directory is a development checkout, never replaced by a package.
  if (link.code !== 0) return finish("refused", "symlinked_plugin", before);
  // WP-CLI cannot load the plugin (not installed, or WordPress itself failing): nothing to replace safely.
  if (before === null) return finish("refused", "plugin_unavailable", null);
  previous = before;
  const activeBefore = await wp("plugin", "is-active", "gq-support");
  if (activeBefore.kind !== "exit") return finish("unreachable", "unreachable", null);
  const wasActive = activeBefore.code === 0;
  const order = compare(before, release.package_version);
  // A downgrade is only ever the approved recovery package.
  if (order === null || (order > 0 && release.kind !== "recovery")) return finish("refused", order === null ? "incomparable_version" : "downgrade", before);
  if (order === 0) {
    // Already this version: verify it, and repair it only if its files differ.
    const current = await readBack(wasActive);
    if (current.lost) return finish("unreachable", "unreachable", null);
    if (current.problem === null) return finish("verified", null, current.version);
  }

  uploaded = true;
  const sent = await run(["cp", "/dev/stdin", upload], { stdin: read.bytes });
  if (sent.kind !== "exit") return finish("unreachable", "unreachable", null);
  const received = await run(["sha256sum", "--", upload]);
  if (received.kind !== "exit") return finish("unreachable", "unreachable", null);
  if (sent.code !== 0 || received.code !== 0 || received.stdout.slice(0, 64) !== sha256) return finish("failed", "upload_integrity", before);
  // The last check before WordPress changes anything: a newer approval or an offboarding stops it here.
  if (!await stillApproved()) return finish("refused", "superseded", before);
  await query("UPDATE central_deployment SET installed = 1 WHERE id = ? AND outcome IS NULL", [id]);
  installed = true;
  // Whatever WordPress answers, or if the answer is lost, only the read-back decides the outcome.
  await run([...target.wp, "plugin", "install", upload, "--force"], { timeoutMs: INSTALL_TIMEOUT_MS });
  const after = await readBack(wasActive);
  if (after.lost) return finish("unknown", "transport_lost", null);
  return after.problem === null ? finish("verified", null, after.version) : finish("failed", after.problem, after.version);
};

/** A downloaded release workflow artifact as the package source: its ZIP, served only when it is the approved bytes. */
export const artifactPackages = (readArtifact: NonNullable<OperatorOptions["readArtifact"]>, directory: string): PackageSource => ({
  async read(version, sha256) {
    const artifact = await readArtifact(directory).catch(() => null);
    if (!artifact) return { failure: "unavailable" };
    const manifest = (() => { try { return JSON.parse(artifact.manifest) as { version?: unknown }; } catch { return null; } })();
    if (manifest?.version !== version) return { failure: "unavailable" };
    return await hex(artifact.zip) === sha256 ? { bytes: artifact.zip } : { failure: "integrity" };
  },
});

const USAGE = "Usage: operator central-apply <slot> <release-id> <artifact-directory> <opaque-actor> | central-status <slot>";

/**
 * The Operator CLI for central deployment:
 *
 * - `central-apply <slot> <release-id> <artifact-directory> <opaque-actor>` applies the
 *   approved release, read from its downloaded release workflow artifact, to the Slot
 *   through its reviewed central target, and prints the recorded outcome.
 * - `central-status <slot>` shows the Slot's recent central applications and outcomes.
 */
export const runCentralOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, mappings, now = Date.now(), central, readArtifact } = options;
  const [command, slot, releaseId, directory, actor] = args;
  if (command === "central-status" && args.length === 2) {
    if (!mappingFor(mappings, slot!)) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
    const rows = await query(`SELECT id, release_sequence, package_version, package_sha256, actor, started_at, outcome, reason, observed_version,
      installed, finished_at FROM central_deployment WHERE slot = ? ORDER BY started_at DESC, rowid DESC LIMIT 20`, [slot!]);
    const time = (value: unknown) => value === null ? null : new Date(Number(value)).toISOString();
    return JSON.stringify({ slot, deployments: rows.map((row) => ({ deployment_id: row.id, release_id: row.release_sequence,
      version: row.package_version, package_sha256: row.package_sha256, actor: row.actor, started_at: time(row.started_at),
      // An unfinished record whose Operator process ended may have changed the installation.
      outcome: row.outcome ?? (Number(row.started_at) > now - CENTRAL_LEASE_MS ? "running" : "abandoned"), reason: row.reason,
      observed_version: row.observed_version, installed: row.installed === 1, finished_at: time(row.finished_at) })) });
  }
  if (command === "central-apply" && args.length === 5) {
    if (!RELEASE_ID.test(releaseId!) || !directory) throw new Error(USAGE);
    if (!central) throw new Error("This Operator boundary has no central deployment transport");
    if (!readArtifact) throw new Error("This Operator boundary cannot read release artifacts");
    return JSON.stringify(await applyCentralRelease({ slot: slot!, releaseId: Number(releaseId), actor: actor!, mappings,
      targets: central.targets, transport: central.transport, packages: central.packages ?? artifactPackages(readArtifact, directory),
      query, now }));
  }
  throw new Error(USAGE);
};
