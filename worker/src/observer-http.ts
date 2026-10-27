import type { QueryDatabase } from "./storage.ts";
import { decodeObserverSnapshot, exact, finiteInt, enumValue, release } from "./observer-snapshot.ts";

const readiness = "/internal/observer/v1/readiness", snapshot = "/internal/observer/v1/snapshot";
export const observerPath = (path: string) => path === readiness || path === snapshot;
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store", Pragma: "no-cache", Vary: "Authorization", "X-Content-Type-Options": "nosniff" };
const response = (body: unknown, status = 200) => Response.json(body, { status, headers });
const unavailable = () => response({ code: "observer_unavailable" }, 503);
export const validObserverToken = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Crypto extension is checked per invocation; unsupported runtimes fail closed.
 * No key/digest cache survives a request or rotation. */
async function authorized(request: Request, env: Record<string, unknown>): Promise<boolean> {
  const token = request.headers.get("authorization");
  if (!validObserverToken(env.SUPPORT_OBSERVER_READ_TOKEN) || !token || !/^Bearer [a-f0-9]{64}$/.test(token)) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  if (typeof subtle.timingSafeEqual !== "function") return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([subtle.digest("SHA-256", encoder.encode(token.slice(7))),
    subtle.digest("SHA-256", encoder.encode(env.SUPPORT_OBSERVER_READ_TOKEN))]);
  return subtle.timingSafeEqual(a, b);
}

/** One fixed SELECT in a single D1 batch: controls and all 240 cells share the
 * same statement snapshot. Substrings bound corrupt text before it crosses D1.
 * Count + LIMIT rejects excess cells rather than silently truncating them. */
const sql = `SELECT
 (SELECT CASE WHEN typeof(generation) = 'integer' THEN generation ELSE -1 END FROM maintenance_control WHERE id = 1) AS generation,
 (SELECT substr(mode, 1, 9) FROM maintenance_control WHERE id = 1) AS maintenance,
 (SELECT CASE WHEN typeof(watermark) = 'integer' THEN watermark ELSE -1 END FROM cron_progress_control WHERE id = 1) AS watermark,
 (SELECT CASE WHEN typeof(partial) = 'integer' THEN partial ELSE -1 END FROM cron_progress_control WHERE id = 1) AS partial,
 (SELECT CASE WHEN typeof(blocked) = 'integer' THEN blocked ELSE -1 END FROM discord_alert_control WHERE id = 1) AS blocked,
 (SELECT CASE WHEN typeof(next_at) = 'integer' THEN next_at ELSE -1 END FROM discord_alert_control WHERE id = 1) AS next_at,
 (SELECT COUNT(*) FROM cron_progress) AS count,
 (SELECT json_group_array(json_array(substr(stage, 1, 8), substr(candidate, 1, 41), generation, minute, attempt, started, terminal,
   CASE outcome WHEN 'settled' THEN 0 WHEN 'failed' THEN 1 WHEN 'interrupted' THEN 2 ELSE CASE WHEN outcome IS NULL THEN NULL ELSE -1 END END,
   CASE delivery WHEN 'not_run' THEN 0 WHEN 'ok' THEN 1 WHEN 'failed' THEN 2 WHEN 'timed_out' THEN 3 WHEN 'contained' THEN 4 ELSE -1 END,
   CASE cleanup WHEN 'not_run' THEN 0 WHEN 'ok' THEN 1 WHEN 'failed' THEN 2 WHEN 'timed_out' THEN 3 WHEN 'contained' THEN 4 ELSE -1 END,
   CASE refresh WHEN 'not_run' THEN 0 WHEN 'ok' THEN 1 WHEN 'failed' THEN 2 WHEN 'timed_out' THEN 3 WHEN 'contained' THEN 4 ELSE -1 END,
   CASE sweep WHEN 'not_run' THEN 0 WHEN 'ok' THEN 1 WHEN 'failed' THEN 2 WHEN 'timed_out' THEN 3 WHEN 'contained' THEN 4 ELSE -1 END,
   CASE drain WHEN 'not_run' THEN 0 WHEN 'ok' THEN 1 WHEN 'failed' THEN 2 WHEN 'timed_out' THEN 3 WHEN 'contained' THEN 4 ELSE -1 END))
 FROM (SELECT CASE WHEN stage IN ('staging', 'prod') THEN stage ELSE '' END AS stage,
 CASE WHEN length(candidate) = 40 AND candidate NOT GLOB '*[^a-f0-9]*' THEN candidate ELSE '' END AS candidate,
 CASE WHEN typeof(generation) = 'integer' THEN generation ELSE -1 END AS generation,
 CASE WHEN typeof(minute) = 'integer' THEN minute ELSE -1 END AS minute,
 CASE WHEN typeof(attempt) = 'integer' THEN attempt ELSE -1 END AS attempt,
 CASE WHEN typeof(started) = 'integer' THEN started ELSE -1 END AS started,
 CASE WHEN terminal IS NULL OR typeof(terminal) = 'integer' THEN terminal ELSE -1 END AS terminal,
 outcome, delivery, cleanup, refresh, sweep, drain
 FROM cron_progress ORDER BY minute, attempt LIMIT 240)) AS ticks`;

export async function observerRequest(request: Request, env: Record<string, unknown>, ledger: () => Promise<QueryDatabase | undefined>): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (!observerPath(url.pathname)) return response({ code: "not_found" }, 404);
    if (request.method !== "GET") return response({ code: "method_not_allowed" }, 405);
    if (request.url.includes("?") || request.url.includes("#") || url.search || url.hash || url.username || url.password || request.body !== null || request.headers.has("cookie") ||
      request.headers.has("origin") || request.headers.has("content-length") || request.headers.has("transfer-encoding")) return response({ code: "invalid_observer_request" }, 400);
    // Route/runtime execution only: no storage, App, Cron, Discord or binding-health assertion.
    if (url.pathname === readiness) return response({ version: 1, check: "route_runtime", result: "available" });
    if (env.SUPPORT_OBSERVER_ENABLED !== "true") return response({ code: "not_found" }, 404);
    if (!await authorized(request, env)) return response({ code: "observer_denied" }, 401);
    const stage = enumValue(env.SUPPORT_RELEASE_STAGE, ["staging", "prod"]), candidate = release(env.SUPPORT_RELEASE_CANDIDATE);
    if (env.SUPPORT_OBSERVER_STAGE !== stage || env.SUPPORT_OBSERVER_RELEASE !== candidate) return unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Cooperative timeout: D1 cannot be cancelled; this path performs SELECT only.
      const body = await Promise.race([ (async () => {
        const db = await ledger(); if (!db) throw new Error();
        const result = await db.batch([db.prepare(sql)]);
        if (result.length !== 1 || !result[0].success || result[0].results.length !== 1) throw new Error();
        const row = exact(result[0].results[0], ["generation", "maintenance", "watermark", "partial", "blocked", "next_at", "count", "ticks"]);
        const partial = finiteInt(row.partial, 1), blocked = finiteInt(row.blocked, 1), next = finiteInt(row.next_at);
        finiteInt(row.count, 240);
        if (typeof row.ticks !== "string" || new TextEncoder().encode(row.ticks).byteLength > 60 * 1024) throw new Error();
        const ticks: unknown = JSON.parse(row.ticks);
        if (!Array.isArray(ticks) || ticks.length !== row.count) throw new Error();
        const generated = Date.now();
        const route = env.DISCORD_ALERTS_ENABLED === "false" || env.DISCORD_ALERTS_ENABLED === undefined ? "disabled" :
          env.DISCORD_ALERTS_ENABLED !== "true" || env.DISCORD_ALERT_RELEASE !== candidate || typeof env.DISCORD_ALERT_WEBHOOK_URL !== "string" || !env.DISCORD_ALERT_WEBHOOK_URL ? "blocked_unknown" :
          blocked ? "blocked_unknown" : next > generated ? "rate_limited" : "ready";
        const dto = decodeObserverSnapshot({ version: 1, generated, stage, candidate, generation: row.generation, maintenance: row.maintenance,
          watermark: row.watermark, partial: !!partial, activation: null, coverage: "unknown", route, ticks }, generated);
        const bytes = JSON.stringify(dto); if (new TextEncoder().encode(bytes).byteLength > 65536) throw new Error();
        return dto;
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 250); }) ]);
      return response(body);
    } finally { clearTimeout(timer); }
  } catch { return unavailable(); }
}
