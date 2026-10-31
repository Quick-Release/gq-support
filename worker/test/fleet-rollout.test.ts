import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CentralTarget, CentralTransport, CommandResult } from "../src/central-deployment.ts";
import { listIncidents } from "../src/incidents.ts";
import { slotInventory } from "../src/inventory.ts";
import { observeSignals } from "../src/operational-signals.ts";
import { restoreGate } from "../src/ledger.ts";
import { asQueryDatabase, runOperator } from "../src/operator.ts";
import type { PackageSource } from "../src/package-source.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { keyPair, publicKeyOf } from "./installation-client.ts";
import { localStage, operatorLedger } from "./local-d1.ts";
import { artifactOf, fakeEvidence, filesSha256, pluginFiles, recordLiveMigrations, reviewedMigrations, SCHEMA_RANGE, sha256, WORKER_COMMIT,
  type Artifact, type FakeEvidence } from "./release-fixture.ts";

// #144 (ADR 0021): one approved release dispatched to the whole eligible fleet together after
// its gates, each Slot's outcome tracked and verified separately, and a bad release withdrawn
// to a verified compatible package. Through the Operator CLI, the Worker HTTP entry and local
// D1, with GitHub's run records, central hosts and the clock controlled.
const START = Date.parse("2026-10-20T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const slotOf = (name: string, deployment: RepositoryMapping["deployment"], repositoryId: number): RepositoryMapping =>
  ({ slot: `${name}/production`, client: name, project: name, environment: "production", repositoryId, defaultDeveloper: "developer", ...(deployment ? { deployment } : {}) });
const mappings: RepositoryMapping[] = [
  slotOf("shop", "central", 42), slotOf("blog", "central", 43), slotOf("news", "native", 44), slotOf("cafe", "native", 45),
];
const pluginDirectory = (slot: string) => `/srv/www/${slot.split("/")[0]}/web/app/plugins/gq-support`;
const targetOf = (slot: string): CentralTarget => ({ slot, runner: ["ssh", "-o", "BatchMode=yes", slot.replace("/", "-")], runnerFailureExit: 255,
  wp: ["wp", `--path=/srv/www/${slot.split("/")[0]}/web/wp`], pluginDirectory: pluginDirectory(slot), uploadDirectory: "/tmp", source: "plugin-directory" });
let targets: CentralTarget[];

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let now: number;
let evidence: FakeEvidence;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const at = (time: number) => new Date(time).toISOString();

/** Built packages by the SHA-256 of their ZIP, so a host installs only what was built. */
const builds = new Map<string, { version: string; files: Record<string, string> }>();
const artifacts = new Map<string, Artifact>();

/**
 * The centrally managed installations, by runner alias: WP-CLI's view of each plugin,
 * its upload and files. `next` replaces one host's answer to a matching command, once.
 */
interface Host { version: string | null; files: Map<string, string>; uploads: Map<string, Uint8Array>; down: boolean; installs: number }
let hosts: Map<string, Host>;
let overrides: { alias: string; match: (command: readonly string[]) => boolean; answer: (command: readonly string[]) => Promise<CommandResult> | CommandResult }[];
const host = (slot: string) => hosts.get(slot.replace("/", "-"))!;
const transport: CentralTransport = {
  async run(argv, { stdin } = {}) {
    const alias = argv[3]!;
    const site = hosts.get(alias)!;
    const command = argv.slice(4);
    const override = overrides.findIndex((candidate) => candidate.alias === alias && candidate.match(command));
    if (override >= 0) return overrides.splice(override, 1)[0]!.answer(command);
    if (site.down) return { kind: "exit", code: 255, stdout: "" };
    const exit = (code: number, stdout = ""): CommandResult => ({ kind: "exit", code, stdout });
    const plugin = pluginDirectory(alias.replace("-", "/"));
    const wp = command[0] === "wp" ? command.slice(2).join(" ") : null;
    if (command.join(" ") === `test ! -L ${plugin}`) return exit(0);
    if (wp === "plugin get gq-support --field=version") return site.version === null ? exit(1) : exit(0, `${site.version}\n`);
    if (wp === "plugin is-active gq-support") return exit(0);
    if (command[0] === "cp") { site.uploads.set(command[2]!, stdin!); return exit(0); }
    if (command[0] === "sha256sum") {
      const lines = command.slice(2).map((path) => {
        const upload = site.uploads.get(path);
        const file = path.startsWith(`${plugin}/`) ? site.files.get(path.slice(plugin.length + 1)) : undefined;
        const digest = upload ? sha256(upload) : file !== undefined ? sha256(file) : null;
        return digest && `${digest}  ${path}`;
      });
      return lines.every(Boolean) ? exit(0, lines.join("\n") + "\n") : exit(1, lines.filter(Boolean).join("\n"));
    }
    if (wp?.startsWith("plugin install ")) {
      const known = builds.get(sha256(site.uploads.get(command[4]!)!));
      if (!known) return exit(1);
      site.installs++;
      site.version = known.version;
      site.files = new Map(Object.entries(known.files));
      return exit(0);
    }
    if (command[0] === "find" && command.includes("f")) return exit(0, [...site.files.keys()].map((path) => `${plugin}/${path}`).join("\n") + "\n");
    if (command[0] === "find") return exit(0, "");
    if (command[0] === "rm") { site.uploads.delete(command[3]!); return exit(0); }
    throw new Error(`Unexpected command: ${command.join(" ")}`);
  },
};
const isInstall = (command: readonly string[]) => command[0] === "wp" && command.includes("install");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  evidence = fakeEvidence();
  await recordLiveMigrations(stage.databases.shared);
  targets = mappings.filter((mapping) => mapping.deployment === "central").map((mapping) => targetOf(mapping.slot));
  hosts = new Map(targets.map((target) => [target.runner[3]!, { version: "0.1.9", files: new Map(Object.entries(pluginFiles("0.1.9"))),
    uploads: new Map(), down: false, installs: 0 }]));
  overrides = [];
  artifacts.clear();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

type D1 = (typeof stage)["databases"]["shared"];
const query = (database: D1) => async (sql: string, parameters: readonly (string | number)[]) =>
  sql.match(/\?\d/) ? Promise.reject(new Error("Numbered parameter"))
    : (await database.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: query(stage.databases.shared), ledger: query(stage.databases.ledger), stage: "prod", evidence, migrations: reviewedMigrations(),
  readArtifact: async (directory) => artifacts.get(directory)!, central: { targets, transport } });
const json = async (...args: string[]) => JSON.parse(await operator(...args));

/** Builds and publishes `version` as the release workflow does, with a passing release run. */
const publish = (version: string, files = pluginFiles(version), signing = "signed") => {
  const artifact = artifactOf(version, files);
  artifacts.set(version, artifact);
  builds.set(sha256(artifact.zip), { version, files });
  evidence.release(artifact);
  return operator("release-candidate", version, WORKER_COMMIT, "1", SCHEMA_RANGE, signing, "alex");
};
const verify = (version: string) => json("release-verify", version, version, evidence.ci(), evidence.deploy("staging"), "alex");
const approve = (version: string, expected: string) =>
  json("release-approve", version, "production", expected, "https://github.com/Quick-Release/gq-support/pull/144", "alex");
const launch = (id: number | string) => json("fleet-launch", String(id), evidence.deploy("prod"), "alex");
/** The whole path: published, gated, approved and launched to the fleet. */
const ship = async (version: string, expected: string) => {
  await publish(version);
  await verify(version);
  const { release_id: id } = await approve(version, expected);
  return { id: id as number, status: await launch(id) };
};
const state = async (id?: number) => (await json("fleet-status", ...(id ? [String(id)] : []))) as {
  converged: boolean; previous_window: string; dispatched_at: string; compatibility_expires_at: string; counts: Record<string, number>;
  slots: { slot: string; state: string; reason: string | null; desired_version: string; verified_at: string | null }[] };
const slotState = async (slot: string, id?: number) => (await state(id)).slots.find((row) => row.slot === slot)!;

// Native installations, signing as GQ_Support_Updater does.
const keyIdOf = (publicKey: string) => createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");
const nativeKeys = new Map<string, { pair: CryptoKeyPair; publicKey: string; keyId: string }>();
const provision = async (slot: string) => {
  const pair = await keyPair();
  const publicKey = await publicKeyOf(pair);
  nativeKeys.set(slot, { pair, publicKey, keyId: keyIdOf(publicKey) });
  await operator("update-access-grant", slot, publicKey, at(now + 300 * DAY), "https://github.com/Quick-Release/gq-support/issues/144", "alex");
};
/** One signed update request; `files` adds the gq-support-update-v2 installed-files claim. */
const signed = async (slot: string, path: string, { installed, grant = "", files }: { installed: string; grant?: string; files?: string }) => {
  const key = nativeKeys.get(slot)!;
  const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", new Uint8Array()))}:`;
  const timestamp = String(Math.floor(now / 1000));
  const requestId = crypto.randomUUID();
  const label = files === undefined ? "gq-support-update-v1" : "gq-support-update-v2";
  const canonical = [label, "GET", path, key.keyId, installed, grant, ...(files === undefined ? [] : [files]), timestamp, requestId, digest].join("\n");
  const signature = await crypto.subtle.sign("Ed25519", key.pair.privateKey, new TextEncoder().encode(canonical));
  return new Request(`https://support.example${path}`, { headers: {
    "GQ-Update-Key-Id": key.keyId, "GQ-Update-Installed-Version": installed, "GQ-Update-Grant": grant, ...(files === undefined ? {} : { "GQ-Update-Installed-Files": files }),
    "GQ-Update-Timestamp": timestamp, "GQ-Update-Request-Id": requestId, "Content-Digest": digest, "GQ-Update-Signature": base64(signature) } });
};
const packages: PackageSource = { async read(version, digest) {
  const artifact = artifacts.get(version);
  return artifact && sha256(artifact.zip) === digest ? { bytes: artifact.zip } : { failure: "unavailable" };
} };
const serve = (request: Request) => Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request), Effect.succeed(stage.databases.shared),
  mappings, () => Effect.die("Not a webhook"), () => {}, undefined, { release: "staged", packages }));
const check = async (slot: string, installed: string, files?: Record<string, string>) => {
  const response = await serve(await signed(slot, "/v1/updates/gq-support", { installed, ...(files ? { files: filesSha256(files) } : {}) }));
  expect(response.status).toBe(200);
  return await response.json() as { release: { release_id: number; version: string; kind: string; files_sha256: string; package_path: string } | null;
    grant: { token: string } | null };
};

it("refuses to record gates or launch until every gate passed at the release's own commits, listing exactly what failed", async () => {
  await publish("0.2.0");
  // A failing CI job and a staging deployment of another Worker commit.
  const ci = evidence.ci();
  evidence.runs.set(ci, { ...evidence.runs.get(ci)!, jobs: evidence.runs.get(ci)!.jobs.map((job) => job.name === "Secret scan" ? { ...job, conclusion: "failure" } : job) });
  const staging = evidence.deploy("staging", "c".repeat(40));
  await expect(operator("release-verify", "0.2.0", "0.2.0", ci, staging, "alex")).rejects.toThrow(
    /security: job "Secret scan" concluded failure.*staging: ran at c{40}, not a{40}/);
  // CI of other code, or a user-typed run that is not CI, proves nothing either.
  const other = evidence.ci();
  evidence.runs.set(other, { ...evidence.runs.get(other)!, head_sha: "d".repeat(40) });
  await expect(operator("release-verify", "0.2.0", "0.2.0", other, evidence.deploy("staging"), "alex")).rejects.toThrow(/privacy: ran at d{40}/);
  await expect(operator("release-verify", "0.2.0", "0.2.0", evidence.deploy("staging"), evidence.deploy("staging"), "alex")).rejects.toThrow(/not a .github\/workflows\/ci.yml run/);
  // Other bytes than the candidate's are never verified.
  artifacts.set("tampered", artifactOf("0.2.0", { ...pluginFiles("0.2.0"), "extra.php": "<?php" }));
  await expect(operator("release-verify", "0.2.0", "tampered", evidence.ci(), evidence.deploy("staging"), "alex")).rejects.toThrow(/not the candidate's/);
  expect((await stage.databases.shared.prepare("SELECT COUNT(*) AS n FROM release_verification").first<{ n: number }>())!.n).toBe(0);

  // Approval is the Operator's decision, but launch needs the gates, the compatible Worker deployed first and the live schema.
  const { release_id: id } = await approve("0.2.0", "none");
  await expect(launch(id)).rejects.toThrow(/gates: no verified release gates/);
  await verify("0.2.0");
  await expect(operator("fleet-launch", String(id), evidence.deploy("prod", "e".repeat(40)), "alex")).rejects.toThrow(/infrastructure: the prod deployment run ran at e{40}/);
  const refused = evidence.deploy("prod");
  evidence.artifacts.set([...evidence.artifacts.keys()].find((key) => key.includes(`-${refused}-`) && key.endsWith("plan.json"))!,
    { schema: "gq-support.deploy-plan/v1", verdict: "refused", stage: "prod", commit: WORKER_COMMIT, digest: "0".repeat(64) });
  await expect(operator("fleet-launch", String(id), refused, "alex")).rejects.toThrow(/infrastructure: .*not a safe prod plan/);
  // A live migration that is not the reviewed one is a confirmed migration failure, alerted as an incident.
  const reviewed = reviewedMigrations();
  await recordLiveMigrations(stage.databases.shared, reviewed.map((migration, index) => index === reviewed.length - 1 ? { ...migration, sha256: "f".repeat(64) } : migration));
  await expect(launch(id)).rejects.toThrow(/schema: live migration 0031 differs from its reviewed checksum/);
  await observeSignals(stage.databases.shared, now);
  expect((await listIncidents(stage.databases.shared, now)).map((incident) => [incident.category, incident.detail])).toEqual([["release_migration_failed", "mismatch"]]);
  // Unconfigured access fails closed, naming what is missing.
  await expect(runOperator(["fleet-launch", String(id), evidence.deploy("prod"), "alex"], { ledger: operatorLedger(stage.databases.shared), mappings, now, recordRevocation: async () => {},
    query: query(stage.databases.shared), migrations: reviewed })).rejects.toThrow(/Not configured: the Operator's target stage/);
  expect(JSON.parse(await operator("release-status")).current.dispatch).toBeNull();
  // The free-form dispatch and recovery approval are gone.
  await expect(operator("release-dispatch", String(id), at(now), "https://example.com/ok", "alex")).rejects.toThrow(/fleet-launch/);
  await expect(operator("release-approve", "0.1.0", "recovery", String(id), "https://example.com/ok", "alex")).rejects.toThrow(/release-withdraw/);

  await recordLiveMigrations(stage.databases.shared);
  expect((await launch(id)).dispatched_at).toBe(at(now));
  await observeSignals(stage.databases.shared, now);
  expect((await listIncidents(stage.databases.shared, now)).every((incident) => incident.category !== "release_migration_failed" || incident.state !== "resolved")).toBe(true);
});

it("dispatches to every eligible Slot together and tracks each outcome: partial completion, unreachable and unverified are not done", async () => {
  await provision("news/production");
  await provision("cafe/production");
  const { id, status } = await ship("0.2.0", "none");
  // One dispatch, at its actual start, for the whole fleet; the previous release keeps exactly 24 hours.
  expect(status).toMatchObject({ release_id: id, dispatched_at: at(START), compatibility_expires_at: at(START + DAY), previous_window: "open", converged: false,
    counts: { pending: 4 } });
  expect(status.slots.map((slot: { desired_version: string }) => slot.desired_version)).toEqual(["0.2.0", "0.2.0", "0.2.0", "0.2.0"]);

  // Central: one host is down.
  host("blog/production").down = true;
  advance(60_000);
  const run = await json("fleet-run", String(id), "0.2.0", "alex");
  expect(run.applications.map((application: { slot: string; outcome: string }) => [application.slot, application.outcome]))
    .toEqual(expect.arrayContaining([["shop/production", "verified"], ["blog/production", "unreachable"]]));
  // Native: one installs and signs exactly the release's files; the other signs the version without files (a v1 plugin).
  const offer = await check("news/production", "0.1.9", pluginFiles("0.1.9"));
  expect(offer.release).toMatchObject({ release_id: id, version: "0.2.0", kind: "production", files_sha256: filesSha256(pluginFiles("0.2.0")) });
  const served = await serve(await signed("news/production", offer.release!.package_path, { installed: "0.1.9", grant: offer.grant!.token }));
  expect(served.status).toBe(200);
  expect(await slotState("news/production")).toMatchObject({ state: "attempted" });
  advance(60_000);
  await check("news/production", "0.2.0", pluginFiles("0.2.0"));
  await check("cafe/production", "0.2.0");

  let current = await state();
  expect(Object.fromEntries(current.slots.map((slot) => [slot.slot, [slot.state, slot.reason]]))).toEqual({
    "shop/production": ["verified", null], "blog/production": ["unreachable", "unreachable"],
    "news/production": ["verified", null], "cafe/production": ["unknown", "files_unreported"] });
  expect(current.converged).toBe(false);
  // Dispatch never implies completion: the inventory keeps desired, attempted and observed apart.
  const inventory = await slotInventory(asQueryDatabase(query(stage.databases.shared)), mappings, null, now);
  expect(inventory.fleet).toMatchObject({ release_id: id, version: "0.2.0", converged: false, counts: { verified: 2, unknown: 1, unreachable: 1 } });

  // The exact 24-hour transition for the previous release, while the rollout stays incomplete.
  advance(START + DAY - 1 - now);
  expect((await state()).previous_window).toBe("open");
  advance(1);
  expect((await state()).previous_window).toBe("expired");
  // A native Slot silent for a day is unknown, not pending.
  current = await state();
  expect(current.slots.find((slot) => slot.slot === "cafe/production")).toMatchObject({ state: "unknown" });

  // The unreachable host comes back; only it is applied again, and the fleet converges.
  host("blog/production").down = false;
  const installs = host("shop/production").installs;
  await json("fleet-run", String(id), "0.2.0", "alex");
  expect(host("shop/production").installs).toBe(installs);
  await check("cafe/production", "0.2.0", pluginFiles("0.2.0"));
  expect((await state()).converged).toBe(true);
});

it("keeps a central install whose files are wrong failed and alerted, and reconciles an unknown install by read-back without repeating it", async () => {
  const { id } = await ship("0.2.0", "none");
  overrides.push({ alias: "shop-production", match: isInstall, answer: () => {
    const site = host("shop/production");
    site.version = "0.2.0";
    site.files = new Map(Object.entries({ ...pluginFiles("0.2.0"), "gq-support.php": "<?php // tampered" }));
    return { kind: "exit", code: 0, stdout: "" };
  } });
  // The blog's install completes but its answer is lost, and the host then stops answering.
  overrides.push({ alias: "blog-production", match: isInstall, answer: async (command) => {
    const result = await transport.run(["ssh", "-o", "BatchMode=yes", "blog-production", ...command]);
    host("blog/production").down = true;
    return result.kind === "exit" ? { kind: "lost" } : result;
  } });
  await json("fleet-run", String(id), "0.2.0", "alex");
  expect(await slotState("shop/production")).toMatchObject({ state: "failed", reason: "files_mismatch" });
  expect(await slotState("blog/production")).toMatchObject({ state: "unknown", reason: "transport_lost" });

  // Only the confirmed failure is an incident, grouped under the release.
  await observeSignals(stage.databases.shared, now);
  expect((await listIncidents(stage.databases.shared, now)).map((incident) => [incident.category, incident.affected_slots]))
    .toEqual([["release_update_failed", ["shop/production"]]]);

  host("blog/production").down = false;
  const installs = host("blog/production").installs;
  const run = await json("fleet-run", String(id), "0.2.0", "alex");
  expect(run.applications.find((application: { slot: string }) => application.slot === "blog/production")).toMatchObject({ action: "reconcile", outcome: "verified" });
  expect(host("blog/production").installs).toBe(installs);
  // The failed Slot is retried, within its attempt bound.
  expect(await slotState("shop/production")).toMatchObject({ state: "verified" });
  await observeSignals(stage.databases.shared, now);

  // After three confirmed failures on one Slot, fleet-run stops trying it and leaves it to an Operator.
  const next = await ship("0.3.0", String(id));
  for (let attempt = 0; attempt < 4; attempt++) {
    overrides.push({ alias: "shop-production", match: isInstall, answer: () => ({ kind: "exit", code: 1, stdout: "" }) });
    await json("fleet-run", String(next.id), "0.3.0", "alex");
  }
  const exhausted = await json("fleet-run", String(next.id), "0.3.0", "alex");
  expect(exhausted.applications.find((application: { slot: string }) => application.slot === "shop/production")).toMatchObject({ action: "skipped", reason: "attempts_exhausted" });
});

it("withdraws a bad release during installs, stops further distribution and recovers every affected Slot to the verified compatible package", async () => {
  await provision("news/production");
  const good = await ship("0.2.0", "none");
  await json("fleet-run", String(good.id), "0.2.0", "alex");
  await check("news/production", "0.2.0", pluginFiles("0.2.0"));
  const bad = await ship("0.3.0", String(good.id));
  // The native Slot already installed the bad release; meanwhile its next offer is cached by WordPress.
  const cached = await check("news/production", "0.2.0", pluginFiles("0.2.0"));
  await check("news/production", "0.3.0", pluginFiles("0.3.0"));

  // The bad release is withdrawn while the first central host installs it: the second is never applied.
  overrides.push({ alias: "shop-production", match: isInstall, answer: async (command) => {
    host("shop/production").installs++;
    const known = builds.get(sha256(host("shop/production").uploads.get(command[4]!)!))!;
    host("shop/production").version = known.version;
    host("shop/production").files = new Map(Object.entries(known.files));
    expect(JSON.parse(await operator("release-withdraw", String(bad.id), "0.2.0", evidence.deploy("prod"), "alex"))).toMatchObject({
      withdrawn: { release_id: bad.id, version: "0.3.0" }, recovery: { kind: "recovery", version: "0.2.0" } });
    return { kind: "exit", code: 0, stdout: "" };
  } });
  const run = await json("fleet-run", String(bad.id), "0.3.0", "alex");
  // Applications already past their last approval check finish and are recorded; none starts after the withdrawal.
  expect(run.halted).toBe(true);
  expect(run.applications).toContainEqual(expect.objectContaining({ slot: "shop/production", outcome: "verified", still_approved: false }));

  // Nothing distributes the bad release any more: no stale offer or cached grant reinstalls it.
  const stale = await serve(await signed("news/production", cached.release!.package_path, { installed: "0.3.0", grant: cached.grant!.token }));
  expect(stale.status).toBe(410);
  await expect(operator("fleet-run", String(bad.id), "0.3.0", "alex")).rejects.toThrow(/Only the dispatched approved release/);
  // The recovery offer names the earlier verified package; the plugin installs it through its guarded recovery path.
  const recovery = await check("news/production", "0.3.0", pluginFiles("0.3.0"));
  expect(recovery.release).toMatchObject({ version: "0.2.0", kind: "recovery", files_sha256: filesSha256(pluginFiles("0.2.0")) });
  const recoveryId = recovery.release!.release_id;
  expect(await slotState("news/production", recoveryId)).toMatchObject({ state: "pending", desired_version: "0.2.0" });

  // Every affected Slot is recovered: central downgrades only under the recovery approval, already-good Slots verify in place.
  await json("fleet-run", String(recoveryId), "0.2.0", "alex");
  advance(60_000);
  await check("news/production", "0.2.0", pluginFiles("0.2.0"));
  expect(host("shop/production").version).toBe("0.2.0");
  const recovered = await state(recoveryId);
  expect(Object.fromEntries(recovered.slots.map((slot) => [slot.slot, slot.state]))).toMatchObject({
    "shop/production": "verified", "blog/production": "verified", "news/production": "verified", "cafe/production": "blocked" });
  // The withdrawn version is never approved or recovered to again.
  await expect(approve("0.3.0", String(recoveryId))).rejects.toThrow(/never approved before/);
  await publish("0.3.1");
  await verify("0.3.1");
  const fixed = await approve("0.3.1", String(recoveryId));
  await launch(fixed.release_id);
  await expect(operator("release-withdraw", String(fixed.release_id), "0.3.0", evidence.deploy("prod"), "alex")).rejects.toThrow(/itself withdrawn/);
});

it("refuses a rollback that merely exists or is incompatible with the live schema, and never reverses migrations", async () => {
  const first = await ship("0.2.0", "none");
  const second = await ship("0.3.0", String(first.id));
  // A published version that was never verified and launched is no recovery package.
  await publish("0.1.5");
  await expect(operator("release-withdraw", String(second.id), "0.1.5", evidence.deploy("prod"), "alex")).rejects.toThrow(/verified release launched before/);
  // A live destructive migration past the package's tested range: the package is not compatible.
  const reviewed = reviewedMigrations();
  const destructive = { name: "0032_drop_legacy.sql", sql: "DROP TABLE slot_update_attempt;", sha256: sha256("DROP TABLE slot_update_attempt;") };
  await recordLiveMigrations(stage.databases.shared, [...reviewed, destructive]);
  const withdraw = runOperator(["release-withdraw", String(second.id), "0.2.0", evidence.deploy("prod"), "alex"], { ledger: operatorLedger(stage.databases.shared), mappings, now, recordRevocation: async () => {},
    query: query(stage.databases.shared), stage: "prod", evidence, migrations: [...reviewed, destructive] });
  await expect(withdraw)
    .rejects.toThrow(/not compatible with the live service \(live migration 0032 removes structures.*never rolled back/);
  // Nor a live migration that is not a reviewed one.
  await recordLiveMigrations(stage.databases.shared, [...reviewed, { name: "0032_hotfix.sql", sha256: "9".repeat(64) }]);
  await expect(operator("release-withdraw", String(second.id), "0.2.0", evidence.deploy("prod"), "alex")).rejects.toThrow(/the live schema is unreviewed/);
  expect(JSON.parse(await operator("release-status")).current).toMatchObject({ release_id: second.id, kind: "production" });
  // The schema is untouched: no migration was reversed.
  expect((await stage.databases.shared.prepare("SELECT COUNT(*) AS n FROM __alchemy_migrations").first<{ n: number }>())!.n).toBe(reviewed.length + 1);
  // On the reviewed live schema, the verified, launched earlier package is a compatible recovery.
  await recordLiveMigrations(stage.databases.shared);
  expect(await json("release-withdraw", String(second.id), "0.2.0", evidence.deploy("prod"), "alex")).toMatchObject({ recovery: { version: "0.2.0", kind: "recovery" } });
});

it("records a rollback boundary only after every Slot verified the release and the previous window ended", async () => {
  await provision("news/production");
  const first = await ship("0.2.0", "none");
  await expect(operator("release-boundary", String(first.id), "31", "alex")).rejects.toThrow(/not every Slot verified/);
  await json("fleet-run", String(first.id), "0.2.0", "alex");
  await check("news/production", "0.2.0", pluginFiles("0.2.0"));
  // The cafe Slot has no update access: blocked is not confirmation.
  await expect(operator("release-boundary", String(first.id), "31", "alex")).rejects.toThrow(/not every Slot verified/);
  await provision("cafe/production");
  await check("cafe/production", "0.2.0", pluginFiles("0.2.0"));
  await expect(operator("release-boundary", String(first.id), "31", "alex")).rejects.toThrow(/24-hour window is still open/);
  advance(DAY);
  expect(await json("release-boundary", String(first.id), "31", "alex")).toMatchObject({ release_id: first.id, schema_floor: 31, verified_slots: 4 });
  // A Composer-managed central target is blocked rather than counted, since a bare ZIP install would not persist.
  targets = targets.map((target) => ({ ...target, source: "composer" }));
  const second = await ship("0.3.0", String(first.id));
  expect((await state(second.id)).slots.filter((slot) => slot.reason === "managed_source_unsupported").length).toBe(2);
});

it("a restore that makes a withdrawn release current again blocks service until it is withdrawn again", async () => {
  const good = await ship("0.2.0", "none");
  const bad = await ship("0.3.0", String(good.id));
  const db = stage.databases.shared;
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`).all<{ name: string }>()).results.map(({ name }) => name);
  const image = await Promise.all(tables.map(async (table) => ({ table, rows: (await db.prepare(`SELECT * FROM ${table}`).all()).results })));
  await json("release-withdraw", String(bad.id), "0.2.0", evidence.deploy("prod"), "alex");

  await json("maintenance-begin", "alex", "restore", "inc-restore-1");
  now += 120_000;
  vi.setSystemTime(now);
  // A Time Travel restore of the main database to before the withdrawal.
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"), ...image.map(({ table }) => db.prepare(`DELETE FROM ${table}`)),
    ...image.flatMap(({ table, rows }) => rows.map((row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))))]);
  await operator("restore-recorded", "alex", "time-travel-restore");
  await restoreGate()(db, stage.databases.ledger, now);
  await expect(operator("maintenance-end", "alex", "1", "inc-restore-1")).rejects.toThrow(/withdrawn_release_current/);
  // Nothing else may change the fleet during maintenance, but the withdrawal can be made again.
  await expect(operator("fleet-launch", String(bad.id), evidence.deploy("prod"), "alex")).rejects.toThrow(/maintenance is in effect/);
  await json("release-withdraw", String(bad.id), "0.2.0", evidence.deploy("prod"), "alex");
  expect(await json("maintenance-end", "alex", "1", "inc-restore-1")).toMatchObject({ state: "serving" });
});

it("an offboarded Slot is not a launch target, gets no fleet application and stays out of convergence", async () => {
  await operator("offboard", "blog/production", "alex", "https://github.com/Quick-Release/gq-support/issues/147");
  const { id } = await ship("0.2.0", "none");
  const [launched] = (await stage.databases.shared.prepare("SELECT evidence FROM fleet_launch WHERE sequence = ?").bind(id)
    .all<{ evidence: string }>()).results;
  expect((JSON.parse(launched!.evidence) as { targets: { slot: string }[] }).targets.map((target) => target.slot))
    .toEqual(["shop/production", "news/production", "cafe/production"]);
  const run = await json("fleet-run", String(id), "0.2.0", "alex") as { applications: { slot: string }[] };
  expect(run.applications.map((application) => application.slot)).toEqual(["shop/production"]);
  expect(await slotState("blog/production")).toMatchObject({ state: "offboarded" });
});


it("refuses recovery to the unsigned bootstrap after a signed release was approved", async () => {
  await publish("0.1.9", undefined, "unsigned-legacy");
  await verify("0.1.9");
  const bootstrap = await approve("0.1.9", "none");
  await launch(bootstrap.release_id);
  const current = await ship("0.2.0", String(bootstrap.release_id));
  await expect(operator("release-withdraw", String(current.id), "0.1.9", evidence.deploy("prod"), "alex"))
    .rejects.toThrow(/unsigned legacy recovery/);
  expect((await json("release-status")).current.package_version).toBe("0.2.0");
  expect(await stage.databases.ledger.prepare("SELECT COUNT(*) AS n FROM release_withdrawal").first()).toEqual({ n: 0 });
});
