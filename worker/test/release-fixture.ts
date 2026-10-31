import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewedMigration } from "../src/fleet-rollout.ts";
import type { ReleaseEvidence, WorkflowJob, WorkflowRun } from "../src/release-gates.ts";
import { MIGRATIONS_DIR, migrationFiles } from "./local-d1.ts";

// Shared release fixtures (#141-#144): real release ZIPs, GitHub's workflow run records
// as a controlled provider, and the live migration record Alchemy keeps.

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A release ZIP as the release workflow writes it: every file under one `gq-support/` root, deflated. */
export const zipOf = (files: Record<string, string>) =>
  zipEntries([["gq-support/", ""], ...Object.entries(files).map(([path, text]): [string, string] => [`gq-support/${path}`, text])]);

/** A ZIP of exactly these entries, in order: names as given, with an optional Unix mode (default 0644 file or 0755 directory). */
export const zipEntries = (entries: readonly (readonly [name: string, text: string, mode?: number])[]) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text, mode] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const directory = path.endsWith("/");
    const packed = directory ? Buffer.alloc(0) : deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(directory ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(directory ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((mode ?? (directory ? 0o40755 : 0o100644)) * 0x10000, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

export const pluginFiles = (version: string) => ({
  "gq-support.php": `<?php\n/* Plugin Name: GETQUICK Support\n * Version: ${version} */\n`,
  "includes/class-gq-support-state.php": `<?php // ${version}\n`,
  "readme.txt": `Stable tag: ${version}\n`,
});

/** The digest a native installation signs for exactly these files (src/central-deployment.ts filesDigest). */
export const filesSha256 = (files: Record<string, string>) =>
  sha256(Object.entries(files).map(([path, text]) => [path, sha256(text)]).sort(([a], [b]) => a! < b! ? -1 : 1)
    .map(([path, digest]) => `${path}\0${digest}\n`).join(""));

export interface Artifact { zip: Uint8Array; manifest: string; provenance: string }
export const RELEASE_COMMIT = "b".repeat(40);
export const WORKER_COMMIT = "a".repeat(40);
// Generated run IDs, apart from the fixed release runs tests name.
let runs = 40_000_000_000;

/** The release workflow's artifacts for `version`, built by run `run` at the release commit. */
export const artifactOf = (version: string, files: Record<string, string> = pluginFiles(version), run = String(++runs)): Artifact => {
  const zip = zipOf(files);
  return { zip, manifest: JSON.stringify({ name: "gq-support", version, zip: { file: "gq-support.zip", size: zip.length, sha256: sha256(zip) }, files: [] }),
    provenance: JSON.stringify({ version, commit: RELEASE_COMMIT, run, zip_sha256: sha256(zip) }) };
};

const passed = (...names: string[]): WorkflowJob[] => names.map((name) => ({ name, conclusion: "success" }));

/**
 * GitHub's records as a controlled provider: each run as GitHub would report it,
 * and the deploy runs' retained plan and apply records. Tests change a record to
 * fail a gate.
 */
export interface FakeEvidence extends ReleaseEvidence {
  readonly runs: Map<string, WorkflowRun>;
  readonly artifacts: Map<string, Record<string, unknown>>;
  /** Records a passing release workflow run for an artifact's provenance. */
  release(artifact: Artifact): void;
  /** A passing CI run on main at the release commit. */
  ci(): string;
  /** A passing gated deployment of `commit` to `stage`, with its safe plan applied. */
  deploy(stage: "staging" | "prod", commit?: string): string;
}

export const fakeEvidence = (): FakeEvidence => {
  const records = new Map<string, WorkflowRun>();
  const artifacts = new Map<string, Record<string, unknown>>();
  const run = (id: string, path: string, commit: string, jobs: WorkflowJob[], extra: Partial<WorkflowRun> = {}): string => {
    records.set(id, { id: Number(id), path, repository: "Quick-Release/gq-support", head_sha: commit, head_branch: "main", event: "push",
      status: "completed", conclusion: "success", html_url: `https://github.com/Quick-Release/gq-support/actions/runs/${id}`, jobs, ...extra });
    return id;
  };
  return {
    runs: records, artifacts,
    async run(id) { return records.get(id) ?? null; },
    async artifact(id, prefix, file) {
      const found = [...artifacts].find(([key]) => key.startsWith(prefix) && key.endsWith(`/${file}`) && key.includes(`-${id}-`));
      return found ? structuredClone(found[1]) : null;
    },
    release(artifact) {
      const { run: id, commit } = JSON.parse(artifact.provenance) as { run: string; commit: string };
      run(id, ".github/workflows/release-plugin.yml", commit, passed("Build the release candidate", "Installed package stable",
        "Installed package minimum", "Pre-release compatibility / Compatibility result"), { head_branch: "plugin-v1", event: "push" });
    },
    ci() {
      return run(String(++runs), ".github/workflows/ci.yml", RELEASE_COMMIT, passed("Plan validation", "PHPCS + PHPStan", "Dependency audit",
        "Secret scan", "Worker typecheck + tests", "Asset size gate", "Required validation"));
    },
    deploy(stage, commit = WORKER_COMMIT) {
      const id = run(String(++runs), ".github/workflows/deploy-worker.yml", commit, passed("plan", "deploy"), { event: "workflow_dispatch" });
      const digest = sha256(`${stage} ${commit} ${id}`);
      artifacts.set(`deploy-plan-${stage}-${id}-1/plan.json`, { schema: "gq-support.deploy-plan/v1", verdict: "safe", stage, commit, digest, refusals: [] });
      artifacts.set(`deploy-plan-${stage}-${id}-1/applied.json`, { schema: "gq-support.deploy-applied/v1", outcome: "applied", stage, commit,
        planDigest: digest, appliedAt: new Date().toISOString(), provenance: { runId: id } });
      return id;
    },
  };
};

/** The reviewed migrations in this checkout, as scripts/operator.ts reads them. */
export const reviewedMigrations = (): ReviewedMigration[] => migrationFiles().map((name) => {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
  return { name, sha256: sha256(sql), sql };
});
export const LIVE_SCHEMA = migrationFiles().length;
/** Every candidate in these tests is verified against the live schema. */
export const SCHEMA_RANGE = `0001-${String(LIVE_SCHEMA).padStart(4, "0")}`;

/** Alchemy's record of the migrations it applied (`__alchemy_migrations`), as a deployment leaves it. */
export const recordLiveMigrations = async (db: D1Database, migrations: readonly { name: string; sha256: string }[] = reviewedMigrations()) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS __alchemy_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL,
    created_at NUMERIC, name TEXT, applied_at TEXT)`).run();
  await db.prepare("DELETE FROM __alchemy_migrations").run();
  for (const migration of migrations) {
    await db.prepare("INSERT INTO __alchemy_migrations (hash, created_at, name, applied_at) VALUES (?, NULL, ?, '2026-10-20T00:00:00Z')")
      .bind(migration.sha256, migration.name).run();
  }
};
