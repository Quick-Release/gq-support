import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { discordDestinations } from "../src/notifications.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { SIGNALS } from "../src/signal-rules.ts";
import { untilAborted, type QueryDatabase } from "../src/storage.ts";
import { makeFakeDiscord, webhookUrl } from "./fake-discord.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

// The minute tick's phase bounds against real local D1 whose every roundtrip costs
// a fixed wall time, as a Worker far from its database pays, with GitHub's API slow too.
const START = Date.parse("2026-10-31T10:00:00Z");
const MINUTE = 60_000;
const mapping: RepositoryMapping = { slot: "sandbox/staging", client: "sandbox", project: "sandbox", environment: "staging",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const REQUESTS = "111111111111111111";
const INCIDENTS = "222222222222222222";
const RULE_READ = "SELECT subject, slot, detail FROM (";
const LEDGER_READ = "SELECT reference, payload FROM ledger_entry WHERE kind";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let discord: ReturnType<typeof makeFakeDiscord>;
let now: number;
/** Wall time each roundtrip of a statement costs, or the error it fails with. */
let roundtrip: (sql: string) => number | Error;
let githubLatency: number;
let ledgerAvailable: boolean;
/** When each roundtrip started, in wall time. */
let started: number[];
const pending = new Set<Promise<unknown>>();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  roundtrip = () => 0;
  githubLatency = 0;
  ledgerAvailable = true;
  started = [];
  stage = await localStage(["shared", "ledger"]);
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "sandbox" });
  discord = makeFakeDiscord();
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => {
  // Work already submitted to D1 cannot be withdrawn; it settles before the databases go.
  await Promise.allSettled(pending);
  await stage.dispose();
  vi.useRealTimers();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits past the cut-off work's in-flight roundtrips, then for whatever is still in flight. */
const quiet = async () => { await sleep(3_500); await Promise.allSettled(pending); };
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
/** A D1 binding whose every roundtrip (first, all, run, raw or batch) waits its cost before reaching the database. */
const distant = (inner: D1Database): QueryDatabase => {
  const hop = <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    started.push(performance.now());
    const cost = roundtrip(sql);
    const result = (async () => {
      await sleep(cost instanceof Error ? 0 : cost);
      if (cost instanceof Error) throw cost;
      return run();
    })();
    pending.add(result);
    void result.catch(() => undefined).finally(() => pending.delete(result));
    return result;
  };
  const statement = (prepared: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(prepared, {
    get(target, key) {
      if (key === "inner") return target;
      if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql);
      if (key === "first" || key === "all" || key === "run" || key === "raw") {
        return (...args: unknown[]) => hop(sql, () => (target[key] as (...args: unknown[]) => Promise<unknown>)(...args));
      }
      return target[key as keyof D1PreparedStatement];
    },
  });
  return {
    prepare: (sql) => statement(inner.prepare(sql), sql),
    batch: (statements) => hop("BATCH", () => inner.batch(statements.map((each) =>
      (each as D1PreparedStatement & { inner?: D1PreparedStatement }).inner ?? each))),
  };
};
const unavailable = { prepare: () => { throw new Error("ledger unavailable"); },
  batch: () => Promise.reject(new Error("ledger unavailable")) } as unknown as QueryDatabase;
/** GitHub's API answering after a fixed, interruptible latency, as over a real network. */
const slowGitHub = () => Layer.effect(HttpClient.HttpClient, Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return HttpClient.make((request) => Effect.sleep(githubLatency).pipe(Effect.andThen(client.execute(request))));
})).pipe(Layer.provide(github.layer));
/** The minute Cron's work, with every D1 roundtrip at its configured cost. */
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: distant(stage.databases.shared),
    ledger: ledgerAvailable ? distant(stage.databases.ledger) : unavailable, mappings: [mapping], botLogin: `${SLUG}[bot]`,
    now: () => now, random: () => 0, notifications: { destinations: discordDestinations(webhookUrl(REQUESTS), webhookUrl(INCIDENTS)), fetch: discord.fetch } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(slowGitHub()))),
    Effect.provide(Logger.layer([]))));
};
const query = (db: D1Database) => async (sql: string, parameters: readonly (string | number)[]) =>
  (await db.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
const operator = async (command: string) => JSON.parse(await runOperator([command], { mappings: [mapping], now,
  recordRevocation: async () => {}, query: query(stage.databases.shared), ledger: query(stage.databases.ledger) })) as Record<string, unknown>;
const incidents = async () => (await operator("incidents")).incidents as { category: string }[];
/** How each scheduler phase ended in the latest tick's hour, by outcome. */
const phases = async () => Object.fromEntries(((await operator("health")).measured as { metric: string; outcome: string; count: number }[])
  .filter((row) => row.metric === "scheduler").map((row) => [row.outcome, row.count]));
/** A revocation only the main database holds: re-enrollment without the ledger, as when its ledger write is lost. */
const unmirroredRevocation = async () => {
  const clients = harness(stage.databases.shared, [mapping]);
  await clients.enroll(mapping.slot, "installation-a");
  await clients.enroll(mapping.slot, "installation-a");
};
const ledgerRevocations = async () => (await stage.databases.ledger.prepare("SELECT reference FROM ledger_entry WHERE kind = 'revocation'")
  .all()).results.length;
/** The suppression ledger stops being reachable while a revocation still has to be mirrored, until it is 16 minutes behind. */
const ledgerBehind = async () => {
  await tick();
  ledgerAvailable = false;
  await unmirroredRevocation();
  advance(16 * MINUTE);
};

it("observes every rule and notifies within the signal phase at 130 ms D1 roundtrips with GitHub at 300 ms", async () => {
  await ledgerBehind();
  roundtrip = () => 130;
  githubLatency = 300;
  await tick();
  // The suppression ledger's rule is the last of the eleven; it is observed and notified in the same tick.
  expect(await incidents()).toEqual([expect.objectContaining({ category: "suppression_ledger_behind" })]);
  expect(discord.messages(INCIDENTS)).toEqual([expect.objectContaining({ content: expect.stringContaining("suppression_ledger_behind") })]);
  expect(await phases()).toMatchObject({ signals_completed: 2 });
}, 30_000);

it("still observes every other rule when one rule's read fails", async () => {
  await ledgerBehind();
  roundtrip = (sql) => sql.startsWith(RULE_READ) && !sql.includes("restore_state") ? new Error("D1 overloaded") : 0;
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "suppression_ledger_behind" })]);
});

it("still observes later rules when one rule cannot build its query", async () => {
  await ledgerBehind();
  const rule = vi.spyOn(SIGNALS.delivery_unknown, "affected").mockImplementation(() => { throw new Error("rule unavailable"); });
  try {
    await tick();
    expect(await incidents()).toEqual([expect.objectContaining({ category: "suppression_ledger_behind" })]);
  } finally { rule.mockRestore(); }
});

it("starts no signal read or incident write once the signal phase is cut off, and the next tick observes again", async () => {
  await ledgerBehind();
  // Every rule's read outlasts the phase bound.
  roundtrip = (sql) => sql.startsWith(RULE_READ) ? 3_000 : 0;
  await tick();
  const ended = performance.now();
  await quiet();
  expect(started.filter((at) => at > ended)).toEqual([]);
  expect(await incidents()).toEqual([]);
  expect(await phases()).toMatchObject({ signals_timed_out: 1 });

  roundtrip = () => 0;
  advance(MINUTE);
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "suppression_ledger_behind" })]);
}, 30_000);

it("completes a full ledger mirror within the cleanup phase at 170 ms D1 roundtrips", async () => {
  await unmirroredRevocation();
  roundtrip = () => 170;
  githubLatency = 300;
  // The first pass mirrors every row.
  await tick();
  expect(await ledgerRevocations()).toBe(1);
  expect(await phases()).toMatchObject({ cleanup_completed: 1 });
  expect(await phases()).not.toHaveProperty("cleanup_timed_out");
}, 30_000);

it("completes an idle cleanup pass within its bound at 320 ms D1 roundtrips", async () => {
  // A stage with nothing to clean up, mirrored once, as staging is on most minutes.
  await tick();
  advance(MINUTE);
  roundtrip = () => 320;
  await tick();
  expect(await phases()).toMatchObject({ cleanup_completed: 2 });
  expect(await phases()).not.toHaveProperty("cleanup_timed_out");
}, 60_000);

it("starts no mirror read or write once the cleanup phase is cut off, and the next tick mirrors in full", async () => {
  await unmirroredRevocation();
  // The ledger's reads outlast the phase bound; nothing is recorded, and the mirror is not marked done.
  roundtrip = (sql) => sql.startsWith(LEDGER_READ) ? 7_000 : 0;
  await tick();
  const ended = performance.now();
  await quiet();
  expect(started.filter((at) => at > ended)).toEqual([]);
  expect(await ledgerRevocations()).toBe(0);
  expect(await phases()).toMatchObject({ cleanup_timed_out: 1 });

  roundtrip = () => 0;
  advance(MINUTE);
  await tick();
  expect(await ledgerRevocations()).toBe(1);
}, 30_000);


it.each(["first", "all", "run", "raw"] as const)("refuses a prepared statement's %s call after cancellation", async (method) => {
  const controller = new AbortController();
  const db = untilAborted(distant(stage.databases.shared), controller.signal);
  const prepared = db.prepare("SELECT ? AS value").bind(1);
  controller.abort();
  expect(() => Reflect.apply(prepared[method], prepared, [])).toThrow(/aborted/i);
  expect(started).toEqual([]);
});

it("binds and batches wrapped statements while active, and refuses binding after cancellation", async () => {
  const controller = new AbortController();
  const db = untilAborted(distant(stage.databases.shared), controller.signal);
  const prepared = db.prepare("SELECT ? AS value");
  expect((await db.batch([prepared.bind(42)]))[0]!.results).toEqual([{ value: 42 }]);
  controller.abort();
  expect(() => prepared.bind(1)).toThrow(/aborted/i);
  expect(() => db.batch([prepared])).toThrow(/aborted/i);
});

it("still records a later rule when one incident write fails", async () => {
  await ledgerBehind();
  github.delivered(500, now);
  let rulesStarted = false;
  let failedWrite = false;
  roundtrip = (sql) => {
    if (sql.startsWith(RULE_READ)) rulesStarted = true;
    if (sql === "BATCH" && rulesStarted && !failedWrite) {
      failedWrite = true;
      return new Error("incident write unavailable");
    }
    return 0;
  };
  await tick();
  expect(failedWrite).toBe(true);
  expect(await incidents()).toEqual([expect.objectContaining({ category: "suppression_ledger_behind" })]);
});

it("starts no webhook log write after the scan is cut off, then retries next tick", async () => {
  github.delivered(500, now);
  roundtrip = (sql) => sql.startsWith("SELECT delivered_through, guids FROM webhook_delivery_scan") ? 1_500 : 0;
  await tick();
  await quiet();
  expect(((await operator("health")).measured as { metric: string }[]).filter((row) => row.metric === "webhook")).toEqual([]);
  roundtrip = () => 0;
  advance(MINUTE);
  await tick();
  expect(await incidents()).toEqual([expect.objectContaining({ category: "webhook_failed" })]);
}, 15_000);
