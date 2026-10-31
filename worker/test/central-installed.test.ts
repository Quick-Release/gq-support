import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CentralTarget } from "../src/central-deployment.ts";
import { slotInventory } from "../src/inventory.ts";
import { asQueryDatabase, runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { commandTransport } from "../scripts/central-transport.ts";
import { localStage } from "./local-d1.ts";

// #143 on a real installation: the Operator CLI's central deployment, with local D1, drives
// WP-CLI on the disposable DDEV site's installed release copy through the real command
// transport. Run by `plugin/tests/integration/package.sh central`, which installs the
// candidate, disables report submission and removes the report credential first, and
// passes the candidate's artifact directory and an approved next release ZIP.
const root = join(import.meta.dirname, "..", "..");
const candidate = process.env.GQ_SUPPORT_CENTRAL_PACKAGE;
const next = process.env.GQ_SUPPORT_CENTRAL_NEXT;
const installed = it.runIf(Boolean(candidate && next));

const site = "/var/www/html/.test-site";
// `ddev exec` does not pass stdin on, so the runner is Docker's own exec into the site's web container,
// as the host user; 125 is Docker's own failure, no answer from the container.
const target: CentralTarget = { slot: "lifecycle/test", runner: ["docker", "exec", "-i", "-u", String(process.getuid?.() ?? 1000),
  "ddev-gq-support-lifecycle-testsite-web"], runnerFailureExit: 125, wp: ["wp", `--path=${site}`],
  pluginDirectory: `${site}/wp-content/plugins/gq-support`, uploadDirectory: "/tmp" };
const mappings: RepositoryMapping[] = [{ slot: "lifecycle/test", client: "lifecycle", project: "lifecycle", environment: "test",
  repositoryId: 1, defaultDeveloper: "developer", deployment: "central" }];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const host = (...args: string[]) => spawnSync(target.runner[0]!, [...target.runner.slice(1), ...args], { encoding: "utf8" });
const wp = (...args: string[]) => host(...target.wp, ...args);

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
beforeAll(async () => { stage = await localStage(["shared", "ledger"]); });
afterAll(async () => { await stage?.dispose(); });

const query = async (sql: string, parameters: readonly (string | number)[]) =>
  (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
/** Release workflow artifacts by version: the exact ZIP with a manifest and provenance that name it. */
const artifacts = new Map<string, { zip: Uint8Array; manifest: string; provenance: string }>();
const artifact = (zip: Uint8Array, version: string) => artifacts.set(version, { zip,
  manifest: JSON.stringify({ name: "gq-support", version, zip: { size: zip.length, sha256: sha256(zip) } }),
  provenance: JSON.stringify({ version, commit: "b".repeat(40), run: "39000000001", zip_sha256: sha256(zip) }) });
const operator = async (...args: string[]) => runOperator(args, { mappings, now: Date.now(), recordRevocation: async () => {}, query,
  readArtifact: async (directory) => artifacts.get(directory)!, central: { targets: [target], transport: commandTransport() } });
const approve = async (version: string, kind: string, expected: string) => {
  if (kind === "production") await operator("release-candidate", version, "a".repeat(40), "1", "0001-0029", "signed", "alex");
  const { release_id: id } = JSON.parse(await operator("release-approve", version, kind, expected, "https://github.com/Quick-Release/gq-support/issues/143", "alex"));
  await operator("release-dispatch", String(id), new Date().toISOString(), "https://github.com/Quick-Release/gq-support/issues/143", "alex");
  return String(id);
};
const apply = async (id: string, version: string) => JSON.parse(await operator("central-apply", "lifecycle/test", id, version, "alex"));

installed("installs approved releases and the recovery package through WP-CLI, verifying every installed file", { timeout: 300_000 }, async () => {
  const manifest = JSON.parse(readFileSync(join(root, candidate!, "gq-support.manifest.json"), "utf8")) as { version: string };
  const version = manifest.version;
  const nextVersion = `${version}.1`;
  artifact(readFileSync(join(root, candidate!, "gq-support.zip")), version);
  artifact(readFileSync(join(root, next!)), nextVersion);
  expect(wp("plugin", "get", "gq-support", "--field=version").stdout.trim()).toBe(version);

  // The installation already runs the approved candidate: verified from its files, not reinstalled.
  const first = await approve(version, "production", "none");
  expect(await apply(first, version)).toMatchObject({ outcome: "verified", installed: false, observed_version: version });

  // The approved next release, installed by WordPress from the uploaded verified bytes.
  const second = await approve(nextVersion, "production", first);
  expect(await apply(second, nextVersion)).toMatchObject({ outcome: "verified", installed: true, previous_version: version, observed_version: nextVersion });
  expect(wp("plugin", "get", "gq-support", "--field=version").stdout.trim()).toBe(nextVersion);
  expect(wp("plugin", "is-active", "gq-support").status).toBe(0);
  // The upload was removed.
  expect(host("test", "-e", `/tmp/gq-support-${sha256(artifacts.get(nextVersion)!.zip)}.zip`).status).toBe(1);

  // The withdrawn release is no longer applied; the approved recovery package downgrades to the candidate.
  const recovery = await approve(version, "recovery", second);
  await expect(apply(second, nextVersion)).rejects.toThrow(/approved release with a recorded dispatch/);
  expect(await apply(recovery, version)).toMatchObject({ kind: "recovery", outcome: "verified", installed: true, previous_version: nextVersion, observed_version: version });
  expect(wp("plugin", "is-active", "gq-support").status).toBe(0);

  const { slots: [slot] } = await slotInventory(asQueryDatabase(query), mappings, null, Date.now());
  expect(slot).toMatchObject({ versions: { desired: { version }, attempted: { version, source: "central-deployment" },
    observed: { state: "current", version, source: "central-deployment" } }, update: { outcome: "confirmed" },
    central_deployment: { release_id: Number(recovery), outcome: "verified" } });
});
