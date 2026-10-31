import { createHmac } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import { discordDestinations } from "../src/notifications.ts";
import { operationsAccess } from "../src/operations-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { makeFakeDiscord, webhookUrl } from "./fake-discord.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, signed, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { operationsClient, type OperationsClient } from "./operations-client.ts";

// Measured support-path health and routed operational signals (#138), through the
// minute tick, the Worker's HTTP entry and the Operator CLI, with a controlled clock.
const START = Date.parse("2026-10-30T10:00:00Z");
const MINUTE = 60_000;
const slot = (client: string, environment: string, repositoryId: number): RepositoryMapping => ({
  slot: `${client}/${environment}`, client, project: client, environment, repositoryId,
  githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer",
});
const mappings = [slot("shop", "production", 42), slot("shop", "staging", 42), slot("globex", "production", 77)];
const subject = "00000000-0000-4000-8000-000000000001";
const REQUESTS = "111111111111111111";
const INCIDENTS = "222222222222222222";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let discord: ReturnType<typeof makeFakeDiscord>;
let production: Installation, staging: Installation, globex: Installation;
let banquinha: OperationsClient;
let now: number;
let refreshReads: number, sweepPages: number;
let ledgerFails: boolean;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  const clients = harness(stage.databases.shared, mappings);
  production = await clients.enroll("shop/production", "installation-a");
  staging = await clients.enroll("shop/staging", "installation-b");
  globex = await clients.enroll("globex/production", "installation-c");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "shop" });
  github.repository({ id: 77, installationId: 7, name: "globex" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  discord = makeFakeDiscord();
  banquinha = await operationsClient();
  refreshReads = 0;
  sweepPages = 10;
  ledgerFails = false;
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const accept = async (installation: Installation) => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
};
/** The minute Cron's work, with Discord through the fake transport. */
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  const ledger = stage.databases.ledger;
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings,
    ledger: ledgerFails ? { prepare: () => { throw new Error("ledger unavailable"); }, batch: () => Promise.reject(new Error("ledger unavailable")) } as unknown as QueryDatabase : ledger, botLogin: `${SLUG}[bot]`, now: () => now,
    random: () => 0, refresh: { readsPerTick: refreshReads }, sweep: { pagesPerTick: sweepPages },
    notifications: { destinations: discordDestinations(webhookUrl(REQUESTS), webhookUrl(INCIDENTS)), fetch: discord.fetch } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer)))));
};
/** Ticks each minute for the given minutes. */
const run = async (minutes: number) => { for (let minute = 0; minute < minutes; minute++) { advance(MINUTE); await tick(); } };
// Like the Wrangler adapter: plain `?` only, one statement at a time.
const queryOf = (db: D1Database) => async (sql: string, parameters: readonly (string | number)[]) => sql.match(/\?\d/)
  ? Promise.reject(new Error("Numbered parameter")) : (await db.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: queryOf(stage.databases.shared), ledger: queryOf(stage.databases.ledger) });
const incidents = async () => (JSON.parse(await operator("incidents")) as { incidents: Record<string, unknown>[] }).incidents;
const access = () => operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex");
const send = (request: Request, waitUntil: (task: Promise<void>) => void = () => {}) => Effect.runPromise(handleWorkerRequest(
  HttpServerRequest.fromWeb(request), Effect.succeed(stage.databases.shared), mappings, () => Effect.die("Not a webhook"), waitUntil,
  undefined, { release: "staged" }, access()));
const staff = async (method: string, path: string, body = "") => send(await banquinha.request(method, path, "alex", body));
/** GitHub accepts the create, but its response is lost: the outcome is unknown and the issue does not exist. */
const loseCreate = () => {
  github.next(() => undefined); // installation token, with repository safety
  github.next(() => new Response(null, { status: 502 }));
};
const creates = () => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues")).length;

it("routes a create still unknown after 15 minutes to one incident for its repository, without another create", async () => {
  loseCreate();
  await accept(production);
  await tick();
  await run(13);
  expect(await incidents()).toEqual([]);

  loseCreate();
  await accept(staging);
  await run(2);
  expect(await incidents()).toEqual([expect.objectContaining({ category: "delivery_unknown", state: "open",
    affected_slots: ["shop/production"] })]);
  // The second unknown create, on the same repository, joins the same incident at its own 15 minutes.
  await run(15);
  expect(await incidents()).toEqual([expect.objectContaining({ category: "delivery_unknown",
    affected_slots: ["shop/production", "shop/staging"] })]);
  expect(creates()).toBe(2);
}, 30_000);

it("updates the same incident and its Discord message at the 24-hour Operator handoff, still without recreating", async () => {
  loseCreate();
  await accept(production);
  await tick();
  await run(15);
  const [opened] = await incidents();
  expect(opened).toMatchObject({ category: "delivery_unknown", detail: "unresolved" });
  expect(discord.messages(INCIDENTS)).toHaveLength(1);

  advance(24 * 60 * MINUTE);
  await tick();
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ id: opened!.id, detail: "operator_handoff" })]);
  const [message] = discord.messages(INCIDENTS);
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(message!.content).toContain("operator_handoff");
  expect(message!.edits).toBe(1);
  expect(creates()).toBe(1);
}, 20_000);

it("routes known non-creation reaching its 24-hour retry deadline, keeping the accepted report", async () => {
  github.next(() => undefined); // installation token, with repository safety
  // GitHub refuses the create and asks for a wait past the acceptance deadline: known not created.
  github.next(() => Response.json({ message: "secondary rate limit" }, { status: 429, headers: { "retry-after": "172800" } }));
  const id = await accept(globex);
  await tick();
  advance(23 * 60 * MINUTE);
  await tick();
  expect(await incidents()).toEqual([]);

  advance(61 * MINUTE);
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "delivery_deadline", affected_slots: ["globex/production"] })]);
  const read = await globex.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`);
  expect(await read.json()).toMatchObject({ id, delivery: "failed" });
  expect(creates()).toBe(1);
});

it("routes a configuration or permission rejection immediately, apart from transient provider failures", async () => {
  github.next(() => undefined); // installation token, with repository safety
  github.next(() => new Response(null, { status: 503 }));
  await accept(globex);
  await tick();
  expect(await incidents()).toEqual([]);

  github.next(() => undefined);
  github.next(() => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
  await accept(production);
  advance(MINUTE);
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "delivery_rejected", affected_slots: ["shop/production"] })]);
});

it("routes conflicting create evidence immediately as the uncertain create's incident, never choosing or recreating", async () => {
  github.onCreate((issue) => {
    github.issues.push({ ...issue, id: 99_000_000, node_id: "I_duplicate", number: 99 });
    return new Response(null, { status: 502 });
  });
  await accept(production);
  await tick();
  github.onCreate(() => undefined);
  await run(2);
  expect(await incidents()).toEqual([expect.objectContaining({ category: "delivery_unknown", detail: "conflicting_evidence",
    affected_slots: ["shop/production"] })]);
  expect(creates()).toBe(1);
  expect(github.issues.every((issue) => issue.state === "open")).toBe(true);
});

it("lets the claimant resolve a routed incident only once its signal has recovered, then edits the same Discord message", async () => {
  github.next(() => undefined);
  github.next(() => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
  const request = await accept(production);
  await tick();
  const [incident] = await incidents();
  const path = `/v1/operations/incidents/${incident!.id as string}`;
  expect((await staff("POST", `${path}/claim`)).status).toBe(200);
  const early = await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }));
  expect(await early.json()).toMatchObject({ code: "recovery_not_verified" });

  // The Operator repairs the App permission and resumes the delivery, once drained, through the audited workflow.
  advance(2 * MINUTE);
  const intent = await stage.databases.shared.prepare("SELECT id FROM delivery_intent WHERE request_id = ?").bind(request)
    .first<{ id: string }>();
  await operator("resume", "shop/production", intent!.id, new Date(now + 3_600_000).toISOString(), "operator-1", "permissions-restored");
  await run(1);
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
  await run(1);
  expect(await incidents()).toEqual([expect.objectContaining({ id: incident!.id, state: "resolved" })]);
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(discord.messages(INCIDENTS)[0]!.content).toContain("Resolved");
});

const WEBHOOK_SECRET = "stage-webhook-secret";
/**
 * One webhook delivery through the Worker's HTTP entry, signed with `secret`, resolved after background work.
 * A delivery from GitHub also enters GitHub's delivery log with the status the receiver answered; a forged one does not.
 */
const webhook = async (secret = WEBHOOK_SECRET, db: () => Promise<QueryDatabase> = async () => stage.databases.shared,
  body: unknown = { action: "edited", repository: { id: 42 }, installation: { id: 7 } }, event = "issues", fromGitHub = true) => {
  const raw = JSON.stringify(body);
  const background: Promise<void>[] = [];
  const response = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(new Request(
    "https://support.example/v1/github/webhooks", { method: "POST", body: raw, headers: {
      "content-type": "application/json", "x-github-event": event, "x-github-delivery": crypto.randomUUID(),
      "x-github-hook-installation-target-type": "integration", "x-github-hook-installation-target-id": "123",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` } })),
    Effect.die("Webhooks bypass installation authentication"), mappings,
    createGitHubWebhookReceiver({ appId: "123", secret: WEBHOOK_SECRET }), (task) => { background.push(task); },
    { mappings, botLogin: `${SLUG}[bot]`, database: db, refresh: async () => {} }));
  await Promise.all(background);
  if (fromGitHub) github.delivered(response.status);
  return response.status;
};

it("routes the broken-webhook drill's rejected deliveries to one incident and Discord, resolvable once deliveries verify again", async () => {
  // Anyone on the internet can send a bad signature: it is rejected, and never counted or routed.
  expect(await webhook("someone-else", undefined, undefined, "issues", false)).toBe(401);
  await run(2);
  expect(await incidents()).toEqual([]);

  // The drill sets an App webhook secret nobody keeps: GitHub's own deliveries keep arriving and failing.
  expect(await webhook("broken-drill-secret")).toBe(401);
  expect(await webhook("broken-drill-secret")).toBe(401);
  // The minute tick counts GitHub's delivery log, then routes what it shows.
  await run(2);
  const [incident] = await incidents();
  expect(incident).toMatchObject({ category: "webhook_rejected", affected_slots: [], state: "open" });
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(discord.messages(INCIDENTS)[0]!.content).toContain("webhook_rejected");
  await run(1);
  expect(await incidents()).toHaveLength(1);

  const path = `/v1/operations/incidents/${incident!.id as string}`;
  expect((await staff("POST", `${path}/claim`)).status).toBe(200);
  expect(await (await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).json())
    .toMatchObject({ code: "recovery_not_verified" });
  // Restored configuration: GitHub's next delivery verifies.
  advance(MINUTE);
  expect(await webhook()).toBe(204);
  await run(1);
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
  await run(1);
  expect(await incidents()).toEqual([expect.objectContaining({ id: incident!.id, state: "resolved" })]);
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(discord.messages(INCIDENTS)[0]!.content).toContain("Resolved");
});

it("routes a verified delivery the Worker failed to record (5xx) at once, until a later delivery is acknowledged", async () => {
  const shared = stage.databases.shared;
  // Suspension storage fails while the rest of D1 answers, so GitHub gets a 503 and its own retry is needed.
  const failing = async (): Promise<QueryDatabase> => ({
    prepare: (sql: string) => { if (sql.includes("repository_state")) throw new Error("D1 write failed"); return shared.prepare(sql); },
    batch: (statements) => shared.batch(statements),
  } as QueryDatabase);
  expect(await webhook(WEBHOOK_SECRET, failing, { action: "archived", repository: { id: 42 }, installation: { id: 7 } }, "repository"))
    .toBe(503);
  await run(2);
  expect(await incidents()).toEqual([expect.objectContaining({ category: "webhook_failed", affected_slots: [] })]);

  advance(MINUTE);
  expect(await webhook(WEBHOOK_SECRET, undefined, { action: "archived", repository: { id: 42 }, installation: { id: 7 } }, "repository"))
    .toBe(202);
  await run(1);
  const incident = (await incidents()).find((candidate) => candidate.category === "webhook_failed");
  const path = `/v1/operations/incidents/${incident!.id as string}`;
  await staff("POST", `${path}/claim`);
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
});

it("routes status refresh and sweep lag at the existing one-hour signals, for the Slots whose status is stale", async () => {
  await accept(production);
  await tick();
  advance(59 * MINUTE);
  await tick();
  expect(await incidents()).toEqual([]);

  // The daily refresh pass queued the delivered request, and nothing has refreshed it for over an hour.
  advance(2 * MINUTE);
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "status_refresh_behind", affected_slots: ["shop/production"] })]);

  // The repository's status sweep stops completing.
  sweepPages = 0;
  advance(61 * MINUTE);
  await tick();
  expect((await incidents()).map((incident) => [incident.category, incident.affected_slots])).toEqual([
    ["status_refresh_behind", ["shop/production"]], ["status_sweep_behind", ["shop/production"]]]);
});

it("routes a privacy cleanup that cannot confirm its remote outcome, until an Operator records how it was settled", async () => {
  loseCreate();
  const request = await accept(production);
  await tick();
  await operator("offboard", "shop/production", "operator-1");
  // Offboarding's 30-day grace ends: content is purged, but the uncertain create's outcome stays unconfirmed.
  advance(30 * 24 * 60 * MINUTE + MINUTE);
  await tick();
  await tick();
  const privacy = (await incidents()).filter((incident) => incident.category === "privacy_cleanup");
  expect(privacy).toEqual([expect.objectContaining({ affected_slots: ["shop/production"], state: "open" })]);

  const path = `/v1/operations/incidents/${privacy[0]!.id as string}`;
  await staff("POST", `${path}/claim`);
  expect(await (await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).json())
    .toMatchObject({ code: "recovery_not_verified" });
  await operator("cleanup-exception", request, "operator-1", "operator-verified");
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
});

it("routes a suppression ledger that stops being mirrored, and sees it recover when mirroring resumes", async () => {
  await accept(production);
  await tick();
  // The Worker loses its ledger while a revocation still has to be mirrored there.
  ledgerFails = true;
  await operator("revoke", "globex/production");
  advance(14 * MINUTE);
  await tick();
  expect(await incidents()).toEqual([]);
  advance(2 * MINUTE);
  await tick();
  const [incident] = await incidents();
  expect(incident).toMatchObject({ category: "suppression_ledger_behind", affected_slots: [] });

  ledgerFails = false;
  await run(1);
  const path = `/v1/operations/incidents/${incident!.id as string}`;
  await staff("POST", `${path}/claim`);
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
});

/** Sends through the Worker's HTTP entry and waits for its background work, as the deployed adapter's waitUntil allows. */
const viaWorker = async (request: Request) => {
  const background: Promise<void>[] = [];
  const response = await send(request, (task) => { background.push(task); });
  await Promise.all(background);
  return response;
};
const health = async () => {
  const response = await staff("GET", "/v1/operations/health");
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};
const metric = (body: Record<string, unknown>, name: string) =>
  (body.measured as { metric: string; outcome: string; client: string | null; count: number }[]).filter((row) => row.metric === name);

it("measures intake at the Worker boundary per verified Client, apart from durable acceptance, and counts untrusted rejections without a Client", async () => {
  // Nothing observed yet is reported as nothing, never as healthy.
  expect(await health()).toMatchObject({ measured: [], current: { intake: { durably_accepted: [] } } });

  const body = JSON.stringify({ submission_id: crypto.randomUUID(), reporter_subject: subject, scope: "mine",
    summary: "Checkout fails", description: "Private report text" });
  expect((await viaWorker(await signed(production.pair, "POST", "/v1/requests", body, production.keyId, "installation-a"))).status).toBe(202);
  // The same signature replayed, and a request signed by an unknown key.
  const forged = await signed(production.pair, "POST", "/v1/requests", body, "not-a-key", "installation-a");
  expect((await viaWorker(forged)).status).toBe(403);

  const report = await health();
  expect(metric(report, "intake")).toEqual([
    { metric: "intake", outcome: "acknowledged", client: "shop", count: 1,
      mean_ms: expect.any(Number), max_ms: expect.any(Number), last_at: new Date(now).toISOString() },
    // An intake failure is measured too, but an unverified request names no Client.
    expect.objectContaining({ outcome: "rejected", client: null, count: 1 }),
  ]);
  expect(metric(report, "auth")).toEqual([expect.objectContaining({ outcome: "installation_rejected", client: null, count: 1 })]);
  expect(report.current).toMatchObject({ intake: { durably_accepted: [{ client: "shop", count: 1 }] } });
  expect(JSON.stringify(report)).not.toMatch(/Private report text|Checkout fails|installation-a|00000000-0000-4000-8000-000000000001/);
});

it("measures GitHub creation delay and attempt outcomes per Client, and reports the backlog's counts and ages", async () => {
  loseCreate();
  await accept(globex);
  await tick();
  const unknownSince = now;
  await accept(production);
  const accepted = now;
  // The uncertain attempt holds the GitHub installation until its execution has drained.
  advance(61_000);
  await tick();

  const report = await health();
  expect(metric(report, "delivery_confirmed")).toEqual([expect.objectContaining({ outcome: "created", client: "shop", count: 1,
    mean_ms: now - accepted, max_ms: now - accepted })]);
  expect(metric(report, "delivery").map(({ outcome, client, count }) => [outcome, client, count])).toEqual([
    ["Delivered", "shop", 1], ["OutcomeUnknown", "globex", 1], ["ReconciliationPending", "globex", 1]]);
  expect(report.current).toMatchObject({ delivery: { backlog: [{ client: "globex", pending: 0, failed: 0, outcome_unknown: 1,
    oldest_due_at: null, oldest_unknown_since: new Date(unknownSince).toISOString() }] } });
});

it("measures each scheduler phase's outcome and duration, and reports provider pacing and per-Slot fairness", async () => {
  github.next(() => undefined);
  github.next(() => Response.json({ message: "secondary rate limit" }, { status: 429, headers: { "retry-after": "600" } }));
  await accept(production);
  advance(1000);
  await accept(globex);
  await tick();

  const report = await health();
  expect(metric(report, "scheduler").map(({ outcome, count }) => [outcome, count])).toEqual([
    ["cleanup_completed", 1], ["delivery_completed", 1], ["notifications_completed", 1], ["refresh_completed", 1],
    ["signals_completed", 1], ["sweep_completed", 1]]);
  expect(metric(report, "scheduler")[0]).toMatchObject({ mean_ms: expect.any(Number), max_ms: expect.any(Number) });
  expect(metric(report, "delivery")).toEqual([expect.objectContaining({ outcome: "RateLimited", client: "shop", count: 1 })]);
  // globex is due but waits behind the shared installation's provider cooldown, never yet served.
  expect(report.current).toMatchObject({ delivery: {
    pacing: { provider_cooldowns: 1, cooldown_until: new Date(now + 600_000).toISOString() },
    fairness: { slots_due: 1, never_served: 1, least_recently_served_at: null } } });
});

it("reports status freshness and measured per-Client usage with shared costs labelled, the same through the Operator CLI", async () => {
  await accept(production);
  await tick();
  advance(MINUTE);
  expect(await webhook()).toBe(204);
  expect(await webhook("broken-drill-secret")).toBe(401);
  await tick();

  const report = await health();
  expect(report.current).toMatchObject({ status: { tracked: 1, oldest_observed_at: new Date(START).toISOString(),
    refresh_due: 1, oldest_refresh_due_at: new Date(START).toISOString(), oldest_sweep_at: new Date(START).toISOString() } });
  expect(metric(report, "webhook").map(({ outcome, count }) => [outcome, count])).toEqual([["accepted", 1], ["rejected", 1]]);
  expect(report.usage).toEqual({
    clients: [{ client: "shop", stored_requests: 1, intake_acknowledged: 0, delivery_steps: 1 }],
    basis: expect.stringContaining("measured"), shared: expect.stringContaining("shared"),
  });
  expect(JSON.parse(await operator("health"))).toEqual(report);
});

it("keeps aggregate metrics for 12 months, then expires them", async () => {
  expect(await webhook()).toBe(204);
  await tick();
  expect((await health()).retention).toEqual({ aggregate_months: 12, oldest_hour: new Date(START).toISOString() });
  advance(366 * 24 * 60 * MINUTE);
  await tick();
  expect((await health()).retention).toEqual({ aggregate_months: 12, oldest_hour: new Date(now - (now % 3_600_000)).toISOString() });
});

it("verifies the broken-webhook drill's evidence from durable records, reporting each missing step as incomplete", async () => {
  const since = new Date(now).toISOString();
  expect(JSON.parse(await operator("drill-verify", "webhook", since))).toEqual({ drill: "broken_webhook", since, verdict: "incomplete",
    checks: { incident: { state: "absent" }, notification: { state: "absent" }, recovery: { state: "absent" }, resolution: { state: "absent" } } });

  advance(MINUTE);
  expect(await webhook("broken-drill-secret")).toBe(401);
  await run(1);
  const [incident] = await incidents();
  expect(JSON.parse(await operator("drill-verify", "webhook", since))).toMatchObject({ verdict: "incomplete", checks: {
    incident: { state: "observed", id: incident!.id, category: "webhook_rejected" }, notification: { state: "sent" },
    recovery: { state: "absent" }, resolution: { state: "absent" } } });

  advance(MINUTE);
  expect(await webhook()).toBe(204);
  await run(1);
  const path = `/v1/operations/incidents/${incident!.id as string}`;
  await staff("POST", `${path}/claim`);
  expect((await staff("POST", `${path}/resolve`, JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
  await run(1);
  expect(JSON.parse(await operator("drill-verify", "webhook", since))).toMatchObject({ verdict: "passed", checks: {
    incident: { state: "observed" }, notification: { state: "sent" }, recovery: { state: "observed" },
    resolution: { state: "observed", claimant: "alex" } } });
  // Evidence from before the drill began does not count.
  expect(JSON.parse(await operator("drill-verify", "webhook", new Date(now).toISOString()))).toMatchObject({ verdict: "incomplete" });
});
