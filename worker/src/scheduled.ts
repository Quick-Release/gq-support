import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sweepDelivery, type DeliveryOptions } from "./delivery.ts";
import { sweepCleanup } from "./cleanup.ts";
import type { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { sweepStatus, type SweepConfig } from "./status-sweep.ts";
import { scanWebhookDeliveries } from "./webhook-deliveries.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";
import { expireIncidents } from "./incidents.ts";
import { observeSignals } from "./operational-signals.ts";
import { sweepNotifications, type NotificationOptions } from "./notifications.ts";
import { expireMetrics, metricStatement, type SchedulerPhase } from "./operational-metrics.ts";

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
 * first, then erasure and retention cleanup, then operational signals
 * (expiring resolved incidents past 90 days and aggregates past 12 months, and
 * routing what trusted records now show, src/operational-signals.ts), then
 * Discord notifications of what those phases recorded, then due refreshes and
 * status sweeps within their time bounds. A failure in one phase never skips
 * the others, and no phase waits for Discord. How each phase ended is measured.
 */
export const scheduledTick = (options: ScheduledOptions): Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  const now = options.now ?? Date.now;
  const outcomes: { phase: SchedulerPhase; outcome: "completed" | "timed_out" | "failed"; durationMs: number; at: number }[] = [];
  /** Runs one phase within its bound and records how it ended; a failure is logged and never skips the next phase. */
  const phase = <A, E, R>(name: SchedulerPhase, work: Effect.Effect<A, E, R>, bound: number, failure: string) => Effect.gen(function* () {
    const started = now();
    const outcome = yield* work.pipe(Effect.timeoutOption(bound),
      Effect.map((result) => Option.isSome(result) ? "completed" as const : "timed_out" as const),
      Effect.catchCause(() => Effect.logError(failure).pipe(Effect.as("failed" as const))));
    outcomes.push({ phase: name, outcome, durationMs: now() - started, at: now() });
  });
  yield* phase("delivery", sweepDelivery(options), 25_000, "Support delivery sweep failed");
  yield* phase("cleanup", sweepCleanup({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    digestKey: options.digestKey ?? null, ledger: options.ledger ?? null,
    ...(options.now ? { now: options.now } : {}) }), 5_000, "Support cleanup sweep failed");
  // GitHub's webhook delivery log first, briefly bounded, so this tick routes what it shows.
  yield* phase("signals", scanWebhookDeliveries(options.db, now()).pipe(Effect.timeoutOption(1_000),
    Effect.catchCause(() => Effect.logError("Webhook delivery log scan failed")),
    Effect.andThen(Effect.tryPromise(async () => {
      await expireIncidents(options.db, now());
      await expireMetrics(options.db, now());
      await observeSignals(options.db, now());
    }))), 2_000, "Operational signal phase failed");
  const notifications = options.notifications;
  if (notifications) {
    yield* phase("notifications", Effect.tryPromise((signal) => sweepNotifications(options.db, notifications, options.mappings,
      now(), signal)).pipe(
      Effect.tap(({ failed }) => Effect.forEach(failed, ({ destination, code }) => Effect.logError("Discord notification failed").pipe(
        Effect.annotateLogs({ destination, code, alert: true }))))), 4_000, "Discord notification sweep failed");
  }
  // Bounded at its own execution time; claims are durable, so a cut-off read retries next minute.
  yield* phase("refresh", refreshStatus({ db: options.db,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.refresh ? { config: options.refresh } : {}) }), 10_000, "Support status refresh failed");
  // Phase bounds total 58 seconds, ending before the next minute tick.
  yield* phase("sweep", sweepStatus({ db: options.db, botLogin: options.botLogin, mappings: options.mappings,
    ...(options.now ? { now: options.now } : {}), ...(options.sweep ? { config: options.sweep } : {}) }), 12_000,
    "Support status sweep failed");
  // Scheduler health, in one write after the work it measures, bounded so the tick still ends before the next.
  yield* Effect.tryPromise(() => options.db.batch(outcomes.map(({ phase: name, outcome, durationMs, at }) =>
    metricStatement(options.db, { metric: "scheduler", outcome: `${name}_${outcome}` }, { at, durationMs })))).pipe(
    Effect.timeoutOption(500), Effect.catchCause(() => Effect.logError("Scheduler measurement failed")));
});

/**
 * The minute Cron's entry: the restore gate first (src/ledger.ts), which
 * replays a recorded restore even during maintenance, then the tick only
 * while the service is serving. Maintenance or an unreadable ledger skips
 * every phase, so nothing is dispatched, swept or notified.
 */
export const serviceTick = (admitted: () => Promise<boolean>, options: ScheduledOptions):
  Effect.Effect<void, never, GitHubGateway | GitHubReader> => Effect.gen(function* () {
  if (!(yield* Effect.promise(() => admitted().catch(() => false)))) return yield* Effect.logError("Support service gate closed: maintenance or restore replay pending");
  yield* scheduledTick(options);
});
