import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { QueryDatabase } from "./storage.ts";

/**
 * Aggregate operational metrics (#138; docs/support-operations-design.md): hourly
 * counts and durations recorded where work actually happens, at the request,
 * provider and scheduler boundaries. Every dimension is a closed set, and a
 * Client appears only for work a reviewed mapping and a verified credential
 * attribute to it. Nothing here holds request content, a Reporter identity, a
 * credential, a URL, a header, a payload or exception text, and nothing here is
 * an objective: the numbers are observations to set objectives from later.
 *
 * Recording never blocks or fails the work it measures: callers hand the write
 * to the background and drop its failure.
 */
export const HOUR = 3_600_000;
/** Aggregates are kept 12 months; they never extend a request's own retention, as they hold none of it. */
export const METRIC_RETENTION_MS = 365 * 86_400_000;

/** Installation API refusals: that API already reads D1 for every request, unlike webhooks and the operations API. */
export type AuthRejection = "installation_rejected" | "enrollment_rejected" | "enrollment_rate_limited";
export type SchedulerPhase = "delivery" | "cleanup" | "signals" | "notifications" | "refresh" | "sweep";
export type MetricEvent =
  /** How each minute-tick phase ended, timed (src/scheduled.ts). */
  | { readonly metric: "scheduler"; readonly outcome: `${SchedulerPhase}_${"completed" | "timed_out" | "failed"}` }
  /** A Support request create or status change answered by the Worker, timed at its HTTP entry. */
  | { readonly metric: "intake"; readonly outcome: "acknowledged" | "rejected" | "failed" }
  /** One delivery step's outcome (src/delivery.ts), with provider pacing among them. */
  | { readonly metric: "delivery"; readonly outcome: DeliveryOutcome }
  /** Acceptance to confirmed GitHub creation; pending, failed and unknown work is in the backlog instead. */
  | { readonly metric: "delivery_confirmed"; readonly outcome: "created" | "reconciled" }
  /** A due candidate another execution claimed first. */
  | { readonly metric: "delivery_claim"; readonly outcome: "contended" }
  /** A request refused before any credential was trusted, grouped by reason; never attributed to a Client. */
  | { readonly metric: "auth"; readonly outcome: AuthRejection }
  /** A GitHub App webhook delivery as GitHub's delivery log records it (src/webhook-deliveries.ts). */
  | { readonly metric: "webhook"; readonly outcome: "accepted" | "rejected" | "failed" };
/** Metrics whose measurements carry a duration. */
const TIMED: ReadonlySet<string> = new Set(["intake", "delivery_confirmed", "scheduler"]);

/** Delivery's own outcome names and bounded provider error classes (src/delivery.ts, src/github-gateway.ts). */
const DELIVERY_OUTCOMES = ["Delivered", "Reconciled", "NotApplied", "Superseded", "ReconciliationPending", "ReviewRequired",
  "MetadataRepair", "DeliveryDeadline", "MappingUnavailable", "MissingIdentity", "SchedulerFailure", "OutcomeUnknown",
  "RateLimited", "ProviderUnavailable", "AppAuthenticationFailed", "InstallationUnavailable", "RepositoryUnavailable",
  "PermissionMissing", "RepositoryNotPrivate", "RepositoryArchived", "ValidationRejected", "IssueMoved", "IssueGone"] as const;
export type DeliveryOutcome = typeof DELIVERY_OUTCOMES[number] | "Other";
/** Keeps the outcome dimension closed: anything unexpected is counted as `Other`. */
export const deliveryOutcome = (outcome: string): DeliveryOutcome =>
  (DELIVERY_OUTCOMES as readonly string[]).includes(outcome) ? outcome as DeliveryOutcome : "Other";

export interface Measurement {
  readonly at: number;
  /** A reviewed mapping's Client, only for verified work attributed to it. */
  readonly client?: string;
  readonly durationMs?: number;
}

/** One measurement's single-statement upsert into its hourly aggregate. */
export const metricStatement = (db: QueryDatabase, event: MetricEvent, { at, client = "", durationMs = 0 }: Measurement): D1PreparedStatement => {
  const duration = Math.max(0, Math.round(durationMs));
  return db.prepare(`INSERT INTO operational_metric (hour, metric, outcome, client, count, total_ms, max_ms, first_at, last_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (hour, metric, outcome, client) DO UPDATE SET count = count + 1,
      total_ms = total_ms + excluded.total_ms, max_ms = MAX(max_ms, excluded.max_ms), last_at = MAX(last_at, excluded.last_at)`)
    .bind(Math.floor(at / HOUR) * HOUR, event.metric, event.outcome, client, duration, duration, at, at);
};

/** Records one measurement; a failed write is dropped, never surfaced to the measured work. */
export const recordMetric = async (db: QueryDatabase | Promise<QueryDatabase>, event: MetricEvent, measurement: Measurement) => {
  try {
    await metricStatement(await db, event, measurement).run();
  } catch {
    // Metrics are best effort; the measured work has already completed.
  }
};

export interface MeasuredRow {
  readonly metric: string; readonly outcome: string; readonly client: string | null; readonly count: number;
  readonly mean_ms?: number; readonly max_ms?: number; readonly last_at: string;
}

/**
 * Aggregates for the hours since `from`, by metric, outcome and Client. Durations
 * appear only for timed metrics, as a mean and a maximum: hourly aggregates hold
 * no distribution. An empty list means nothing was observed, not that all is well.
 */
export const measuredSince = async (db: QueryDatabase, from: number): Promise<MeasuredRow[]> =>
  (await db.prepare(`SELECT metric, outcome, client, SUM(count) AS count, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms,
      MAX(last_at) AS last_at FROM operational_metric WHERE hour >= ? GROUP BY metric, outcome, client ORDER BY metric, outcome, client`)
    .bind(Math.floor(from / HOUR) * HOUR).all<{ metric: string; outcome: string; client: string; count: number; total_ms: number;
      max_ms: number; last_at: number }>()).results.map((row) => ({
    metric: row.metric, outcome: row.outcome, client: row.client || null, count: row.count,
    ...(TIMED.has(row.metric) ? { mean_ms: Math.round(row.total_ms / row.count), max_ms: row.max_ms } : {}),
    last_at: new Date(row.last_at).toISOString(),
  }));

/** Deletes a bounded batch of aggregates older than 12 months. */
export const expireMetrics = async (db: QueryDatabase, now: number): Promise<void> => {
  await db.prepare(`DELETE FROM operational_metric WHERE rowid IN (SELECT rowid FROM operational_metric WHERE hour < ? LIMIT 500)`)
    .bind(now - METRIC_RETENTION_MS).run();
};
