import { notePhaseFailure } from "../src/phase-observation.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, expect, it, vi } from "vitest";
import { localStage } from "./local-d1.ts";
import { recordAlerts } from "../src/discord-alerts.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { scheduledTick } from "../src/scheduled.ts";

const events = vi.hoisted(() => [] as string[]);
const mode = vi.hoisted(() => ({ value: "timeout" }));
beforeEach(() => { events.length = 0; mode.value = "timeout"; });
vi.mock("../src/delivery.ts", () => ({ sweepDelivery: () => mode.value === "failure" ? Effect.die(`gqcanary_${crypto.randomUUID()}`) : mode.value === "caught" ? notePhaseFailure.pipe(Effect.andThen(Effect.logError("Support delivery requires review"))) : mode.value === "ok" ? Effect.void : Effect.sync(() => { events.push("delivery"); }).pipe(
  Effect.andThen(Effect.never), Effect.onExit(() => Effect.sync(() => { events.push("delivery cancelled"); }))) }));
vi.mock("../src/cleanup.ts", () => ({ sweepCleanup: () => mode.value !== "timeout" ? Effect.void : Effect.sync(() => { events.push("cleanup"); }).pipe(
  Effect.andThen(Effect.never), Effect.onExit(() => Effect.sync(() => { events.push("cleanup cancelled"); }))) }));
vi.mock("../src/status-refresh.ts", () => ({ refreshStatus: () => mode.value !== "timeout" ? Effect.void : Effect.sync(() => { events.push("refresh"); }).pipe(
  Effect.andThen(Effect.never), Effect.onExit(() => Effect.sync(() => { events.push("refresh cancelled"); }))) }));
vi.mock("../src/status-sweep.ts", () => ({ sweepStatus: () => mode.value !== "timeout" ? Effect.void : Effect.sync(() => { events.push("sweep"); }).pipe(
  Effect.andThen(Effect.never), Effect.onExit(() => Effect.sync(() => { events.push("sweep cancelled"); }))) }));

it("observes all four real scheduled deadlines once while preserving phase order and cancellation", async () => {
  const stage = await localStage(["main", "ledger"]);
  try {
    const services = Layer.mergeAll(GitHubGateway.live({ clientId: "synthetic", slug: "synthetic", privateKeyPem: "synthetic" }),
      GitHubReader.live({ clientId: "synthetic", slug: "synthetic", privateKeyPem: "synthetic" }));
    await Effect.runPromise(Effect.gen(function* () {
      const work = scheduledTick({ db: stage.databases.main, mappings: [], botLogin: "synthetic[bot]" }).pipe(Effect.provide(services));
      const fiber = yield* recordAlerts(work, stage.databases.main, stage.databases.ledger, {
        enabled: true, stage: "staging", release: "a".repeat(40),
        webhook: `https://discord.com/api/webhooks/123456789012345678/${"fake_".repeat(14)}`,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(57_000);
      expect(yield* Fiber.join(fiber)).toEqual({ delivery: "timed_out", cleanup: "timed_out", refresh: "timed_out", sweep: "timed_out" });
    }).pipe(Effect.provide(TestClock.layer())));
    expect(events).toEqual(["delivery", "delivery cancelled", "cleanup", "cleanup cancelled", "refresh", "refresh cancelled", "sweep", "sweep cancelled"]);
    expect((await stage.databases.ledger.prepare("SELECT signal, count FROM discord_alert ORDER BY signal").all()).results).toEqual([
      { signal: "cleanup_sweep_failed", count: 1 }, { signal: "delivery_sweep_failed", count: 1 },
      { signal: "refresh_failed", count: 1 }, { signal: "sweep_failed", count: 1 },
    ]);
  } finally { await stage.dispose(); }
});

it.each(["failure", "caught"])("retains %s and continues later phases", async (value) => {
  mode.value = value;
  const stage = await localStage(["main", "ledger"]);
  try {
    const result = await Effect.runPromise(scheduledTick({ db: stage.databases.main, mappings: [], botLogin: "synthetic" }) as Effect.Effect<unknown>);
    expect(result).toEqual({ delivery: "failed", cleanup: "ok", refresh: "ok", sweep: "ok" });
  } finally { await stage.dispose(); }
});
it("reports maintenance denial separately from success without starting phases", async () => {
  mode.value = "ok";
  const stage = await localStage(["main", "ledger"]);
  try {
    await stage.databases.ledger.prepare("UPDATE maintenance_control SET mode = 'held'").run();
    const result = await Effect.runPromise(scheduledTick({ db: stage.databases.main, ledger: stage.databases.ledger, mappings: [], botLogin: "synthetic" }) as Effect.Effect<unknown>);
    expect(result).toEqual({ delivery: "contained", cleanup: "contained", refresh: "contained", sweep: "contained" });
    expect(events).toEqual([]);
  } finally { await stage.dispose(); }
});
