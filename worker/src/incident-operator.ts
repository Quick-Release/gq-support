import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { claimIncident, findIncident, incidentAudit, incidentPage } from "./incidents.ts";
import { DESTINATIONS, notificationStatus, retryNotifications, type Destination } from "./notifications.ts";
import { operationsHealth } from "./operations-health.ts";
import { verifyWebhookDrill } from "./drill-verify.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[0-9a-f-]{36}$/;

/**
 * The Operator CLI fallback for Operational incidents (src/incidents.ts), for
 * when the staff dashboard is unavailable but storage is healthy:
 *
 * - `incidents` lists the team view;
 * - `incident <id>` adds the restricted audit trail;
 * - `incident-claim <id> <opaque-actor>` self-claims, with the same atomic rule and audit as the API.
 *
 * - `notifications` shows Discord delivery health and failing notifications;
 * - `notification-retry <destination>` re-arms a destination's failed notifications once its cause is fixed;
 * - `health` shows measured support-path health, as the operations API does;
 * - `drill-verify webhook <ISO-start>` checks the broken-webhook drill's recorded evidence since its start.
 *
 * Staff resolve claimed incidents through the operations API once recovery is verified.
 */
export const runIncidentOperator = async (args: readonly string[], { query, mappings, now = Date.now() }: OperatorOptions): Promise<string> => {
  const db = asQueryDatabase(query);
  const [command, id, actor] = args;
  if (command === "incidents" && args.length <= 2) {
    const page = await incidentPage(db, now, id ?? null);
    if (!page) throw new Error("Invalid incident cursor; start again with operator incidents");
    return JSON.stringify(page);
  }
  if (command === "incident" && args.length === 2 && ID.test(id!)) {
    const incident = await findIncident(db, id!, now);
    if (!incident) throw new Error("Unknown incident");
    return JSON.stringify({ incident, audit: await incidentAudit(db, id!) });
  }
  if (command === "incident-claim" && args.length === 3 && ID.test(id!) && ACTOR.test(actor!)) {
    const { outcome, incident } = await claimIncident(db, id!, actor!, "operator", now);
    if (outcome === "not_found") throw new Error("Unknown incident");
    if (outcome === "resolved") throw new Error("Incident already resolved");
    if (outcome === "claimed_by_other") throw new Error(`Incident already claimed by ${incident!.claimant}`);
    return JSON.stringify({ incident });
  }
  if (command === "health" && args.length === 1) return JSON.stringify(await operationsHealth(db, mappings, now));
  if (command === "drill-verify" && id === "webhook" && args.length === 3 && Number.isFinite(Date.parse(actor!)) && Date.parse(actor!) <= now) {
    return JSON.stringify(await verifyWebhookDrill(db, Date.parse(actor!)));
  }
  if (command === "notifications" && args.length === 1) return JSON.stringify(await notificationStatus(db));
  if (command === "notification-retry" && args.length === 2 && DESTINATIONS.includes(id as Destination)) {
    return JSON.stringify({ destination: id, retried: await retryNotifications(db, id as Destination, now) });
  }
  throw new Error(`Usage: operator incidents | incident <id> | incident-claim <id> <opaque-actor> | notifications | notification-retry <${DESTINATIONS.join("|")}> | health | drill-verify webhook <ISO-start>`);
};
