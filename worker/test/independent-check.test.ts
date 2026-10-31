import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkerAccess } from "../src/independent-check.ts";
import { runIndependentCheck, type CheckRun } from "../src/independent-checker.ts";
import { runOperator } from "../src/operator.ts";
import { makeFakeDiscord, webhookUrl } from "./fake-discord.ts";
import { restoreGate } from "../src/ledger.ts";
import { operationsAccess } from "../src/operations-api.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { localStage } from "./local-d1.ts";
import { CHECKER, operationsClient, type OperationsClient } from "./operations-client.ts";

const START = Date.parse("2026-10-31T10:00:00Z");
const mappings: RepositoryMapping[] = [{ slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" }];

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let checker: OperationsClient;
let banquinha: OperationsClient;
let now: number;
/** Components a test has made fail: storage throws, as an unavailable D1 binding would. */
let down: Set<"support_db" | "suppression_ledger">;
let gate: ReturnType<typeof restoreGate>;
/** A recorded restore whose ledger replay has not completed: the gate stays closed. */
let replayPending: boolean;
let discord: ReturnType<typeof makeFakeDiscord>;
/** The Worker as the GitHub runner reaches it: answering, unreachable, or failing at the edge with a status. */
let worker: "up" | "unreachable" | number;
let githubStatus: number;
/** Banquinha's approved endpoint as the runner reaches it. */
let dashboardStatus: number | "unreachable";
let privateKey: string;
let configuration: { github_app: boolean; operational_incidents: boolean };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  checker = await operationsClient("checker-staging", CHECKER);
  banquinha = await operationsClient();
  down = new Set();
  gate = restoreGate();
  replayPending = false;
  discord = makeFakeDiscord();
  worker = "up";
  githubStatus = 200;
  dashboardStatus = 302;
  configuration = { github_app: true, operational_incidents: true };
  privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", checker.privateKey)).toString("base64");
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const unavailable = (): QueryDatabase => ({
  prepare: () => { throw new Error("D1_ERROR: storage unavailable"); },
  batch: () => Promise.reject(new Error("D1_ERROR: storage unavailable")),
});
const main = () => down.has("support_db") ? unavailable() : stage.databases.shared;
const ledger = () => down.has("suppression_ledger") ? unavailable() : stage.databases.ledger;

/** The deployed Worker's HTTP entry, as src/worker.ts serves it, over local D1. */
const serve = (request: Request) => Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request),
  Effect.sync(main), mappings, () => Effect.die("Not a webhook"), () => {}, undefined, {},
  operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex"), ["operational_incidents"], null, {
    checker: checkerAccess(JSON.stringify({ [checker.keyId]: checker.publicKey })),
    ledger: ledger(), restored: async (db, ledgerDb) => !replayPending && await gate(db, ledgerDb, Date.now()),
    ...(replayPending ? { restoreReady: async () => ({ open: false, maintenance: false }) } : {}),
    configuration,
  }));
const PROBE = "/v1/operations/checker/probe";

it("answers only the independent checker's signed probe, with component health and no data", async () => {
  expect((await serve(new Request(`https://support.example${PROBE}`))).status).toBe(401);
  // A staff dashboard's key is not the checker's identity.
  expect((await serve(await banquinha.request("GET", PROBE, "run-1"))).status).toBe(401);
  const response = await serve(await checker.request("GET", PROBE, "run-1"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    worker: "ok", support_db: "ok", suppression_ledger: "ok", restore_gate: "open", maintenance: "inactive",
    configuration: { github_app: "configured", operational_incidents: "configured" },
    observed_at: new Date(START).toISOString(),
  });
});

it("observes a pending restore without executing replay through the probe", async () => {
  await stage.databases.ledger.prepare("UPDATE ledger_epoch SET epoch = ? WHERE id = 1").bind(START).run();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await serve(await checker.request("GET", PROBE, "run-1"));
    expect(await response.json()).toMatchObject({ restore_gate: "pending" });
  }
  // An ordinary gated request may perform recovery; the checker only observes it.
  expect((await serve(await banquinha.request("GET", "/v1/operations/incidents", "alex"))).status).toBe(200);
  expect(await (await serve(await checker.request("GET", PROBE, "run-1"))).json()).toMatchObject({ restore_gate: "open" });
});

it("tells an unavailable database, ledger or closed restore gate apart, and serves nothing else meanwhile", async () => {
  const probe = async () => (await serve(await checker.request("GET", PROBE, "run-1"))).json();
  down.add("support_db");
  expect(await probe()).toMatchObject({ worker: "ok", support_db: "unavailable", suppression_ledger: "ok", restore_gate: "unknown" });
  down = new Set(["suppression_ledger"]);
  expect(await probe()).toMatchObject({ worker: "ok", support_db: "ok", suppression_ledger: "unavailable", restore_gate: "unknown" });
  down.clear();
  replayPending = true;
  expect(await probe()).toMatchObject({ support_db: "ok", suppression_ledger: "ok", restore_gate: "pending" });
  const staff = await serve(await banquinha.request("GET", "/v1/operations/incidents", "alex"));
  expect(staff.status).toBe(503);
  replayPending = false;
  expect((await serve(await banquinha.request("GET", "/v1/operations/incidents", "alex"))).status).toBe(200);
});

const REPORT = "/v1/operations/checker/report";
interface Incident { id: string; detail: string; state: string }
interface StaffView { incidents: Incident[]; incident: Incident; independent: { components: unknown[] } }
const staff = async (method: string, path: string, actor = "alex", body = "") =>
  (await serve(await banquinha.request(method, path, actor, body))).json() as Promise<StaffView>;
const report = async (body: unknown, requestId?: string) =>
  serve(await checker.request("POST", REPORT, "run-2", JSON.stringify(body), requestId ? { requestId } : {}));
const iso = (time: number) => new Date(time).toISOString();

it("reconciles an outage the checker saw while storage was down into one claimable incident, however often it is resent", async () => {
  const episode = { id: crypto.randomUUID(), component: "support_db", code: "unavailable",
    first_failed_at: iso(START - 30 * 60_000), last_failed_at: iso(START - 10 * 60_000), recovered_at: iso(START - 5 * 60_000) };
  const body = { observed_at: iso(START), components: [{ component: "support_db", state: "healthy", code: "ok" }], episodes: [episode] };
  // Only the checker's identity can report.
  expect((await serve(await banquinha.request("POST", REPORT, "alex", JSON.stringify(body)))).status).toBe(401);
  const requestId = crypto.randomUUID();
  const first = await report(body, requestId);
  expect(first.status).toBe(200);
  const { incidents } = await staff("GET", "/v1/operations/incidents");
  expect(incidents).toEqual([expect.objectContaining({ category: "component_unavailable", detail: "support_db", state: "open",
    affected_slots: [], first_observed_at: episode.first_failed_at, last_observed_at: episode.last_failed_at,
    runbook: "docs/runbooks/support-operations.md#independent-outage-checks" })]);
  expect(await first.json()).toEqual({ episodes: [{ id: episode.id, incident_id: incidents[0].id }] });
  // A replayed request is refused; a retried report after a lost response changes nothing.
  expect((await report(body, requestId)).status).toBe(401);
  expect((await report(body)).status).toBe(200);
  expect((await staff("GET", "/v1/operations/incidents")).incidents).toHaveLength(1);
  // Recovered evidence lets the claimant resolve it; resending the episode afterwards opens nothing new.
  await staff("POST", `/v1/operations/incidents/${incidents[0].id}/claim`);
  expect((await staff("POST", `/v1/operations/incidents/${incidents[0].id}/resolve`, "alex",
    JSON.stringify({ resolution: "recovered" }))).incident.state).toBe("resolved");
  expect((await report(body)).status).toBe(200);
  expect((await staff("GET", "/v1/operations/incidents")).incidents).toEqual([expect.objectContaining({ state: "resolved" })]);
});

// The runner's whole outside world: the Worker over local D1, fake GitHub and Discord. Anything else is refused.
const SERVICE = "https://gqsupportworker-worker-staging-test.tipme.workers.dev";
const INCIDENTS = "222222222222222222";
const DASHBOARD = "https://banquinha.example";
const contacted: string[] = [];
const network = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  contacted.push(url.origin);
  if (url.origin === SERVICE) {
    if (worker === "unreachable") throw new TypeError("fetch failed");
    if (typeof worker === "number") return new Response("error code: 1101", { status: worker });
    return serve(new Request(input, init));
  }
  if (url.origin === "https://discord.com") return discord.fetch(input, init);
  if (url.href === "https://api.github.com/rate_limit") return Response.json({ resources: {} }, { status: githubStatus });
  if (url.origin === DASHBOARD) {
    if (dashboardStatus === "unreachable") throw new TypeError("fetch failed");
    return new Response(null, { status: dashboardStatus, headers: dashboardStatus === 302 ? { Location: `${DASHBOARD}/login` } : {} });
  }
  throw new Error(`Unexpected request to ${url.origin}`);
};
const environment = (overrides: Record<string, string | undefined> = {}) => ({
  INDEPENDENT_CHECK_STAGE: "staging", INDEPENDENT_CHECK_SERVICE_URL: SERVICE,
  INDEPENDENT_CHECK_KEY_ID: checker.keyId, INDEPENDENT_CHECK_PRIVATE_KEY: privateKey,
  DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL: webhookUrl(INCIDENTS), GITHUB_TOKEN: "ghs_runner-token",
  GITHUB_RUN_ID: "1001", GITHUB_RUN_ATTEMPT: "1", ...overrides,
});
let previous: unknown = null;
/** One scheduled runner execution, carrying its state to the next as the workflow's artifact does. */
const check = async (overrides: Record<string, string | undefined> = {}, dashboards: readonly string[] = []): Promise<CheckRun> => {
  const run = await runIndependentCheck({ env: environment(overrides), state: previous, fetch: network, now: Date.now(), dashboards });
  previous = JSON.parse(JSON.stringify(run.state));
  return run;
};
const after = (minutes: number) => { now += minutes * 60_000; vi.setSystemTime(now); };
const states = (run: CheckRun) => Object.fromEntries(run.summary.components.map(({ component, state, code }) => [component, `${state}:${code}`]));

it("observes each component separately on a healthy stage, reports it, and posts nothing to Discord", async () => {
  previous = null;
  contacted.length = 0;
  const run = await check();
  expect(run.exitCode).toBe(0);
  expect(states(run)).toEqual({
    worker: "healthy:ok", support_db: "healthy:ok", suppression_ledger: "healthy:ok", restore_gate: "healthy:ok",
    service_configuration: "healthy:ok", github: "healthy:ok", discord: "healthy:ok",
    // No dashboard endpoint is approved, and installations are never probed from here.
    dashboard: "unknown:not_configured", installation: "unknown:not_observed",
  });
  expect(run.summary.reconciliation).toBe("accepted");
  expect(discord.messages(INCIDENTS)).toEqual([]);
  expect(new Set(contacted)).toEqual(new Set([SERVICE, "https://discord.com", "https://api.github.com"]));
  expect(JSON.stringify(run)).not.toMatch(/token|ghs_|BEGIN|discord\.com\/api/);
});

it("announces a Worker outage itself while it lasts, then reconciles it into exactly one incident", async () => {
  previous = null;
  worker = "unreachable";
  const down1 = await check();
  expect(states(down1)).toMatchObject({ worker: "failing:transport_failed", support_db: "unknown:not_observed",
    github: "healthy:ok", discord: "healthy:ok" });
  expect(down1.summary.reconciliation).toBe("not_possible");
  expect(down1.exitCode).toBe(0);
  const [notice] = discord.messages(INCIDENTS);
  expect(notice!.content).toMatch(/Independent check.*`staging`.*`worker` failing \(`transport_failed`\)/);
  expect(notice!.content).toContain("cannot record or announce this itself now");
  expect(notice!.allowedMentions).toEqual({ parse: [] });
  // Still down: the same episode, no second notice. A Worker failing at the edge is still the Worker.
  after(5);
  worker = 522;
  expect(states(await check())).toMatchObject({ worker: "failing:http_error" });
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  after(5);
  worker = "up";
  const back = await check();
  expect(back.summary.reconciliation).toBe("accepted");
  const { incidents } = await staff("GET", "/v1/operations/incidents");
  expect(incidents).toEqual([expect.objectContaining({ category: "component_unavailable", detail: "worker",
    first_observed_at: new Date(START).toISOString(), last_observed_at: new Date(START + 5 * 60_000).toISOString() })]);
  expect(back.summary.episodes).toEqual([expect.objectContaining({ component: "worker", incident_id: incidents[0].id,
    recovered_at: new Date(START + 10 * 60_000).toISOString(), notice: "sent" })]);
  // The notice is edited, not reposted, and the settled episode leaves the checker's state.
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(discord.messages(INCIDENTS)[0]!.content).toMatch(/`worker` recovered[\s\S]*Reconciled into a service incident/);
  expect(back.state.episodes).toEqual([]);
  after(5);
  await check();
  expect((await staff("GET", "/v1/operations/incidents")).incidents).toHaveLength(1);
  await staff("POST", `/v1/operations/incidents/${incidents[0].id}/claim`);
  expect((await staff("POST", `/v1/operations/incidents/${incidents[0].id}/resolve`, "alex",
    JSON.stringify({ resolution: "recovered" }))).incident.state).toBe("resolved");
});

it("never writes to a dead database or claims a Discord send during a Discord outage, and fails the run when nothing can surface it", async () => {
  previous = null;
  down.add("support_db");
  const run = await check();
  expect(states(run)).toMatchObject({ worker: "healthy:ok", support_db: "failing:unavailable", suppression_ledger: "healthy:ok",
    restore_gate: "unknown:not_observed" });
  expect(run.summary.reconciliation).toBe("not_possible");
  expect(discord.messages(INCIDENTS)[0]!.content).toMatch(/`support_db` failing \(`unavailable`\)/);
  // Discord now fails too: its webhook was deleted. Nothing is posted and nothing can surface the outage.
  after(5);
  discord.fail(INCIDENTS, { status: 404, body: { code: 10015, message: "Unknown Webhook" } });
  const dark = await check();
  expect(states(dark)).toMatchObject({ support_db: "failing:unavailable", discord: "failing:destination_rejected" });
  expect(dark.summary.episodes.find(({ component }) => component === "discord")).toMatchObject({ notice: "none", incident_id: null });
  expect(dark.exitCode).toBe(1);
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  // Storage returns while Discord is still down: the service now holds both, as separate incidents.
  after(5);
  down.clear();
  discord.fail(INCIDENTS, { status: 404, body: { code: 10015 } });
  const held = await check();
  expect(held.summary.reconciliation).toBe("accepted");
  expect(held.exitCode).toBe(0);
  const detail = async () => (await staff("GET", "/v1/operations/incidents")).incidents.map(({ detail }) => detail).sort();
  expect(await detail()).toEqual(["discord", "support_db"]);
  // Discord's recovery ends its episode and edits the storage notice; still exactly two incidents.
  after(5);
  const recovered = await check();
  expect(states(recovered)).toMatchObject({ discord: "healthy:ok", support_db: "healthy:ok" });
  expect(discord.messages(INCIDENTS)[0]!.content).toMatch(/`support_db` recovered/);
  expect(recovered.state.episodes).toEqual([]);
  expect(await detail()).toEqual(["discord", "support_db"]);
});

it("announces a closed restore gate or missing service configuration itself, since the service's own notifier is blocked", async () => {
  previous = null;
  replayPending = true;
  const gated = await check();
  expect(states(gated)).toMatchObject({ restore_gate: "failing:pending" });
  expect(gated.summary.reconciliation).toBe("not_possible");
  expect(discord.messages(INCIDENTS)[0]!.content).toMatch(/`restore_gate` failing \(`pending`\)/);
  after(5);
  replayPending = false;
  // The Worker's minute tick needs its GitHub App configuration before it notifies anyone.
  configuration = { github_app: false, operational_incidents: true };
  const blocked = await check();
  expect(states(blocked)).toMatchObject({ restore_gate: "healthy:ok", service_configuration: "failing:missing" });
  expect(blocked.summary.reconciliation).toBe("accepted");
  expect(discord.messages(INCIDENTS).map(({ content }) => content.split("\n")[0])).toEqual([
    expect.stringMatching(/`restore_gate` recovered/), expect.stringMatching(/`service_configuration` failing \(`missing`\)/)]);
  expect((await staff("GET", "/v1/operations/incidents")).incidents.map(({ detail }) => detail).sort())
    .toEqual(["restore_gate", "service_configuration"]);
});

it("separates a GitHub provider failure, which the healthy service records and announces itself", async () => {
  previous = null;
  githubStatus = 503;
  const run = await check();
  expect(states(run)).toMatchObject({ github: "failing:http_error", worker: "healthy:ok", discord: "healthy:ok" });
  expect(run.summary.episodes).toEqual([expect.objectContaining({ component: "github", notice: "none", incident_id: expect.any(String) })]);
  expect(run.exitCode).toBe(0);
  expect(discord.messages(INCIDENTS)).toEqual([]);
  // A rate-limited read is unknown, neither failure nor recovery.
  after(5);
  githubStatus = 429;
  expect(states(await check())).toMatchObject({ github: "unknown:rate_limited" });
  expect((await staff("GET", "/v1/operations/incidents")).incidents).toEqual([expect.objectContaining({ detail: "github", state: "open" })]);
});

it("respects Discord's rate limit and an unknown send outcome without opening another incident", async () => {
  previous = null;
  worker = "unreachable";
  // The post reaches Discord but its response is lost: the notice is uncertain, and is retried.
  discord.fail(INCIDENTS, { status: 200, body: { id: INCIDENTS } }, { lostResponse: true });
  const lost = await check();
  expect(lost.summary.episodes[0]).toMatchObject({ notice: "outcome_unknown" });
  after(5);
  discord.fail(INCIDENTS, { status: 200, body: { id: INCIDENTS } }, { status: 429, body: { retry_after: 600, global: false } });
  const limited = await check();
  expect(limited.state.discord_retry_at).toBe(now + 600_000);
  // Within Discord's wait the checker sends nothing at all, not even its read-only check.
  after(5);
  const requests = discord.requests.length;
  expect(states(await check())).toMatchObject({ discord: "unknown:rate_limited" });
  expect(discord.requests).toHaveLength(requests);
  after(10);
  await check();
  // Discord may show the uncertain notice twice; exactly once is not promised.
  expect(discord.messages(INCIDENTS)).toHaveLength(2);
  worker = "up";
  after(5);
  await check();
  expect((await staff("GET", "/v1/operations/incidents")).incidents).toHaveLength(1);
});

it("fails closed on missing or malformed configuration and state, never reporting the service healthy", async () => {
  previous = null;
  const unconfigured = await check({ INDEPENDENT_CHECK_SERVICE_URL: "https://support.example.com", INDEPENDENT_CHECK_PRIVATE_KEY: "not-a-key",
    DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL: "https://discord.example/api/webhooks/1/x", INDEPENDENT_CHECK_DASHBOARD_URL: "https://banquinha.example" });
  expect(unconfigured.exitCode).toBe(1);
  expect(unconfigured.summary.problems).toEqual(["service_url_missing_or_not_approved", "checker_key_missing", "discord_webhook_missing",
    "dashboard_url_not_approved"]);
  expect(states(unconfigured)).toMatchObject({ worker: "unknown:not_configured", support_db: "unknown:not_configured",
    discord: "unknown:not_configured", dashboard: "unknown:not_configured" });
  expect(unconfigured.summary.reconciliation).toBe("not_possible");
  expect(discord.requests).toEqual([]);
  // A Worker that refuses this checker's key is a configuration problem, not an outage.
  const stranger = await operationsClient("checker-staging", CHECKER);
  const strangerKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", stranger.privateKey)).toString("base64");
  const refused = await check({ INDEPENDENT_CHECK_PRIVATE_KEY: strangerKey });
  expect(states(refused)).toMatchObject({ worker: "unknown:unauthorized", support_db: "unknown:not_observed" });
  expect(refused.summary.episodes).toEqual([]);
  // Tampered or foreign state is discarded and reported, never trusted.
  previous = { version: 1, stage: "staging", discord_retry_at: null, episodes: [{ id: "x" }] };
  const tampered = await check();
  expect(tampered.summary.problems).toEqual(["previous_state_unusable"]);
  expect(tampered.exitCode).toBe(1);
  previous = { ...tampered.state, stage: "prod" };
  expect((await check()).summary.problems).toEqual(["previous_state_unusable"]);
});

it("shows the checker's latest observations in measured health, unknown once stale, and no request data", async () => {
  previous = null;
  githubStatus = 503;
  await check();
  const health = await staff("GET", "/v1/operations/health");
  expect(health.independent).toEqual({
    last_report_at: new Date(START).toISOString(), stale_after_minutes: 60,
    components: expect.arrayContaining([
      { component: "worker", state: "healthy", code: "ok", observed_at: new Date(START).toISOString(), display: "current" },
      { component: "github", state: "failing", code: "http_error", observed_at: new Date(START).toISOString(), display: "current" },
      { component: "dashboard", state: "unknown", code: "not_configured", observed_at: new Date(START).toISOString(), display: "current" },
    ]),
  });
  // No report for over an hour: the last values stay visible, but nothing is current.
  after(61);
  const stale = await staff("GET", "/v1/operations/health");
  expect(stale.independent.components).toContainEqual({ component: "worker", state: "healthy", code: "ok",
    observed_at: new Date(START).toISOString(), display: "unknown", reason: "stale" });
});

it("separates a dashboard outage, which the Operator CLI can still inspect while storage is healthy", async () => {
  previous = null;
  const withDashboard = () => check({ INDEPENDENT_CHECK_DASHBOARD_URL: `${DASHBOARD}/operations` }, [DASHBOARD]);
  // A login redirect still answers; the checker never follows it.
  expect(states(await withDashboard())).toMatchObject({ dashboard: "healthy:ok" });
  after(5);
  dashboardStatus = "unreachable";
  const run = await withDashboard();
  expect(states(run)).toMatchObject({ dashboard: "failing:transport_failed", worker: "healthy:ok", discord: "healthy:ok" });
  expect(discord.messages(INCIDENTS)).toEqual([]);
  const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
    query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
  const listed = JSON.parse(await operator("incidents")) as { incidents: Incident[] };
  expect(listed.incidents).toEqual([expect.objectContaining({ category: "component_unavailable", detail: "dashboard", state: "open" })]);
  expect(await operator("incident-claim", listed.incidents[0]!.id, "sam")).toContain("sam");
  after(5);
  dashboardStatus = 200;
  await withDashboard();
  expect(await operator("incident", listed.incidents[0]!.id)).toContain("claimed");
});

it("keeps one resolvable incident when the runner's state is lost mid-outage or the outage outlasts its retention", async () => {
  previous = null;
  down.add("suppression_ledger");
  await check();
  // The ledger alone is down: the restore gate cannot be read, so nothing is reconciled yet.
  after(5);
  down.clear();
  replayPending = true;
  await check();
  after(5);
  // The workflow artifact is lost, and the gate's failure carries on for over a week.
  previous = null;
  await check();
  after(8 * 24 * 60);
  const late = await check();
  expect(late.summary.reconciliation).toBe("not_possible");
  replayPending = false;
  after(5);
  const back = await check();
  expect(back.summary.reconciliation).toBe("accepted");
  // One incident for the gate's outage across both runner states. The ledger episode went with the lost
  // artifact before storage could take it: it survives only as the checker's notice and run summary.
  const { incidents } = await staff("GET", "/v1/operations/incidents");
  expect(incidents.map(({ detail }) => detail)).toEqual(["restore_gate"]);
  expect(discord.messages(INCIDENTS).map(({ content }) => content.split("\n")[0])).toEqual(expect.arrayContaining([
    expect.stringMatching(/`suppression_ledger` recovered/)]));
  // Every incident is recoverable from the healthy observations, whatever episodes the runner still held.
  for (const incident of incidents) {
    await staff("POST", `/v1/operations/incidents/${incident.id}/claim`);
    expect((await staff("POST", `/v1/operations/incidents/${incident.id}/resolve`, "alex",
      JSON.stringify({ resolution: "recovered" }))).incident.state).toBe("resolved");
  }
});
