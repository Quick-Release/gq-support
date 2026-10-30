import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sweepDelivery, type DeliveryOptions } from "./delivery.ts";
import { sweepCleanup } from "./cleanup.ts";
import type { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { sweepStatus, type SweepConfig } from "./status-sweep.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";
import { expireIncidents } from "./incidents.ts";
import { sweepNotifications, type NotificationOptions } from "./notifications.ts";

export interface ScheduledOptions extends DeliveryOptions {
  /** The title-digest key for erasure redaction (src/cleanup.ts). */
  readonly digestKey?: CryptoKey | null;
  readonly sweep?: Partial<SweepConfig>;
  readonly refresh?: Partial<RefreshConfig>;
  /** Discord destinations and transport (src/notifications.ts); none configured sends nothing. */
  readonly notifications?: NotificationOptions;
}

/**
 * The minute Cron's work, in priority order: delivery and reconciliation
 * first, then erasure and retention cleanup (including resolved incidents past
 * their 90 days), then Discord notifications of what those phases recorded,
 * then due refreshes and status sweeps within their time bounds. A failure in
 * one phase never skips the others, and no phase waits for Discord.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  yield* sweepDelivery(options).pipe(
    Effect.timeoutOption(25_000),
    Effect.catchCause(() => Effect.logError("Support delivery sweep failed")),
  );
  yield* sweepCleanup({ db: options.db, botLogin: options.botLogin, mappings: options.mappings, digestKey: options.digestKey ?? null,
    ledger: options.ledger ?? null,
    ...(options.now ? { now: options.now } : {}) }).pipe(
    Effect.timeoutOption(5_000),
    Effect.catchCause(() => Effect.logError("Support cleanup sweep failed")),
  );
  yield* Effect.tryPromise(() => expireIncidents(options.db, (options.now ?? Date.now)())).pipe(
    Effect.timeoutOption(1_000),
    Effect.catchCause(() => Effect.logError("Operational incident expiry failed")),
  );
  const notifications = options.notifications;
  if (notifications) {
    yield* Effect.tryPromise((signal) => sweepNotifications(options.db, notifications, options.mappings,
      (options.now ?? Date.now)(), signal)).pipe(
      Effect.timeoutOption(4_000),
      Effect.flatMap((sweep) => Effect.forEach(Option.match(sweep, { onNone: () => [], onSome: ({ failed }) => failed }),
        ({ destination, code }) => Effect.logError("Discord notification failed").pipe(
          Effect.annotateLogs({ destination, code, alert: true })))),
      Effect.catchCause(() => Effect.logError("Discord notification sweep failed")),
    );
  }
  yield* refreshStatus({ db: options.db,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.refresh ? { config: options.refresh } : {}) }).pipe(
    Effect.timeoutOption(11_000),
    Effect.catchCause(() => Effect.logError("Support status refresh failed")),
  );
  yield* sweepStatus({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) }).pipe(
    // Phase bounds total 58 seconds, ending before the next minute tick.
    Effect.timeoutOption(12_000),
    Effect.catchCause(() => Effect.logError("Support status sweep failed")),
  );
});
