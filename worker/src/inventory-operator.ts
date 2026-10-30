import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { credentialCustody, slotInventory } from "./inventory.ts";
import { mappingFor } from "./repository-mappings.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;
/** A reference to where the evidence lives, such as a CI run URL; never the evidence or a credential itself. */
const EVIDENCE = /^[\x21-\x7e]{1,256}$/;
const KINDS = ["desired", "attempted", "observed", "failed"];
/** Restricted contact route text: printable, no control characters. */
const ROUTE = /^[\x20-\x7e]{1,256}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;

/**
 * The Operator CLI for Slot inventory evidence (src/inventory.ts):
 *
 * - `inventory-record <slot> <desired|attempted|observed|failed> <version> <at> <evidence-ref> <opaque-actor>`
 *   appends version evidence from a deployment or maintenance interaction. `at` is when it was observed,
 *   never later than now. Each record is its own audit row: one append, never edited.
 * - `inventory-contact <slot> <route> <verified-at> <evidence-ref> <opaque-actor>` records that the Client's
 *   independent emergency contact route was verified outside WordPress. The route is restricted.
 * - `inventory <slot>` shows the Slot's inventory with its restricted contact details.
 * - `inventory-credentials` shows the stage's credential custody, with locations and evidence.
 */
export const runInventoryOperator = async (args: readonly string[], { query, mappings, now = Date.now(), inventory }: OperatorOptions): Promise<string> => {
  const db = asQueryDatabase(query);
  const [command, slot, kind, version, time, evidence, actor] = args;
  const timeOf = (value: string) => {
    const parsed = ISO.test(value) ? Date.parse(value) : NaN;
    if (!(parsed <= now)) throw new Error("Evidence time must be an ISO UTC time no later than now");
    return parsed;
  };
  if (command === "inventory" && args.length === 2) {
    const mapping = mappingFor(mappings, slot!);
    if (!mapping) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
    const { slots: [inventory] } = await slotInventory(db, [mapping], null, now, { restricted: true });
    return JSON.stringify(inventory);
  }
  if (command === "inventory-credentials" && args.length === 1) {
    if (!inventory) throw new Error("No reviewed inventory for this stage");
    return JSON.stringify({ stage: inventory.stage, credentials: credentialCustody(inventory, now, { restricted: true }) });
  }
  if (command === "inventory-contact" && args.length === 6) {
    const [, , route, verified, reference, by] = args;
    if (!mappingFor(mappings, slot!)) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
    if (!ROUTE.test(route!) || !route!.trim() || !EVIDENCE.test(reference!) || !ACTOR.test(by!)) throw new Error("Invalid contact verification");
    const verifiedAt = timeOf(verified!);
    await db.prepare(`INSERT INTO slot_contact_verification (slot, route, evidence, verified_at, verified_by, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(slot, route, reference, verifiedAt, by, now).run();
    return JSON.stringify({ slot, contact: "verified", verified_at: new Date(verifiedAt).toISOString() });
  }
  if (command === "inventory-record" && args.length === 7) {
    if (!mappingFor(mappings, slot!)) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
    if (!KINDS.includes(kind!) || !VERSION.test(version!) || !EVIDENCE.test(evidence!) || !ACTOR.test(actor!)) throw new Error("Invalid inventory record");
    const observedAt = timeOf(time!);
    await db.prepare(`INSERT INTO slot_version_evidence (slot, kind, version, observed_at, source, evidence, recorded_by, recorded_at)
      VALUES (?, ?, ?, ?, 'operator', ?, ?, ?)`).bind(slot, kind, version, observedAt, evidence, actor, now).run();
    return JSON.stringify({ slot, kind, version, at: new Date(observedAt).toISOString() });
  }
  throw new Error(`Usage: operator inventory <slot> | inventory-credentials | inventory-record <slot> <${KINDS.join("|")}> <version> <at> <evidence-ref> <opaque-actor>`
    + " | inventory-contact <slot> <route> <verified-at> <evidence-ref> <opaque-actor>");
};
