import { HOUR, measuredSince } from "./operational-metrics.ts";
import { COMPONENTS } from "./independent-check.ts";
import { refreshEligible } from "./status-refresh.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";

/** The aggregate window the health view reports. */
const WINDOW_MS = 24 * HOUR;

const clientOf = (mappings: readonly RepositoryMapping[], slot: string) => mappings.find((mapping) => mapping.slot === slot)?.client ?? null;
/** Sums per-Slot counts into per-Client ones; a Slot no reviewed mapping names is reported without a Client. */
const byClient = (mappings: readonly RepositoryMapping[], rows: readonly { slot: string; count: number }[]) => {
  const totals = new Map<string | null, number>();
  for (const row of rows) totals.set(clientOf(mappings, row.slot), (totals.get(clientOf(mappings, row.slot)) ?? 0) + row.count);
  return [...totals].map(([client, count]) => ({ client, count })).sort((a, b) => String(a.client).localeCompare(String(b.client)));
};

const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
const earliest = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.min(a, b);
/** Pending, failed and outcome-unknown work per Client, with its oldest due and unknown times; none is dropped. */
const backlogByClient = (mappings: readonly RepositoryMapping[], rows: readonly { slot: string; pending: number; failed: number;
  outcome_unknown: number; oldest_due_at: number | null; oldest_unknown_since: number | null }[]) => {
  const totals = new Map<string | null, { pending: number; failed: number; outcome_unknown: number; due: number | null; unknown: number | null }>();
  for (const row of rows) {
    const client = clientOf(mappings, row.slot);
    const total = totals.get(client) ?? { pending: 0, failed: 0, outcome_unknown: 0, due: null, unknown: null };
    totals.set(client, { pending: total.pending + row.pending, failed: total.failed + row.failed,
      outcome_unknown: total.outcome_unknown + row.outcome_unknown, due: earliest(total.due, row.oldest_due_at),
      unknown: earliest(total.unknown, row.oldest_unknown_since) });
  }
  return [...totals].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([client, total]) => ({ client,
    pending: total.pending, failed: total.failed, outcome_unknown: total.outcome_unknown,
    oldest_due_at: iso(total.due), oldest_unknown_since: iso(total.unknown) }));
};

/**
 * Work measured per Client: requests stored now, and acknowledged intake and delivery steps in the window.
 * Everything else the service spends is shared and not attributed.
 */
const usageByClient = (mappings: readonly RepositoryMapping[], stored: readonly { slot: string; count: number }[],
  measured: readonly { metric: string; outcome: string; client: string | null; count: number }[]) => {
  const clients = new Map<string, { stored_requests: number; intake_acknowledged: number; delivery_steps: number }>();
  const entry = (client: string) => clients.get(client) ?? clients.set(client, { stored_requests: 0, intake_acknowledged: 0, delivery_steps: 0 }).get(client)!;
  for (const { client, count } of byClient(mappings, stored)) if (client) entry(client).stored_requests += count;
  for (const row of measured) {
    if (!row.client) continue;
    if (row.metric === "intake" && row.outcome === "acknowledged") entry(row.client).intake_acknowledged += row.count;
    if (row.metric === "delivery") entry(row.client).delivery_steps += row.count;
  }
  return {
    clients: [...clients].sort(([a], [b]) => a.localeCompare(b)).map(([client, usage]) => ({ client, ...usage })),
    basis: "measured counts attributed to a Client only through its reviewed mapping and verified credentials",
    shared: "Worker requests and CPU, D1 storage and queries, scheduled ticks, webhooks and Discord delivery are shared across Clients: not attributed and not estimated",
  };
};

/**
 * The independent checker's last reported observation of each component
 * (src/independent-check.ts). Current for an hour, a display rule rather than
 * an objective since GitHub's scheduler runs it every few minutes at best;
 * then unknown with reason `stale`, and never-reported ones `absent`. During
 * an outage of this Worker or its D1 the checker cannot report here at all:
 * it announces in Discord and reconciles later.
 */
const CHECKER_STALE_MS = HOUR;
const independent = async (db: QueryDatabase, now: number) => {
  const rows = (await db.prepare("SELECT component, state, code, observed_at FROM independent_component").bind()
    .all<{ component: string; state: string; code: string; observed_at: number }>()).results;
  const last = rows.reduce<number | null>((latest, row) => latest === null || row.observed_at > latest ? row.observed_at : latest, null);
  return {
    last_report_at: iso(last), stale_after_minutes: CHECKER_STALE_MS / 60_000,
    components: COMPONENTS.map((component) => {
      const row = rows.find((candidate) => candidate.component === component);
      if (!row) return { component, state: null, code: null, observed_at: null, display: "unknown", reason: "absent" };
      const observed = { component, state: row.state, code: row.code, observed_at: iso(row.observed_at) };
      return now - row.observed_at > CHECKER_STALE_MS ? { ...observed, display: "unknown", reason: "stale" } : { ...observed, display: "current" };
    }),
  };
};

/**
 * Measured support-path health (#138; docs/support-operations-design.md), for
 * the operations API and the Operator CLI: what was observed in the last 24
 * hours of aggregates, and what durable records show now. A missing
 * observation is absent or null, never healthy. Nothing here is an objective,
 * and nothing names a request, Reporter, credential or URL.
 */
export const operationsHealth = async (db: QueryDatabase, mappings: readonly RepositoryMapping[], now: number) => {
  const from = now - WINDOW_MS;
  const accepted = (await db.prepare("SELECT slot, COUNT(*) AS count FROM support_request WHERE created_at > ? GROUP BY slot")
    .bind(from).all<{ slot: string; count: number }>()).results;
  const backlog = (await db.prepare(`SELECT slot, SUM(state IN ('pending', 'in_flight')) AS pending, SUM(state = 'failed') AS failed,
      SUM(state = 'outcome_unknown') AS outcome_unknown,
      MIN(CASE WHEN state = 'pending' AND next_attempt_at <= ? THEN next_attempt_at END) AS oldest_due_at,
      MIN(CASE WHEN state = 'outcome_unknown' THEN unknown_since END) AS oldest_unknown_since
    FROM delivery_intent WHERE state IN ('pending', 'in_flight', 'failed', 'outcome_unknown') GROUP BY slot`).bind(now)
    .all<{ slot: string; pending: number; failed: number; outcome_unknown: number; oldest_due_at: number | null;
      oldest_unknown_since: number | null }>()).results;
  // Provider pacing: installations GitHub has asked to wait. Fairness: Slots with due work and when each was last served.
  const pacing = await db.prepare(`SELECT COUNT(*) AS cooldowns, MAX(provider_cooldown_until) AS until FROM delivery_permit
    WHERE provider_cooldown_until > ?`).bind(now).first<{ cooldowns: number; until: number | null }>();
  const fairness = await db.prepare(`SELECT COUNT(*) AS due, SUM(s.last_served_at IS NULL) AS never, MIN(s.last_served_at) AS least
    FROM (SELECT DISTINCT slot FROM delivery_intent WHERE state = 'pending' AND next_attempt_at <= ?) d
    LEFT JOIN delivery_slot_schedule s ON s.slot = d.slot`).bind(now).first<{ due: number; never: number | null; least: number | null }>();
  // Last-observed GitHub status of tracked requests: no client-visible freshness objective is implied.
  const tracked = `issue_id IS NOT NULL AND tracking = 'active'`;
  const status = await db.prepare(`SELECT COUNT(*) AS tracked, MIN(status_observed_at) AS observed,
      (SELECT COUNT(*) FROM support_request WHERE status_refresh_due_at IS NOT NULL AND ${refreshEligible}) AS due,
      (SELECT MIN(status_refresh_due_at) FROM support_request WHERE status_refresh_due_at IS NOT NULL AND ${refreshEligible}) AS oldest_due,
      (SELECT MIN(COALESCE(last_swept_at, sweep_scheduled_at)) FROM repository_state WHERE repository_id IN
        (SELECT repository_id FROM support_request WHERE ${tracked})) AS swept
    FROM support_request WHERE ${tracked}`).bind()
    .first<{ tracked: number; observed: number | null; due: number; oldest_due: number | null; swept: number | null }>();
  const measured = await measuredSince(db, from);
  const stored = (await db.prepare("SELECT slot, COUNT(*) AS count FROM support_request GROUP BY slot").bind()
    .all<{ slot: string; count: number }>()).results;
  const oldest = await db.prepare("SELECT MIN(hour) AS hour FROM operational_metric").bind().first<{ hour: number | null }>();
  return {
    observed_at: new Date(now).toISOString(),
    window: { from: new Date(Math.floor(from / HOUR) * HOUR).toISOString(), to: new Date(now).toISOString() },
    measured,
    current: {
      // Requests durably recorded in the window, whatever their delivery outcome: acceptance, not GitHub creation.
      intake: { durably_accepted: byClient(mappings, accepted) },
      delivery: {
        backlog: backlogByClient(mappings, backlog),
        pacing: { provider_cooldowns: pacing?.cooldowns ?? 0, cooldown_until: iso(pacing?.until ?? null) },
        fairness: { slots_due: fairness?.due ?? 0, never_served: fairness?.never ?? 0, least_recently_served_at: iso(fairness?.least ?? null) },
      },
      status: { tracked: status?.tracked ?? 0, oldest_observed_at: iso(status?.observed ?? null), refresh_due: status?.due ?? 0,
        oldest_refresh_due_at: iso(status?.oldest_due ?? null), oldest_sweep_at: iso(status?.swept ?? null) },
    },
    usage: usageByClient(mappings, stored, measured),
    independent: await independent(db, now),
    // Aggregates are expired after 12 months (src/operational-metrics.ts); the oldest hour still kept.
    retention: { aggregate_months: 12, oldest_hour: iso(oldest?.hour ?? null) },
  };
};
