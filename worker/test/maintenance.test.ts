import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { contained, admitOperation, finishOperation } from "../src/maintenance.ts";
import { executeOperator } from "../src/maintenance-operator.ts";
import type { OperatorOptions } from "../src/operator.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { CLIENT_ID, SLUG, makeFakeGitHub } from "./fake-github.ts";
import { localStage } from "./local-d1.ts";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
beforeEach(async () => { stage = await localStage(["shared", "ledger"]); });
afterEach(async () => { await stage.dispose(); });
const main = () => stage.databases.shared;
const ledger = () => stage.databases.ledger;
const options = (): OperatorOptions => ({
  query: async (sql, params) => (await main().prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
  ledger: async (sql, params) => (await ledger().prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
  mappings: [], recordRevocation: async () => {},
});
const operator = (...args: string[]) => executeOperator(args, options());
const operations = () => ledger().prepare("SELECT * FROM maintenance_operation").all();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([]))));

it("serializes ingress and background admission with containment, without expiring a live owner", async () => {
  const started = deferred(), finish = deferred();
  const active = run(contained(main(), ledger(), Effect.promise(async () => {
    started.resolve(); await finish.promise; return "accepted";
  }), "unavailable"));
  await started.promise;
  await operator("maintenance-enter", "operator-1");
  expect(await run(contained(main(), ledger(), Effect.die("must not execute"), "unavailable"))).toBe("unavailable");
  await expect(operator("restore-recorded", "operator-1", "time-travel-restore")).rejects.toThrow("exclusive drain");
  expect((await operations()).results).toHaveLength(1);
  finish.resolve();
  expect(await active).toBe("accepted");
  expect((await operations()).results).toHaveLength(0);
  await operator("maintenance-mirror", "operator-1");
  await operator("restore-recorded", "operator-1", "time-travel-restore");
});

it("blocks restored enabled state and requires exclusive replay and generation-bound authorized release", async () => {
  await expect(operator("restore-recorded", "operator-1", "time-travel-restore")).rejects.toThrow("exclusive drain");
  await operator("maintenance-enter", "operator-1");
  // Models the old delivery bit coming back with SupportDB; ledger is untouched.
  await main().prepare("UPDATE delivery_control SET enabled = 1").run();
  await operator("restore-recorded", "operator-1", "time-travel-restore");
  await expect(operator("maintenance-release", "operator-1", "1")).rejects.toThrow("epoch");
  await expect(operator("resume", "any")).rejects.toThrow("contained");
  await expect(operator("maintenance-mirror", "operator-1")).rejects.toThrow("exclusive drain");
  await operator("maintenance-replay", "operator-1");
  expect(await main().prepare("SELECT enabled FROM delivery_control").first("enabled")).toBe(0);
  expect(await run(contained(main(), ledger(), Effect.succeed("served"), "unavailable"))).toBe("unavailable");
  await expect(operator("maintenance-release", "operator-1", "0")).rejects.toThrow("generation");
  await operator("maintenance-release", "operator-1", "1");
  expect(await run(contained(main(), ledger(), Effect.succeed("served"), "unavailable"))).toBe("served");
  expect(await main().prepare("SELECT enabled FROM delivery_control").first("enabled")).toBe(0);
});

it("leaves an interrupted operation obstructing restore, regardless of its age", async () => {
  const started = deferred();
  const fiber = Effect.runFork(contained(main(), ledger(), Effect.promise(async () => { started.resolve(); }).pipe(
    Effect.andThen(Effect.never)), undefined));
  await started.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  await ledger().prepare("UPDATE maintenance_operation SET started_at = 0").run();
  await operator("maintenance-enter", "operator-1");
  await expect(operator("maintenance-replay", "operator-1")).rejects.toThrow("exclusive drain");
});

it("Cron phases do not touch SupportDB while contained, including cleanup mirroring", async () => {
  await operator("maintenance-enter", "operator-1");
  const poison = { prepare: () => { throw new Error("must not touch main"); }, batch: main().batch.bind(main()) };
  // No gateway services are needed: all phases must be denied before use.
  const github = makeFakeGitHub();
  await Effect.runPromise(scheduledTick({ db: poison, ledger: ledger(), mappings: [], botLogin: `${SLUG}[bot]` }).pipe(
    Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
    // The reader is never used. Supply its real adapter too for the type contract.
    Effect.provide(GitHubReader.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
    Effect.provide(Logger.layer([]))));
  expect(github.requests).toHaveLength(0);
});

it("denies provider dispatch after admission was closed during repository verification", async () => {
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  const authorize = Effect.promise(async () => { await operator("maintenance-enter", "operator-1"); });
  await expect(Effect.runPromise(Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    return yield* gateway.createIssue({ installationId: 7, repositoryId: 42 },
      { title: "Synthetic", body: "Synthetic", labels: [], assignees: [] }, authorize);
  }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem,
    ledger: ledger() }).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([]))))).rejects.toThrow();
  expect(github.requests.filter((r) => r.path.endsWith("/issues") && r.method === "POST")).toHaveLength(0);
});

it("a possibly completed provider write remains an obstruction after its caller finishes", async () => {
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  github.onCreate(() => new Response(null, { status: 502 }));
  await Effect.runPromise(Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    yield* gateway.createIssue({ installationId: 7, repositoryId: 42 },
      { title: "Synthetic", body: "Synthetic", labels: [], assignees: [] }).pipe(Effect.ignore);
  }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem,
    ledger: ledger() }).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([]))));
  expect(github.issues).toHaveLength(1);
  expect((await operations()).results).toMatchObject([{ kind: "provider", target: "7/42/POST/create" }]);
  await operator("maintenance-enter", "operator-1");
  await expect(operator("restore-recorded", "operator-1", "time-travel-restore")).rejects.toThrow("exclusive drain");
});

it("ledger loss fails closed and failed replay never permits release", async () => {
  const broken = { prepare: () => { throw new Error("unavailable"); }, batch: ledger().batch.bind(ledger()) };
  expect(await run(contained(main(), broken, Effect.die("must not run"), "unavailable"))).toBe("unavailable");
  await operator("maintenance-enter", "operator-1");
  await operator("restore-recorded", "operator-1", "time-travel-restore");
  await expect(executeOperator(["maintenance-replay", "operator-1"], { ...options(), query: async () => { throw new Error("main unavailable"); } })).rejects.toThrow("main unavailable");
  await expect(operator("maintenance-release", "operator-1", "1")).rejects.toThrow();
  expect((await operations()).results).toMatchObject([{ kind: "recovery" }]);
});

it("a denied admission cannot be turned into a provider write by an enabled main database", async () => {
  await operator("maintenance-enter", "operator-1");
  await main().prepare("UPDATE delivery_control SET enabled = 1").run();
  expect(await admitOperation(ledger(), "provider", "7/42")).toBeNull();
  // An absent ID cannot remove another registration.
  await finishOperation(ledger(), "unknown-id");
  expect((await operations()).results).toHaveLength(0);
});

it("ingress returns a retryable 503 without accessing restored records or consuming authentication", async () => {
  await operator("maintenance-enter", "operator-1");
  const work = handleWorkerRequest(HttpServerRequest.fromWeb(new Request("https://support.example/v1/erasures", { method: "POST" })),
    Effect.die("must not access restored credentials"), [], createGitHubWebhookReceiver({ appId: "123" }), () => {});
  const denied = Response.json({ code: "service_unavailable" }, { status: 503, headers: { "Retry-After": "60" } });
  const response = await run(contained(main(), ledger(), work, denied));
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(await response.json()).toEqual({ code: "service_unavailable" });
});

it("a local provider timeout and a later successful response do not establish remote drain", async () => {
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  const dispatched = deferred(), lateResponse = deferred();
  github.onCreate(async () => { dispatched.resolve(); await lateResponse.promise; return undefined; });
  await Effect.runPromise(Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    const fiber = yield* Effect.forkChild(gateway.createIssue({ installationId: 7, repositoryId: 42 },
      { title: "Synthetic", body: "Synthetic", labels: [], assignees: [] }).pipe(Effect.ignore));
    yield* Effect.promise(() => dispatched.promise);
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem,
    ledger: ledger() }).pipe(Layer.provide(github.layer))), Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))));
  await operator("maintenance-enter", "operator-1");
  expect((await operations()).results).toMatchObject([{ kind: "provider" }]);
  lateResponse.resolve();
  await expect(operator("maintenance-replay", "operator-1")).rejects.toThrow("exclusive drain");
  expect(github.issues).toHaveLength(1);
});

it("retires a completed synchronous provider write, allowing exclusive recovery", async () => {
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  await Effect.runPromise(Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    yield* gateway.createIssue({ installationId: 7, repositoryId: 42 },
      { title: "Synthetic", body: "Synthetic", labels: [], assignees: [] });
  }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem,
    ledger: ledger() }).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([]))));
  expect((await operations()).results).toHaveLength(0);
  await operator("maintenance-enter", "operator-1");
  await operator("maintenance-replay", "operator-1");
});

it.each([["status", "unknown-slot"], ["invalid-command"]])("retires CLI validation failure before mutation: %s", async (...args) => {
  await expect(operator(...args)).rejects.toThrow();
  expect((await operations()).results).toHaveLength(0);
  await operator("maintenance-enter", "operator-1");
  await operator("maintenance-mirror", "operator-1");
});

it("retains CLI ownership when a mutation may have completed before its response failed", async () => {
  const original = options();
  // The command is valid and attempts a write; losing its response is not proof
  // that the main database was left unchanged.
  const mapping = { slot: "synthetic/staging", client: "synthetic", project: "synthetic", environment: "staging", repositoryId: 42, defaultDeveloper: "operator-1" };
  await expect(executeOperator(["enroll", mapping.slot], {
    ...original, mappings: [mapping], query: async (sql, params) => {
      const rows = await original.query(sql, params);
      if (sql.startsWith("INSERT INTO enrollment_code")) throw new Error("lost write response");
      return rows;
    },
  })).rejects.toThrow("lost write response");
  expect((await operations()).results).toMatchObject([{ kind: "runtime" }]);
  await operator("maintenance-enter", "operator-1");
  await expect(operator("maintenance-mirror", "operator-1")).rejects.toThrow("exclusive drain");
});

it("retires a transferred-issue rejection without following the redirect or changing its state", async () => {
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  await expect(Effect.runPromise(Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    yield* gateway.createIssue({ installationId: 7, repositoryId: 42 },
      { title: "Synthetic", body: "Synthetic", labels: [], assignees: [] });
    const issue = github.issues[0]!;
    issue.movedTo = "https://api.github.com/repos/other/project/issues/99";
    yield* gateway.setIssueState({ installationId: 7, repositoryId: 42 }, issue.number, "closed");
  }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem,
    ledger: ledger() }).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([]))))).rejects.toThrow();
  expect(github.issues[0]!.state).toBe("open");
  expect(github.requests.filter((r) => r.method === "PATCH").map((r) => r.path)).toEqual([
    `/repos/Quick-Release/repo-42/issues/${github.issues[0]!.number}`,
  ]);
  expect((await operations()).results).toHaveLength(0);
  await operator("maintenance-enter", "operator-1");
  await operator("maintenance-mirror", "operator-1");
});
