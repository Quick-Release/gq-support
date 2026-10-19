import type { D1PreparedStatement } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { digestKey, erasureStatus, recordErasure, sweepCleanup, titleDigest } from "../src/cleanup.ts";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { sha256 } from "../src/signature.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG, type FakeIssue } from "./fake-github.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const DAY = 86_400_000;
const mapping: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const subject = "00000000-0000-4000-8000-000000000001";
const ERASED_BODY = "Support request text erased at the Reporter's request.";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let installation: Installation;
let github: ReturnType<typeof makeFakeGitHub>;
let logs: string[];
let now: number;
let key: CryptoKey;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  installation = await harness(stage.databases.shared, [mapping]).enroll(mapping.slot, "installation-a");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  logs = [];
  key = await digestKey("test App private key");
});
afterEach(async () => {
  // No log line from any flow carries Submitted text, subjects or credentials.
  expect(logs.join("\n")).not.toMatch(/Private report text|Checkout fails|00000000-0000-4000|ghs_|Bearer/);
  await stage.dispose();
  vi.useRealTimers();
});

const db = () => stage.databases.shared;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const accept = async (description = "Private report text") => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description }));
  expect(response.status).toBe(202);
  return await response.json() as { id: string };
};
const gateway = () => GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer));
const logger = () => Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(line); })]);
const sweep = (database: QueryDatabase = db()) => Effect.runPromise(sweepDelivery({ db: database, mappings: [mapping],
  botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 }).pipe(Effect.provide(gateway()), Effect.provide(logger())));
const cleanup = (digest: CryptoKey | null = key) => Effect.runPromise(sweepCleanup({ db: db(), botLogin: `${SLUG}[bot]`, mappings: [mapping], digestKey: digest, now: () => now })
  .pipe(Effect.provide(gateway()), Effect.provide(logger())));
const erase = () => recordErasure(db(), mapping.slot, subject, now, key, null);
const operator = (...args: string[]) => runOperator(args, {
  query: async (sql, parameters) => (await db().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  ledger: async (sql, parameters) => (await stage.databases.ledger.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  recordRevocation: async () => {}, mappings: [mapping], now,
});
const read = (id: string) => installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`);
const list = async () => (await (await installation.send("GET", `/v1/requests?reporter_subject=${subject}&scope=mine`)).json() as { items: unknown[] }).items;
const posts = () => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));
const patches = () => github.requests.filter((request) => request.method === "PATCH");
const requestRow = (id: string) => db().prepare("SELECT * FROM support_request WHERE id = ?").bind(id).first<Record<string, unknown>>();
const intentRow = (id: string) => db().prepare("SELECT * FROM delivery_intent WHERE request_id = ?").bind(id).first<Record<string, unknown>>();
const cleanupRow = (id: string) => db().prepare("SELECT * FROM support_cleanup WHERE request_id = ?").bind(id).first<Record<string, unknown>>();
const suppressed = async (id: string) => (await db().prepare("SELECT 1 FROM delivery_suppression WHERE scope = 'request' AND reference = ?").bind(id).first()) !== null;
/** Runs the cleanup on its automatic schedule until the 24-hour window has passed. */
const throughWindow = async () => { for (let hour = 0; hour < 26; hour++) { advance(3_600_000); await cleanup(); } };
const unknownCreate = (hide = false) => github.onCreate((issue) => { if (hide) issue.deleted = true; return new Response(null, { status: 502 }); });
const expectRedacted = (issue: FakeIssue, title: string) => {
  expect(issue.title).toBe(title);
  expect(issue.body!.split("\n").slice(0, 2)).toEqual([expect.stringMatching(/^<!-- gq-support:v1 intent=int_\w+ -->$/),
    expect.stringMatching(/^\*\*Support request\*\* submitted via GETQUICK Support/)]);
  expect(issue.body).toContain(ERASED_BODY);
  expect(issue.body).not.toContain("Private report text");
};
/** Only the restricted cleanup record remains: no request row, text, subject, Submission ID or digest. */
const expectMinimal = async (id: string) => {
  expect(await requestRow(id)).toBeNull();
  expect(await intentRow(id)).toBeNull();
  expect(await cleanupRow(id)).toMatchObject({ intent_id: expect.stringMatching(/^int_/), github_installation_id: 7,
    repository_id: 42, attempt_started_at: expect.any(Number), attempt_ended_at: expect.any(Number) });
};

it("erasure before dispatch suppresses the create and completes after purging", async () => {
  const request = await accept();
  const erasure = await erase();
  await sweep();
  expect(github.requests).toHaveLength(0);
  expect(github.requests).toHaveLength(0);
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress", counts: { pending: 1 } });
  await cleanup();
  expect(await erasureStatus(db(), erasure)).toEqual({ id: erasure, state: "completed",
    counts: { purged: 1, redacted: 0, pending: 0 }, residual: [] });
  expect(await requestRow(request.id)).toBeNull();
  expect(await intentRow(request.id)).toBeNull();
  expect(await cleanupRow(request.id)).toMatchObject({ state: "resolved", outcome: "purged", title_digest: null });
  expect(await suppressed(request.id)).toBe(true);
  expect((await read(request.id)).status).toBe(404);
  advance(DAY);
  await sweep();
  expect(posts()).toHaveLength(0);
});

it("an authorized create drains, then its issue is redacted and retitled", async () => {
  const request = await accept();
  let erasure = "";
  github.next(() => undefined); // installation token
  github.next(async () => { erasure = await erase(); return undefined; }); // erasure lands while the POST is in flight
  await sweep();
  expect(posts()).toHaveLength(1);
  // Hidden from the Reporter at once, even while the attempt drains.
  expect((await read(request.id)).status).toBe(404);
  expect(await list()).toEqual([]);
  expect(await requestRow(request.id)).toMatchObject({ description: "", issue_id: github.issues[0]!.id });
  await cleanup();
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress" });
  advance(10_000); // the installation's mutation pacing
  await cleanup();
  expectRedacted(github.issues[0]!, "Support request (erased)");
  expect(patches()).toHaveLength(1);
  expect(await erasureStatus(db(), erasure)).toEqual({ id: erasure, state: "needs_review",
    counts: { purged: 0, redacted: 1, pending: 0 }, residual: ["edit_history"] });
  expect(await requestRow(request.id)).toBeNull();
  expect(posts()).toHaveLength(1);
});

it("an uncertain result is reconciled read-only, then the found issue is redacted", async () => {
  const request = await accept();
  unknownCreate();
  await sweep();
  const erasure = await erase();
  await cleanup();
  await expectMinimal(request.id);
  // Only the keyed title digest outlives the text, and only while automatic retitling remains possible.
  expect(await cleanupRow(request.id)).toMatchObject({ state: "reconciling", title_digest: expect.stringMatching(/^[a-f0-9]{16}\.[a-f0-9]{64}$/) });
  advance(60_000);
  await cleanup();
  expectRedacted(github.issues[0]!, "Support request (erased)");
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "needs_review", counts: { redacted: 1, pending: 0 } });
  expect(posts()).toHaveLength(1);
  expect(await requestRow(request.id)).toBeNull();
});

it("an issue discovered late in the window is still redacted", async () => {
  const request = await accept();
  unknownCreate(true);
  await sweep();
  const erasure = await erase();
  await cleanup();
  advance(60_000);
  await cleanup(); // an empty scan proves nothing
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress", counts: { pending: 1 } });
  github.issues[0]!.deleted = false; // GitHub's listing catches up
  advance(240_000);
  await cleanup();
  expectRedacted(github.issues[0]!, "Support request (erased)");
  expect(await cleanupRow(request.id)).toMatchObject({ state: "resolved", outcome: "redacted" });
});

it("empty scans hand off to review after 24 hours and never complete the erasure", async () => {
  const request = await accept();
  github.next(async () => { await erase(); return undefined; }); // after the claim, before dispatch authorization
  await sweep();
  expect(posts()).toHaveLength(0);
  const [{ id: erasure }] = (await db().prepare("SELECT id FROM erasure").all<{ id: string }>()).results as [{ id: string }];
  await cleanup();
  await throughWindow();
  expect(await erasureStatus(db(), erasure)).toEqual({ id: erasure, state: "needs_review",
    counts: { purged: 0, redacted: 0, pending: 0 }, residual: ["remote_outcome"] });
  expect(await cleanupRow(request.id)).toMatchObject({ state: "unresolved", next_attempt_at: null, title_digest: null });
  await expectMinimal(request.id);
  expect(logs.some((line) => line.includes("Support cleanup requires review") && line.includes('"alert":true'))).toBe(true);
  expect(posts()).toHaveLength(0);
}, 30_000);

it("a late Operator-approved discovery redacts the body and leaves an unverifiable title for review", async () => {
  const request = await accept();
  unknownCreate(true);
  await sweep();
  const erasure = await erase();
  await cleanup();
  await throughWindow();
  github.issues[0]!.deleted = false;
  expect(await operator("cleanup-reconcile", request.id, "operator-1", "positive-evidence")).toBe("Cleanup reconciliation scheduled");
  await cleanup();
  expectRedacted(github.issues[0]!, "Checkout fails");
  expect(await erasureStatus(db(), erasure)).toEqual({ id: erasure, state: "needs_review",
    counts: { purged: 0, redacted: 1, pending: 0 }, residual: ["edit_history", "title_review"] });
  expect((await db().prepare("SELECT actor, action, reason FROM cleanup_audit").all()).results)
    .toEqual([{ actor: "operator-1", action: "reconcile", reason: "positive-evidence" }]);
}, 30_000);

it("an incomplete scan keeps its checkpoint and never completes the erasure", async () => {
  const request = await accept();
  unknownCreate();
  await sweep();
  const original = github.issues[0]!;
  for (let n = 1; n <= 100; n++) github.issues.push({ ...original, id: original.id + n, node_id: `noise_${n}`,
    number: original.number + n, body: "Unrelated App issue" });
  const erasure = await erase();
  await cleanup();
  advance(60_000);
  github.next(() => undefined); // installation token
  github.next(() => undefined); // repository identity
  github.next(() => undefined); // page one, with a continuation
  github.next(() => new Response(null, { status: 503 })); // the continuation fails
  await cleanup();
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress", counts: { pending: 1 } });
  expect(JSON.parse((await cleanupRow(request.id))!.reconciliation_json as string)).toMatchObject({ page: 2 });
  advance(60_000);
  await cleanup();
  expectRedacted(original, "Support request (erased)");
});

it("a delayed wake-up, the scheduler and Operator resume cannot revive erased delivery", async () => {
  const failed = await accept("First private report text");
  github.next(() => undefined);
  github.next(() => Response.json({ message: "Forbidden" }, { status: 403 }));
  await sweep();
  advance(60_000);
  const pending = await accept();
  let erased = false;
  // The claim's batch arrives after the erasure: a wake-up that read due work earlier.
  await sweep({ prepare: db().prepare.bind(db()), batch: async <T>(statements: D1PreparedStatement[]) => {
    if (!erased) { erased = true; await erase(); }
    return db().batch<T>(statements);
  } });
  expect(posts()).toHaveLength(1);
  const intent = await intentRow(failed.id);
  await expect(operator("resume", mapping.slot, intent!.id as string, new Date(now + 3_600_000).toISOString(),
    "operator-1", "permissions-restored")).rejects.toThrow("cannot be resumed");
  await cleanup();
  advance(DAY);
  await sweep();
  expect(posts()).toHaveLength(1);
  expect(await requestRow(pending.id)).toBeNull();
  expect(await requestRow(failed.id)).toBeNull();
});

it("restored rows stay suppressed and are purged again", async () => {
  const request = await accept();
  const snapshot = { request: await requestRow(request.id), intent: await intentRow(request.id) };
  await sweep();
  await erase();
  await cleanup();
  advance(10_000);
  await cleanup();
  expect(await requestRow(request.id)).toBeNull();
  // A Time Travel restore brings back the accepted, undelivered rows; the ledger is replayed.
  for (const [table, row] of [["support_request", snapshot.request], ["delivery_intent", snapshot.intent]] as const) {
    const columns = Object.keys(row!);
    await db().prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .bind(...Object.values(row!)).run();
  }
  advance(60_000);
  await sweep();
  expect(posts()).toHaveLength(1);
  await cleanup();
  expect(await requestRow(request.id)).toBeNull();
  expect(await intentRow(request.id)).toBeNull();
  expect((await read(request.id)).status).toBe(404);
  expect(patches()).toHaveLength(1);
});

it("redaction leaves a retitled issue's title and reports comments", async () => {
  await accept();
  await sweep();
  const issue = github.issues[0]!;
  github.edit(issue, { title: "Renamed by a Developer" });
  issue.comments = 2;
  const erasure = await erase();
  await cleanup();
  advance(10_000);
  await cleanup();
  expectRedacted(issue, "Renamed by a Developer");
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "needs_review",
    residual: ["comments", "edit_history", "retitled"] });
});

it("never-delivered text expires 12 months from acceptance; delivered text 12 months after the last observed close", async () => {
  const failed = await accept();
  const uncertain = await accept();
  const closed = await accept();
  const reopened = await accept();
  const open = await accept();
  await db().prepare("UPDATE delivery_intent SET state = 'failed' WHERE request_id = ?").bind(failed.id).run();
  await db().prepare(`UPDATE delivery_intent SET state = 'outcome_unknown', unknown_since = ?1, attempt_started_at = ?1,
    drain_until = ?1, github_installation_id = 7 WHERE request_id = ?2`).bind(now, uncertain.id).run();
  for (const id of [closed.id, reopened.id, open.id]) {
    await db().prepare("UPDATE delivery_intent SET state = 'delivered' WHERE request_id = ?").bind(id).run();
    await db().prepare("UPDATE support_request SET status = 'open', status_observed_at = ?, issue_id = ? WHERE id = ?")
      .bind(now, Math.floor(Math.random() * 1e9), id).run();
  }
  await db().prepare("UPDATE support_request SET status = 'closed', status_observed_at = ? WHERE id IN (?, ?)")
    .bind(now + DAY, closed.id, reopened.id).run();
  advance(365 * DAY - 1);
  await cleanup();
  expect(await list()).toHaveLength(5);
  advance(1);
  await cleanup();
  expect(await requestRow(failed.id)).toBeNull();
  expect(await cleanupRow(failed.id)).toBeNull(); // retention purges are not ledgered
  await expectMinimal(uncertain.id);
  expect(await cleanupRow(uncertain.id)).toMatchObject({ purpose: "retention", state: "unresolved" });
  expect(await list()).toHaveLength(3);
  // A reopen and a later close move the clock.
  await db().prepare("UPDATE support_request SET status_observed_at = ? WHERE id = ?").bind(now, reopened.id).run();
  advance(DAY);
  await cleanup();
  expect(await requestRow(closed.id)).toBeNull();
  expect(await requestRow(reopened.id)).not.toBeNull();
  expect(await requestRow(open.id)).toMatchObject({ description: "Private report text" });
  expect(await cleanupRow(uncertain.id)).toMatchObject({ state: "unresolved" }); // review metadata outlives the text
});

it("unresolved records cross 45-day compaction; the tombstone window starts after resolution", async () => {
  const resolved = await accept();
  const erasure = await erase();
  await cleanup();
  const uncertain = await accept();
  unknownCreate(true);
  await sweep();
  // While the erasure is open, a repeated request reuses it and covers the newer request.
  expect(await erase()).toBe(erasure);
  await cleanup();
  await throughWindow();
  advance(45 * DAY);
  await cleanup();
  expect(await cleanupRow(resolved.id)).toBeNull();
  expect(await suppressed(resolved.id)).toBe(false);
  expect(await cleanupRow(uncertain.id)).toMatchObject({ state: "unresolved" });
  expect(await suppressed(uncertain.id)).toBe(true);
  await expectMinimal(uncertain.id);
  await expect(operator("cleanup-exception", uncertain.id, "operator-1", "free text")).rejects.toThrow("Usage");
  expect(await operator("cleanup-exception", uncertain.id, "operator-1", "client-instructed")).toBe("Cleanup exception recorded");
  // An exception releases the metadata but never completes the erasure.
  expect(await requestRow(uncertain.id)).toBeNull();
  expect(await intentRow(uncertain.id)).toBeNull();
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "needs_review", residual: ["remote_outcome"] });
  // An excepted record awaits the Operator's review, so it outlives 45 days until the erasure is closed.
  advance(45 * DAY);
  await cleanup();
  expect(await cleanupRow(uncertain.id)).toMatchObject({ state: "excepted" });
  expect(await operator("erasure-close", erasure, "operator-1")).toBe("Erasure closed");
  await expect(operator("erasure-close", erasure, "operator-1")).rejects.toThrow("Only a finished, open erasure");
  await cleanup();
  expect(await cleanupRow(uncertain.id)).toBeNull();
  expect(await suppressed(uncertain.id)).toBe(false);
  expect(await erasureStatus(db(), erasure)).toBeNull();
  expect(posts()).toHaveLength(1);
}, 30_000);

it("offboarding suppresses creates, purges content after 30 days and leaves the Client's issues", async () => {
  const delivered = await accept();
  await sweep();
  advance(10_000);
  const pending = await accept();
  const uncertain = await accept();
  await db().prepare(`UPDATE delivery_intent SET state = 'outcome_unknown', unknown_since = ?1, attempt_started_at = ?1,
    drain_until = ?1, next_attempt_at = NULL WHERE request_id = ?2`).bind(now, uncertain.id).run();
  expect(await operator("offboard", mapping.slot, "operator-1")).toMatch(/Offboarded shop\/production/);
  await sweep();
  expect(posts()).toHaveLength(1);
  advance(30 * DAY - 1);
  await cleanup();
  expect(await requestRow(pending.id)).toMatchObject({ description: "Private report text" });
  advance(1);
  await cleanup();
  await cleanup();
  expect(await requestRow(pending.id)).toBeNull();
  expect(await requestRow(delivered.id)).toBeNull();
  await expectMinimal(uncertain.id);
  expect(await cleanupRow(uncertain.id)).toMatchObject({ purpose: "offboarding", state: "unresolved" });
  // An Operator check of an uncertain offboarded attempt stays read-only, even with a known issue.
  await db().prepare("UPDATE support_cleanup SET issues_json = ? WHERE request_id = ?")
    .bind(JSON.stringify([{ id: github.issues[0]!.id, nodeId: github.issues[0]!.node_id, number: 1 }]), uncertain.id).run();
  expect(await operator("cleanup-reconcile", uncertain.id, "operator-1", "positive-evidence")).toBe("Cleanup reconciliation scheduled");
  expect(await cleanupRow(uncertain.id)).toMatchObject({ state: "reconciling" });
  await cleanup();
  expect(github.issues[0]!.body).toContain("Private report text");
  expect(patches()).toHaveLength(0);
});

it("an Operator erases by the issue's reporter reference, and the scheduled tick runs the cleanup", async () => {
  const request = await accept();
  const reference = `rs_${(await sha256(JSON.stringify([mapping.slot, subject]))).slice(0, 32)}`;
  await expect(operator("erase", mapping.slot, "operator-1", "rs_unknown")).rejects.toThrow("Usage");
  const erasure = await operator("erase", mapping.slot, "operator-1", reference);
  expect(erasure).toMatch(/^era_/);
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  await Effect.runPromise(scheduledTick({ db: db(), mappings: [mapping], botLogin: `${SLUG}[bot]`, now: () => now, digestKey: key })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
      Effect.provide(logger())));
  expect(posts()).toHaveLength(0); // the status sweep still reads, but nothing is created
  expect(await requestRow(request.id)).toBeNull();
  expect(JSON.parse(await operator("erasure-status", erasure))).toMatchObject({ state: "completed" });
  expect((await db().prepare("SELECT action, reference FROM cleanup_audit").first())).toEqual({ action: "erase", reference: erasure });
});

it("every plausible duplicate of an uncertain create is redacted", async () => {
  const request = await accept();
  unknownCreate();
  await sweep();
  const issue = github.issues[0]!;
  github.issues.push({ ...issue, id: issue.id + 1, number: issue.number + 1, node_id: "I_duplicate" });
  const erasure = await erase();
  await cleanup();
  advance(60_000);
  await cleanup();
  advance(10_000);
  await cleanup();
  for (const copy of github.issues) expectRedacted(copy, "Support request (erased)");
  expect(patches()).toHaveLength(2);
  expect(await cleanupRow(request.id)).toMatchObject({ state: "resolved", outcome: "redacted", issues_json: "[]" });
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "needs_review", residual: ["edit_history", "multiple_matches"] });
});

it("an Operator erase leaves the keyed digest and text purge to the Worker", async () => {
  const request = await accept();
  await sweep();
  const intent = (await intentRow(request.id))!.id as string;
  const reference = `rs_${(await sha256(JSON.stringify([mapping.slot, subject]))).slice(0, 32)}`;
  await operator("erase", mapping.slot, "operator-1", reference);
  expect(await cleanupRow(request.id)).toMatchObject({ title_digest: null });
  await cleanup();
  expect(await requestRow(request.id)).toBeNull();
  // A keyed digest: the stored value cannot be recomputed from D1 alone.
  const digest = (await cleanupRow(request.id))!.title_digest;
  expect(digest).toBe(await titleDigest(key, intent, "Checkout fails"));
  expect(digest).not.toBe(await sha256(JSON.stringify([intent, "Checkout fails"])));
  expect(digest).not.toBe(await titleDigest(await digestKey("another key"), intent, "Checkout fails"));
  advance(10_000);
  await cleanup();
  expectRedacted(github.issues[0]!, "Support request (erased)");
});

it("without the digest key, a redacted title is left for review", async () => {
  await accept();
  await sweep();
  const erasure = await erase();
  await cleanup(null);
  advance(10_000);
  await cleanup(null);
  expectRedacted(github.issues[0]!, "Checkout fails");
  expect(await erasureStatus(db(), erasure)).toMatchObject({ residual: ["edit_history", "title_review"] });
});

it("the reference search redacts issues whose request rows retention already purged", async () => {
  const old = await accept();
  await sweep();
  // Closed and observed long ago: retention deletes the rows, and with them the link to the issue.
  await db().prepare("UPDATE support_request SET status = 'closed', status_observed_at = ? WHERE id = ?").bind(now, old.id).run();
  advance(366 * DAY);
  await cleanup();
  expect(await requestRow(old.id)).toBeNull();
  const unrelated = { ...github.issues[0]!, id: 1, node_id: "I_unrelated", number: 99,
    body: github.issues[0]!.body!.replace(/reporter `rs_\w+`/, "reporter `rs_someone_else`") };
  github.issues.push(unrelated);
  const erasure = await erase();
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress" });
  await cleanup();
  advance(10_000);
  await cleanup();
  expectRedacted(github.issues[0]!, "Checkout fails"); // no digest survives retention: the title needs review
  expect(unrelated.body).toContain("Private report text");
  expect(await erasureStatus(db(), erasure)).toEqual({ id: erasure, state: "needs_review",
    counts: { purged: 0, redacted: 1, pending: 0 }, residual: ["edit_history", "title_review"] });
});

it("a search that keeps failing is reported, not taken as proof", async () => {
  await accept();
  const erasure = await erase();
  for (let attempt = 0; attempt < 300; attempt++) github.next(() => new Response(null, { status: 503 }));
  await cleanup();
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "in_progress" });
  for (let hour = 0; hour < 25; hour++) { advance(3_600_000); await cleanup(); }
  expect(await erasureStatus(db(), erasure)).toMatchObject({ state: "needs_review", residual: ["reference_search"] });
}, 30_000);

it("a digest made before the key rotated leaves the title for review, not as retitled", async () => {
  await accept();
  await sweep();
  const erasure = await erase();
  await cleanup(await digestKey("the rotated App private key"));
  advance(10_000);
  await cleanup(await digestKey("the rotated App private key"));
  expectRedacted(github.issues[0]!, "Checkout fails");
  expect(await erasureStatus(db(), erasure)).toMatchObject({ residual: ["edit_history", "title_review"] });
});
