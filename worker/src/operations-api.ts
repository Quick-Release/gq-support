import { readBody } from "./installation-api.ts";
import { claimIncident, findIncident, isResolution, listIncidents, resolveIncident } from "./incidents.ts";
import { slotInventory, type StageInventory } from "./inventory.ts";
import { notificationStatus, type Destination } from "./notifications.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";
import { OPERATIONS_SIGNATURE, verifySignature } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * The authenticated operations API (docs/support-operations-design.md): the one
 * service boundary through which a staff dashboard, such as Banquinha, views,
 * claims and resolves Operational incidents, and sees Discord notification
 * delivery health. The dashboard signs each request
 * with a key registered here and names the GETQUICK team member it has
 * authenticated; this Worker then checks that member against its own staff
 * roster. An Installation credential, a Discord identity or a dashboard key
 * alone is never authority. No route here performs recovery: that stays with
 * the independently authorized Operator CLI.
 */
export interface OperationsAccess {
  /** Registered dashboard key IDs and their raw Ed25519 public keys, base64. */
  readonly keys: ReadonlyMap<string, string>;
  /** Opaque actor IDs of authenticated GETQUICK team members. */
  readonly staff: ReadonlySet<string>;
}
export const NO_OPERATIONS_ACCESS: OperationsAccess = { keys: new Map(), staff: new Set() };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
/**
 * The access configured for a stage, from `OPERATIONS_API_KEYS` (a JSON object
 * of key ID to public key) and `OPERATIONS_STAFF` (comma-separated actor IDs).
 * Any malformed entry closes the whole API rather than admitting a partial list.
 */
export const operationsAccess = (keys: string, staff: string): OperationsAccess => {
  try {
    const parsed: unknown = JSON.parse(keys || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NO_OPERATIONS_ACCESS;
    const entries = Object.entries(parsed);
    const actors = staff.split(",").map((actor) => actor.trim()).filter(Boolean);
    if (entries.some(([id, key]) => !ID.test(id) || typeof key !== "string" || !PUBLIC_KEY.test(key)) ||
      actors.some((actor) => !ID.test(actor))) return NO_OPERATIONS_ACCESS;
    return { keys: new Map(entries as [string, string][]), staff: new Set(actors) };
  } catch {
    return NO_OPERATIONS_ACCESS;
  }
};

const BODY_BYTES = 8192;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json({ code: "operations_unauthorized" }, 401);
const notFound = () => json({ code: "not_found" }, 404);
const INCIDENT = /^\/v1\/operations\/incidents\/([0-9a-f-]{36})(\/claim|\/resolve)?$/;

/** The operations HTTP boundary, shared by the Worker adapter and local D1 integration tests. */
export const handleOperationsRequest = async (request: Request, db: QueryDatabase, access: OperationsAccess,
  now = Date.now(), notifications: readonly Destination[] = [],
  { mappings = [], inventory = null }: { mappings?: readonly RepositoryMapping[]; inventory?: StageInventory | null } = {}): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const list = request.method === "GET" && url.pathname === "/v1/operations/incidents";
    const delivery = request.method === "GET" && url.pathname === "/v1/operations/notifications";
    const slots = request.method === "GET" && url.pathname === "/v1/operations/inventory";
    const match = INCIDENT.exec(url.pathname);
    const action = match?.[2]?.slice(1);
    if (url.search || !(list || delivery || slots || (match && request.method === (action ? "POST" : "GET")))) return notFound();
    if (url.protocol !== "https:") return unauthorized();
    const body = await readBody(request, BODY_BYTES);
    if (body === null) return json({ code: "request_too_large" }, 413);
    const keyId = request.headers.get(OPERATIONS_SIGNATURE.keyId) ?? "";
    const actor = request.headers.get(OPERATIONS_SIGNATURE.principal) ?? "";
    const publicKey = access.keys.get(keyId);
    if (!publicKey || !ID.test(actor) || !await verifySignature(request, body, publicKey, now, OPERATIONS_SIGNATURE)) return unauthorized();
    // The dashboard's assertion names a team member; only this roster makes them one.
    if (!access.staff.has(actor)) return json({ code: "operations_forbidden" }, 403);
    const [, nonce] = await db.batch([
      db.prepare("DELETE FROM replay WHERE rowid IN (SELECT rowid FROM replay WHERE expires_at < ? LIMIT 100)").bind(now),
      db.prepare("INSERT INTO replay (key_id, request_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (key_id, request_id) DO NOTHING")
        .bind(`operations:${keyId}`, request.headers.get(OPERATIONS_SIGNATURE.requestId), now + 600_000),
    ]);
    if (nonce!.meta.changes !== 1) return unauthorized();

    if (list) return json({ incidents: await listIncidents(db, now) });
    if (delivery) return json(await notificationStatus(db, notifications));
    if (slots) return json(await slotInventory(db, mappings, inventory, now));
    const id = match![1]!;
    if (!action) {
      const incident = await findIncident(db, id, now);
      return incident ? json({ incident }) : notFound();
    }
    if (action === "claim") {
      if (body) return json({ code: "invalid_request" }, 400);
      const { outcome, incident } = await claimIncident(db, id, actor, "api", now);
      if (outcome === "not_found") return notFound();
      return outcome === "claimed" ? json({ incident })
        : json({ code: outcome === "resolved" ? "incident_resolved" : "incident_claimed", incident }, 409);
    }
    let data: unknown;
    try { data = JSON.parse(body); } catch { data = null; }
    const resolution = data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1
      ? (data as { resolution?: unknown }).resolution : undefined;
    if (!isResolution(resolution)) return json({ code: "invalid_request" }, 400);
    const { outcome, incident } = await resolveIncident(db, id, actor, "api", resolution, now);
    if (outcome === "not_found") return notFound();
    return outcome === "resolved" ? json({ incident }) : json({ code: {
      not_claimant: "incident_not_claimed", already_resolved: "incident_resolved", recovery_not_verified: "recovery_not_verified",
    }[outcome], incident }, 409);
  } catch {
    // Neither SQL errors nor request data enter logs or responses.
    return json({ code: "service_unavailable" }, 503);
  }
};
