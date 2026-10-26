import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

// Two Slots share repository 42; globex has repository 77. Both are on installation 7.
const START = Date.parse("2026-10-17T10:00:00Z");
const slot = (name: string, environment: string, repositoryId: number): RepositoryMapping => ({
  slot: `${name}/${environment}`, client: name, project: name, environment, repositoryId,
  githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer",
});
const mappings = [slot("shop", "production", 42), slot("shop", "staging", 42), slot("globex", "production", 77)];
const secret = "test-webhook-secret";
const subject = "00000000-0000-4000-8000-000000000001";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let production: Installation, staging: Installation, globex: Installation;
let logs: { message: string; annotations: Record<string, unknown> }[];
let accesses: number;
let failDatabase: boolean;
let now: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  const clients = harness(stage.databases.shared, mappings);
  production = await clients.enroll("shop/production", "installation-a");
  staging = await clients.enroll("shop/staging", "installation-b");
  globex = await clients.enroll("globex/production", "installation-c");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "shop" });
  github.repository({ id: 77, installationId: 7, name: "globex" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  logs = []; accesses = 0; failDatabase = false;
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const send = (body: unknown, event: string, signWith = secret) => {
  const raw = JSON.stringify(body);
  const input = new Request("https://support.example/v1/github/webhooks", { method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": "same-delivery",
      "x-github-hook-installation-target-type": "integration", "x-github-hook-installation-target-id": "123",
      "x-hub-signature-256": `sha256=${createHmac("sha256", signWith).update(raw).digest("hex")}` },
  });
  const status = { mappings, botLogin: BOT, refresh: async () => {},
    database: async () => {
      accesses++;
      if (failDatabase) throw new Error("D1 unavailable");
      return stage.databases.shared;
    } };
  return Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(input), Effect.die("Webhook must bypass installation authentication"),
    mappings, createGitHubWebhookReceiver({ appId: "123", secret }), () => {}, status).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(JSON.parse(line)); })])))).then((response) => response.status);
};
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT, now: () => now,
    random: () => 0, refresh: { readsPerTick: 0 } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
    Effect.provide(Logger.layer([]))));
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
const mappingState = async (installation: Installation) =>
  ((await (await installation.send("GET", "/v1/installation")).json()) as { mapping_state: string }).mapping_state;
const suspensions = async () => (await stage.databases.shared.prepare(`SELECT repository_id, suspended_reason, suspended_at
  FROM repository_state WHERE suspended_reason IS NOT NULL ORDER BY repository_id`).all()).results;
const alerts = () => logs.filter((log) => log.message === "Repository mapping suspended");
const lastSwept = async () => Object.fromEntries((await stage.databases.shared.prepare(
  "SELECT repository_id, last_swept_at FROM repository_state ORDER BY repository_id").all<{ repository_id: number; last_swept_at: number }>())
  .results.map((row) => [row.repository_id, row.last_swept_at]));
const repository = (id: number) => ({ id, private: true, full_name: "Private/name" });

it("suspends every Slot on a repository made public at once, without a sweep or a GitHub call", async () => {
  expect(await send({ repository: repository(42), installation: { id: 7 } }, "public")).toBe(202);
  expect(github.requests).toEqual([]);
  for (const installation of [production, staging]) {
    expect(await mappingState(installation)).toBe("suspended");
    const refused = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
      reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "gq_support_not_configured" });
  }
  expect(await mappingState(globex)).toBe("active");
  expect(alerts()).toEqual([expect.objectContaining({ annotations: expect.objectContaining({ repository: 42, reason: "public", alert: true }) })]);
});

it.each([
  ["repository", { action: "publicized", repository: repository(42) }, [[42, "public"]]],
  ["repository", { action: "archived", repository: repository(42) }, [[42, "archived"]]],
  ["repository", { action: "deleted", repository: repository(42) }, [[42, "no_access"]]],
  ["repository", { action: "transferred", repository: repository(42) }, [[42, "no_access"]]],
  ["installation", { action: "deleted" }, [[42, "no_access"], [77, "no_access"]]],
  ["installation", { action: "suspend" }, [[42, "no_access"], [77, "no_access"]]],
  ["installation_repositories", { action: "removed", repositories_removed: [repository(77), repository(99)] }, [[77, "no_access"]]],
] as const)("fails closed on %s %j", async (event, body, expected) => {
  expect(await send({ ...body, installation: { id: 7 } }, event)).toBe(202);
  expect((await suspensions()).map((row) => [row.repository_id, row.suspended_reason])).toEqual(expected);
});

it("keeps the first suspension on duplicate and conflicting redeliveries, and alerts once", async () => {
  const body = { action: "publicized", repository: repository(42), installation: { id: 7 } };
  expect(await send(body, "repository")).toBe(202);
  advance(60_000);
  expect(await send(body, "repository")).toBe(202);
  expect(await send({ repository: repository(42), installation: { id: 7 } }, "public")).toBe(202);
  expect(await send({ ...body, action: "archived" }, "repository")).toBe(202);
  expect(await suspensions()).toEqual([{ repository_id: 42, suspended_reason: "public", suspended_at: START }]);
  expect(alerts()).toHaveLength(1);
});

it("never lifts a suspension from a webhook, in any order", async () => {
  // Out of order: the unsuspend arrives before the suspend it follows.
  expect(await send({ action: "unsuspend", installation: { id: 7 } }, "installation")).toBe(202);
  expect(await send({ action: "suspend", installation: { id: 7 } }, "installation")).toBe(202);
  for (const [event, body] of [
    ["installation", { action: "unsuspend" }], ["installation", { action: "new_permissions_accepted" }],
    ["installation_repositories", { action: "added", repositories_added: [repository(42), repository(77)] }],
    ["repository", { action: "privatized", repository: repository(42) }],
    ["repository", { action: "unarchived", repository: repository(77) }],
  ] as const) expect(await send({ ...body, installation: { id: 7 } }, event)).toBe(202);
  expect((await suspensions()).map((row) => row.suspended_reason)).toEqual(["no_access", "no_access"]);
  expect(await mappingState(production)).toBe("suspended");
});

it("schedules the next sweep at once on a safe signal", async () => {
  await tick();
  const first = now;
  advance(60_000); await tick();
  expect(await lastSwept()).toEqual({ 42: first, 77: first }); // Neither is due within the 15-minute interval.
  const signalled = now;
  expect(await send({ action: "unarchived", repository: repository(77), installation: { id: 7 } }, "repository")).toBe(202);
  advance(60_000); await tick();
  // The window runs from the signal, so the completed sweep counts from it.
  expect(await lastSwept()).toEqual({ 42: first, 77: signalled });
});

it("lifts a webhook suspension only through the Operator, after a later passing verification", async () => {
  await tick();
  github.update(42, { private: false });
  advance(60_000);
  expect(await send({ action: "publicized", repository: repository(42), installation: { id: 7 } }, "repository")).toBe(202);
  advance(60_000); await tick(); // The scheduled verification still sees it public.
  await expect(operator("unsuspend", "shop/production", "operator-1", "verified-private")).rejects.toThrow(/later passing verification/);

  github.update(42, { private: true });
  expect(await send({ action: "privatized", repository: repository(42), installation: { id: 7 } }, "repository")).toBe(202);
  expect(await mappingState(production)).toBe("suspended");
  advance(60_000); await tick();
  expect(await operator("unsuspend", "shop/production", "operator-1", "verified-private")).toMatch(/Unsuspended repository 42/);
  expect(await mappingState(staging)).toBe("active");
});

it("rejects a forged lifecycle delivery before D1", async () => {
  expect(await send({ repository: repository(42), installation: { id: 7 } }, "public", "another-secret")).toBe(401);
  expect(accesses).toBe(0);
  expect(await suspensions()).toEqual([]);
});

it.each([
  ["public", { repository: repository(99), installation: { id: 7 } }],
  ["public", { repository: repository(42), installation: { id: 8 } }],
  ["public", { repository: { id: "42" }, installation: { id: 7 } }],
  ["public", { repository: repository(42), installation: { id: "7" } }],
  ["public", { repository: repository(42) }],
  ["repository", { action: "renamed", repository: repository(42), installation: { id: 7 } }],
  ["repository", { action: "edited", repository: repository(42), installation: { id: 7 } }],
  ["repository", { action: "future_action", repository: repository(42), installation: { id: 7 } }],
  ["installation", { action: "created", installation: { id: 7 } }],
  ["installation", { action: "deleted", installation: { id: 8 } }],
  ["installation_repositories", { action: "removed", repositories_removed: [repository(99)], installation: { id: 7 } }],
  ["installation_repositories", { action: "removed", repositories_removed: "42", installation: { id: 7 } }],
  ["installation_target", { action: "renamed", installation: { id: 7 } }],
] as const)("acknowledges %s %j without D1", async (event, body) => {
  expect(await send(body, event)).toBe(204);
  expect(accesses).toBe(0);
});

it("answers 503 when D1 fails, so the redelivery can apply it", async () => {
  const body = { action: "removed", repositories_removed: [repository(42)], installation: { id: 7 } };
  failDatabase = true;
  expect(await send(body, "installation_repositories")).toBe(503);
  expect(await suspensions()).toEqual([]);
  failDatabase = false;
  expect(await send(body, "installation_repositories")).toBe(202);
  expect((await suspensions()).map((row) => row.repository_id)).toEqual([42]);
});
