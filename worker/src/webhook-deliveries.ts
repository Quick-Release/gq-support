import * as Effect from "effect/Effect";
import { GitHubReader } from "./github-gateway.ts";
import { metricStatement } from "./operational-metrics.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Webhook delivery health from GitHub's own delivery log (#138). GitHub records
 * every delivery it sent and the status our receiver answered, so these counts
 * hold only genuine deliveries: a forged request never reaches them, and the
 * receiver never writes to D1 for a delivery it rejects. A 5xx answered while
 * D1 was down is counted once storage is back; detecting that outage while it
 * lasts belongs to the independent checker (docs/runbooks/support-operations.md).
 *
 * Each minute's scan counts the deliveries after the last counted one, from
 * GitHub's most recent page, and advances its mark in the same D1 batch.
 */
export const scanWebhookDeliveries = (db: QueryDatabase, now: number) => Effect.gen(function* () {
  // While GitHub has asked the service to wait, the log keeps: it is read once the wait is over.
  const waiting = yield* Effect.tryPromise(() => db.prepare("SELECT 1 FROM delivery_permit WHERE provider_cooldown_until > ? LIMIT 1")
    .bind(now).first());
  if (waiting) return 0;
  const reader = yield* GitHubReader;
  const deliveries = yield* reader.listHookDeliveries();
  return yield* Effect.tryPromise(async () => {
    const mark = await db.prepare("SELECT delivered_through, guids FROM webhook_delivery_scan WHERE id = 1").bind()
      .first<{ delivered_through: number; guids: string }>();
    const through = mark?.delivered_through ?? 0;
    const seen = new Set<string>(mark ? JSON.parse(mark.guids) as string[] : []);
    const fresh = deliveries.filter((delivery) => delivery.deliveredAt > through ||
      (delivery.deliveredAt === through && !seen.has(delivery.guid)));
    if (fresh.length === 0) return 0;
    const latest = Math.max(through, ...fresh.map((delivery) => delivery.deliveredAt));
    const guids = [...(latest === through ? seen : []), ...fresh.filter((delivery) => delivery.deliveredAt === latest).map((delivery) => delivery.guid)];
    await db.batch([
      ...fresh.map((delivery) => metricStatement(db, { metric: "webhook", outcome: outcomeOf(delivery.statusCode) }, { at: delivery.deliveredAt })),
      // Only the scan that read the previous mark may move it, so a concurrent scan cannot count the same deliveries.
      db.prepare(`INSERT INTO webhook_delivery_scan (id, delivered_through, guids) VALUES (1, ?, ?)
        ON CONFLICT (id) DO UPDATE SET delivered_through = excluded.delivered_through, guids = excluded.guids
        WHERE webhook_delivery_scan.delivered_through = ? AND webhook_delivery_scan.guids = ?`)
        .bind(latest, JSON.stringify(guids), through, mark?.guids ?? "[]"),
    ]);
    return fresh.length;
  });
});

/** Acknowledged, rejected as unauthenticated (401), or failed: a 5xx, no response, or anything else. */
const outcomeOf = (status: number) => status >= 200 && status < 300 ? "accepted" : status === 401 ? "rejected" : "failed";
