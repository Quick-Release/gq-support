import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations } from "effect/References";
import { admitOperation, contained, finishOperation } from "./maintenance.ts";
import type { QueryDatabase } from "./storage.ts";

// Exact producer names only. Neither messages nor annotation values cross this boundary.
export const SIGNALS = {
  "GitHub webhook rejected": "webhook_rejected",
  "Support delivery requires review": "delivery_review",
  "Repository mapping suspended": "mapping_suspended",
  "Repository suspension not recorded": "suspension_write_failed",
  "Support status refresh is behind": "refresh_lag",
  "Support status refresh age": "refresh_lag",
  "Support status refresh retry": "refresh_retry",
  "Support status tracking lost": "tracking_lost",
  "Support status sweep is behind": "sweep_lag",
  "Support status sweep skipped a repository": "mapping_conflict",
  "Support status sweep skipped conflicting historical installations": "historical_conflict",
  "Suspended repository verified safe; Operator lift required": "mapping_lift_review",
  "Support status sweep failed for a repository": "repository_sweep_failed",
  "Support cleanup requires review": "cleanup_review",
  "Support cleanup step failed": "cleanup_step_failed",
  "Support delivery sweep failed": "delivery_sweep_failed",
  "Support cleanup sweep failed": "cleanup_sweep_failed",
  "Support status refresh failed": "refresh_failed",
  "Support status sweep failed": "sweep_failed",
  "Support scheduled tick failed": "tick_failed",
  "Support webhook status refresh failed": "webhook_refresh_failed",
} as const;
const DELIVERY_CLASSES = {
  PermissionMissing: "delivery_permission", AppAuthenticationFailed: "delivery_configuration",
  MappingUnavailable: "delivery_configuration", InstallationUnavailable: "delivery_configuration",
  DeliveryDeadline: "delivery_deadline", ReconciliationPending: "delivery_ambiguity",
} as const;
export type Signal = typeof SIGNALS[keyof typeof SIGNALS] | typeof DELIVERY_CLASSES[keyof typeof DELIVERY_CLASSES];
const classes = new Set<string>([...Object.values(SIGNALS), ...Object.values(DELIVERY_CLASSES)]);
const MINUTE = 60_000;
const RETENTION = 7 * 24 * 60 * MINUTE;
export interface AlertConfig {
  enabled: boolean;
  stage: "staging" | "prod";
  release: string;
  webhook?: string;
}
export const webhookURL = (value: unknown): string | null => {
  // Canonical ASCII only: no user info, ports, query, fragments, escapes or alternate hosts.
  if (typeof value !== "string" || !/^https:\/\/discord\.com\/api\/webhooks\/[1-9][0-9]{0,19}\/[A-Za-z0-9_-]{60,100}$/.test(value)) return null;
  return `${value}?wait=true`;
};
export const alertConfig = (env: Record<string, unknown>, slug: string): AlertConfig => ({
  enabled: env.DISCORD_ALERTS_ENABLED === "true" && ["getquick-support-staging", "getquick-support"].includes(slug),
  stage: slug === "getquick-support-staging" ? "staging" : "prod",
  release: typeof env.DISCORD_ALERT_RELEASE === "string" && /^[a-f0-9]{40}$/.test(env.DISCORD_ALERT_RELEASE)
    ? env.DISCORD_ALERT_RELEASE : "unrecorded",
  webhook: typeof env.DISCORD_ALERT_WEBHOOK_URL === "string" ? env.DISCORD_ALERT_WEBHOOK_URL : undefined,
});

/** Invocation-local, fixed-cardinality aggregation; no asynchronous I/O inside the logger. */
export function collectAlerts() {
  const events = new Map<Signal, { active: boolean; count: number }>();
  const logger = Logger.make<unknown, void>(({ message, fiber }) => {
    const name = Array.isArray(message) && message.length === 1 ? message[0] : message;
    if (typeof name !== "string" || !Object.hasOwn(SIGNALS, name)) return;
    const annotations = fiber.getRef(CurrentLogAnnotations);
    const outcome = annotations.outcome;
    const signal = name === "Support delivery requires review" && typeof outcome === "string" && Object.hasOwn(DELIVERY_CLASSES, outcome)
      ? DELIVERY_CLASSES[outcome as keyof typeof DELIVERY_CLASSES] : SIGNALS[name as keyof typeof SIGNALS];
    // Only the global refresh-age observation can prove this aggregate condition recovered.
    const recovery = name === "Support status refresh age" && annotations.alert === false;
    if (!recovery && annotations.alert !== true && !name.endsWith("failed") && name !== "GitHub webhook rejected") return;
    const previous = events.get(signal);
    events.set(signal, { active: !recovery, count: Math.min(999999, (previous?.count ?? 0) + 1) });
  });
  return {
    layer: Logger.layer([logger], { mergeWithExisting: true }),
    persist: async (db: QueryDatabase, config: AlertConfig, now = Date.now()) => {
      if (!config.enabled || !webhookURL(config.webhook)) return;
      // Called in an independently admitted background operation, never intake's response path.
      for (const [signal, event] of events) await observeAlert(db, signal, event.active, event.count, now);
    },
  };
}

/** Stage database + finite class is the proposed incident key; no Reporter dimensions. */
export async function observeAlert(db: QueryDatabase, signal: Signal, active: boolean, count: number, now: number) {
  if (!classes.has(signal) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(count)) return;
  await db.prepare(`INSERT INTO discord_alert (signal, active, count, first_at, last_at, version)
    SELECT ?, 1, ?, ?, ?, 1 WHERE ? = 1
    ON CONFLICT(signal) DO UPDATE SET
      version = discord_alert.version + CASE WHEN discord_alert.active != ? THEN 1 ELSE 0 END,
      attempts = CASE WHEN discord_alert.active != ? THEN 0 ELSE discord_alert.attempts END,
      active = ?, count = MIN(999999, discord_alert.count + excluded.count), last_at = excluded.last_at`)
    .bind(signal, Math.max(1, Math.min(999999, Math.trunc(count))), now, now, active ? 1 : 0, active ? 1 : 0, active ? 1 : 0, active ? 1 : 0).run();
  // Recovery must not manufacture an incident when no active observation exists.
  if (!active) await db.prepare(`UPDATE discord_alert SET version = version + 1, attempts = 0, active = 0, last_at = ?
    WHERE signal = ? AND active = 1`).bind(now, signal).run();
}
interface Row { signal: Signal; active: number; count: number; first_at: number; last_at: number; version: number; attempts: number }

/** At most one POST per minute across competing isolates. Unknown delivery latches the route closed. */
export async function drainAlerts(main: QueryDatabase, ledger: QueryDatabase, config: AlertConfig,
  request: typeof fetch = fetch, now = Date.now(), clock = Date.now) {
  const url = config.enabled ? webhookURL(config.webhook) : null;
  if (!url || !["prod", "staging"].includes(config.stage) || !/^(?:[a-f0-9]{40}|unrecorded)$/.test(config.release)) return;
  await Effect.runPromise(contained(main, ledger, Effect.promise(async () => {
    const owner = crypto.randomUUID();
    const lock = await ledger.prepare(`UPDATE discord_alert_control SET owner = ?, next_at = ?
      WHERE id = 1 AND owner IS NULL AND blocked = 0 AND next_at <= ? RETURNING id`)
      .bind(owner, now + MINUTE, now).first();
    if (!lock) return;
    // A lost drain owner never silently expires. No D1 restore rewinds this independent state.
    await ledger.prepare("DELETE FROM discord_alert WHERE last_at < ?").bind(now - RETENTION).run();
    const row = await ledger.prepare(`SELECT * FROM discord_alert WHERE sent_version < version AND attempts < 3
      ORDER BY first_at, signal LIMIT 1`).first<Row>();
    if (!row) { await unlock(ledger, owner); return; }
    if (!classes.has(row.signal) || ![0, 1].includes(row.active) ||
        ![row.count, row.first_at, row.last_at, row.version, row.attempts].every(Number.isSafeInteger) ||
        row.count < 1 || row.count > 999999 || row.first_at < 0 || row.last_at < row.first_at) { await block(ledger, owner); return; }
    const operation = await admitOperation(ledger, "provider", "discord-alert");
    if (!operation) { await unlock(ledger, owner); return; }
    await ledger.prepare("UPDATE discord_alert SET attempts = attempts + 1 WHERE signal = ?").bind(row.signal).run();
    let response: Response;
    try {
      response = await request(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(2_000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          content: `Support ${row.active ? "incident" : "recovery"}: ${row.signal}; stage=${config.stage}; release=${config.release}; count=${row.count}; first_ms=${row.first_at}; last_ms=${row.last_at}`,
          allowed_mentions: { parse: [] },
        }) });
    } catch {
      // The notification may have posted, but it cannot mutate SupportDB or
      // replay its data. Latch alert uncertainty locally, not in restore drain.
      await block(ledger, owner);
      await finishOperation(ledger, operation);
      return;
    }
    const receivedAt = Math.max(now, clock());
    // Never consume or log the upstream body, including on errors.
    await response.body?.cancel().catch(() => undefined);
    // Local notification I/O has settled; its unknown remote receipt is kept
    // in discord_alert_control. The enclosing runtime still owns local writes.
    await finishOperation(ledger, operation);
    if (response.status === 200) {
      await ledger.prepare("UPDATE discord_alert SET sent_version = ?, attempts = 0 WHERE signal = ?").bind(row.version, row.signal).run();
      const remaining = response.headers.get("X-RateLimit-Remaining");
      const reset = seconds(response.headers.get("X-RateLimit-Reset-After"), receivedAt);
      if (remaining === "0") {
        if (reset === null) { await block(ledger, owner); return; }
        await defer(ledger, owner, receivedAt + Math.max(MINUTE, reset));
      } else await unlock(ledger, owner);
    } else if (response.status === 429) {
      const retry = seconds(response.headers.get("Retry-After"), receivedAt);
      // Header is the documented alternative to body.retry_after. Unsupported/missing header fails closed.
      if (retry === null) await block(ledger, owner);
      else await defer(ledger, owner, receivedAt + Math.max(MINUTE, retry));
    } else {
      // Unsupported outcomes stop this notification route without obstructing
      // support recovery. Existing GitHub write obstructions are unchanged.
      await block(ledger, owner);
    }
  }), undefined));
}
const seconds = (value: string | null, receivedAt: number): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const ms = Math.ceil(Number(value) * 1000);
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER - receivedAt ? ms : null;
};
const unlock = async (db: QueryDatabase, owner: string) => { await db.prepare("UPDATE discord_alert_control SET owner = NULL WHERE owner = ?").bind(owner).run(); };
const defer = async (db: QueryDatabase, owner: string, next: number) => { await db.prepare("UPDATE discord_alert_control SET next_at = ?, owner = NULL WHERE owner = ?").bind(next, owner).run(); };
const block = async (db: QueryDatabase, owner: string) => { await db.prepare("UPDATE discord_alert_control SET blocked = 1, owner = NULL WHERE owner = ?").bind(owner).run(); };

/** Background/Cron adapter. A notification-store failure cannot change support delivery. */
export const recordAlerts = <A, E, R>(work: Effect.Effect<A, E, R>, main: QueryDatabase, ledger: QueryDatabase, config: AlertConfig) =>
  Effect.suspend(() => {
    const collector = collectAlerts();
    return work.pipe(Effect.provide(collector.layer), Effect.onExit(() => persistCollected(collector, main, ledger, config)));
  });
export const persistCollected = (collector: ReturnType<typeof collectAlerts>, main: QueryDatabase, ledger: QueryDatabase, config: AlertConfig) =>
  !config.enabled || !webhookURL(config.webhook) ? Effect.void :
  contained(main, ledger, Effect.promise(() => collector.persist(ledger, config)), undefined).pipe(
    Effect.catchCause(() => Effect.logError("Support alert state unavailable")),
  );
