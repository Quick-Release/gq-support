import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { operationsAccess } from "../src/operations-api.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { operationsClient } from "./operations-client.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { runOperator } from "../src/operator.ts";
import type { ReleaseEnforcement } from "../src/release-policy.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

// #141 (ADR 0021): approved releases, the 24-hour previous-release window and
// service intake enforcement, through the Operator CLI and the signed installation API.
const START = Date.parse("2026-10-20T10:00:00Z");
const HOUR = 3_600_000;
const WORKER_COMMIT = "a".repeat(40);
const mappings: RepositoryMapping[] = [
  { slot: "shop/production", client: "shop", project: "shop", environment: "production", repositoryId: 42, defaultDeveloper: "developer" },
];

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let now: number;
// Release artifacts as the release workflow writes them (scripts/ci/release-package.mjs), by directory.
let artifacts: Map<string, { zip: Uint8Array; manifest: string; provenance: string }>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  artifacts = new Map();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const at = (time: number) => new Date(time).toISOString();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A verified release workflow's output for `version`; returns its directory. */
const published = (version: string, change: { manifest?: object; provenance?: object } = {}) => {
  const zip = new TextEncoder().encode(`gq-support ${version} package bytes`);
  const directory = `package-zip-${version}`;
  artifacts.set(directory, {
    zip,
    manifest: JSON.stringify({ name: "gq-support", version, zip: { file: "gq-support.zip", size: zip.length, sha256: sha256(zip) }, files: [],
      ...change.manifest }),
    provenance: JSON.stringify({ version, commit: "b".repeat(40), run: "39000000001", zip_sha256: sha256(zip), ...change.provenance }),
  });
  return directory;
};

const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  // Like the Wrangler adapter: plain `?` parameters, one statement per call.
  query: async (sql, parameters) => sql.match(/\?\d/) ? Promise.reject(new Error("Numbered parameter"))
    : (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  readArtifact: async (directory) => {
    const artifact = artifacts.get(directory);
    if (!artifact) throw new Error("No such artifact");
    return artifact;
  } });

/** Records a published candidate from its artifacts, approves it and records its fleet dispatch. */
const candidate = (version: string, claim: "signed" | "unsigned-legacy" = "signed") =>
  operator("release-candidate", published(version), WORKER_COMMIT, "1", "0001-0027", claim, "alex");
const approve = (version: string, expected: string, kind = "production") =>
  operator("release-approve", version, kind, expected, "https://github.com/Quick-Release/gq-support/pull/141", "alex");
const dispatch = (release: string, dispatchedAt = now) =>
  operator("release-dispatch", release, at(dispatchedAt), "https://github.com/Quick-Release/gq-support/actions/runs/39000000002", "alex");

const REPORTER = "11111111-1111-4111-8111-111111111111";
const submission = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const create = (installation: Installation, n: number) => installation.send("POST", "/v1/requests", JSON.stringify({
  submission_id: submission(n), description: "Checkout does nothing", reporter_subject: REPORTER, scope: "mine" }));
const enrolled = async (enforcement: ReleaseEnforcement | null = "enforced", version: string | null = "0.2.0") =>
  harness(stage.databases.shared, mappings, { release: enforcement }).enroll("shop/production", "installation-a", {}, version);

it("accepts new intake only from the approved release, and the previous one until 24 hours after the recorded dispatch", async () => {
  await candidate("0.1.9");
  expect(JSON.parse(await approve("0.1.9", "none"))).toMatchObject({ release_id: 1, package_version: "0.1.9", kind: "production" });
  await dispatch("1");
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  const current = await enrolled("enforced", "0.2.0");
  const previous = current.running("0.1.9");

  // Before its dispatch is recorded the fleet still runs 0.1.9, and nothing has started its window.
  expect((await create(previous, 1)).status).toBe(202);
  advance(2 * HOUR);
  const dispatchedAt = now;
  expect(JSON.parse(await dispatch("2"))).toMatchObject({ release_id: 2, dispatched_at: at(dispatchedAt),
    compatibility_expires_at: at(dispatchedAt + 24 * HOUR) });

  expect((await create(current, 2)).status).toBe(202);
  advance(24 * HOUR - 1);
  expect((await create(previous, 3)).status).toBe(202);
  advance(1);
  // Exactly at expiry the previous release takes no new intake; the approved one still does.
  const refused = await create(previous, 4);
  expect(refused.status).toBe(426);
  expect(await refused.json()).toEqual({ code: "gq_support_plugin_outdated", release: { enforcement: "enforced", intake: "closed",
    reason: "expired", plugin_version: "0.1.9", approved_version: "0.2.0", compatible_until: null } });
  expect((await create(current, 5)).status).toBe(202);
  // An unknown or unapproved version never had a window.
  expect((await create(current.running("0.3.0-dev"), 6)).status).toBe(426);
});

const deliver = (id: string) => stage.databases.shared.batch([
  stage.databases.shared.prepare("UPDATE delivery_intent SET state = 'delivered' WHERE request_id = ? AND seq = 0").bind(id),
  stage.databases.shared.prepare("UPDATE support_request SET status = 'open' WHERE id = ?").bind(id),
]);
const change = (installation: Installation, id: string, n: number) => installation.send("POST", `/v1/requests/${id}/status`,
  JSON.stringify({ change_id: submission(100 + n), status: "closed", reporter_subject: REPORTER, scope: "mine" }));

it("still answers retries of work accepted before the window closed, and refuses only new intents", async () => {
  await candidate("0.1.9");
  await approve("0.1.9", "none");
  await dispatch("1");
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  await dispatch("2");
  const previous = (await enrolled("enforced", "0.2.0")).running("0.1.9");
  const accepted = await create(previous, 1);
  expect(accepted.status).toBe(202);
  const { id } = await accepted.json() as { id: string };
  await deliver(id);
  expect((await change(previous, id, 1)).status).toBe(202);

  advance(24 * HOUR);
  // A retry checks for the accepted intent before any policy: never a false failure or loss.
  const retried = await create(previous, 1);
  expect(retried.status).toBe(201);
  expect(await retried.json()).toMatchObject({ id, submission_id: submission(1), delivery: "delivered" });
  expect((await change(previous, id, 1)).status).toBe(202);
  // New intents are refused, and nothing was stored for them.
  expect((await create(previous, 2)).status).toBe(426);
  expect((await change(previous, id, 2)).status).toBe(426);
  // Reads, lists and the installation check keep working for the outdated plugin.
  expect((await previous.send("GET", `/v1/requests/${id}?reporter_subject=${REPORTER}&scope=mine`)).status).toBe(200);
  expect((await previous.send("GET", `/v1/requests?reporter_subject=${REPORTER}&scope=mine`)).status).toBe(200);
  expect((await previous.send("GET", "/v1/installation")).status).toBe(200);
  const stored = await stage.databases.shared.prepare("SELECT COUNT(*) AS count FROM support_request").first<{ count: number }>();
  expect(stored?.count).toBe(1);
});

it("treats an unsigned version header as unknown, so a legacy plugin cannot claim the approved release", async () => {
  // The previous approved release is a legacy package that cannot sign its version.
  await candidate("0.1.10", "unsigned-legacy");
  await approve("0.1.10", "none");
  await dispatch("1");
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  await dispatch("2");
  const legacy = (await enrolled("enforced", null));
  expect((await create(legacy, 1)).status).toBe(202);
  advance(24 * HOUR);
  const spoofed = await legacy.send("POST", "/v1/requests", JSON.stringify({ submission_id: submission(2), description: "Checkout does nothing",
    reporter_subject: REPORTER, scope: "mine" }), { "GQ-Support-Plugin-Version": "0.2.0" });
  expect(spoofed.status).toBe(426);
  expect(await spoofed.json()).toMatchObject({ release: { plugin_version: null, reason: "expired", approved_version: "0.2.0" } });
  // Nor can a signed version be swapped after signing.
  const swapped = await legacy.running("0.1.10").send("POST", "/v1/requests", "{}", { "GQ-Support-Plugin-Version": "0.2.0" });
  expect(swapped.status).toBe(403);
});

it("lets an Operator approve an earlier verified package as the temporary recovery release", async () => {
  await candidate("0.1.9");
  await approve("0.1.9", "none");
  await dispatch("1");
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  await dispatch("2");
  const installation = await enrolled("enforced", "0.2.0");
  const revoked = await harness(stage.databases.shared, mappings, { release: "enforced" }).enroll("shop/production", "installation-b", {}, "0.1.9");
  // Re-enrolling the Slot revoked installation-a's key; no release decision revives it.
  advance(25 * HOUR);
  expect((await create(revoked, 1)).status).toBe(426);
  expect(JSON.parse(await approve("0.1.9", "2", "recovery"))).toMatchObject({ release_id: 3, kind: "recovery", previous_release_id: 2 });
  expect((await create(revoked, 2)).status).toBe(202);
  // The release it replaced is the previous one; it stays compatible only until the recovery's dispatch window ends.
  expect((await create(installation, 3)).status).toBe(403);
  await dispatch("3");
  advance(24 * HOUR);
  expect((await create(revoked, 4)).status).toBe(202);
  expect((await create(revoked.running("0.2.0"), 5)).status).toBe(426);

  // A recovery package must be an earlier approved one, never the approved release or an unapproved candidate.
  await candidate("0.2.1");
  await expect(approve("0.2.1", "3", "recovery")).rejects.toThrow(/earlier approved version/);
  await expect(approve("0.1.9", "3", "recovery")).rejects.toThrow(/earlier approved version/);
});

it("refuses approvals and dispatches the evidence does not support, recording nothing", async () => {
  const status = async () => JSON.parse(await operator("release-status"));
  // Artifacts whose bytes, manifest and provenance disagree are not a verified package.
  await expect(operator("release-candidate", published("0.1.9", { manifest: { zip: { file: "gq-support.zip", size: 1, sha256: "0".repeat(64) } } }),
    WORKER_COMMIT, "1", "0001-0027", "signed", "alex")).rejects.toThrow(/do not agree/);
  await expect(operator("release-candidate", published("0.1.9", { provenance: { version: "0.1.8" } }),
    WORKER_COMMIT, "1", "0001-0027", "signed", "alex")).rejects.toThrow(/do not agree/);
  await expect(approve("0.1.9", "none")).rejects.toThrow(/No published candidate/);
  await expect(operator("release-candidate", published("0.1.9"), WORKER_COMMIT, "2", "0001-0027", "signed", "alex")).resolves.toBeTruthy();
  await expect(approve("0.1.9", "none")).rejects.toThrow(/does not serve/);
  await candidate("0.1.10");
  // A retry of the same record is idempotent; other bytes for the version are refused.
  await expect(candidate("0.1.10")).resolves.toContain("candidate");
  artifacts.clear();
  await expect(operator("release-candidate", published("0.1.10", {}), WORKER_COMMIT, "1", "0001-0027", "signed", "alex")).resolves.toBeTruthy();
  await approve("0.1.10", "none");
  // A stale expectation loses, as a concurrent approval would.
  await candidate("0.2.0");
  await expect(approve("0.2.0", "none")).rejects.toThrow(/now 1, not none/);
  // Production waits for the approved release's recorded dispatch.
  await expect(approve("0.2.0", "1")).rejects.toThrow(/after the approved release's dispatch/);
  await expect(dispatch("1", now + 1)).rejects.toThrow(/no later than now/);
  await expect(dispatch("1", now - 1)).rejects.toThrow(/at or after its approval/);
  await dispatch("1");
  await expect(dispatch("1")).rejects.toThrow(/first dispatch/);
  await approve("0.2.0", "1");
  await expect(dispatch("1")).rejects.toThrow(/first dispatch/);
  await expect(approve("0.1.10", "2")).rejects.toThrow(/never approved before/);
  await expect(approve("0.2.0", "2", "production")).rejects.toThrow(/never approved before/);
  await expect(operator("release-approve", "0.2.0", "production", "2", "evidence", "alex smith")).rejects.toThrow(/Usage/);
  const { current, previous, enforcement } = await status();
  expect(enforcement).toBe("unconfigured");
  expect(current).toMatchObject({ release_id: 2, package_version: "0.2.0", kind: "production", previous_release_id: 1, dispatch: null,
    package_sha256: sha256(artifacts.get("package-zip-0.2.0")!.zip), worker_commit: WORKER_COMMIT, contract_version: 1,
    schema: { from: 1, to: 27 }, signs_version: true, provenance: `release-plugin run 39000000001 at ${"b".repeat(40)}`, approved_by: "alex" });
  expect(previous).toMatchObject({ release_id: 1, package_version: "0.1.10", dispatch: { dispatched_at: at(START), recorded_by: "alex" } });
});

it("fails closed without a well-formed approved release or a configured enforcement, and reports a staged one honestly", async () => {
  const installation = await enrolled("enforced", "0.2.0");
  const check = async (sender: Installation) => (await (await sender.send("GET", "/v1/installation")).json() as { release: unknown }).release;
  // Nothing approved yet: new intake is refused as unavailable, never as an outdated plugin.
  const refused = await create(installation, 1);
  expect([refused.status, await refused.json()]).toEqual([503, { code: "gq_support_not_accepted" }]);
  expect(await check(installation)).toEqual({ enforcement: "enforced", intake: "closed", reason: "unavailable", plugin_version: "0.2.0",
    approved_version: null, compatible_until: null });

  const staged = await enrolled("staged", "0.2.0");
  expect((await create(staged, 2)).status).toBe(202);
  expect(await check(staged)).toMatchObject({ enforcement: "staged", intake: "open", reason: "unavailable" });
  const unconfigured = await enrolled(null, "0.2.0");
  expect((await create(unconfigured, 3)).status).toBe(503);
  expect(await check(unconfigured)).toMatchObject({ enforcement: "unconfigured", intake: "closed" });

  await candidate("0.2.0");
  await approve("0.2.0", "none");
  const current = await enrolled("enforced", "0.2.0");
  expect((await create(current, 4)).status).toBe(202);
  expect(await check(current)).toEqual({ enforcement: "enforced", intake: "open", reason: "current", plugin_version: "0.2.0",
    approved_version: "0.2.0", compatible_until: null });
  // A malformed record is never trusted.
  await stage.databases.shared.prepare("UPDATE release_candidate SET package_sha256 = 'not-a-digest'").run();
  expect((await create(current, 5)).status).toBe(503);
});

it("tells the previous release when its window ends, so WordPress can close new intake locally without asking again", async () => {
  await candidate("0.1.9");
  await approve("0.1.9", "none");
  await dispatch("1");
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  const previous = (await enrolled("enforced", "0.2.0")).running("0.1.9");
  const check = async () => (await (await previous.send("GET", "/v1/installation")).json() as { release: unknown }).release;
  expect(await check()).toMatchObject({ intake: "open", reason: "previous", compatible_until: null });
  await dispatch("2");
  expect(await check()).toEqual({ enforcement: "enforced", intake: "open", reason: "previous", plugin_version: "0.1.9",
    approved_version: "0.2.0", compatible_until: at(START + 24 * HOUR) });
});

it("shows staff the approved release as each Slot's desired version, and only a signed or recorded version as observed", async () => {
  const banquinha = await operationsClient();
  const access = operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex");
  const staff = async () => {
    const response = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(await banquinha.request("GET", "/v1/operations/inventory", "alex")),
      Effect.succeed(stage.databases.shared), mappings, () => Effect.die("Not a webhook"), () => {}, undefined, { release: "enforced" }, access));
    expect(response.status).toBe(200);
    return await response.json() as { release: unknown; slots: { versions: Record<string, unknown>; update: unknown }[] };
  };
  await candidate("0.1.9");
  await approve("0.1.9", "none");
  await dispatch("1");
  const installation = await enrolled("enforced", "0.1.9");
  // A signed request is the installation's own authenticated report of its version.
  await installation.send("GET", "/v1/installation");
  advance(HOUR);
  await candidate("0.2.0");
  await approve("0.2.0", "1");
  await dispatch("2");

  const { release, slots: [slot] } = await staff();
  expect(release).toEqual({ enforcement: "enforced",
    approved: { release_id: 2, package_version: "0.2.0", kind: "production", approved_at: at(now), dispatched_at: at(now),
      compatibility_expires_at: at(now + 24 * HOUR) },
    previous: { release_id: 1, package_version: "0.1.9" } });
  // The dispatch is policy intent: the installation is neither attempted nor observed on 0.2.0 by it.
  expect(slot!.versions).toEqual({ desired: { version: "0.2.0", at: at(now), source: "release" }, attempted: null,
    observed: { state: "current", reason: null, version: "0.1.9", observed_at: at(START), source: "signed-request" } });
  expect(slot!.update).toEqual({ outcome: "none", at: null });

  // Unreachable for a day: unknown, never confirmed current or disabled.
  advance(24 * HOUR + 1);
  expect((await staff()).slots[0]!.versions.observed).toMatchObject({ state: "unknown", reason: "stale", version: "0.1.9" });
  await installation.running("0.2.0").send("GET", "/v1/installation");
  expect((await staff()).slots[0]!.versions.observed).toMatchObject({ state: "current", version: "0.2.0", source: "signed-request" });
  // Staff cannot approve or dispatch: release authority stays with the Operator CLI.
  const mutation = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(await banquinha.request("POST", "/v1/operations/releases", "alex", "{}")),
    Effect.succeed(stage.databases.shared), mappings, () => Effect.die("Not a webhook"), () => {}, undefined, { release: "enforced" }, access));
  expect(mutation.status).toBe(404);
});
