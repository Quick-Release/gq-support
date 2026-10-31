import type { D1Database } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { checkerAccess } from "../src/independent-check.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import { serviceTick } from "../src/scheduled.ts";
import { restoreGate } from "../src/ledger.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { harness, signed, type Installation } from "./installation-client.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { localStage } from "./local-d1.ts";
import { CHECKER, operationsClient, type OperationsClient } from "./operations-client.ts";

const START = Date.parse("2026-10-31T10:00:00Z");
const mapping: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const other: RepositoryMapping = { slot: "blog/production", client: "blog", project: "blog", environment: "production",
  repositoryId: 43, githubInstallationId: 8, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const mappings = [mapping, other];
const subject = "00000000-0000-4000-8000-000000000001";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let installation: Installation;
let checker: OperationsClient;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
/** The suppression ledger as the Worker reaches it: answering, or unreachable. */
let ledgerDown: boolean;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  ledgerDown = false;
  stage = await localStage(["shared", "ledger"]);
  installation = await harness(stage.databases.shared, mappings, { ledger: stage.databases.ledger }).enroll(mapping.slot, "installation-a");
  checker = await operationsClient("checker-staging", CHECKER);
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  github.installation(8);
  github.repository({ id: 43, installationId: 8 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const main = () => stage.databases.shared;
const unreachable: QueryDatabase = {
  prepare: () => { throw new Error("D1_ERROR: storage unavailable"); },
  batch: () => Promise.reject(new Error("D1_ERROR: storage unavailable")),
};
const ledger = (): QueryDatabase => ledgerDown ? unreachable : stage.databases.ledger;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };

/** One Worker isolate's HTTP entry, wired as src/worker.ts serves it, with its own per-isolate gate. */
const isolate = () => {
  const gate = restoreGate();
  return async (request: Request) => {
    const background: Promise<void>[] = [];
    const response = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request),
      Effect.sync(main), mappings, () => Effect.die("Not a webhook"), (task) => { background.push(task); }, undefined,
      { ledger: ledger(), release: "staged" }, undefined, [], null, {
        checker: checkerAccess(JSON.stringify({ [checker.keyId]: checker.publicKey })),
        ledger: ledger(), restored: (db, ledgerDb) => gate(db, ledgerDb, Date.now()),
        configuration: { github_app: true, operational_incidents: true },
      }));
    await Promise.all(background);
    return response;
  };
};
const operator = (...args: string[]) => runOperator(args, {
  query: async (sql, parameters) => (await main().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  ledger: async (sql, parameters) => (await (ledger() as D1Database).prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  recordRevocation: async () => {}, mappings: mappings, now,
});
const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: "" };
const layers = () => Layer.mergeAll(GitHubGateway.layer({ ...config, privateKeyPem: github.privateKeyPem }),
  GitHubReader.layer({ ...config, privateKeyPem: github.privateKeyPem })).pipe(Layer.provide(github.layer));
const deliveryOptions = () => ({ db: main(), ledger: ledger(), mappings: mappings, botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 });
/** One isolate's scheduled entry, as src/worker.ts runs it each minute. */
const tick = (gate = restoreGate()) => Effect.runPromise(serviceTick(() => gate(main(), ledger(), now), deliveryOptions())
  .pipe(Effect.provide(layers()), Effect.provide(Logger.layer([]))));
const sweep = () => Effect.runPromise(sweepDelivery(deliveryOptions()).pipe(Effect.provide(layers()), Effect.provide(Logger.layer([]))));
const posts = () => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));
const intentState = async () => main().prepare("SELECT state, last_error_class FROM delivery_intent").first();
const submission = (summary = "Checkout fails", reporter = subject) => JSON.stringify({ submission_id: crypto.randomUUID(),
  reporter_subject: reporter, scope: "mine", summary, description: `Private report text: ${summary}` });
const submit = async (serve: ReturnType<typeof isolate>, summary?: string, reporter?: string, from = installation) =>
  serve(await signed(from.pair, "POST", "/v1/requests", submission(summary, reporter), from.keyId, from.installationId));
const accept = async (summary: string, reporter = subject) => {
  const response = await submit(isolate(), summary, reporter);
  expect(response.status).toBe(202);
  return (await response.json() as { id: string }).id;
};
const intentOf = async (request: string) => main().prepare("SELECT id, state, last_error_class FROM delivery_intent WHERE request_id = ?")
  .bind(request).first<{ id: string; state: string; last_error_class: string | null }>();

/** Every main table's rows: what a Time Travel restore of the main D1 brings back. The ledger is never restored. */
const snapshot = async () => {
  const db = main();
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`).all<{ name: string }>()).results.map((row) => row.name);
  return Promise.all(tables.map(async (table) => ({ table, rows: (await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results })));
};
const timeTravel = async (image: Awaited<ReturnType<typeof snapshot>>) => {
  const db = main();
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...image.map(({ table }) => db.prepare(`DELETE FROM ${table}`)),
    ...image.flatMap(({ table, rows }) => rows.map((row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))))]);
};
const refused = (work: Promise<unknown>) => work.then(() => "accepted", (error: Error) => error.message);
const requests = async () => (await main().prepare("SELECT COUNT(*) AS n FROM support_request").first<number>("n"));

it("maintenance closes intake in every isolate at once, including one that just passed the gate", async () => {
  const first = isolate(), second = isolate();
  expect((await submit(first)).status).toBe(202);
  expect((await submit(second)).status).toBe(202);
  expect(JSON.parse(await operator("maintenance-begin", "operator-1", "restore", "inc-restore-1"))).toMatchObject({ state: "maintenance" });
  for (const serve of [first, second, isolate()]) {
    const response = await submit(serve);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
  }
  expect(await requests()).toBe(2);
});

it("an unreachable ledger fails closed, even right after a passed check", async () => {
  const serve = isolate();
  expect((await submit(serve)).status).toBe(202);
  ledgerDown = true;
  advance(1_000);
  expect((await submit(serve)).status).toBe(503);
  ledgerDown = false;
  expect((await submit(serve)).status).toBe(202);
});

it("concurrent maintenance begins transition once, and every attempt is audited", async () => {
  const outcomes = await Promise.allSettled([operator("maintenance-begin", "operator-1", "restore", "inc-1"),
    operator("maintenance-begin", "operator-2", "incident", "inc-2")]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({ reason: { message: expect.stringMatching(/already in effect/) } });
  const status = JSON.parse(await operator("maintenance-status"));
  expect(status).toMatchObject({ state: "maintenance", generation: 1, drained: false, restore_recorded: false });
  expect(await operator("maintenance-begin", "operator-3", "incident", "inc-3").catch((error: Error) => error.message)).toMatch(/already in effect/);
  const audits = (await stage.databases.ledger.prepare("SELECT actor, action, evidence FROM maintenance_audit ORDER BY actor").all()).results;
  expect(audits.map(({ actor }) => actor)).toEqual(expect.arrayContaining(["operator-1", "operator-2"]));
  expect(audits.every(({ action }) => action === "begin")).toBe(true);
  advance(120_000);
  expect(JSON.parse(await operator("maintenance-status"))).toMatchObject({ drained: true });
});

it("the independent checker's probe observes maintenance without replaying or writing", async () => {
  const serve = isolate();
  const probe = async () => (await serve(await checker.request("GET", "/v1/operations/checker/probe", crypto.randomUUID()))).json();
  expect(await probe()).toMatchObject({ restore_gate: "open", maintenance: "inactive" });
  await operator("maintenance-begin", "operator-1", "restore", "inc-1");
  expect(await probe()).toMatchObject({ support_db: "ok", suppression_ledger: "ok", restore_gate: "pending", maintenance: "active" });
  ledgerDown = true;
  expect(await probe()).toMatchObject({ suppression_ledger: "unavailable", restore_gate: "unknown", maintenance: "unknown" });
});

it("a scheduled tick during maintenance dispatches nothing, in any isolate", async () => {
  expect((await submit(isolate())).status).toBe(202);
  await operator("maintenance-begin", "operator-1", "incident", "inc-1");
  await tick();
  await tick(restoreGate());
  expect(github.requests).toHaveLength(0);
  expect(await intentState()).toMatchObject({ state: "pending" });
});

it("an execution admitted before maintenance cannot authorize its create once maintenance begins", async () => {
  expect((await submit(isolate())).status).toBe(202);
  // Maintenance begins while this sweep is looking up the repository and minting its token.
  github.next(async () => { await operator("maintenance-begin", "operator-1", "restore", "inc-1"); return undefined; });
  await sweep();
  expect(posts()).toHaveLength(0);
  // Never a blind retry: it is reconciled by its marker like any uncertain create.
  expect(await intentState()).toMatchObject({ state: "outcome_unknown" });
});

it("a restore is recorded and service resumes only through a drained, replayed and verified maintenance boundary", async () => {
  const other = "00000000-0000-4000-8000-000000000002";
  const delivered = await accept("A delivered after the restore point");
  const neverCreated = await accept("B never created");
  const erased = await accept("C erased", other);
  const image = await snapshot();
  // After the restore point: A and C reach GitHub, B's create fails without an issue.
  github.onCreate((issue) => issue.title.includes("B never created") ? (issue.deleted = true, new Response(null, { status: 502 })) : undefined);
  for (let pass = 0; pass < 3; pass++) { await sweep(); advance(61_000); }
  expect(posts()).toHaveLength(3);
  // C's Reporter erases; the site re-enrolls, which revokes its old key.
  expect((await installation.send("POST", "/v1/erasures", JSON.stringify({ reporter_subject: other }))).status).toBe(202);
  const replacement = await harness(main(), mappings, { ledger: stage.databases.ledger }).enroll(mapping.slot, "installation-b");

  expect(await refused(operator("restore-recorded", "operator-1", "time-travel-restore"))).toMatch(/maintenance/);
  const begun = JSON.parse(await operator("maintenance-begin", "operator-1", "restore", "inc-restore-1"));
  expect(await refused(operator("restore-recorded", "operator-1", "time-travel-restore"))).toMatch(/drain/);
  advance(120_000);
  await timeTravel(image);
  // Before the restore is recorded nothing can resume: the ledger shows the restore has not been replayed.
  expect(await refused(operator("maintenance-end", "operator-1", String(begun.generation), "inc-restore-1"))).toMatch(/restore_not_recorded/);
  expect(await operator("restore-recorded", "operator-1", "time-travel-restore")).toMatch(/Restore recorded/);
  expect(await refused(operator("maintenance-end", "operator-1", String(begun.generation), "inc-restore-1"))).toMatch(/replay_pending/);
  // The next scheduled tick replays under maintenance and does nothing else.
  await tick();
  expect(posts()).toHaveLength(3);
  expect(JSON.parse(await operator("maintenance-status"))).toMatchObject({ state: "maintenance", restore_epoch: 1, replayed_epoch: 1 });
  expect((await submit(isolate(), "during maintenance", subject, replacement)).status).toBe(503);
  expect(await refused(operator("maintenance-end", "operator-1", String(begun.generation + 1), "inc-restore-1"))).toMatch(/generation/);
  expect(JSON.parse(await operator("maintenance-end", "operator-1", String(begun.generation), "inc-restore-1"))).toMatchObject({ state: "serving" });

  // Nothing restored is revived: the old key is refused, C's text is gone and every restored request is uncertain.
  expect((await submit(isolate())).status).toBe(403);
  expect(await main().prepare("SELECT description FROM support_request WHERE id = ?").bind(erased).first("description")).toBe("");
  for (const request of [delivered, neverCreated, erased]) expect(await intentOf(request)).toMatchObject({ state: "outcome_unknown" });
  // Positive evidence settles A; B stays uncertain, is never posted again and cannot be resumed.
  for (let pass = 0; pass < 4; pass++) { await tick(); advance(61_000); }
  expect(await intentOf(delivered)).toMatchObject({ state: "delivered" });
  expect(await intentOf(neverCreated)).toMatchObject({ state: "outcome_unknown" });
  expect(posts()).toHaveLength(3);
  const intent = (await intentOf(neverCreated))!.id;
  expect(await refused(operator("resume", mapping.slot, intent, new Date(now + 3_600_000).toISOString(), "operator-1", "provider-recovered")))
    .toMatch(/cannot be resumed/);
  const audit = (await stage.databases.ledger.prepare("SELECT action, actor, evidence FROM maintenance_audit ORDER BY occurred_at, action").all()).results;
  expect(audit).toEqual([{ action: "begin", actor: "operator-1", evidence: "inc-restore-1" }, { action: "end", actor: "operator-1", evidence: "inc-restore-1" }]);
});

it("a create in flight across a restore succeeds late without a duplicate, and its stale result is not persisted", async () => {
  const request = await accept("In flight across the restore");
  const image = await snapshot();
  // The POST is already authorized and on its way when maintenance begins; GitHub completes it only after
  // the restore has been recorded and replayed.
  github.next(() => undefined); // installation token
  github.next(async () => {
    await operator("maintenance-begin", "operator-1", "restore", "inc-restore-1");
    advance(120_000);
    await timeTravel(image);
    await operator("restore-recorded", "operator-1", "time-travel-restore");
    await tick();
    return undefined;
  });
  await sweep();
  expect(posts()).toHaveLength(1);
  // The old execution's success did not land in the restored, replayed database.
  expect(await intentOf(request)).toMatchObject({ state: "outcome_unknown", last_error_class: "RestoredIntent" });
  expect(JSON.parse(await operator("maintenance-end", "operator-1", "1", "inc-restore-1"))).toMatchObject({ state: "serving" });
  for (let pass = 0; pass < 3; pass++) { await tick(); advance(61_000); }
  expect(await intentOf(request)).toMatchObject({ state: "delivered" });
  expect(posts()).toHaveLength(1);
});

it("unsafe Operator mutations are refused during maintenance and before replay, while protective ones still apply", async () => {
  const request = await accept("Failed create");
  await main().prepare("UPDATE delivery_intent SET state = 'failed', last_error_class = 'ValidationFailed'").run();
  const intent = (await intentOf(request))!.id;
  const deadline = () => new Date(now + 3_600_000).toISOString();
  await operator("maintenance-begin", "operator-1", "restore", "inc-1");
  for (const command of [["resume", mapping.slot, intent, deadline(), "operator-1", "provider-recovered"], ["enroll", mapping.slot],
    ["unsuspend", mapping.slot, "operator-1", "verified-private"], ["fleet-launch", "1", "123", "operator-1"],
    ["update-access-grant", mapping.slot, "a".repeat(64), "b".repeat(43) + "=", "operator-1", "evidence-1"]]) {
    expect(await refused(operator(...command))).toMatch(/maintenance is in effect/);
  }
  // Revocation and erasure protect, so they still apply, ledger first.
  expect(await operator("revoke", mapping.slot)).toMatch(/Revoked/);
  advance(120_000);
  await operator("restore-recorded", "operator-1", "time-travel-restore");
  expect(JSON.parse(await operator("maintenance-end", "operator-1", "1", "inc-1").catch(() => "{}"))).toEqual({});
  await tick();
  expect(JSON.parse(await operator("maintenance-end", "operator-1", "1", "inc-1"))).toMatchObject({ state: "serving" });
  expect(await refused(operator("resume", mapping.slot, intent, deadline(), "operator-1", "provider-recovered"))).toMatch(/cannot be resumed/);
});

it("an Operator resume is refused for a request the ledger suppresses, even when the main copy was lost", async () => {
  const request = await accept("Failed create");
  await main().prepare("UPDATE delivery_intent SET state = 'failed', last_error_class = 'ValidationFailed'").run();
  const intent = (await intentOf(request))!.id;
  await stage.databases.ledger.prepare(`INSERT INTO ledger_entry (kind, reference, payload, recorded_at) VALUES ('suppression', ?, ?, ?)`)
    .bind(`request:${request}`, JSON.stringify({ scope: "request", reference: request, reason: "erasure" }), now).run();
  expect(await refused(operator("resume", mapping.slot, intent, new Date(now + 3_600_000).toISOString(), "operator-1", "provider-recovered")))
    .toMatch(/suppressed/);
  expect(await intentOf(request)).toMatchObject({ state: "failed" });
});

it("an unsafe Operator mutation is refused when the ledger cannot be read", async () => {
  const request = await accept("Failed create");
  await main().prepare("UPDATE delivery_intent SET state = 'failed', last_error_class = 'ValidationFailed'").run();
  ledgerDown = true;
  expect(await refused(operator("resume", mapping.slot, (await intentOf(request))!.id, new Date(now + 3_600_000).toISOString(),
    "operator-1", "provider-recovered"))).toMatch(/storage unavailable|ledger/);
  expect(await intentOf(request)).toMatchObject({ state: "failed" });
});

it("a forged webhook at the deployed boundary is refused before any D1 access, and a verified one waits out maintenance", async () => {
  const secret = "webhook-secret";
  let statements = 0;
  const counted = (db: QueryDatabase): QueryDatabase => ({
    prepare: (sql: string) => { statements++; return db.prepare(sql); },
    batch: (list) => { statements++; return db.batch(list); },
  } as QueryDatabase);
  const gate = restoreGate();
  const receiver = createGitHubWebhookReceiver({ appId: "123", secret });
  const serve = (request: Request) => Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request),
    Effect.sync(() => counted(main())), mappings, receiver, () => {}, {
      mappings: mappings, botLogin: `${SLUG}[bot]`, database: async () => counted(main()), refresh: async () => {},
    }, {}, undefined, [], null, {
      checker: checkerAccess("{}"), ledger: counted(stage.databases.ledger),
      restored: (db, ledgerDb) => gate(db, ledgerDb, Date.now()), configuration: { github_app: true, operational_incidents: true },
    }));
  const request = await accept("Tracked by webhooks");
  await sweep();
  const issue = github.issues[0]!.id;
  const due = () => main().prepare("SELECT status_refresh_due_at FROM support_request WHERE id = ?").bind(request).first("status_refresh_due_at");
  statements = 0;
  const delivery = async (key = secret) => {
    const body = JSON.stringify({ action: "closed", issue: { id: issue, user: { login: `${SLUG}[bot]`, type: "Bot" } },
      repository: { id: 42 }, installation: { id: 7 } });
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(body))).toString("hex");
    return new Request("https://support.example/v1/github/webhooks", { method: "POST", body, headers: {
      "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${signature}`, "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": "123" } });
  };
  expect((await serve(await delivery("forged-secret"))).status).toBe(401);
  expect(statements).toBe(0);
  await operator("maintenance-begin", "operator-1", "incident", "inc-1");
  expect((await serve(await delivery("forged-secret"))).status).toBe(401);
  expect(statements).toBe(0);
  // Verified, but it would write: refused until service resumes, then redelivered and status-reconciled.
  expect((await serve(await delivery())).status).toBe(503);
  expect(await due()).toBeNull();
  advance(120_000);
  await operator("maintenance-end", "operator-1", "1", "inc-1");
  expect((await serve(await delivery())).status).toBe(202);
  expect(await due()).not.toBeNull();
});

it("an outage episode the service acknowledged survives a restore of the main database and is reopened for review", async () => {
  const serve = isolate();
  const iso = (at: number) => new Date(at).toISOString();
  const report = async (episodes: unknown[]) => serve(await checker.request("POST", "/v1/operations/checker/report", "run-1",
    JSON.stringify({ observed_at: iso(now), components: [{ component: "discord", state: "healthy", code: "ok" }], episodes })));
  const image = await snapshot();
  const episode = { id: crypto.randomUUID(), component: "discord", code: "transport_failed", first_failed_at: iso(now - 600_000),
    last_failed_at: iso(now - 300_000), recovered_at: iso(now - 60_000) };
  const response = await report([episode]);
  expect(response.status).toBe(200);
  const [{ incident_id: incident }] = (await response.json() as { episodes: { incident_id: string }[] }).episodes;
  // Acknowledged, so the checker drops it: the service holds it now, in the main database and in the ledger.
  expect(incident).toMatch(/^[0-9a-f-]{36}$/);

  await operator("maintenance-begin", "operator-1", "restore", "inc-restore-1");
  advance(120_000);
  await timeTravel(image);
  await operator("restore-recorded", "operator-1", "time-travel-restore");
  await tick();
  expect(JSON.parse(await operator("maintenance-end", "operator-1", "1", "inc-restore-1"))).toMatchObject({ state: "serving" });
  const restored = await main().prepare(`SELECT e.recovered_at, i.category, i.subject, i.state FROM independent_episode e
    JOIN incident i ON i.id = e.incident_id WHERE e.id = ?`).bind(episode.id).first();
  expect(restored).toMatchObject({ category: "component_unavailable", subject: "discord", state: "open", recovered_at: now - 120_000 - 60_000 });
});

it("an episode is acknowledged only once the ledger also holds it, and its incident stands when the ledger write fails", async () => {
  const iso = (at: number) => new Date(at).toISOString();
  const episode = { id: crypto.randomUUID(), component: "github", code: "timeout", first_failed_at: iso(now - 600_000),
    last_failed_at: iso(now - 300_000), recovered_at: null };
  const body = JSON.stringify({ observed_at: iso(now), components: [], episodes: [episode] });
  const serve = isolate();
  // The gate passed, then the ledger write fails.
  const failing: QueryDatabase = { prepare: stage.databases.ledger.prepare.bind(stage.databases.ledger),
    batch: () => Promise.reject(new Error("D1_ERROR: ledger write failed")) };
  const { handleReport } = await import("../src/independent-check.ts");
  const response = await handleReport(await checker.request("POST", "/v1/operations/checker/report", "run-1", body), main(),
    checkerAccess(JSON.stringify({ [checker.keyId]: checker.publicKey })), now, failing);
  expect(await response.json()).toEqual({ episodes: [{ id: episode.id, incident_id: null }] });
  expect(await main().prepare("SELECT state FROM incident WHERE subject = 'github'").first("state")).toBe("open");
  // The checker keeps it and resends; now both hold it, and it is acknowledged.
  const retried = await serve(await checker.request("POST", "/v1/operations/checker/report", "run-2", body));
  expect((await retried.json() as { episodes: { incident_id: string | null }[] }).episodes[0]!.incident_id).not.toBeNull();
});

it("a poisoned D1 record is isolated on every tick, while another Client's reports are still delivered", async () => {
  const poisoned = await accept("Poisoned record");
  await main().prepare(`UPDATE delivery_intent SET state = 'outcome_unknown', attempt_started_at = ?, unknown_since = ?,
    next_attempt_at = ?, reconciliation_json = '{corrupt' WHERE request_id = ?`).bind(now - 60_000, now - 60_000, now, poisoned).run();
  const blog = await harness(main(), mappings, { ledger: stage.databases.ledger }).enroll(other.slot, "installation-blog");
  const delivered: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const response = await submit(isolate(), `Blog report ${pass}`, subject, blog);
    delivered.push((await response.json() as { id: string }).id);
    await tick();
    advance(61_000);
  }
  for (const request of delivered) expect(await intentOf(request)).toMatchObject({ state: "delivered" });
  expect(posts().every((post) => post.path.includes("/repo-43/"))).toBe(true);
  expect(posts()).toHaveLength(3);
  expect(await intentOf(poisoned)).not.toMatchObject({ state: "delivered" });
});

it("refuses every guarded library command when the ledger was omitted, before querying main", async () => {
  const query = vi.fn(async () => []);
  for (const command of ["enroll", "resume", "reconcile", "unsuspend", "release-candidate", "release-approve", "fleet-launch"]) {
    await expect(runOperator([command, mapping.slot], { query, mappings, recordRevocation: async () => {} }))
      .rejects.toThrow("ledger database is required");
  }
  expect(query).not.toHaveBeenCalled();
});
