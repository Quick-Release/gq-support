import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { claimIncident, findIncident, incidentAudit, listIncidents } from "./incidents.ts";

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
 * Resolution stays with the claimant through the operations API.
 */
export const runIncidentOperator = async (args: readonly string[], { query, now = Date.now() }: OperatorOptions): Promise<string> => {
  const db = asQueryDatabase(query);
  const [command, id, actor] = args;
  if (command === "incidents" && args.length === 1) return JSON.stringify({ incidents: await listIncidents(db, now) });
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
  throw new Error("Usage: operator incidents | incident <id> | incident-claim <id> <opaque-actor>");
};
