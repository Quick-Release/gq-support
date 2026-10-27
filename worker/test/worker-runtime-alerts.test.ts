import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { WorkerEnvironment, WorkerExecutionContext, fromExecutionContext } from "alchemy/Cloudflare/Workers/WorkerRuntime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { localStage } from "./local-d1.ts";

const state = vi.hoisted(() => ({
  declaration: undefined as unknown,
  missing: false,
  main: undefined as D1Database | undefined, ledger: undefined as D1Database | undefined,
  tick: undefined as Effect.Effect<void> | undefined,
  request: undefined as Effect.Effect<Response> | undefined,
  digest: undefined as Effect.Effect<CryptoKey | null> | undefined,
  phases: undefined as Effect.Effect<void> | undefined,
  delivery: undefined as Effect.Effect<void> | undefined,
}));
vi.mock("../src/support-db.ts", async () => {
  const E = await import("effect/Effect");
  return { SupportDB: E.succeed("main"), SupportLedger: E.succeed("ledger") };
});
vi.mock("alchemy/Cloudflare", async (original) => {
  const actual = await original<typeof import("alchemy/Cloudflare")>();
  const E = await import("effect/Effect");
  const L = await import("effect/Layer");
  return { ...actual,
    Worker: (_name: string, config: unknown, handler: Effect.Effect<unknown>) => { state.declaration = config; return handler; },
    D1: { ...actual.D1, QueryDatabaseBinding: L.empty,
      QueryDatabase: (name: string) => E.succeed({ raw: E.sync(() => {
        const db = name === "main" ? state.main : state.ledger;
        if (!db && !state.missing) throw new Error("binding unavailable");
        return db;
      }) }) },
    Workers: { ...actual.Workers, CronEventSourceLive: L.empty,
      cron: (_pattern: string, handler: (controller: { scheduledTime: number }) => Effect.Effect<void>) => E.sync(() => { state.tick = handler({ scheduledTime: 120_000 }); }) },
  };
});
vi.mock("../src/cleanup.ts", async (original) => ({ ...await original<object>(),
  digestKey: () => Effect.runPromise(state.digest ?? Effect.succeed(null)),
}));
vi.mock("../src/delivery.ts", async (original) => ({ ...await original<object>(),
  sweepDelivery: () => state.delivery ?? Effect.void,
}));
vi.mock("../src/scheduled.ts", () => ({ scheduledTick: (options: { observePhase: (phase: string, outcome: string) => Effect.Effect<void> }) => state.phases ?? Effect.gen(function* () {
  for (const phase of ["delivery", "cleanup", "refresh", "sweep"]) yield* options.observePhase(phase, "ok");
}) }));
vi.mock("../src/worker-http.ts", () => ({ handleWorkerRequest: () => state.request ?? Effect.succeed(new Response(null, { status: 202 })) }));
vi.mock("../src/github-gateway.ts", async (original) => ({ ...await original<object>(),
  GitHubGateway: { live: () => Layer.empty }, GitHubReader: { live: () => Layer.empty },
}));

let stage: Awaited<ReturnType<typeof localStage<"main" | "ledger">>>;
const pending: Promise<unknown>[] = [];
beforeEach(async () => {
  vi.resetModules();
  stage = await localStage(["main", "ledger"]);
  state.main = stage.databases.main; state.ledger = stage.databases.ledger;
  state.missing = false; state.digest = undefined; state.request = undefined; state.delivery = undefined; state.phases = undefined;
  pending.length = 0;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "synthetic");
  vi.stubEnv("GITHUB_APP_SLUG", "getquick-support-staging");
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.allSettled(pending); await stage.dispose(); vi.unstubAllEnvs(); });
const env = {
  SUPPORT_RELEASE_STAGE: "staging", SUPPORT_RELEASE_CANDIDATE: "a".repeat(40),
  GITHUB_APP_PRIVATE_KEY: "synthetic", DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_RELEASE: "a".repeat(40),
  DISCORD_ALERT_WEBHOOK_URL: `https://discord.com/api/webhooks/123456789012345678/${"fake_".repeat(14)}`,
};
const load = async () => {
  const module = await import("../src/worker.ts");
  // The registration double returns the real handler Effect instead of provisioning.
  return await Effect.runPromise(module.default as Effect.Effect<unknown>) as { fetch: Effect.Effect<unknown, unknown, WorkerEnvironment | WorkerExecutionContext | HttpServerRequest.HttpServerRequest> };
};
const request = async (rejectBackground = false) => {
  const handler = await load();
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); if (rejectBackground) throw new Error("queue unavailable"); } } as ExecutionContext;
  return Effect.runPromiseExit(handler.fetch.pipe(
    Effect.provideService(WorkerEnvironment, env),
    Effect.provideService(WorkerExecutionContext, fromExecutionContext(ctx)),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("https://support.invalid/v1/requests", { method: "POST" }))),
  ));
};
const rows = async () => (await stage.databases.ledger.prepare("SELECT signal, count FROM discord_alert ORDER BY signal").all()).results;

it("captures tick setup failure before scheduled phases without recursively alerting drain failure", async () => {
  state.digest = Effect.die("private key setup error");
  await load();
  // Block transport locally; never call Discord from this wiring test.
  await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(await rows()).toEqual([{ signal: "tick_failed", count: 1 }]);
});

it("captures an outer delivery wake failure after an accepted response", async () => {
  state.delivery = Effect.die("private delivery error");
  const result = await request();
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.value).toMatchObject({ status: 202 });
  await Promise.all(pending);
  expect(await rows()).toEqual([{ signal: "delivery_sweep_failed", count: 1 }]);
});

it("finalizes thrown request handler collection without replacing its failure", async () => {
  state.request = Effect.die("private handler error");
  const result = await request();
  expect(result._tag).toBe("Failure");
  await Promise.all(pending);
  expect(await rows()).toEqual([{ signal: "request_handler_failed", count: 1 }]);
});


it("does not duplicate existing inner phase failure observations", async () => {
  state.phases = Effect.logError("Support cleanup sweep failed");
  await load();
  await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(await rows()).toEqual([{ signal: "cleanup_sweep_failed", count: 1 }]);
});

it("keeps drain outages logs-only and cannot recursively alert its broken route", async () => {
  await load();
  await stage.databases.ledger.prepare("DROP TABLE discord_alert_control").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(await rows()).toEqual([]);
});

it("preserves accepted response when background registration throws", async () => {
  const result = await request(true);
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.value).toMatchObject({ status: 202 });
  await Promise.allSettled(pending);
});

it("leaves unknown pre-binding failure logs-only without a reacquisition loop", async () => {
  state.ledger = undefined;
  expect((await request())._tag).toBe("Failure");
  expect(pending).toEqual([]);
  expect(await rows()).toEqual([]);
});


it("preserves containment 503 for absent raw bindings without attempting persistence", async () => {
  state.missing = true;
  state.ledger = undefined;
  const result = await request();
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.value).toMatchObject({ status: 503 });
  expect(pending).toEqual([]);
  expect(await rows()).toEqual([]);
});

it("records actual callback scheduled minute and failed setup without inventing phase health", async () => {
  const canary = `gqcanary_${crypto.randomUUID()}`;
  state.digest = Effect.die(canary);
  await load();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  const rows = (await stage.databases.ledger.prepare("SELECT * FROM cron_progress").all()).results;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ minute: 120_000, attempt: 1, candidate: "a".repeat(40), stage: "staging", outcome: "failed",
    delivery: "not_run", cleanup: "not_run", refresh: "not_run", sweep: "not_run", drain: "not_run" });
  expect(rows[0]!.started).toBeGreaterThan(120_000);
  expect(rows[0]!.terminal).toBeGreaterThanOrEqual(rows[0]!.started as number);
  expect(JSON.stringify(rows)).not.toContain(canary);
});

it("bounds a hung start write and still runs support without manufacturing terminal", async () => {
  vi.spyOn(await import("../src/cron-progress.ts"), "startProgress").mockImplementation(() => new Promise(() => {}));
  let ran = false;
  state.phases = Effect.sync(() => { ran = true; });
  await load();
  await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(ran).toBe(true);
  expect((await stage.databases.ledger.prepare("SELECT * FROM cron_progress").all()).results).toEqual([]);
});
it("bounds a hung terminal write and keeps progress incomplete", async () => {
  vi.spyOn(await import("../src/cron-progress.ts"), "writeProgress").mockImplementation(() => new Promise(() => {}));
  await load();
  await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(await stage.databases.ledger.prepare("SELECT terminal FROM cron_progress").first()).toEqual({ terminal: null });
});
it("does not terminalize cancellation before noncooperative finalizers settle", async () => {
  let began!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const finalizer = new Promise<void>(resolve => { finish = resolve; });
  state.phases = Effect.sync(began).pipe(Effect.andThen(Effect.never), Effect.onExit(() => Effect.promise(() => finalizer)));
  await load();
  const fiber = Effect.runFork(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  await started;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  expect(await stage.databases.ledger.prepare("SELECT terminal FROM cron_progress").first()).toEqual({ terminal: null });
  finish();
  await interrupted;
  expect(await stage.databases.ledger.prepare("SELECT outcome FROM cron_progress").first()).toEqual({ outcome: "interrupted" });
});
it("leaves absent public release identity unknown while support still runs", async () => {
  let ran = false;
  state.phases = Effect.sync(() => { ran = true; });
  await load();
  await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, { ...env, SUPPORT_RELEASE_CANDIDATE: undefined })));
  expect(ran).toBe(true);
  expect((await stage.databases.ledger.prepare("SELECT * FROM cron_progress").all()).results).toEqual([]);
});

it("never resumes cancelled support after interrupting a hung start observation", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  vi.spyOn(await import("../src/cron-progress.ts"), "startProgress").mockImplementation(() => { began(); return new Promise(() => {}); });
  let ran = false;
  state.phases = Effect.sync(() => { ran = true; });
  await load();
  const fiber = Effect.runFork(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  await started;
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(ran).toBe(false);
});

it("keeps notification failure separate from successful support phases", async () => {
  await load();
  await stage.databases.ledger.prepare("DROP TABLE discord_alert_control").run();
  await Effect.runPromise(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  expect(await stage.databases.ledger.prepare("SELECT delivery, cleanup, refresh, sweep, drain, outcome FROM cron_progress").first()).toEqual({
    delivery: "ok", cleanup: "ok", refresh: "ok", sweep: "ok", drain: "failed", outcome: "settled",
  });
});
it("awaits independent notification cleanup before recording interrupted terminal", async () => {
  let began!: () => void, finish!: (outcome: "failed") => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const draining = new Promise<"failed">(resolve => { finish = resolve; });
  vi.spyOn(await import("../src/discord-alerts.ts"), "drainAlerts").mockImplementation(() => { began(); return draining; });
  await load();
  const fiber = Effect.runFork(state.tick!.pipe(Effect.provideService(WorkerEnvironment, env)));
  await started;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  expect(await stage.databases.ledger.prepare("SELECT terminal FROM cron_progress").first()).toEqual({ terminal: null });
  finish("failed");
  await interrupted;
  expect(await stage.databases.ledger.prepare("SELECT outcome, drain FROM cron_progress").first()).toEqual({ outcome: "interrupted", drain: "failed" });
});

it("does not grant declaration release authority to ambient environment values", async () => {
  vi.stubEnv("SUPPORT_RELEASE_CANDIDATE", "e".repeat(40));
  vi.stubEnv("SUPPORT_RELEASE_STAGE", "prod");
  await load();
  expect(state.declaration).toMatchObject({ env: { SUPPORT_RELEASE_CANDIDATE: "unknown", SUPPORT_RELEASE_STAGE: "unknown" } });
});
