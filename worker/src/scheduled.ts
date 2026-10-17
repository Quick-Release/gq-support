import * as Effect from "effect/Effect";
import { sweepDelivery, type DeliveryOptions } from "./delivery.ts";
import type { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { sweepStatus, type SweepConfig } from "./status-sweep.ts";

export interface ScheduledOptions extends DeliveryOptions {
  readonly sweep?: Partial<SweepConfig>;
}

/**
 * The minute Cron's work, in priority order: delivery and reconciliation
 * first, then status sweeps with whatever the tick has left. A failure in one
 * phase never skips the other.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  yield* sweepDelivery(options).pipe(
    Effect.timeoutOption(25_000),
    Effect.catchCause(() => Effect.logError("Support delivery sweep failed")),
  );
  yield* sweepStatus({ db: options.db, botLogin: options.botLogin,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) }).pipe(
    // Together with delivery's bound, the tick ends before the next one starts.
    Effect.timeoutOption(20_000),
    Effect.catchCause(() => Effect.logError("Support status sweep failed")),
  );
});
