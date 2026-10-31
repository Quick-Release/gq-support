import { readBody } from "./request-body.ts";
import { CHECKER_SIGNATURE, verifySignature } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * The independent checker's service boundary (#139; docs/support-operations-design.md).
 * The checker runs outside this Worker, on GitHub Actions (scripts/independent-check.ts),
 * so a dead Worker, D1 or dashboard need not report its own failure. It holds
 * its own narrow identity: a key registered here, which can only read the
 * probe and report what it observed. It is never staff, Operator or
 * installation authority, and a staff or installation key never verifies here.
 */
export interface CheckerAccess {
  /** Registered checker key IDs and their raw Ed25519 public keys, base64. */
  readonly keys: ReadonlyMap<string, string>;
}
export const NO_CHECKER_ACCESS: CheckerAccess = { keys: new Map() };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
/** The stage's checker keys, from `OPERATIONS_CHECKER_KEYS` (a JSON object of key ID to public key). Malformed closes both routes. */
export const checkerAccess = (keys: string): CheckerAccess => {
  try {
    const parsed: unknown = JSON.parse(keys || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHECKER_ACCESS;
    const entries = Object.entries(parsed);
    if (entries.some(([id, key]) => !ID.test(id) || typeof key !== "string" || !PUBLIC_KEY.test(key))) return NO_CHECKER_ACCESS;
    return { keys: new Map(entries as [string, string][]) };
  } catch {
    return NO_CHECKER_ACCESS;
  }
};

/** Whether the service's own notification and GitHub configuration is present; values are never exposed. */
export interface ServiceConfiguration { readonly github_app: boolean; readonly operational_incidents: boolean }

export interface ServiceOptions {
  readonly checker: CheckerAccess;
  readonly ledger: QueryDatabase;
  /** The restore gate (src/ledger.ts): false until a recorded restore has been replayed. */
  readonly restored: (db: QueryDatabase, ledger: QueryDatabase) => Promise<boolean>;
  readonly configuration: ServiceConfiguration;
}

export const PROBE_PATH = "/v1/operations/checker/probe";
const STORAGE_TIMEOUT_MS = 2_000;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json({ code: "checker_unauthorized" }, 401);

const authenticated = async (request: Request, body: string, access: CheckerAccess, now: number) => {
  const publicKey = access.keys.get(request.headers.get(CHECKER_SIGNATURE.keyId) ?? "");
  return !!publicKey && ID.test(request.headers.get(CHECKER_SIGNATURE.principal) ?? "") &&
    await verifySignature(request, body, publicKey, now, CHECKER_SIGNATURE);
};

/** True when one trivial read answers within its bound. */
const answers = async (db: QueryDatabase) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      db.prepare("SELECT 1 AS ok").first<{ ok: number }>().then((row) => row?.ok === 1),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), STORAGE_TIMEOUT_MS); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The narrow health probe, answered before the restore gate and recording
 * nothing of its own (the gate may run its pending replay, as for any request),
 * so it works while storage is down: whether this Worker answers,
 * whether the main database and suppression ledger each answer a trivial read,
 * whether the restore gate is open, and whether the service's configuration is
 * present. Signature only: a replayed probe reveals nothing beyond these states,
 * and a replay record would need the D1 under test. No record or value is read.
 */
export const handleProbe = async (request: Request, db: QueryDatabase, options: ServiceOptions, now: number): Promise<Response> => {
  try {
    if (request.method !== "GET" || new URL(request.url).search) return json({ code: "not_found" }, 404);
    const body = await readBody(request, 0);
    if (body !== "" || !await authenticated(request, "", options.checker, now)) return unauthorized();
    const [main, ledger] = await Promise.all([answers(db), answers(options.ledger)]);
    const gate = main && ledger ? await options.restored(db, options.ledger).catch(() => null) : null;
    const present = (value: boolean) => value ? "configured" : "missing";
    return json({
      worker: "ok", support_db: main ? "ok" : "unavailable", suppression_ledger: ledger ? "ok" : "unavailable",
      restore_gate: gate === null ? "unknown" : gate ? "open" : "pending",
      configuration: { github_app: present(options.configuration.github_app),
        operational_incidents: present(options.configuration.operational_incidents) },
      observed_at: new Date(now).toISOString(),
    });
  } catch {
    return json({ code: "service_unavailable" }, 503);
  }
};

/** What the checker observes, each separately: an outage of one never implies another. */
export const COMPONENTS = ["worker", "support_db", "suppression_ledger", "restore_gate", "service_configuration", "github",
  "dashboard", "discord"] as const;
export type Component = typeof COMPONENTS[number];
export type ComponentState = "healthy" | "failing" | "unknown";
/** Bounded observation codes; no response body, URL or exception text is ever reported. */
export const CODES = ["ok", "transport_failed", "timeout", "http_error", "invalid_response", "unauthorized", "unavailable",
  "pending", "missing", "rate_limited", "destination_rejected", "not_configured", "not_observed"] as const;
export type Code = typeof CODES[number];

export const REPORT_PATH = "/v1/operations/checker/report";
const BODY_BYTES = 8192;
/** The checker keeps unreconciled episodes this long (scripts/independent-check.ts); older evidence is refused. */
export const EPISODE_RETENTION_MS = 7 * 86_400_000;
const SKEW_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Episode { id: string; component: Component; code: Code; first: number; last: number; recovered: number | null }
interface Report { observed: number; components: { component: Component; state: ComponentState; code: Code }[]; episodes: Episode[] }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
/** Strictly parses a report, or null: anything unexpected refuses the whole report rather than recording part of it. */
const parseReport = (body: string, now: number): Report | null => {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  // Recent evidence only; an outage may have begun before the retention window.
  const time = (value: unknown, oldest = now - EPISODE_RETENTION_MS) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed <= now + SKEW_MS && parsed >= oldest ? parsed : null;
  };
  if (!isObject(data) || !keys(data, ["observed_at", "components", "episodes"]) || !Array.isArray(data.components) ||
    !Array.isArray(data.episodes) || data.components.length > COMPONENTS.length || data.episodes.length > 20) return null;
  const observed = time(data.observed_at);
  if (observed === null) return null;
  const components: Report["components"] = [];
  for (const item of data.components) {
    if (!isObject(item) || !keys(item, ["component", "state", "code"]) || !COMPONENTS.includes(item.component as Component) ||
      !["healthy", "failing", "unknown"].includes(item.state as string) || !CODES.includes(item.code as Code) ||
      components.some(({ component }) => component === item.component)) return null;
    components.push(item as Report["components"][number]);
  }
  const episodes: Episode[] = [];
  for (const item of data.episodes) {
    if (!isObject(item) || !keys(item, ["id", "component", "code", "first_failed_at", "last_failed_at", "recovered_at"]) ||
      typeof item.id !== "string" || !UUID.test(item.id) || !COMPONENTS.includes(item.component as Component) ||
      !CODES.includes(item.code as Code) || episodes.some(({ id }) => id === item.id)) return null;
    const first = time(item.first_failed_at, 0), last = time(item.last_failed_at);
    const recovered = item.recovered_at === null ? null : time(item.recovered_at);
    if (first === null || last === null || last < first || (item.recovered_at !== null && (recovered === null || recovered < last))) return null;
    episodes.push({ id: item.id, component: item.component as Component, code: item.code as Code, first, last, recovered });
  }
  return { observed, components, episodes };
};

/**
 * Records one checker report, once storage is back: each component's latest
 * state, and each outage episode reconciled into the component's open
 * `component_unavailable` incident, opening one when none is open. An episode
 * already recorded only extends its own incident while that stays open, so a
 * resent report, or one retried after a lost response, never opens another.
 * A healthy component ends its earlier episodes, so an incident stays
 * resolvable when the checker has lost or expired the episode it opened.
 * Request IDs are single-use for 10 minutes, as for the operations API.
 */
export const handleReport = async (request: Request, db: QueryDatabase, access: CheckerAccess, now: number): Promise<Response> => {
  try {
    if (request.method !== "POST" || new URL(request.url).search) return json({ code: "not_found" }, 404);
    const body = await readBody(request, BODY_BYTES);
    if (body === null) return json({ code: "request_too_large" }, 413);
    if (!await authenticated(request, body, access, now)) return unauthorized();
    const report = parseReport(body, now);
    if (!report) return json({ code: "invalid_request" }, 400);
    const keyId = request.headers.get(CHECKER_SIGNATURE.keyId);
    const [, nonce] = await db.batch([
      db.prepare("DELETE FROM replay WHERE rowid IN (SELECT rowid FROM replay WHERE expires_at < ? LIMIT 100)").bind(now),
      db.prepare("INSERT INTO replay (key_id, request_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (key_id, request_id) DO NOTHING")
        .bind(`checker:${keyId}`, request.headers.get(CHECKER_SIGNATURE.requestId), now + 600_000),
    ]);
    if (nonce!.meta.changes !== 1) return unauthorized();
    const statements = report.components.map(({ component, state, code }) => db.prepare(`INSERT INTO independent_component
      (component, state, code, observed_at, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (component) DO UPDATE SET
      state = excluded.state, code = excluded.code, observed_at = excluded.observed_at, received_at = excluded.received_at
      WHERE excluded.observed_at >= independent_component.observed_at`).bind(component, state, code, report.observed, now));
    // A healthy observation ends every earlier episode of its component, including one the checker no longer holds.
    for (const { component } of report.components.filter(({ state }) => state === "healthy")) {
      statements.push(db.prepare(`UPDATE independent_episode SET recovered_at = ?
        WHERE component = ? AND recovered_at IS NULL AND last_failed_at <= ?`).bind(report.observed, component, report.observed));
    }
    for (const episode of report.episodes) {
      const id = crypto.randomUUID();
      const known = "EXISTS (SELECT 1 FROM independent_episode WHERE id = ?)";
      statements.push(
        // A new episode opens the component's incident, or groups into the one already open.
        db.prepare(`INSERT INTO incident (id, category, subject, state, first_observed_at, last_observed_at, detail)
          SELECT ?, 'component_unavailable', ?, 'open', ?, ?, ? WHERE NOT ${known}
          ON CONFLICT (category, subject) WHERE state = 'open' DO UPDATE SET
            first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
            last_observed_at = MAX(last_observed_at, excluded.last_observed_at)`)
          .bind(id, episode.component, episode.first, episode.last, episode.component, episode.id),
        db.prepare(`INSERT INTO incident_audit (id, incident_id, actor, via, action, previous_state, new_state, occurred_at)
          SELECT ?, id, 'service', 'service', 'open', NULL, 'open', ? FROM incident WHERE id = ?`).bind(crypto.randomUUID(), now, id),
        db.prepare(`INSERT INTO independent_episode (id, component, code, first_failed_at, last_failed_at, recovered_at, incident_id, received_at)
          SELECT ?, ?, ?, ?, ?, ?, i.id, ? FROM incident i
          WHERE i.category = 'component_unavailable' AND i.subject = ? AND i.state = 'open' AND NOT ${known}`)
          .bind(episode.id, episode.component, episode.code, episode.first, episode.last, episode.recovered, now, episode.component, episode.id),
        // A known episode: its latest evidence. A recovery, once reported, stands.
        db.prepare(`UPDATE independent_episode SET last_failed_at = MAX(last_failed_at, ?), code = ?,
          recovered_at = COALESCE(recovered_at, ?) WHERE id = ?`).bind(episode.last, episode.code, episode.recovered, episode.id),
        db.prepare(`UPDATE incident SET last_observed_at = MAX(last_observed_at, ?)
          WHERE state = 'open' AND id = (SELECT incident_id FROM independent_episode WHERE id = ?)`).bind(episode.last, episode.id),
      );
    }
    if (statements.length) await db.batch(statements);
    const linked = report.episodes.length ? (await db.prepare(`SELECT id, incident_id FROM independent_episode
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(JSON.stringify(report.episodes.map(({ id }) => id)))
      .all<{ id: string; incident_id: string }>()).results : [];
    return json({ episodes: report.episodes.map(({ id }) => ({ id, incident_id: linked.find((row) => row.id === id)?.incident_id ?? null })) });
  } catch {
    // Neither SQL errors nor report data enter logs or responses.
    return json({ code: "service_unavailable" }, 503);
  }
};
