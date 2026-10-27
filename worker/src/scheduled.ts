import { PhaseFailure } from "./phase-observation.ts";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations } from "effect/References";
import * as Option from "effect/Option";
import type { PhaseOutcome } from "./cron-progress.ts";
import { contained } from "./maintenance.ts";
import * as Effect from "effect/Effect";
import { sweepDelivery, type DeliveryOptions } from "./delivery.ts";
import { sweepCleanup } from "./cleanup.ts";
import type { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { sweepStatus, type SweepConfig } from "./status-sweep.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";

export interface ScheduledOptions extends DeliveryOptions {
  /** The title-digest key for erasure redaction (src/cleanup.ts). */
  readonly digestKey?: CryptoKey | null;
  readonly sweep?: Partial<SweepConfig>;
  readonly refresh?: Partial<RefreshConfig>;
  readonly observePhase?: (phase: "delivery" | "cleanup" | "refresh" | "sweep", outcome: PhaseOutcome) => Effect.Effect<void>;
}

/**
 * The minute Cron's work, in priority order: delivery and reconciliation
 * first, then erasure and retention cleanup, then due refreshes and status
 * sweeps within their time bounds. A failure in one phase never skips the others.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<Record<"delivery" | "cleanup" | "refresh" | "sweep", PhaseOutcome>, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  const results: Record<"delivery" | "cleanup" | "refresh" | "sweep", PhaseOutcome> = {
    delivery: "not_run", cleanup: "not_run", refresh: "not_run", sweep: "not_run",
  };
  const phase = <E, R>(name: keyof typeof results, work: Effect.Effect<void, E, R>, milliseconds: number,
    failure: "Support delivery sweep failed" | "Support cleanup sweep failed" | "Support status refresh failed" | "Support status sweep failed") => Effect.gen(function* () {
    // Inner passes deliberately isolate item failures. Observe their fixed
    // failure/retry logs without copying annotations or changing those contracts.
    let incomplete = false;
    const logger = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
      const name = Array.isArray(message) && message.length === 1 ? message[0] : message;
      if (logLevel === "Error" || logLevel === "Warn" || logLevel === "Fatal") incomplete = true;
      if (name === "Support delivery outcome" && !["Delivered", "Reconciled", "NotApplied", "Superseded"].includes(String(fiber.getRef(CurrentLogAnnotations).outcome))) incomplete = true;
    });
    const admitted = work.pipe(Effect.map(() => incomplete ? "failed" as const : "ok" as const),
      Effect.provideService(PhaseFailure, () => { incomplete = true; }),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: true })));
    const outcome = yield* (options.ledger ? contained(options.db, options.ledger, admitted, "contained" as PhaseOutcome) : admitted).pipe(
      Effect.timeoutOption(milliseconds),
      Effect.flatMap((result) => Option.isNone(result)
        ? Effect.logError(failure).pipe(Effect.annotateLogs({ timeout: true }), Effect.as("timed_out" as const))
        : Effect.succeed(result.value)),
      Effect.catchCause(() => Effect.logError(failure).pipe(Effect.as("failed" as const))),
    );
    results[name] = outcome;
    if (options.observePhase) yield* options.observePhase(name, outcome);
  }).pipe(Effect.onExit((exit) => exit._tag === "Failure" ? Effect.gen(function* () {
    results[name] = "failed";
    if (options.observePhase) yield* options.observePhase(name, "failed");
  }) : Effect.void));
  yield* phase("delivery", sweepDelivery(options), 25_000, "Support delivery sweep failed");
  yield* phase("cleanup", sweepCleanup({ db: options.db, botLogin: options.botLogin, mappings: options.mappings, digestKey: options.digestKey ?? null,
    ledger: options.ledger ?? null,
    ...(options.now ? { now: options.now } : {}) }), 5_000, "Support cleanup sweep failed");
  yield* phase("refresh", refreshStatus({ db: options.db,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.refresh ? { config: options.refresh } : {}) }), 11_000, "Support status refresh failed");
  yield* phase("sweep", sweepStatus({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) }), 16_000, "Support status sweep failed");
  // Cooperative deadlines wait for cancellation/finalizers, which can exceed 57s.
  return results;
});
