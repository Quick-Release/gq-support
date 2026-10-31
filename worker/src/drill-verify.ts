import type { QueryDatabase } from "./storage.ts";

/**
 * `operator drill-verify webhook <ISO-start>` (#138): checks the broken-webhook
 * drill's evidence in durable records only, never by contacting GitHub or
 * Discord. Each step is `observed` or `absent`; the verdict is `passed` only
 * when GitHub's failed deliveries opened a webhook incident after the start,
 * its Discord notification was sent, a later delivery was acknowledged, and a
 * team member resolved it. This is evidence for the human sign-off, not a
 * substitute for it, and a passing local run is not staging evidence.
 */
export const verifyWebhookDrill = async (db: QueryDatabase, since: number) => {
  const incident = await db.prepare(`SELECT id, category, first_observed_at, state, claimant, resolved_at FROM incident
    WHERE category IN ('webhook_rejected', 'webhook_failed') AND first_observed_at >= ? ORDER BY first_observed_at, id LIMIT 1`)
    .bind(since).first<{ id: string; category: string; first_observed_at: number; state: string; claimant: string | null;
      resolved_at: number | null }>();
  const notification = incident && await db.prepare(`SELECT state, sent_transition, sent_at FROM notification
    WHERE source_kind = 'incident' AND source_id = ? AND destination = 'operational_incidents'`).bind(incident.id)
    .first<{ state: string; sent_transition: string | null; sent_at: number | null }>();
  // GitHub's delivery log: an acknowledged delivery after the drill's last failed one.
  const deliveries = await db.prepare(`SELECT MAX(CASE WHEN outcome = 'accepted' THEN last_at END) AS accepted,
      MAX(CASE WHEN outcome != 'accepted' THEN last_at END) AS failed
    FROM operational_metric WHERE metric = 'webhook' AND last_at >= ?`).bind(since).first<{ accepted: number | null; failed: number | null }>();
  const iso = (time: number) => new Date(time).toISOString();
  const recovered = incident && deliveries?.accepted != null && deliveries.failed != null && deliveries.accepted > deliveries.failed;
  const checks = {
    incident: incident ? { state: "observed", id: incident.id, category: incident.category, first_observed_at: iso(incident.first_observed_at) }
      : { state: "absent" },
    notification: !notification ? { state: "absent" } : notification.sent_transition !== null
      ? { state: "sent", transition: notification.sent_transition, sent_at: iso(notification.sent_at!) }
      : { state: notification.state },
    recovery: recovered ? { state: "observed", accepted_at: iso(deliveries.accepted!) } : { state: "absent" },
    resolution: incident?.state === "resolved"
      ? { state: "observed", claimant: incident.claimant, resolved_at: iso(incident.resolved_at!) } : { state: "absent" },
  };
  const passed = Object.values(checks).every((check) => check.state === "observed" || check.state === "sent");
  return { drill: "broken_webhook", since: iso(since), verdict: passed ? "passed" : "incomplete", checks };
};
