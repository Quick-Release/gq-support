import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { operationsAccess } from "../src/operations-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, signed, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { operationsClient, type OperationsClient } from "./operations-client.ts";
import type { QueryDatabase } from "../src/storage.ts";

// Repository 42 serves a production and a staging Slot; globex keeps its own repository 77.
const START = Date.parse("2026-10-17T10:00:00Z");
const slot = (name: string, environment: string, repositoryId: number): RepositoryMapping => ({
  slot: `${name}/${environment}`, client: name, project: name, environment, repositoryId,
  githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer",
});
const mappings = [slot("shop", "production", 42), slot("shop", "staging", 42), slot("globex", "production", 77)];
const subject = "00000000-0000-4000-8000-000000000001";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let production: Installation, globex: Installation;
let banquinha: OperationsClient;
let access: ReturnType<typeof operationsAccess>;
let now: number;

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
  banquinha = await operationsClient();
  access = operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex,sam");
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const accept = async (installation: Installation) => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
};
const deliver = async (db: QueryDatabase = stage.databases.shared) => {
  advance(10_000);
  await Effect.runPromise(sweepDelivery({ db, mappings, botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 })
    .pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem })
      .pipe(Layer.provide(github.layer)))));
};
/** The minute Cron's work: delivery, cleanup, status refresh and sweep. */
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: `${SLUG}[bot]`, now: () => now,
    random: () => 0, refresh: { readsPerTick: 0 } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer)))));
};
/** Opens the shop repository's incident by delivering into a repository made public. */
const shopIncident = async () => {
  github.update(42, { private: false });
  await accept(production);
  await deliver();
  const [incident] = await incidents();
  return incident!.id as string;
};
const audit = async () => {
  const list = JSON.parse(await operator("incidents")) as { incidents: { id: string }[] };
  const histories = await Promise.all(list.incidents.map(async ({ id }) =>
    (JSON.parse(await operator("incident", id)) as { audit: Record<string, unknown>[] }).audit));
  const order = { open: 0, claim: 1, resolve: 2 };
  return histories.flat().sort((a, b) => Number(a.occurred_at) - Number(b.occurred_at) ||
    order[a.action as keyof typeof order] - order[b.action as keyof typeof order])
    .map(({ occurred_at: _time, ...entry }) => entry);
};
/** Sends through the Worker's HTTP entry, as the deployed adapter does. */
const send = (request: Request, config = access) => Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request),
  Effect.succeed(stage.databases.shared), mappings, () => Effect.die("Not a webhook"), () => {}, undefined, {}, config));
const staff = async (method: string, path: string, actor = "alex", body = "") => send(await banquinha.request(method, path, actor, body));
const incidents = async (actor = "alex") => {
  const response = await staff("GET", "/v1/operations/incidents", actor);
  expect(response.status).toBe(200);
  return ((await response.json()) as { incidents: Record<string, unknown>[] }).incidents;
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  // Like the Wrangler adapter, which substitutes plain `?` in order and has no numbered parameters.
  query: async (sql, parameters) => sql.match(/\?\d/) ? Promise.reject(new Error("Numbered parameter")) : (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });

it("lists Support request metadata separately for staff, with bounded pagination and no Reporter content", async () => {
  await accept(production);
  advance(1_000);
  await accept(globex);
  const first = await staff("GET", "/v1/operations/requests?limit=1");
  expect(first.status).toBe(200);
  const page = await first.json() as { items: { id: string; slot: string; delivery: string }[]; next_cursor: string | null };
  expect(page.items).toEqual([expect.objectContaining({ slot: "globex/production", delivery: "accepted-pending" })]);
  expect(page.next_cursor).toEqual(expect.any(String));
  const next = await staff("GET", `/v1/operations/requests?limit=1&cursor=${page.next_cursor}`);
  expect(next.status).toBe(200);
  const last = await next.json() as { items: { id: string; slot: string }[]; next_cursor: string | null };
  expect(last.items).toEqual([expect.objectContaining({ slot: "shop/production" })]);
  expect(last.items[0]!.id).not.toBe(page.items[0]!.id);
  expect(last.next_cursor).toBeNull();
  const shown = JSON.stringify([page, last]);
  for (const hidden of ["Checkout fails", "Private report text", subject, "reporter_subject", "summary", "description"])
    expect(shown).not.toContain(hidden);
  expect((await staff("GET", "/v1/operations/requests?limit=201")).status).toBe(400);
  expect((await staff("GET", "/v1/operations/requests?cursor=invalid")).status).toBe(400);
  expect((await staff("GET", "/v1/operations/requests", "discord-member")).status).toBe(403);
});

it("groups a shared repository failure into one incident listing every affected Slot, apart from unrelated failures", async () => {
  github.update(42, { private: false });
  await accept(production);
  await deliver();

  // The suspension covers every Slot on the repository, whichever one observed it.
  expect(await incidents()).toEqual([{
    id: expect.any(String), category: "repository_suspended", detail: null, state: "open",
    affected_slots: ["shop/production", "shop/staging"],
    first_observed_at: new Date(START + 10_000).toISOString(), last_observed_at: expect.any(String),
    claimant: null, claimed_at: null, resolution: null, resolved_at: null,
    runbook: "worker/README.md#suspended-mappings",
  }]);

  github.update(77, { archived: true });
  await accept(globex);
  await deliver();
  const [shop, other] = await incidents();
  expect(other).toMatchObject({ category: "repository_suspended", affected_slots: ["globex/production"] });
  expect(shop!.affected_slots).toEqual(["shop/production", "shop/staging"]);
  expect(other!.id).not.toBe(shop!.id);
});

it("keeps a repository suspended even when incident storage fails", async () => {
  github.update(42, { private: false });
  await accept(production);
  const db = stage.databases.shared;
  await deliver({
    prepare: (sql) => db.prepare(sql.includes("INSERT INTO incident (") ? "SELECT * FROM unavailable_incident_store" : sql),
    batch: (statements) => db.batch(statements),
  });
  expect(JSON.parse(await operator("status", "shop/production"))).toMatchObject({ suspension: { reason: "public" } });
  expect(await incidents()).toEqual([]);
});

it("admits only a registered dashboard key naming a rostered team member, never an installation or Discord identity", async () => {
  const path = "/v1/operations/incidents";
  expect((await staff("GET", path)).status).toBe(200);
  // An enrolled installation's own valid signature, re-addressed to the operations API.
  const installation = await send(await signed(production.pair, "GET", path, "", production.keyId, production.installationId));
  expect(installation.status).toBe(401);
  expect(await installation.json()).toEqual({ code: "operations_unauthorized" });
  // Discord membership alone: an interaction signature or bot token is no credential here.
  const discord = await send(new Request(`https://support.example${path}`, { headers: {
    "X-Signature-Ed25519": "a".repeat(128), "X-Signature-Timestamp": String(Math.floor(now / 1000)), Authorization: "Bot discord-token",
    "GQ-Operations-Actor": "alex" } }));
  expect(discord.status).toBe(401);
  // A signed assertion for someone outside the roster, such as a Discord-only member.
  const outsider = await staff("GET", path, "discord-member");
  expect(outsider.status).toBe(403);
  expect(await outsider.json()).toEqual({ code: "operations_forbidden" });
  // Another key, or the actor swapped after signing.
  const stranger = await operationsClient(banquinha.keyId);
  expect((await send(await stranger.request("GET", path, "alex"))).status).toBe(401);
  const swapped = await banquinha.request("GET", path, "alex");
  swapped.headers.set("GQ-Operations-Actor", "sam");
  expect((await send(swapped)).status).toBe(401);
  // A replayed request, a stale one, and a stage with no or malformed configuration.
  const once = await banquinha.request("GET", path, "alex");
  expect((await send(once.clone())).status).toBe(200);
  expect((await send(once)).status).toBe(401);
  expect((await send(await banquinha.request("GET", path, "alex", "", { now: now - 600_000 }))).status).toBe(401);
  expect((await send(await banquinha.request("GET", path, "alex"), operationsAccess("", ""))).status).toBe(401);
  expect((await send(await banquinha.request("GET", path, "alex"),
    operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey, other: "not-a-key" }), "alex"))).status).toBe(401);
  expect((await send(await banquinha.request("GET", path, "alex"),
    operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), ""))).status).toBe(403);
});

it("lets exactly one of two concurrent team members claim an incident, and audits only the winner", async () => {
  const id = await shopIncident();
  const claims = await Promise.all(["alex", "sam"].map((actor) => staff("POST", `/v1/operations/incidents/${id}/claim`, actor)));
  const statuses = claims.map((response) => response.status).sort();
  expect(statuses).toEqual([200, 409]);
  const bodies = await Promise.all(claims.map((response) => response.json())) as { code?: string; incident: { claimant: string } }[];
  const winner = bodies.find((body) => !body.code)!.incident.claimant;
  expect(bodies.find((body) => body.code)).toMatchObject({ code: "incident_claimed", incident: { state: "claimed", claimant: winner } });
  expect(await audit()).toEqual([
    { actor: "service", via: "service", action: "open", previous_state: null, new_state: "open" },
    { actor: winner, via: "api", action: "claim", previous_state: "open", new_state: "claimed" },
  ]);
  // Retrying your own claim is safe; nobody can take it over.
  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`, winner)).status).toBe(200);
  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`, winner === "alex" ? "sam" : "alex")).status).toBe(409);
  expect(await audit()).toHaveLength(2);
  expect((await staff("POST", `/v1/operations/incidents/${crypto.randomUUID()}/claim`)).status).toBe(404);
});

it("resolves an incident only for its claimant, after an Operator's recovery is verified", async () => {
  const id = await shopIncident();
  const resolve = (actor = "alex", body = JSON.stringify({ resolution: "recovered" })) =>
    staff("POST", `/v1/operations/incidents/${id}/resolve`, actor, body);
  expect(await (await resolve()).json()).toMatchObject({ code: "incident_not_claimed", incident: { state: "open" } });
  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`, "alex")).status).toBe(200);
  expect((await resolve("alex", JSON.stringify({ resolution: "fixed-it" }))).status).toBe(400);
  // Still suspended: the staff API cannot perform or skip the Operator's recovery.
  const early = await resolve();
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ code: "recovery_not_verified", incident: { state: "claimed", resolution: null } });
  expect((await staff("POST", "/v1/operations/repositories/42/unsuspend")).status).toBe(404);

  github.update(42, { private: true });
  advance(60_000);
  await tick();
  await operator("unsuspend", "shop/production", "operator-7", "verified-private");
  expect(await (await resolve("sam")).json()).toMatchObject({ code: "incident_not_claimed" });
  advance(1_000);
  const resolved = await resolve();
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toEqual({ incident: expect.objectContaining({ state: "resolved", claimant: "alex",
    resolution: "recovered", resolved_at: new Date(now).toISOString() }) });
  expect((await resolve()).status).toBe(409);
  expect(await audit()).toEqual([
    expect.objectContaining({ action: "open" }),
    { actor: "alex", via: "api", action: "claim", previous_state: "open", new_state: "claimed" },
    { actor: "alex", via: "api", action: "resolve", previous_state: "claimed", new_state: "resolved" },
  ]);

  // The same cause failing again is a new incident, not a reopened one.
  github.update(42, { archived: true });
  await accept(production);
  await deliver();
  const [open, closed] = await incidents();
  expect(open).toMatchObject({ state: "open", claimant: null, affected_slots: ["shop/production", "shop/staging"] });
  expect(closed).toMatchObject({ id, state: "resolved" });
});

it("gives Operators an audited CLI fallback to inspect and claim incidents when the dashboard is unavailable", async () => {
  const id = await shopIncident();
  expect(JSON.parse(await operator("incidents"))).toEqual({ incidents: [expect.objectContaining({ id, state: "open", claimant: null })] });
  await expect(operator("incident-claim", id, "not an actor")).rejects.toThrow("Usage");
  expect(JSON.parse(await operator("incident-claim", id, "operator-7"))).toMatchObject({ incident: { id, state: "claimed", claimant: "operator-7" } });
  await expect(operator("incident-claim", id, "operator-8")).rejects.toThrow("already claimed by operator-7");
  // The dashboard sees the same durable claim, and cannot take it over.
  expect((await staff("POST", `/v1/operations/incidents/${id}/claim`, "alex")).status).toBe(409);
  // The restricted Operator view includes the audit trail; the team view does not.
  expect(JSON.parse(await operator("incident", id))).toEqual({
    incident: expect.objectContaining({ id, claimant: "operator-7" }),
    audit: [
      expect.objectContaining({ actor: "service", action: "open" }),
      expect.objectContaining({ actor: "operator-7", via: "operator", action: "claim", new_state: "claimed" }),
    ],
  });
  expect(await (await staff("GET", `/v1/operations/incidents/${id}`)).json()).not.toHaveProperty("audit");
  await expect(operator("incident", crypto.randomUUID())).rejects.toThrow("Unknown incident");
});

it("audits only the winning remote CLI claim when two Operators race", async () => {
  const id = await shopIncident();
  const claims = await Promise.allSettled(["operator-7", "operator-8"].map((actor) => operator("incident-claim", id, actor)));
  expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
  const detail = JSON.parse(await operator("incident", id)) as {
    incident: { claimant: string }; audit: { actor: string; action: string }[];
  };
  expect(detail.audit.filter((entry) => entry.action === "claim")).toEqual([
    expect.objectContaining({ actor: detail.incident.claimant }),
  ]);
});

it("keeps an unclaimed incident visible without reminders or escalation, and expires resolved ones after 90 days", async () => {
  const DAY = 86_400_000;
  const id = await shopIncident();
  github.update(77, { archived: true });
  await accept(globex);
  await deliver();
  const globexId = (await incidents()).find((incident) => incident.id !== id)!.id as string;
  github.update(77, { archived: false });
  advance(60_000);
  await tick();
  await operator("unsuspend", "globex/production", "operator-7", "verified-unarchived");
  expect((await staff("POST", `/v1/operations/incidents/${globexId}/claim`)).status).toBe(200);
  expect((await staff("POST", `/v1/operations/incidents/${globexId}/resolve`, "alex", JSON.stringify({ resolution: "recovered" }))).status).toBe(200);
  const before = await audit();

  advance(90 * DAY - 1);
  await tick();
  expect((await incidents()).map((incident) => [incident.id, incident.state])).toEqual([[id, "open"], [globexId, "resolved"]]);
  advance(1);
  // Expired from every projection at once, before the sweep deletes it.
  expect((await incidents()).map((incident) => incident.id)).toEqual([id]);
  expect((await staff("GET", `/v1/operations/incidents/${globexId}`)).status).toBe(404);
  expect((await staff("POST", `/v1/operations/incidents/${globexId}/claim`)).status).toBe(404);
  await expect(operator("incident", globexId)).rejects.toThrow("Unknown incident");
  await tick();
  const rows = async (table: string) => (await stage.databases.shared.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE incident_id = ?`)
    .bind(globexId).first<{ n: number }>())!.n;
  expect([await rows("incident_slot"), await rows("incident_audit")]).toEqual([0, 0]);
  expect(await stage.databases.shared.prepare("SELECT id FROM incident").all()).toMatchObject({ results: [{ id }] });

  // Ninety days on, the unresolved incident is still unclaimed, unchanged and unaudited: nothing reminded or escalated.
  expect(await incidents()).toEqual([expect.objectContaining({ id, state: "open", claimant: null, claimed_at: null })]);
  expect(await audit()).toEqual(before.filter((row) => row.action === "open").slice(0, 1));
});

it("projects incidents without report content, Reporter identity, credentials or cause internals", async () => {
  const id = await shopIncident();
  await staff("POST", `/v1/operations/incidents/${id}/claim`);
  const views = [
    await (await staff("GET", "/v1/operations/incidents")).text(),
    await (await staff("GET", `/v1/operations/incidents/${id}`)).text(),
    await operator("incidents"), await operator("incident", id),
  ].join("\n");
  for (const forbidden of ["Checkout fails", "Private report text", subject, production.keyId, production.installationId,
    banquinha.publicKey, '"subject"', "https://"]) expect(views).not.toContain(forbidden);
});
