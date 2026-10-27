import type { D1PreparedStatement } from "@cloudflare/workers-types";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundedWork, observeRuntime } from "../src/runtime-alerts.ts";
import { drainAlerts, type AlertConfig } from "../src/discord-alerts.ts";
import { contained } from "../src/maintenance.ts";
import { localStage } from "./local-d1.ts";

const config: AlertConfig = { enabled: true, stage: "staging", release: "a".repeat(40),
  webhook: `https://discord.com/api/webhooks/123456789012345678/${"fake_".repeat(14)}` };
let stage: Awaited<ReturnType<typeof localStage<"main" | "ledger">>>;
beforeEach(async () => { stage = await localStage(["main", "ledger"]); });
afterEach(async () => { await stage.dispose(); });
const rows = async () => (await stage.databases.ledger.prepare("SELECT signal, count FROM discord_alert ORDER BY signal").all()).results;
const wrap = <A, E>(work: Effect.Effect<A, E>, failure: "Support scheduled tick failed" | "Support delivery sweep failed" | "Support request handler failed", setting = config,
  background?: (work: Effect.Effect<void>) => Effect.Effect<void>) =>
  observeRuntime(work, stage.databases.main, stage.databases.ledger, setting, failure, background);

it.each([
  ["Support scheduled tick failed", "tick_failed"],
  ["Support delivery sweep failed", "delivery_sweep_failed"],
  ["Support request handler failed", "request_handler_failed"],
] as const)("captures %s outside inner work, preserving the original cause and private-data boundary", async (name, signal) => {
  const error = new Error("private-reporter-url-body-token-@everyone");
  const result = await Effect.runPromiseExit(wrap(Effect.die(error), name));
  expect(result).toEqual(await Effect.runPromiseExit(Effect.die(error)));
  expect(await rows()).toEqual([{ signal, count: 1 }]);
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  await drainAlerts(stage.databases.main, stage.databases.ledger, config, request);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![1]!.body).toContain(signal);
  expect(request.mock.calls[0]![1]!.body).not.toContain(error.message);
});

it("observes timeout at actual work, runs cancellation finalizers, and never resumes it", async () => {
  const events: string[] = [];
  const work = Effect.never.pipe(Effect.onExit(() => Effect.sync(() => { events.push("cancelled"); })));
  await Effect.runPromise(wrap(boundedWork(contained(stage.databases.main, stage.databases.ledger, work, undefined), 30, "Support delivery sweep failed"), "Support delivery sweep failed"));
  expect(events).toEqual(["cancelled"]);
  expect((await stage.databases.ledger.prepare("SELECT * FROM maintenance_operation").all()).results).toHaveLength(1);
  expect(await rows()).toEqual([{ signal: "delivery_sweep_failed", count: 1 }]);
});

it("persists existing inner failures once without manufacturing an outer failure", async () => {
  await Effect.runPromise(wrap(Effect.logError("Support cleanup sweep failed"), "Support scheduled tick failed"));
  expect(await rows()).toEqual([{ signal: "cleanup_sweep_failed", count: 1 }]);
});

it("registers request persistence on failure and cancellation without awaiting notification I/O", async () => {
  const pending: Effect.Effect<void>[] = [];
  const background = (work: Effect.Effect<void>) => Effect.sync(() => { pending.push(work); });
  const result = await Effect.runPromiseExit(wrap(Effect.fail("original"), "Support request handler failed", config, background));
  expect(Exit.isFailure(result)).toBe(true);
  expect(await rows()).toEqual([]);
  const fiber = Effect.runFork(wrap(Effect.never, "Support request handler failed", config, background));
  await Effect.runPromise(Effect.yieldNow);
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(pending).toHaveLength(2);
  await Effect.runPromise(Effect.all(pending));
  expect(await rows()).toEqual([{ signal: "request_handler_failed", count: 2 }]);
});

it("alert-store failure leaves no support admission and preserves accepted response and original error", async () => {
  await stage.databases.ledger.prepare("DROP TABLE discord_alert").run();
  const response = new Response(null, { status: 202 });
  expect(await Effect.runPromise(wrap(Effect.logError("Support cleanup sweep failed").pipe(Effect.as(response)), "Support scheduled tick failed"))).toBe(response);
  const failure = Effect.fail("original");
  expect(await Effect.runPromiseExit(wrap(failure, "Support request handler failed"))).toEqual(await Effect.runPromiseExit(failure));
  expect((await stage.databases.ledger.prepare("SELECT * FROM maintenance_operation").all()).results).toEqual([]);
});

it("disabled alerts neither persist nor touch either database", async () => {
  const db = { prepare: vi.fn(() => { throw new Error("unexpected DB access"); }),
    batch: vi.fn(() => { throw new Error("unexpected DB access"); }) };
  await Effect.runPromiseExit(observeRuntime(Effect.fail("original"), db, db, { ...config, enabled: false }, "Support scheduled tick failed"));
  expect(db.prepare).not.toHaveBeenCalled();
  expect(db.batch).not.toHaveBeenCalled();
});

it("does not enter denied support work or turn containment into a failure signal", async () => {
  await stage.databases.ledger.prepare("UPDATE maintenance_control SET mode = 'held'").run();
  const work = vi.fn();
  await Effect.runPromise(wrap(contained(stage.databases.main, stage.databases.ledger, Effect.sync(work), undefined), "Support scheduled tick failed"));
  expect(work).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
});

it("bounds hung persistence even during uninterruptible exit finalization", async () => {
  const real = stage.databases.ledger.prepare("SELECT 1");
  const statement: D1PreparedStatement = {
    bind: () => statement, run: () => new Promise<never>(() => {}),
    first: real.first.bind(real), all: real.all.bind(real), raw: real.raw.bind(real),
  };
  const ledger = { prepare: vi.fn(() => statement), batch: stage.databases.ledger.batch };
  const main = { prepare: vi.fn(() => { throw new Error("unexpected SupportDB access"); }), batch: stage.databases.main.batch };
  expect(await Effect.runPromise(observeRuntime(Effect.logError("Support cleanup sweep failed").pipe(Effect.as(202)),
    main, ledger, config, "Support scheduled tick failed"))).toBe(202);
  expect(ledger.prepare).toHaveBeenCalledTimes(1);
  expect(main.prepare).not.toHaveBeenCalled();
});


it("observes only the unexpected application 503 catch, preserving its response", async () => {
  await stage.databases.main.prepare("DROP TABLE replay").run();
  const work = handleWorkerRequest(HttpServerRequest.fromWeb(new Request("https://support.invalid/v1/requests")),
    Effect.succeed(stage.databases.main), [], createGitHubWebhookReceiver({ appId: "123" }), () => {});
  const response = await Effect.runPromise(wrap(work, "Support request handler failed"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "service_unavailable", message: "Service unavailable." });
  expect(await rows()).toEqual([{ signal: "request_handler_failed", count: 1 }]);
});

it("does not alert on ordinary validation or unknown endpoint responses", async () => {
  for (const path of ["/v1/requests", "/unknown"]) {
    const work = handleWorkerRequest(HttpServerRequest.fromWeb(new Request(`https://support.invalid${path}`)),
      Effect.succeed(stage.databases.main), [], createGitHubWebhookReceiver({ appId: "123" }), () => {});
    const response = await Effect.runPromise(wrap(work, "Support request handler failed"));
    expect([403, 404]).toContain(response.status);
  }
  expect(await rows()).toEqual([]);
});
