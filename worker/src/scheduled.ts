import * as Effect from "effect/Effect";
import { sweepDelivery, type DeliveryOptions } from "./delivery.ts";
import { sweepCleanup } from "./cleanup.ts";
import type { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { sweepStatus, type SweepConfig } from "./status-sweep.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";

export interface ScheduledOptions extends DeliveryOptions {
  readonly sweep?: Partial<SweepConfig>;
  readonly refresh?: Partial<RefreshConfig>;
}

/**
 * The minute Cron's work, in priority order: delivery and reconciliation
 * first, then erasure and retention cleanup, then due refreshes and status
 * sweeps within their time bounds. A failure in one phase never skips the others.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  yield* sweepDelivery(options).pipe(
    Effect.timeoutOption(25_000),
    Effect.catchCause(() => Effect.logError("Support delivery sweep failed")),
  );
  yield* sweepCleanup({ db: options.db, botLogin: options.botLogin, ...(options.now ? { now: options.now } : {}) }).pipe(
    Effect.timeoutOption(5_000),
    Effect.catchCause(() => Effect.logError("Support cleanup sweep failed")),
  );
  yield* refreshStatus({ db: options.db,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.refresh ? { config: options.refresh } : {}) }).pipe(
    Effect.timeoutOption(11_000),
    Effect.catchCause(() => Effect.logError("Support status refresh failed")),
  );
  yield* sweepStatus({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) }).pipe(
    // Phase bounds total 57 seconds, ending before the next minute tick.
    Effect.timeoutOption(16_000),
    Effect.catchCause(() => Effect.logError("Support status sweep failed")),
  );
});
