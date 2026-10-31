import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { filesDigest, packageFiles } from "../src/central-deployment.ts";
import type { PackageTags, PublishedTag } from "../src/composer-approval.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { localStage } from "./local-d1.ts";
import { artifactOf, fakeEvidence, filesSha256, pluginFiles, recordLiveMigrations, reviewedMigrations, SCHEMA_RANGE, sha256, WORKER_COMMIT,
  zipEntries, zipOf, type Artifact, type FakeEvidence } from "./release-fixture.ts";

// The Composer rollout approval record (gq-support.composer-approval/v1): a read-only Operator
// command that derives what a Composer-managed site may install from the approved release's
// exact bytes and the live service state. Through the Operator CLI and real local D1, with the
// artifacts, GitHub's records and the clock controlled.
const START = Date.parse("2026-10-31T10:00:00Z");
const slotOf = (name: string, deployment: RepositoryMapping["deployment"], repositoryId: number): RepositoryMapping =>
  ({ slot: `${name}/production`, client: name, project: name, environment: "production", repositoryId, defaultDeveloper: "developer", ...(deployment ? { deployment } : {}) });
const mappings: RepositoryMapping[] = [slotOf("nomia", "central", 42), slotOf("ekis", "central", 43), slotOf("cafe", "native", 44)];
const SLOT = "nomia/production";

const composerJson = JSON.stringify({ name: "getquick/gq-support", type: "wordpress-plugin", extra: { "installer-name": "gq-support" },
  require: { php: ">=8.0", "composer/installers": "^2.0" } });
const filesOf = (version: string): Record<string, string> => ({ ...pluginFiles(version), "composer.json": composerJson });

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let now: number;
let evidence: FakeEvidence;
const artifacts = new Map<string, Artifact>();
/** The published `v<version>` tags as GitHub records them, by tag name. */
let tags: Map<string, PublishedTag>;
const tagReads: string[] = [];
const packageTags: PackageTags = { async read(tag) { tagReads.push(tag); return tags.get(tag) ?? null; } };

const gitBlob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const tagCommit = (version: string) => sha256(`composer ${version}`).slice(0, 40);
/** The publish job's commit on the composer branch: exactly the package's files at its root. */
const publishTag = (version: string, files: Record<string, string>) => tags.set(`v${version}`, { commit: tagCommit(version), truncated: false,
  entries: [...Object.entries(files).map(([path, text]) => ({ path, mode: "100644", type: "blob", sha: gitBlob(text) })),
    ...[...new Set(Object.keys(files).filter((path) => path.includes("/")).map((path) => path.split("/")[0]!))]
      .map((path) => ({ path, mode: "040000", type: "tree", sha: "f".repeat(40) }))] });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  evidence = fakeEvidence();
  await recordLiveMigrations(stage.databases.shared);
  artifacts.clear();
  tags = new Map();
  tagReads.length = 0;
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

type D1 = (typeof stage)["databases"]["shared"];
const statements: string[] = [];
const query = (database: D1) => async (sql: string, parameters: readonly (string | number)[]) => {
  statements.push(sql);
  return (await database.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: query(stage.databases.shared), ledger: query(stage.databases.ledger), stage: "prod", evidence, migrations: reviewedMigrations(),
  readArtifact: async (directory) => { const artifact = artifacts.get(directory); if (!artifact) throw new Error("no such artifact"); return artifact; },
  packageTags });
const json = async (...args: string[]) => JSON.parse(await operator(...args));

/** Built, published as a Composer tag and recorded as a candidate, as the release workflow and Operator do. */
const publish = async (version: string, { files = filesOf(version), signing = "signed", range = SCHEMA_RANGE }:
  { files?: Record<string, string>; signing?: string; range?: string } = {}) => {
  const artifact = artifactOf(version, files);
  artifacts.set(version, artifact);
  evidence.release(artifact);
  publishTag(version, files);
  await operator("release-candidate", version, WORKER_COMMIT, "1", range, signing, "alex");
  return artifact;
};
const verify = (version: string) => json("release-verify", version, version, evidence.ci(), evidence.deploy("staging"), "alex");
const approve = async (version: string, expected: string) =>
  (await json("release-approve", version, "production", expected, "https://github.com/Quick-Release/gq-support/pull/152", "alex")).release_id as number;
const launch = (id: number) => json("fleet-launch", String(id), evidence.deploy("prod"), "alex");
/** Published, gated and approved, but not dispatched. */
const approved = async (version: string, expected = "none") => {
  const artifact = await publish(version);
  await verify(version);
  return { id: await approve(version, expected), artifact };
};
const approval = (slot: string, id: number | string, directory: string, phase: string) => json("composer-approval", slot, String(id), directory, phase);

it("derives the prepare record from the approved release's exact bytes, before its dispatch", async () => {
  const { id, artifact } = await approved("0.2.0");
  const files = filesOf("0.2.0");
  const provenance = JSON.parse(artifact.provenance) as { commit: string; run: string };
  expect(await approval(SLOT, id, "0.2.0", "prepare")).toEqual({
    schema: "gq-support.composer-approval/v1", stage: "prod", slot: SLOT, phase: "prepare", release_id: id,
    package: { name: "getquick/gq-support", version: "0.2.0", zip_sha256: sha256(artifact.zip) },
    provenance: { source_commit: provenance.commit, release_run: provenance.run },
    published_tag: { name: "v0.2.0", commit: tagCommit("0.2.0") },
    files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)]).sort(([a], [b]) => a! < b! ? -1 : 1)),
    files_digest: filesSha256(files),
    normalization: "gq-support.files/v1",
    observed_at: new Date(START).toISOString(),
  });
  expect(tagReads).toEqual(["v0.2.0"]);
});

it("gives a deploy record only once the release's fleet dispatch is recorded", async () => {
  const { id } = await approved("0.2.0");
  await expect(approval(SLOT, id, "0.2.0", "deploy")).rejects.toThrow(/dispatch is not recorded/);
  const prepared = await approval(SLOT, id, "0.2.0", "prepare");
  await launch(id);
  now += 60_000;
  const deployed = await approval(SLOT, id, "0.2.0", "deploy");
  // The same package, files and tag: only the phase and the observation time differ.
  expect(deployed).toEqual({ ...prepared, phase: "deploy", observed_at: new Date(START + 60_000).toISOString() });
});

const sql = (database: D1, statement: string, ...parameters: (string | number)[]) => database.prepare(statement).bind(...parameters).run();

it("refuses while maintenance holds, a recorded restore is not replayed, or the ledger is missing or unreadable", async () => {
  const { id } = await approved("0.2.0");
  await sql(stage.databases.ledger, "UPDATE maintenance SET state = 'maintenance', generation = generation + 1 WHERE id = 1");
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/Refused: maintenance is in effect/);
  await sql(stage.databases.ledger, "UPDATE maintenance SET state = 'serving', generation = generation + 1 WHERE id = 1");
  // A restore recorded in the ledger, which the main database has not replayed: its records may be rewound.
  await sql(stage.databases.ledger, "UPDATE ledger_epoch SET epoch = 1 WHERE id = 1");
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/Refused: a recorded restore is not replayed/);
  await sql(stage.databases.shared, "UPDATE restore_state SET epoch = 1 WHERE id = 1");
  await approval(SLOT, id, "0.2.0", "prepare");

  const without = (overrides: Partial<Parameters<typeof runOperator>[1]>) => runOperator(["composer-approval", SLOT, String(id), "0.2.0", "prepare"],
    { mappings, now, recordRevocation: async () => {}, query: query(stage.databases.shared), ledger: query(stage.databases.ledger), stage: "prod",
      migrations: reviewedMigrations(), readArtifact: async () => artifacts.get("0.2.0")!, packageTags, ...overrides });
  await expect(without({ ledger: undefined })).rejects.toThrow(/suppression ledger/);
  // The shared mutation guard reads it first: whatever its error, nothing is printed.
  await expect(without({ ledger: async () => { throw new Error("unreachable"); } })).rejects.toThrow();
  await expect(without({ stage: undefined })).rejects.toThrow(/Refused: this Operator command has no reviewed target stage/);
  await expect(without({ packageTags: undefined })).rejects.toThrow(/Refused: .*published Composer tags/);
});

it("refuses a Slot that is not central, unknown, or offboarded, even when only the ledger still holds the offboarding", async () => {
  const { id } = await approved("0.2.0");
  await expect(approval("cafe/production", id, "0.2.0", "prepare")).rejects.toThrow(/deployment method is not central/);
  await expect(approval("ghost/production", id, "0.2.0", "prepare")).rejects.toThrow(/unknown Slot/);
  await operator("offboard", SLOT, "alex", "https://github.com/Quick-Release/gq-support/issues/1");
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/Slot is offboarded/);
  // A restore of the main database dropped its record; the ledger's holds.
  await sql(stage.databases.shared, "DELETE FROM offboarding WHERE slot = ?", SLOT);
  await sql(stage.databases.shared, "DELETE FROM delivery_suppression WHERE reference = ?", SLOT);
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/Slot is offboarded/);
  // Another central Slot is unaffected.
  expect((await approval("ekis/production", id, "0.2.0", "prepare")).slot).toBe("ekis/production");
});

it("refuses an old approval, a withdrawn release and an unsigned legacy package", async () => {
  const unsigned = await publish("0.1.11", { signing: "unsigned-legacy" });
  await verify("0.1.11");
  const legacy = await approve("0.1.11", "none");
  await expect(approval(SLOT, legacy, "0.1.11", "prepare")).rejects.toThrow(/unsigned legacy package/);
  expect(unsigned).toBeDefined();
  await launch(legacy);

  const first = await approved("0.2.0", String(legacy));
  await launch(first.id);
  const second = await approved("0.2.1", String(first.id));
  // The previous approval is not current any more.
  await expect(approval(SLOT, first.id, "0.2.0", "deploy")).rejects.toThrow(/only the current approved release/);
  await launch(second.id);
  const withdrawal = await json("release-withdraw", String(second.id), "0.2.0", evidence.deploy("prod"), "alex");
  const recovery = withdrawal.recovery.release_id as number;
  await expect(approval(SLOT, second.id, "0.2.1", "deploy")).rejects.toThrow(/only the current approved release/);
  // The recovery release is the current approved one, and its package is the earlier verified one.
  expect((await approval(SLOT, recovery, "0.2.0", "deploy")).package.version).toBe("0.2.0");
  // A restore rewound the main database to before the withdrawal: the ledger still knows 0.2.1 was withdrawn.
  for (const table of ["release_dispatch", "fleet_launch", "release_approval"]) await sql(stage.databases.shared, `DELETE FROM ${table} WHERE sequence = ?`, recovery);
  await expect(approval(SLOT, second.id, "0.2.1", "deploy")).rejects.toThrow(/withdrawn/);
});

it("refuses when the live schema is not the reviewed one or is outside the release's tested range", async () => {
  const { id } = await approved("0.2.0");
  const migrations = reviewedMigrations();
  await recordLiveMigrations(stage.databases.shared, migrations.map((migration, index) => index === 3 ? { ...migration, sha256: "0".repeat(64) } : migration));
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/live schema is not the reviewed one/);
  await recordLiveMigrations(stage.databases.shared, migrations);
  await approval(SLOT, id, "0.2.0", "prepare");
  // A newer release verified only against an older schema than the live one.
  await publish("0.2.1", { range: "0001-0005" });
  await verify("0.2.1");
  await launch(id);
  const newer = await approve("0.2.1", String(id));
  await expect(approval(SLOT, newer, "0.2.1", "prepare")).rejects.toThrow(new RegExp(`live schema ${migrations.length} is outside the release's tested range 1-5`));
});

it("refuses an artifact that is not the approved package's exact bytes and provenance", async () => {
  const { id, artifact } = await approved("0.2.0");
  const files = filesOf("0.2.0");
  // A forged package for the same version, with a consistent manifest and provenance of its own.
  artifacts.set("forged", artifactOf("0.2.0", { ...files, "gq-support.php": `${files["gq-support.php"]}// added\n` }));
  await expect(approval(SLOT, id, "forged", "prepare")).rejects.toThrow(/not the approved release's package/);
  // The approved bytes, claimed by another build (a different run).
  artifacts.set("rebuilt", artifactOf("0.2.0", files, "41000000001"));
  expect(sha256(artifacts.get("rebuilt")!.zip)).toBe(sha256(artifact.zip));
  await expect(approval(SLOT, id, "rebuilt", "prepare")).rejects.toThrow(/not the approved release's package/);
  // Records that disagree with the bytes, and an older version's package.
  artifacts.set("typed", { ...artifact, manifest: JSON.stringify({ ...JSON.parse(artifact.manifest), version: "0.2.1" }) });
  await expect(approval(SLOT, id, "typed", "prepare")).rejects.toThrow(/do not agree/);
  await publish("0.1.12");
  await expect(approval(SLOT, id, "0.1.12", "prepare")).rejects.toThrow(/not the approved release's package/);
  await expect(approval(SLOT, id, "missing", "prepare")).rejects.toThrow(/artifact cannot be read/);
});

it("refuses unless the published Composer tag's tree is exactly the approved files", async () => {
  const { id } = await approved("0.2.0");
  const files = filesOf("0.2.0");
  const good = tags.get("v0.2.0")!;
  const refused = async (tag: PublishedTag | undefined) => {
    if (tag) tags.set("v0.2.0", tag); else tags.delete("v0.2.0");
    await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/Refused: the published Composer tag v0.2.0/);
  };
  await refused(undefined);
  const blob = (path: string, text: string, mode = "100644") => ({ path, mode, type: "blob", sha: gitBlob(text) });
  await refused({ ...good, entries: good.entries.map((entry) => entry.path === "readme.txt" ? blob("readme.txt", "Stable tag: 0.2.1\n") : entry) });
  await refused({ ...good, entries: [...good.entries, blob(".env", "SECRET=1\n")] });
  await refused({ ...good, entries: good.entries.filter((entry) => entry.path !== "readme.txt") });
  await refused({ ...good, entries: good.entries.map((entry) => entry.path === "readme.txt" ? { ...entry, mode: "120000" } : entry) });
  await refused({ ...good, entries: [...good.entries, { path: "vendor", mode: "160000", type: "commit", sha: "c".repeat(40) }] });
  await refused({ ...good, truncated: true });
  await refused({ ...good, commit: "not-a-commit" });
  publishTag("0.2.0", files);
  expect((await approval(SLOT, id, "0.2.0", "prepare")).published_tag).toEqual({ name: "v0.2.0", commit: tagCommit("0.2.0") });
});

it("refuses a package whose composer.json does not name the Composer package", async () => {
  const files = { ...filesOf("0.2.0"), "composer.json": JSON.stringify({ name: "someone/else" }) };
  await publish("0.2.0", { files });
  await verify("0.2.0");
  const id = await approve("0.2.0", "none");
  await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/composer.json does not name getquick\/gq-support/);
});

it("refuses when the state it read changes before the record is complete", async () => {
  const { id } = await approved("0.2.0");
  const read = packageTags.read;
  packageTags.read = async (tag) => {
    await sql(stage.databases.ledger, "UPDATE maintenance SET state = 'maintenance', generation = generation + 1 WHERE id = 1");
    return read(tag);
  };
  try {
    await expect(approval(SLOT, id, "0.2.0", "prepare")).rejects.toThrow(/changed during the read/);
  } finally { packageTags.read = read; }
});

it.each(["schema", "rollback boundary"])("refuses when the %s changes during the published-tag read", async (change) => {
  const { id } = await approved("0.1.11");
  const read = packageTags.read;
  packageTags.read = async (tag) => {
    if (change === "schema") {
      await sql(stage.databases.shared, "UPDATE __alchemy_migrations SET hash = ? WHERE name = ?", "0".repeat(64), reviewedMigrations().at(-1)!.name);
    } else {
      await sql(stage.databases.shared, "INSERT INTO rollback_boundary (sequence, schema_floor, evidence, recorded_by, recorded_at) VALUES (?, 1, 'reviewed-boundary', 'alex', ?)", id, now);
    }
    return read(tag);
  };
  try {
    await expect(approval(SLOT, id, "0.1.11", "prepare")).rejects.toThrow(/changed during the read/);
  } finally { packageTags.read = read; }
});

it("reads only: no D1 record is added or changed, and the record holds no secrets or request content", async () => {
  const { id } = await approved("0.2.0");
  await launch(id);
  const snapshot = async (database: D1) => {
    const tables = (await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
      .all<{ name: string }>()).results;
    return Object.fromEntries(await Promise.all(tables.map(async ({ name }) =>
      [name, (await database.prepare(`SELECT * FROM "${name}"`).all()).results] as const)));
  };
  const before = [await snapshot(stage.databases.shared), await snapshot(stage.databases.ledger)];
  statements.length = 0;
  const output = await operator("composer-approval", SLOT, String(id), "0.2.0", "deploy");
  expect(statements.length).toBeGreaterThan(0);
  expect(statements.every((statement) => /^\s*SELECT\b/i.test(statement))).toBe(true);
  expect([await snapshot(stage.databases.shared), await snapshot(stage.databases.ledger)]).toEqual(before);
  // Only versions, digests, commits and run IDs: no actor, evidence reference, URL or credential.
  expect(output).not.toMatch(/alex|https?:|github\.com|token|key|secret/i);
  expect(Object.keys(JSON.parse(output))).toEqual(["schema", "stage", "slot", "phase", "release_id", "package", "provenance", "published_tag", "files",
    "files_digest", "normalization", "observed_at"]);
});

it("normalizes gq-support.files/v1: every runtime file's raw bytes, and refuses unusual entries", async () => {
  // Raw bytes: CRLF, a BOM and binary content are hashed as they are.
  const files = { "gq-support.php": "<?php\r\n", "assets/app.js": "\ufeffx\n", "languages/gq-support-pt_BR.mo": "\u0000\u0001" };
  const normalized = await packageFiles(zipOf(files));
  expect(Object.fromEntries(normalized)).toEqual(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)])));
  // A known digest, from the spec: sorted `path NUL sha256 LF` lines.
  expect(await filesDigest(new Map([["b.txt", "1".repeat(64)], ["a.txt", "0".repeat(64)]])))
    .toBe(sha256(`a.txt\0${"0".repeat(64)}\nb.txt\0${"1".repeat(64)}\n`));
  const php: [string, string] = ["gq-support/gq-support.php", "<?php\n"];
  for (const entries of [
    [php, ["gq-support/readme.txt", "a"], ["gq-support/readme.txt", "b"]],
    [php, ["gq-support/../wp-config.php", "x"]],
    [php, ["gq-support/includes/./x.php", "x"]],
    // Never silently excluded: a hidden file refuses the package.
    [php, ["gq-support/.htaccess", "deny"]],
    [php, ["/etc/passwd", "x"]],
    [php, ["gq-support/includes\\x.php", "x"]],
    [php, ["gq-support/caf\u00e9.php", "x"]],
    [php, ["other/readme.txt", "x"]],
    [php, ["gq-support/link.php", "/etc/passwd", 0o120777]],
    [php, ["gq-support/pipe", "", 0o010644]],
    [["gq-support/readme.txt", "no main file"]],
  ] as (readonly [string, string, number?])[][]) {
    await expect(packageFiles(zipEntries(entries)), JSON.stringify(entries)).rejects.toThrow(/not a plain gq-support\/ ZIP/);
  }
});
