import { findIncident, type IncidentProjection } from "./incidents.ts";
import { SIGNALS } from "./signal-rules.ts";
import { mappingFor, type RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Discord notifications (docs/support-operations-design.md). Accepted Support
 * requests and Operational incidents go to separate Discord destinations, with
 * minimal metadata and trusted links only: never Submitted text, a Reporter
 * identity, a credential, a payload or an untrusted URL.
 *
 * Notifications are derived by the minute sweep from durable state, so intake
 * and incident writes never wait for, or fail with, Discord. Delivery state is
 * separate from its source: an outage leaves the incident or request intact and
 * the notification pending. Each source, destination and transition is
 * announced once when Discord confirms it; a later transition edits the known
 * message. A lost response leaves Discord's outcome unknown, so a retry may
 * post the same notice twice: exactly-once Discord delivery is not promised,
 * and no retry ever creates another incident. Nothing here reminds about or
 * escalates an unclaimed incident.
 */
export type Destination = "support_requests" | "operational_incidents";
export const DESTINATIONS: readonly Destination[] = ["support_requests", "operational_incidents"];

export interface DiscordWebhook { readonly id: string; readonly token: string }
export type DiscordDestinations = Partial<Record<Destination, DiscordWebhook>>;

const WEBHOOK_URL = /^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/([0-9]{17,20})\/([A-Za-z0-9_-]{20,100})$/;
const parseWebhook = (url: string): DiscordWebhook | undefined => {
  const match = WEBHOOK_URL.exec(url.trim());
  return match ? { id: match[1]!, token: match[2]! } : undefined;
};
/**
 * The configured destinations, from the `DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL`
 * and `DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL` Worker secrets. An unset or
 * malformed URL leaves its destination unconfigured, and nothing is queued for
 * it. One webhook for both would merge the channels, so it configures neither.
 */
export const discordDestinations = (supportRequests: string, operationalIncidents: string): DiscordDestinations => {
  const requests = parseWebhook(supportRequests);
  const incidents = parseWebhook(operationalIncidents);
  if (requests && incidents && requests.id === incidents.id) return {};
  return { ...(requests ? { support_requests: requests } : {}), ...(incidents ? { operational_incidents: incidents } : {}) };
};

/** Bounded delivery error codes; provider responses are never stored or logged. */
export type NotificationError = "outcome_unknown" | "rate_limited" | "provider_unavailable" | "destination_rejected"
  | "request_rejected" | "message_missing";

/** Retries per transition before the notification needs an Operator's `notification-retry`. */
export const MAX_ATTEMPTS = 8;
const backoff = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);
const SENDS_PER_TICK = 10;
const REQUEST_TIMEOUT_MS = 2_500;
/** Support requests accepted this recently are announced; later transitions edit them for this long. */
const REQUEST_ANNOUNCE_MS = 86_400_000;
export const REQUEST_NOTIFICATION_RETENTION_MS = 7 * 86_400_000;
const DOCS = "https://github.com/Quick-Release/gq-support/blob/main/";
const USER_AGENT = "DiscordBot (https://github.com/Quick-Release/gq-support, 1)";

// A more advanced stage of an incident edits its message, such as an uncertain create reaching Operator handoff.
const detailRank = `CASE ${Object.values(SIGNALS).flatMap((signal) => signal.details?.map((detail, rank) =>
  `WHEN i.detail = '${detail}' THEN ${rank}`) ?? []).join(" ")} ELSE 0 END`;

/**
 * Brings each source's notification up to its current transition. Transitions
 * only move forward; one that moves resets the attempts and keeps the message.
 */
const enqueue = async (db: QueryDatabase, destinations: DiscordDestinations, now: number) => {
  const upsert = `ON CONFLICT (source_kind, source_id, destination) DO UPDATE SET transition = excluded.transition,
    transition_rank = excluded.transition_rank, state = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at,
    error_code = NULL, changed_at = excluded.changed_at WHERE excluded.transition_rank > notification.transition_rank`;
  const statements = [];
  if (destinations.operational_incidents) {
    // Open incidents whatever their age; retained resolved ones update existing notices even after a long outage.
    statements.push(db.prepare(`INSERT INTO notification (source_kind, source_id, destination, transition, transition_rank,
      state, next_attempt_at, source_at, changed_at)
      SELECT 'incident', i.id, 'operational_incidents',
        CASE WHEN i.state = 'resolved' THEN 'resolved' WHEN i.claimant IS NOT NULL THEN 'claimed' ELSE 'opened' END
          || COALESCE(':' || i.detail, ''),
        CASE WHEN i.state = 'resolved' THEN 2 WHEN i.claimant IS NOT NULL THEN 1 ELSE 0 END * 100 + ${detailRank}, 'pending', ?, i.first_observed_at, ?
      FROM incident i WHERE i.state = 'open' OR (i.state = 'resolved' AND EXISTS (SELECT 1 FROM notification n
        WHERE n.source_kind = 'incident' AND n.source_id = i.id AND n.destination = 'operational_incidents')) ${upsert}`)
      .bind(now, now));
  }
  if (destinations.support_requests) {
    // The create's actual outcome: issue confirmed, needs review, or still only accepted.
    statements.push(db.prepare(`INSERT INTO notification (source_kind, source_id, destination, transition, transition_rank,
      state, next_attempt_at, source_at, changed_at)
      SELECT 'support_request', r.id, 'support_requests',
        CASE WHEN r.issue_number IS NOT NULL THEN 'delivered' WHEN d.state IN ('failed', 'outcome_unknown') THEN 'delivery_attention'
          ELSE 'accepted' END,
        CASE WHEN r.issue_number IS NOT NULL THEN 2 WHEN d.state IN ('failed', 'outcome_unknown') THEN 1 ELSE 0 END,
        'pending', ?, r.created_at, ?
      FROM support_request r LEFT JOIN delivery_intent d ON d.request_id = r.id AND d.seq = 0
      WHERE r.created_at > ? AND r.erased_at IS NULL AND (r.created_at > ? OR EXISTS (SELECT 1 FROM notification n
        WHERE n.source_kind = 'support_request' AND n.source_id = r.id AND n.destination = 'support_requests')) ${upsert}`)
      .bind(now, now, now - REQUEST_NOTIFICATION_RETENTION_MS, now - REQUEST_ANNOUNCE_MS));
  }
  if (statements.length) await db.batch(statements);
};

/**
 * Removes delivery state whose source is gone, such as an expired incident or
 * an erased or purged request, and request notifications after 7 days. These
 * rows hold no report content, and their retention never extends a source's.
 */
const expire = async (db: QueryDatabase, now: number) => {
  await db.prepare(`DELETE FROM notification WHERE rowid IN (SELECT n.rowid FROM notification n WHERE
    (n.source_kind = 'incident' AND NOT EXISTS (SELECT 1 FROM incident i WHERE i.id = n.source_id))
    OR (n.source_kind = 'support_request' AND (n.source_at <= ? OR NOT EXISTS (SELECT 1 FROM support_request r
      WHERE r.id = n.source_id AND r.erased_at IS NULL))) LIMIT 100)`).bind(now - REQUEST_NOTIFICATION_RETENTION_MS).run();
};

interface RequestSource {
  id: string; slot: string; repository_id: number; issue_number: number | null; delivery: string | null; erased_at: number | null;
}
const code = (value: string) => `\`${value.replaceAll("`", "")}\``;

const incidentMessage = (incident: IncidentProjection) => [
  `**Operational incident** · ${incident.state === "resolved" ? `Resolved (${incident.resolution})`
    : incident.claimant ? `Claimed by ${code(incident.claimant)}` : "Unclaimed"}`,
  `Category: ${code(incident.category)}${incident.detail ? ` · ${code(incident.detail)}` : ""}`,
  `Affected Slots: ${incident.affected_slots.length ? incident.affected_slots.map(code).join(", ") : "none (stage-wide)"}`,
  `Incident: ${code(incident.id)}`,
  ...(incident.runbook ? [`Runbook: <${DOCS}${incident.runbook}>`] : []),
].join("\n");

const requestMessage = (request: RequestSource, mapping: RepositoryMapping | undefined) => {
  const repository = mapping?.repository;
  const state = request.issue_number !== null ? "Delivered: GitHub issue created"
    : request.delivery === "outcome_unknown" ? "Accepted; GitHub outcome unknown, needs Operator review (no issue confirmed)"
    : request.delivery === "failed" ? "Accepted; GitHub delivery failed, needs Operator review (no issue created)"
    : "Accepted; pending GitHub delivery (no issue confirmed yet)";
  return [
    `**Support request** · ${state}`,
    `Slot: ${code(request.slot)}`,
    `Request: ${code(request.id)}`,
    ...(request.issue_number === null ? []
      : [repository ? `Issue: <https://github.com/${repository}/issues/${request.issue_number}>`
        : `Issue: #${request.issue_number} in repository ${request.repository_id}`]),
  ].join("\n");
};

interface Due {
  source_kind: "support_request" | "incident"; source_id: string; destination: Destination; transition: string;
  attempts: number; webhook_id: string | null; message_id: string | null;
}

/** The current message for a source, or null once the source is gone or erased. */
const render = async (db: QueryDatabase, due: Due, mappings: readonly RepositoryMapping[], now: number) => {
  if (due.source_kind === "incident") {
    const incident = await findIncident(db, due.source_id, now);
    return incident ? incidentMessage(incident) : null;
  }
  const request = await db.prepare(`SELECT r.id, r.slot, r.repository_id, r.issue_number, r.erased_at, d.state AS delivery
    FROM support_request r LEFT JOIN delivery_intent d ON d.request_id = r.id AND d.seq = 0 WHERE r.id = ?`)
    .bind(due.source_id).first<RequestSource>();
  return request && request.erased_at === null ? requestMessage(request, mappingFor(mappings, request.slot)) : null;
};

type Outcome =
  | { readonly sent: string | null }
  | { readonly error: NotificationError; readonly retryAfterMs?: number; readonly global?: boolean; readonly terminal?: boolean };

const seconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value
  : typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value) ? Number(value) : undefined;

/** One execute or edit request, classified without keeping any of the response. */
const send = async (fetcher: typeof fetch, webhook: DiscordWebhook, messageId: string | null, content: string,
  signal: AbortSignal | undefined): Promise<Outcome> => {
  const base = `https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}`;
  let response: Response;
  try {
    response = await fetcher(messageId ? `${base}/messages/${messageId}` : `${base}?wait=true`, {
      method: messageId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      // No mentions: a notification never pings anyone.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The request may or may not have reached Discord.
    return { error: "outcome_unknown" };
  }
  const body = await response.json().catch(() => null) as { id?: unknown; code?: unknown; retry_after?: unknown; global?: unknown } | null;
  if (response.ok) {
    if (messageId) return { sent: messageId };
    return typeof body?.id === "string" && /^[0-9]{1,20}$/.test(body.id) ? { sent: body.id } : { error: "outcome_unknown" };
  }
  if (response.status === 429) {
    const wait = seconds(body?.retry_after) ?? seconds(response.headers.get("Retry-After")) ?? 60;
    return { error: "rate_limited", retryAfterMs: Math.max(Math.ceil(wait * 1000), 1_000),
      global: body?.global === true || response.headers.has("X-RateLimit-Global") };
  }
  // Unknown Message: the message was deleted, so post the current state anew.
  if (messageId && response.status === 404 && body?.code === 10008) return { error: "message_missing" };
  if (response.status === 401 || response.status === 403 || response.status === 404) return { error: "destination_rejected" };
  if (response.status >= 500) return { error: "provider_unavailable" };
  return { error: "request_rejected", terminal: true };
};

export interface NotificationOptions {
  readonly destinations: DiscordDestinations;
  /** Discord's HTTP transport; tests pass a fake. */
  readonly fetch?: typeof fetch;
}
export interface NotificationSweep { readonly failed: readonly { destination: Destination; code: NotificationError }[] }

/**
 * The minute tick's notification phase: queue current transitions, send a
 * bounded number that are due, then expire delivery state. Each attempt is
 * recorded before the request as `outcome_unknown` with its next retry, so an
 * interrupted tick leaves an honest, retryable state, and only one tick can
 * claim a given attempt. A rate limit defers its destination as Discord asks.
 */
export const sweepNotifications = async (db: QueryDatabase, { destinations, fetch: fetcher = fetch }: NotificationOptions,
  mappings: readonly RepositoryMapping[], now: number, signal?: AbortSignal): Promise<NotificationSweep> => {
  const failed: { destination: Destination; code: NotificationError }[] = [];
  const configured = DESTINATIONS.filter((destination) => destinations[destination]);
  await enqueue(db, destinations, now);
  const due = configured.length ? (await db.prepare(`SELECT source_kind, source_id, destination, transition, attempts, webhook_id, message_id
    FROM notification n WHERE state = 'pending' AND next_attempt_at <= ? AND destination IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM notification_cooldown c WHERE c.destination = n.destination AND c.retry_at > ?)
    ORDER BY next_attempt_at, source_at LIMIT ?`).bind(now, JSON.stringify(configured), now, SENDS_PER_TICK).all<Due>()).results : [];
  const deferred = new Set<Destination>();
  for (const item of due) {
    if (signal?.aborted) break;
    const webhook = destinations[item.destination]!;
    if (deferred.has(item.destination)) continue;
    const key = [item.source_kind, item.source_id, item.destination] as const;
    const content = await render(db, item, mappings, now);
    if (content === null) {
      await db.prepare("DELETE FROM notification WHERE source_kind = ? AND source_id = ? AND destination = ?").bind(...key).run();
      continue;
    }
    const attempt = item.attempts + 1;
    const claimed = await db.prepare(`UPDATE notification SET attempts = ?, error_code = 'outcome_unknown', next_attempt_at = ?
      WHERE source_kind = ? AND source_id = ? AND destination = ? AND state = 'pending' AND attempts = ? AND transition = ?
        AND next_attempt_at <= ?`).bind(attempt, now + backoff(attempt), ...key, item.attempts, item.transition, now).run();
    if (claimed.meta.changes !== 1) continue;
    const messageId = item.webhook_id === webhook.id ? item.message_id : null;
    const outcome = await send(fetcher, webhook, messageId, content, signal);
    if ("sent" in outcome) {
      // A transition queued meanwhile stays pending, to edit this message.
      await db.prepare(`UPDATE notification SET sent_transition = ?, webhook_id = ?, message_id = ?, sent_at = ?, error_code = NULL,
        state = CASE WHEN transition = ? THEN 'sent' ELSE state END,
        next_attempt_at = CASE WHEN transition = ? THEN next_attempt_at ELSE ? END
        WHERE source_kind = ? AND source_id = ? AND destination = ?`)
        .bind(item.transition, webhook.id, outcome.sent, now, item.transition, item.transition, now, ...key).run();
      continue;
    }
    const { error } = outcome;
    if (error === "rate_limited") {
      await db.batch((outcome.global ? DESTINATIONS : [item.destination]).map((destination) =>
        db.prepare(`INSERT INTO notification_cooldown (destination, retry_at) VALUES (?, ?)
          ON CONFLICT (destination) DO UPDATE SET retry_at = MAX(retry_at, excluded.retry_at)`)
          .bind(destination, now + outcome.retryAfterMs!)));
      // Discord's wait, not a failed attempt.
      await db.prepare(`UPDATE notification SET attempts = ?, error_code = 'rate_limited', next_attempt_at = ?
        WHERE source_kind = ? AND source_id = ? AND destination = ? AND attempts = ?`)
        .bind(item.attempts, now + outcome.retryAfterMs!, ...key, attempt).run();
      if (outcome.global) configured.forEach((destination) => deferred.add(destination));
      deferred.add(item.destination);
      continue;
    }
    const terminal = outcome.terminal || attempt >= MAX_ATTEMPTS;
    if (terminal) failed.push({ destination: item.destination, code: error });
    await db.prepare(`UPDATE notification SET error_code = ?, state = ?,
      next_attempt_at = ?, webhook_id = CASE WHEN ? THEN NULL ELSE webhook_id END, message_id = CASE WHEN ? THEN NULL ELSE message_id END
      WHERE source_kind = ? AND source_id = ? AND destination = ? AND attempts = ?`)
      .bind(error, terminal ? "failed" : "pending", error === "message_missing" ? now : now + backoff(attempt),
        error === "message_missing" ? 1 : 0, error === "message_missing" ? 1 : 0, ...key, attempt).run();
  }
  await expire(db, now);
  return { failed };
};

interface StatusRow {
  destination: Destination; pending: number; failed: number; oldest_pending_at: number | null; last_sent_at: number | null;
}
const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();

/**
 * Delivery health per destination and the notifications that are failing or
 * have failed, for the operations API and the Operator CLI. `configured` is
 * known only to the Worker that holds the webhook secrets.
 */
export const notificationStatus = async (db: QueryDatabase, configured?: readonly Destination[]) => {
  const totals = (await db.prepare(`SELECT destination, SUM(state = 'pending') AS pending, SUM(state = 'failed') AS failed,
    MIN(CASE WHEN state = 'pending' THEN changed_at END) AS oldest_pending_at, MAX(sent_at) AS last_sent_at
    FROM notification GROUP BY destination`).bind().all<StatusRow>()).results;
  const problems = (await db.prepare(`SELECT source_kind, source_id, destination, transition, state, attempts, next_attempt_at, error_code
    FROM notification WHERE state = 'failed' OR (state = 'pending' AND error_code IS NOT NULL)
    ORDER BY state = 'pending', changed_at LIMIT 50`).bind().all<Record<string, unknown>>()).results;
  return {
    destinations: DESTINATIONS.map((destination) => {
      const row = totals.find((total) => total.destination === destination);
      return {
        destination, ...(configured ? { configured: configured.includes(destination) } : {}),
        pending: row?.pending ?? 0, failed: row?.failed ?? 0,
        oldest_pending_at: iso(row?.oldest_pending_at ?? null), last_sent_at: iso(row?.last_sent_at ?? null),
      };
    }),
    problems: problems.map((problem) => ({ ...problem,
      next_attempt_at: problem.state === "pending" ? iso(problem.next_attempt_at as number) : null })),
  };
};

/** Re-arms a destination's failed notifications after its cause is fixed. Returns how many. */
export const retryNotifications = async (db: QueryDatabase, destination: Destination, now: number): Promise<number> =>
  (await db.prepare(`UPDATE notification SET state = 'pending', attempts = 0, next_attempt_at = ?, error_code = NULL, changed_at = ?
    WHERE destination = ? AND state = 'failed' RETURNING source_id`).bind(now, now, destination).all()).results.length;
