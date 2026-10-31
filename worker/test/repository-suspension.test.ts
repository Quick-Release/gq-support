import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage, operatorLedger } from "./local-d1.ts";

// A production and a staging Slot share repository 42; globex keeps its own repository 77.
const START = Date.parse("2026-10-17T10:00:00Z");
const slot = (name: string, environment: string, repositoryId: number): RepositoryMapping => ({
  slot: `${name}/${environment}`, client: name, project: name, environment, repositoryId,
  githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer",
});
const mappings = [slot("shop", "production", 42), slot("shop", "staging", 42), slot("globex", "production", 77)];
const subject = "00000000-0000-4000-8000-000000000001";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let clients: ReturnType<typeof harness>;
let github: ReturnType<typeof makeFakeGitHub>;
let production: Installation, staging: Installation, globex: Installation;
let logs: { message: string; annotations: Record<string, unknown> }[];
let now: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  clients = harness(stage.databases.shared, mappings);
  production = await clients.enroll("shop/production", "installation-a");
  staging = await clients.enroll("shop/staging", "installation-b");
  globex = await clients.enroll("globex/production", "installation-c");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "shop" });
  github.repository({ id: 77, installationId: 7, name: "globex" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  logs = [];
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const submit = (installation: Installation, submissionId = crypto.randomUUID()) => installation.send("POST", "/v1/requests", JSON.stringify({
  submission_id: submissionId, reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
const accept = async (installation: Installation) => {
  const response = await submit(installation);
  expect(response.status).toBe(202);
  return await response.json() as { id: string };
};
const read = async (installation: Installation, id: string) =>
  (await installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`)).json();
const mappingState = async (installation: Installation) =>
  ((await (await installation.send("GET", "/v1/installation")).json()) as { mapping_state: string }).mapping_state;
const sweep = () => Effect.runPromise(sweepDelivery({ db: stage.databases.shared, mappings, botLogin: `${SLUG}[bot]`,
  now: () => now, random: () => 0 }).pipe(
  Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
  Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(JSON.parse(line)); })]))));
const verifySweep = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: `${SLUG}[bot]`, now: () => now,
    random: () => 0, refresh: { readsPerTick: 0 } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer)))));
};
/** Waits out the shared mutation pacing between creates. */
const deliver = async () => { advance(10_000); await sweep(); };
const operator = (...args: string[]) => runOperator(args, { ledger: operatorLedger(stage.databases.shared), mappings, now, recordRevocation: async () => {},
  query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
const issuePosts = () => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));
const suspensionAlerts = () => logs.filter((log) => log.message === "Repository mapping suspended");

it("suspends every Slot on a repository made public, and alerts the Operator once", async () => {
  const earlier = await accept(production);
  await deliver();
  expect(await read(production, earlier.id)).toMatchObject({ delivery: "delivered", status: "open" });

  github.update(42, { private: false });
  const later = await accept(staging);
  await deliver();
  expect(issuePosts()).toHaveLength(1);
  expect(await read(staging, later.id)).toMatchObject({ delivery: "failed", status: null });
  expect(suspensionAlerts()).toEqual([expect.objectContaining({ annotations: expect.objectContaining({ repository: 42, reason: "public", alert: true }) })]);

  for (const installation of [production, staging]) {
    expect(await mappingState(installation)).toBe("suspended");
    const refused = await submit(installation);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "gq_support_not_configured" });
  }
  // Existing requests keep their last-known status; another repository is untouched.
  expect(await read(production, earlier.id)).toMatchObject({ delivery: "delivered", status: "open" });
  expect(await mappingState(globex)).toBe("active");
  await accept(globex);
});

it("refuses an archived repository from the create's own token mint, with no extra repository read", async () => {
  github.update(42, { archived: true });
  const request = await accept(production);
  await deliver();
  expect(github.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /app/installations/7/access_tokens"]);
  expect(await read(production, request.id)).toMatchObject({ delivery: "failed" });
  expect(suspensionAlerts().map((log) => log.annotations.reason)).toEqual(["archived"]);
  expect(await mappingState(staging)).toBe("suspended");
});

it("makes one repository read when the mint omits archived", async () => {
  github.mintOmits("archived");
  await accept(production);
  await deliver();
  expect(github.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    "POST /app/installations/7/access_tokens", "GET /repos/Quick-Release/shop", "POST /repos/Quick-Release/shop/issues"]);
  github.update(42, { archived: true });
  await accept(production);
  await deliver();
  expect(issuePosts()).toHaveLength(1);
  expect(suspensionAlerts().map((log) => log.annotations.reason)).toEqual(["archived"]);
});

it("resolves a renamed repository by ID and refreshes its name on the next mint", async () => {
  await accept(production);
  await deliver();
  github.update(42, { name: "shop-renamed" });
  await accept(production);
  await deliver();
  expect(issuePosts().map((r) => r.path)).toEqual(["/repos/Quick-Release/shop/issues", "/repos/Quick-Release/shop-renamed/issues"]);
  expect(suspensionAlerts()).toEqual([]);
  expect(await mappingState(production)).toBe("active");
});

it.each([
  ["transferred to an owner without the App", () => { github.installation(8); github.update(42, { owner: "Elsewhere", installationId: 8 }); }],
  ["removed from the App installation", () => { github.update(42, { installationId: 9 }); }],
  ["on a suspended App installation", () => { github.suspend(7); }],
  ["after the App is uninstalled", () => { github.next(() => Response.json({ message: "Not Found" }, { status: 404 })); }],
])("suspends a repository %s as lost access", async (_name, change) => {
  await accept(production);
  await deliver();
  change();
  const request = await accept(production);
  await deliver();
  expect(issuePosts()).toHaveLength(1);
  expect(await read(production, request.id)).toMatchObject({ delivery: "failed" });
  expect(suspensionAlerts().map((log) => log.annotations)).toEqual([expect.objectContaining({ repository: 42, reason: "no_access" })]);
  expect(await mappingState(staging)).toBe("suspended");
  expect((await submit(staging)).status).toBe(403);
});

it("stays suspended after the repository is made private again, until an Operator unsuspends it", async () => {
  github.update(42, { private: false });
  const requests = [[production, await accept(production)], [staging, await accept(staging)]] as const;
  await deliver();
  // One create found the repository public; the other was held, unsent.
  const deliveries = async () => Promise.all(requests.map(async ([installation, { id }]) => ((await read(installation, id)) as { delivery: string }).delivery));
  expect((await deliveries()).sort()).toEqual(["accepted-pending", "failed"]);
  const held = (await deliveries()).indexOf("accepted-pending");
  github.update(42, { private: true });
  advance(3_600_000);
  await deliver();
  expect(issuePosts()).toHaveLength(0);
  expect((await deliveries())[held]).toBe("accepted-pending");
  expect(await mappingState(production)).toBe("suspended");
  expect((await submit(production)).status).toBe(403);

  await expect(operator("unsuspend", "shop/staging", "operator-7", "verified-private")).rejects.toThrow("cannot be unsuspended");
  await verifySweep();
  expect(JSON.parse(await operator("status", "shop/staging"))).toMatchObject({ suspension: { reason: "public", suspended_at: START + 10_000 } });
  // The evidence must answer the recorded cause.
  await expect(operator("unsuspend", "shop/staging", "operator-7", "access-restored")).rejects.toThrow("cannot be unsuspended");
  expect(await operator("unsuspend", "shop/staging", "operator-7", "verified-private"))
    .toBe("Unsuspended repository 42 for shop/production, shop/staging");
  await expect(operator("unsuspend", "shop/staging", "operator-7", "verified-private")).rejects.toThrow("cannot be unsuspended");
  expect(await stage.databases.shared.prepare("SELECT repository_id, actor, action, evidence, suspended_reason FROM repository_audit").all())
    .toMatchObject({ results: [{ repository_id: 42, actor: "operator-7", action: "unsuspend", evidence: "verified-private", suspended_reason: "public" }] });

  for (const installation of [production, staging]) expect(await mappingState(installation)).toBe("active");
  expect(JSON.parse(await operator("status", "shop/production"))).toMatchObject({ suspension: null });
  // Work accepted before the suspension was held, not lost.
  await deliver();
  expect((await deliveries())[held]).toBe("delivered");
  await accept(production);
});

it("re-suspends an unsuspended repository that is still unsafe at the next create", async () => {
  github.update(42, { archived: true });
  await accept(production);
  await deliver();
  await expect(operator("unsuspend", "shop/production", "operator-7", "verified-unarchived")).rejects.toThrow("cannot be unsuspended");
  github.update(42, { archived: false });
  advance(60_000);
  await verifySweep();
  await operator("unsuspend", "shop/production", "operator-7", "verified-unarchived");
  github.update(42, { archived: true });
  await accept(production);
  await deliver();
  expect(issuePosts()).toHaveLength(0);
  expect(suspensionAlerts().map((log) => log.annotations.reason)).toEqual(["archived", "archived"]);
  expect(await mappingState(staging)).toBe("suspended");
});

it("suspends from a metadata repair that finds the repository archived, keeping the delivered status", async () => {
  github.onCreate((issue) => { issue.labels = []; return undefined; });
  const request = await accept(production);
  await deliver();
  github.update(42, { archived: true });
  await deliver();
  expect(github.requests.filter((r) => r.path.endsWith("/labels"))).toHaveLength(0);
  expect(suspensionAlerts().map((log) => log.annotations.reason)).toEqual(["archived"]);
  expect(await read(production, request.id)).toMatchObject({ delivery: "delivered", status: "open" });
  expect(await mappingState(staging)).toBe("suspended");
});

it("still replays a submission accepted before the suspension, and refuses only new ones", async () => {
  const submissionId = crypto.randomUUID();
  const accepted = await (await submit(production, submissionId)).json() as { id: string };
  github.update(42, { private: false });
  await deliver();
  const retried = await submit(production, submissionId);
  expect(retried.status).toBe(202);
  expect(await retried.json()).toMatchObject({ id: accepted.id, delivery: "failed" });
  expect((await submit(production)).status).toBe(403);
});
