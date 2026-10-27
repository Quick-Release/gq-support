import { boundedWork } from "./runtime-alerts.ts";
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
}

/**
 * The minute Cron's work, in priority order: delivery and reconciliation
 * first, then erasure and retention cleanup, then due refreshes and status
 * sweeps within their time bounds. A failure in one phase never skips the others.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  const phase = <E, R>(work: Effect.Effect<void, E, R>) => options.ledger
    ? contained(options.db, options.ledger, work, undefined) : work;
  yield* phase(sweepDelivery(options)).pipe(
    (work) => boundedWork(work, 25_000, "Support delivery sweep failed"),
    Effect.catchCause(() => Effect.logError("Support delivery sweep failed")),
  );
  yield* phase(sweepCleanup({ db: options.db, botLogin: options.botLogin, mappings: options.mappings, digestKey: options.digestKey ?? null,
    ledger: options.ledger ?? null,
    ...(options.now ? { now: options.now } : {}) })).pipe(
    (work) => boundedWork(work, 5_000, "Support cleanup sweep failed"),
    Effect.catchCause(() => Effect.logError("Support cleanup sweep failed")),
  );
  yield* phase(refreshStatus({ db: options.db,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.refresh ? { config: options.refresh } : {}) })).pipe(
    (work) => boundedWork(work, 11_000, "Support status refresh failed"),
    Effect.catchCause(() => Effect.logError("Support status refresh failed")),
  );
  yield* phase(sweepStatus({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) })).pipe(
    // Phase bounds total 57 seconds, ending before the next minute tick.
    (work) => boundedWork(work, 16_000, "Support status sweep failed"),
    Effect.catchCause(() => Effect.logError("Support status sweep failed")),
  );
});
