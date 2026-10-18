import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { suspendRepository } from "../src/repository-suspension.ts";
import { requestStatusRefresh } from "../src/status-refresh.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";

// The missed-webhook runbook's Operator commands (#57), through the scheduled entry and real local D1.
const START = Date.parse("2026-10-17T10:00:00Z");
const MINUTE = 60_000;
const SWEEP = 15 * MINUTE;
const mapping = (slot: string, repositoryId: number): RepositoryMapping => ({ slot, client: "shop", project: "shop",
  environment: slot.split("/")[1]!, repositoryId, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" });
const mappings = [mapping("shop/production", 42), mapping("globex/production", 77)];
const subject = "00000000-0000-4000-8000-000000000001";
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
let installation: Installation;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "shop" });
  github.repository({ id: 77, installationId: 7, name: "globex" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
  installation = await harness(stage.databases.shared, mappings).enroll("shop/production", "installation-a");
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const db = () => stage.databases.shared;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: db(), mappings, botLogin: BOT, now: () => now, random: () => 0 })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, () => {})]))));
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: async (sql, parameters) => (await db().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
const health = async () => JSON.parse(await operator("status-health")) as {
  healthy: boolean; dueRefreshes: number;
  repositories: { repositoryId: number; lastSweptAt: string | null; sweeping: boolean; suspended: boolean; withinInterval: boolean }[];
  suspensions: { repositoryId: number; reason: string; acknowledged: boolean }[];
};
const accept = async () => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
  return await response.json() as { id: string };
};
const statusOf = async (id: string) => {
  const response = await installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`);
  return (await response.json() as { status: string | null }).status;
};
const iso = (time: number) => new Date(time).toISOString();
const mutations = () => github.requests.filter((request) => request.method !== "GET" && !request.path.endsWith("/access_tokens"));
const audit = async () => (await db().prepare("SELECT * FROM status_audit ORDER BY occurred_at").all<Record<string, unknown>>()).results;

/** Delivers a request, then sweeps each repository once. */
const delivered = async () => {
  const request = await accept();
  await tick();
  expect(await statusOf(request.id)).toBe("open");
  return request;
};

it("re-sweeps every repository from an outage start, repairing status that normal sweeps no longer list", async () => {
  const request = await delivered();
  advance(MINUTE);
  const closedAt = now;
  github.edit(github.issues[0]!, { state: "closed" });
  advance(SWEEP);
  await tick();
  expect(await statusOf(request.id)).toBe("closed");
  for (let elapsed = 0; elapsed < 60 * MINUTE; elapsed += SWEEP) { advance(SWEEP); await tick(); }
  // A projection rolled back behind the last sweep, as after a restore: ordinary sweeps never list the issue again.
  await db().prepare("UPDATE support_request SET status = 'open', status_source_updated_at = ?, status_etag = NULL")
    .bind(closedAt - MINUTE).run();
  advance(SWEEP);
  await tick();
  expect(await statusOf(request.id)).toBe("open");
  const created = mutations().length;

  expect(await operator("status-reconcile", iso(closedAt - MINUTE), "operator-1"))
    .toBe(`Full reconciliation sweep scheduled for 2 repositories from ${iso(closedAt - MINUTE)}`);
  expect((await health()).repositories.every((repository) => repository.sweeping && !repository.withinInterval)).toBe(true);
  await tick();

  expect(await statusOf(request.id)).toBe("closed");
  expect(mutations()).toHaveLength(created);
  expect((await health()).repositories.every((repository) => !repository.sweeping && repository.withinInterval)).toBe(true);
  expect(await audit()).toEqual([{ id: expect.any(String), actor: "operator-1", action: "reconcile", window_start: closedAt - MINUTE,
    window_end: null, repositories: 2, due_refreshes: 0, suspended_repositories: "[]", occurred_at: now }]);
});

it("restarts a sweep already in progress from the earlier reconciliation start", async () => {
  await delivered();
  advance(SWEEP);
  await db().prepare("UPDATE repository_state SET sweep_started_at = ?1, sweep_cursor = ?1, sweep_page = 3 WHERE repository_id = 42")
    .bind(now - MINUTE).run();
  await operator("status-reconcile", iso(START), "operator-1");
  const state = await db().prepare("SELECT sweep_started_at, sweep_cursor, sweep_page FROM repository_state WHERE repository_id = 42").first();
  // Skewed back like an ordinary sweep's `since`; the original start is kept so completion never moves `last_swept_at` backwards.
  expect(state).toEqual({ sweep_started_at: now - MINUTE, sweep_cursor: START - 5 * MINUTE, sweep_page: 1 });
});

it.each([
  [["status-reconcile", "2026-10-17T10:00:00Z"]],
  [["status-reconcile", "not-a-time", "operator-1"]],
  [["status-reconcile", "2026-10-17T11:00:00Z", "operator-1"]],
  [["status-reconcile", "2026-10-17T09:00:00Z", "an operator"]],
  [["status-health", "extra"]],
  [["status-reconcil", "2026-10-17T09:00:00Z", "operator-1"]],
  [["status-repair", "2026-10-17T09:00:00Z", "operator-1"]],
  [["status-repair", "2026-10-17T09:30:00Z", "2026-10-17T09:00:00Z", "operator-1"]],
  [["status-repair", "2026-10-17T09:00:00Z", "2026-10-17T11:00:00Z", "operator-1"]],
])("rejects malformed arguments %j without writing", async (args) => {
  await expect(operator(...args)).rejects.toThrow(/^Usage: operator status-/);
  expect(await audit()).toEqual([]);
});

it("reports a due refresh backlog and sweep lag, and refuses to record a repair until both clear", async () => {
  const request = await delivered();
  expect(await health()).toMatchObject({ healthy: true, dueRefreshes: 0, suspensions: [] });

  const row = await db().prepare("SELECT repository_id, issue_id FROM support_request WHERE id = ?").bind(request.id)
    .first<{ repository_id: number; issue_id: number }>();
  await requestStatusRefresh(db(), row!.repository_id, row!.issue_id, now);
  advance(SWEEP + 3 * MINUTE);
  const behind = await health();
  expect(behind).toMatchObject({ healthy: false, dueRefreshes: 1 });
  expect(behind.repositories.map((repository) => [repository.repositoryId, repository.withinInterval])).toEqual([[42, false], [77, false]]);
  const window = [iso(START), iso(now - MINUTE), "operator-1"] as const;
  await expect(operator("status-repair", ...window)).rejects.toThrow("Status not yet repaired: 1 due refreshes, 2 repositories behind");
  expect(await audit()).toEqual([]);

  await tick();
  expect(await health()).toMatchObject({ healthy: true, dueRefreshes: 0 });
  expect(await operator("status-repair", ...window)).toBe("Recorded status repair for 2 repositories");
  expect(await audit()).toEqual([{ id: expect.any(String), actor: "operator-1", action: "repair", window_start: START,
    window_end: now - MINUTE, repositories: 2, due_refreshes: 0, suspended_repositories: "[]", occurred_at: now }]);
});

it("lists suspensions as unacknowledged until a recorded repair acknowledges them", async () => {
  await delivered();
  await Effect.runPromise(suspendRepository(db(), 77, "public", now).pipe(Effect.provide(Logger.layer([]))));
  advance(MINUTE);
  await tick();
  expect(await health()).toMatchObject({ healthy: false, suspensions: [{ repositoryId: 77, reason: "public", acknowledged: false }] });

  await operator("status-repair", iso(START), iso(now), "operator-1");
  expect(await health()).toMatchObject({ healthy: true, suspensions: [{ repositoryId: 77, reason: "public", acknowledged: true }] });
  expect((await audit())[0]).toMatchObject({ suspended_repositories: "[77]" });

  // Still public: every sweep of it fails verification and never completes, yet a repair can be recorded.
  github.update(77, { private: false });
  advance(SWEEP);
  await tick();
  advance(SWEEP);
  await tick();
  const unsafe = await health();
  expect(unsafe.repositories.find((repository) => repository.repositoryId === 77)).toMatchObject({ suspended: true, withinInterval: false });
  expect(unsafe).toMatchObject({ healthy: true, dueRefreshes: 0 });
  expect(await operator("status-repair", iso(START), iso(now), "operator-1")).toBe("Recorded status repair for 2 repositories");

  // A later suspension of the same repository needs a new acknowledgement.
  await db().prepare("UPDATE repository_state SET suspended_reason = NULL, suspended_at = NULL WHERE repository_id = 77").run();
  advance(MINUTE);
  await Effect.runPromise(suspendRepository(db(), 77, "archived", now).pipe(Effect.provide(Logger.layer([]))));
  expect(await health()).toMatchObject({ healthy: false, suspensions: [{ repositoryId: 77, reason: "archived", acknowledged: false }] });
});
