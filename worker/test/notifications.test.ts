import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { discordDestinations } from "../src/notifications.ts";
import { operationsAccess } from "../src/operations-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { makeFakeDiscord, webhookUrl } from "./fake-discord.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { operationsClient, type OperationsClient } from "./operations-client.ts";

const START = Date.parse("2026-10-30T10:00:00Z");
const slot = (name: string, environment: string, repositoryId: number, repository?: string): RepositoryMapping => ({
  slot: `${name}/${environment}`, client: name, project: name, environment, repositoryId, ...(repository ? { repository } : {}),
  githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer",
});
const mappings = [slot("shop", "production", 42, "acme/shop"), slot("shop", "staging", 42, "acme/shop"), slot("globex", "production", 77)];
const subject = "00000000-0000-4000-8000-000000000001";
const REQUESTS = "111111111111111111";
const INCIDENTS = "222222222222222222";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let discord: ReturnType<typeof makeFakeDiscord>;
let production: Installation, globex: Installation;
let banquinha: OperationsClient;
let now: number;
let destinations = discordDestinations(webhookUrl(REQUESTS), webhookUrl(INCIDENTS));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  const clients = harness(stage.databases.shared, mappings);
  production = await clients.enroll("shop/production", "installation-a");
  await clients.enroll("shop/staging", "installation-b");
  globex = await clients.enroll("globex/production", "installation-c");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "shop" });
  github.repository({ id: 77, installationId: 7, name: "globex" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  discord = makeFakeDiscord();
  destinations = discordDestinations(webhookUrl(REQUESTS), webhookUrl(INCIDENTS));
  banquinha = await operationsClient();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const accept = async (installation: Installation, summary = "Checkout fails") => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary, description: "Private report text" }));
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
};
const deliver = async (db: QueryDatabase = stage.databases.shared) => {
  advance(10_000);
  await Effect.runPromise(sweepDelivery({ db, mappings, botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 })
    .pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem })
      .pipe(Layer.provide(github.layer)))));
};
/** The minute Cron's work, with Discord notifications through the fake transport. */
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: `${SLUG}[bot]`, now: () => now,
    random: () => 0, refresh: { readsPerTick: 0 }, notifications: { destinations, fetch: discord.fetch } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer)))));
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
const access = () => operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex,sam");
const staff = async (method: string, path: string, actor = "alex", body = "") => Effect.runPromise(handleWorkerRequest(
  HttpServerRequest.fromWeb(await banquinha.request(method, path, actor, body)), Effect.succeed(stage.databases.shared), mappings,
  () => Effect.die("Not a webhook"), () => {}, undefined, {}, access(), Object.keys(destinations) as never));
/** Opens the shop repository's incident by delivering into a repository made public. */
const shopIncident = async () => {
  github.update(42, { private: false });
  await accept(production);
  await deliver();
  const list = await operator("incidents");
  return (JSON.parse(list) as { incidents: { id: string }[] }).incidents[0]!.id;
};

it("notifies an opened incident once in the incident channel, apart from Support requests", async () => {
  const id = await shopIncident();
  advance(60_000);
  await tick();
  await tick();

  expect(discord.messages(INCIDENTS)).toEqual([expect.objectContaining({ allowedMentions: { parse: [] } })]);
  const [message] = discord.messages(INCIDENTS);
  expect(message!.content).toContain(id);
  expect(message!.content).toContain("repository_suspended");
  expect(message!.content).toContain("`shop/production`, `shop/staging`");
  expect(message!.content).toContain("Unclaimed");
  expect(message!.content).toContain("<https://github.com/Quick-Release/gq-support/blob/main/worker/README.md#suspended-mappings>");
  // The Support request behind the failure goes only to the request channel.
  expect(discord.messages(REQUESTS)).toHaveLength(1);
  expect(discord.messages(REQUESTS)[0]!.content).not.toContain(id);
  expect(discord.requests.every((request) => request.userAgent?.startsWith("DiscordBot ("))).toBe(true);
});

it("announces an accepted Support request without implying GitHub creation, then edits it once creation is confirmed", async () => {
  // GitHub delivery held back, so the first notice sees the request only accepted.
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 0").run();
  const id = await accept(production);
  await tick();
  const [message] = discord.messages(REQUESTS);
  expect(message!.content).toContain("pending GitHub delivery (no issue confirmed yet)");
  expect(message!.content).toContain("`shop/production`");
  expect(message!.content).toContain(id);
  expect(message!.content).not.toMatch(/created|issues\//);

  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  await deliver();
  advance(60_000);
  await tick();
  await tick();
  expect(discord.messages(REQUESTS)).toHaveLength(1);
  expect(discord.messages(REQUESTS)[0]).toMatchObject({ id: message!.id, edits: 1 });
  expect(discord.messages(REQUESTS)[0]!.content).toMatch(/Delivered: GitHub issue created[\s\S]*Issue: <https:\/\/github\.com\/acme\/shop\/issues\/\d+>/);
  expect(discord.messages(INCIDENTS)).toEqual([]);
});

it("never copies Submitted text, Reporter identity, credentials or untrusted URLs into Discord", async () => {
  await shopIncident();
  await accept(globex, "Pay at https://evil.example/@everyone token=secret");
  await accept(globex);
  advance(60_000);
  await tick();
  const sent = [...discord.messages(REQUESTS), ...discord.messages(INCIDENTS)];
  expect(sent).toHaveLength(4);
  const text = sent.map((message) => message.content).join("\n");
  for (const forbidden of ["Checkout fails", "Private report text", "evil.example", "@everyone", subject, production.keyId,
    production.installationId, "token-", banquinha.publicKey]) expect(text).not.toContain(forbidden);
  // Every link is built by the service from reviewed configuration.
  expect(text.match(/https:\/\/[^\s>]+/g)!.every((link) =>
    link.startsWith("https://github.com/Quick-Release/gq-support/blob/main/") || link.startsWith("https://github.com/acme/shop/issues/"))).toBe(true);
  expect(sent.every((message) => JSON.stringify(message.allowedMentions) === '{"parse":[]}')).toBe(true);
});

it("edits the incident's message as it is claimed and resolved, and announces a claim made before the first send just once", async () => {
  const id = await shopIncident();
  // Claimed while Discord had not yet been told: one message, already showing the claim.
  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`)).status).toBe(200);
  await tick();
  expect(discord.messages(INCIDENTS)).toEqual([expect.objectContaining({ edits: 0 })]);
  expect(discord.messages(INCIDENTS)[0]!.content).toContain("Claimed by `alex`");

  github.update(42, { private: true });
  advance(60_000);
  await tick();
  await operator("unsuspend", "shop/production", "operator-7", "verified-private");
  advance(1_000);
  expect((await staff("POST", `/v1/operations/incidents/${id}/resolve`, "alex", JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
  // A scheduler outage must not leave the known Discord message claimed forever.
  advance(2 * 86_400_000);
  await tick();
  await tick();
  expect(discord.messages(INCIDENTS)).toEqual([expect.objectContaining({ edits: 1 })]);
  expect(discord.messages(INCIDENTS)[0]!.content).toContain("Resolved (recovered)");
});

it("keeps incidents through a Discord outage, exposes the failing delivery, and recovers without another incident", async () => {
  const outage = Array.from({ length: 20 }, () => ({ status: 503 }));
  discord.fail(INCIDENTS, ...outage);
  const id = await shopIncident();
  await tick();
  // The incident is durable and visible though Discord is down.
  expect((await (await staff("GET", `/v1/operations/incidents/${id}`)).json())).toMatchObject({ incident: { id, state: "open" } });
  const status = async () => (await (await staff("GET", "/v1/operations/notifications")).json()) as {
    destinations: { destination: string; configured: boolean; pending: number; failed: number; last_sent_at: string | null }[];
    problems: { source_kind: string; source_id: string; state: string; attempts: number; error_code: string }[];
  };
  expect((await status()).problems).toEqual([expect.objectContaining({ source_kind: "incident", source_id: id, state: "pending",
    attempts: 1, error_code: "provider_unavailable" })]);
  // Retries back off: nothing is resent before the next attempt is due.
  await tick();
  expect(discord.requests.filter((request) => request.webhook === INCIDENTS)).toHaveLength(1);
  for (let attempt = 0; attempt < 12; attempt++) { advance(3_600_000); await tick(); }
  expect(discord.requests.filter((request) => request.webhook === INCIDENTS)).toHaveLength(8);
  expect((await status()).destinations).toContainEqual(expect.objectContaining({ destination: "operational_incidents",
    configured: true, pending: 0, failed: 1, last_sent_at: null }));
  expect(JSON.parse(await operator("notifications")).problems).toEqual([expect.objectContaining({ source_id: id, state: "failed",
    attempts: 8, error_code: "provider_unavailable" })]);

  // After the outage, an Operator re-arms the destination and the notice goes out once.
  discord.recover(INCIDENTS);
  expect(JSON.parse(await operator("notification-retry", "operational_incidents"))).toEqual({ destination: "operational_incidents", retried: 1 });
  await tick();
  await tick();
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect((await status()).destinations).toContainEqual(expect.objectContaining({ destination: "operational_incidents",
    pending: 0, failed: 0, last_sent_at: new Date(now).toISOString() }));
  expect((await status()).problems).toEqual([]);
  expect(JSON.parse(await operator("incidents")).incidents).toHaveLength(1);
}, 20_000);

it("retries a send whose outcome is unknown without creating another incident, and edits the last known message afterwards", async () => {
  discord.fail(INCIDENTS, { lostResponse: true });
  const id = await shopIncident();
  await tick();
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
  expect(JSON.parse(await operator("notifications")).problems).toEqual([expect.objectContaining({ source_id: id, state: "pending",
    error_code: "outcome_unknown" })]);
  advance(60_000);
  await tick();
  // Discord may now show the notice twice; exactly-once is not promised. The incident is still one.
  expect(discord.messages(INCIDENTS)).toHaveLength(2);
  expect(JSON.parse(await operator("incidents")).incidents).toHaveLength(1);
  expect(JSON.parse(await operator("notifications")).problems).toEqual([]);

  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`, "sam")).status).toBe(200);
  await tick();
  expect(discord.messages(INCIDENTS).map((message) => message.edits)).toEqual([0, 1]);
  expect(discord.messages(INCIDENTS)[1]!.content).toContain("Claimed by `sam`");
});

it("honors Discord rate limits per destination without spending retry attempts", async () => {
  discord.fail(REQUESTS, { status: 429, body: { message: "You are being rate limited.", retry_after: 90.5, global: false } });
  const id = await shopIncident();
  await accept(globex);
  await accept(globex);
  await tick();
  // One request to the limited webhook this tick; the incident channel is unaffected.
  expect(discord.requests.filter((request) => request.webhook === REQUESTS)).toHaveLength(1);
  expect(discord.messages(INCIDENTS)).toEqual([expect.objectContaining({ content: expect.stringContaining(id) })]);
  expect(JSON.parse(await operator("notifications")).problems).toEqual([expect.objectContaining({ destination: "support_requests",
    attempts: 0, error_code: "rate_limited", next_attempt_at: new Date(now + 90_500).toISOString() })]);
  advance(60_000);
  await tick();
  expect(discord.messages(REQUESTS)).toHaveLength(0);
  advance(31_000);
  await tick();
  expect(discord.messages(REQUESTS)).toHaveLength(3);
});

it("persists global Discord rate limits across ticks and newly queued notifications", async () => {
  discord.fail(REQUESTS, { status: 429, body: { retry_after: 90.5, global: true } });
  await shopIncident();
  await tick();
  expect(discord.requests).toHaveLength(1);
  advance(60_000);
  await accept(globex);
  await tick();
  expect(discord.requests).toHaveLength(1);
  advance(31_000);
  await tick();
  expect(discord.messages(REQUESTS)).toHaveLength(2);
  expect(discord.messages(INCIDENTS)).toHaveLength(1);
});

it("fails closed when a destination is unset, malformed or shared by both channels", async () => {
  const configured = (supportRequests: string, incidents: string) => Object.keys(discordDestinations(supportRequests, incidents));
  expect(configured("", "")).toEqual([]);
  expect(configured(webhookUrl(REQUESTS), webhookUrl(REQUESTS))).toEqual([]);
  expect(configured(`http://discord.com/api/webhooks/${REQUESTS}/${"x".repeat(60)}`, "not a url")).toEqual([]);
  expect(configured(`https://discord.example/api/webhooks/${REQUESTS}/${"x".repeat(60)}`, webhookUrl(INCIDENTS)))
    .toEqual(["operational_incidents"]);

  destinations = discordDestinations("", webhookUrl(INCIDENTS));
  await shopIncident();
  await accept(globex);
  await tick();
  expect(discord.requests.map((request) => request.webhook)).toEqual([INCIDENTS]);
  // Nothing is queued for an unconfigured channel, so configuring it later does not flood it with old requests.
  const status = (await (await staff("GET", "/v1/operations/notifications")).json()) as { destinations: unknown[] };
  expect(status.destinations).toEqual([
    { destination: "support_requests", configured: false, pending: 0, failed: 0, oldest_pending_at: null, last_sent_at: null },
    expect.objectContaining({ destination: "operational_incidents", configured: true, pending: 0 }),
  ]);
});

it("reposts a deleted message, and keeps delivery state no longer than its source", async () => {
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 0").run();
  await accept(globex);
  await tick();
  const [first] = discord.messages(REQUESTS);
  discord.remove(REQUESTS, first!.id);
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  await deliver();
  advance(60_000);
  await tick();
  advance(1_000);
  await tick();
  expect(discord.messages(REQUESTS)).toEqual([expect.objectContaining({ content: expect.stringContaining("Delivered") })]);
  // Without a reviewed repository name the issue is named, not linked.
  expect(discord.messages(REQUESTS)[0]!.content).toMatch(/Issue: #\d+ in repository 77/);

  // Request notifications only: the week without status refreshes also routes its own incident (src/operational-signals.ts).
  const rows = async () => (await stage.databases.shared.prepare(`SELECT source_kind, state FROM notification
    WHERE source_kind = 'support_request' ORDER BY source_kind`).all()).results;
  expect(await rows()).toEqual([{ source_kind: "support_request", state: "sent" }]);
  advance(7 * 86_400_000);
  await tick();
  expect(await rows()).toEqual([]);
  // A later sweep does not announce the old request again.
  await tick();
  expect(discord.messages(REQUESTS)).toHaveLength(1);
});
