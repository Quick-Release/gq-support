import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { contactBlockers, credentialCustody, slotInventory } from "./inventory.ts";
import { mappingFor } from "./repository-mappings.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;
/** A reference to where the evidence lives, such as a CI run URL; never the evidence or a credential itself. */
const EVIDENCE = /^[\x21-\x7e]{1,256}$/;
const KINDS = ["desired", "attempted", "observed", "failed"];
/** Restricted contact route text: printable, no control characters. */
const ROUTE = /^[\x20-\x7e]{1,256}$/;
/** How the route was checked: only a live contact from a separate device verifies it; an attestation is recorded, never verified. */
const METHODS = ["separate-device-drill", "attestation"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;

/**
 * The Operator CLI for Slot inventory evidence (src/inventory.ts):
 *
 * - `inventory-record <slot> <desired|attempted|observed|failed> <version> <at> <evidence-ref> <opaque-actor>`
 *   appends version evidence from a deployment or maintenance interaction. `at` is when it was observed,
 *   never later than now. Each record is its own audit row: one append, never edited.
 * - `inventory-contact <slot> <route> <responder> <separate-device-drill|attestation> <verified-at> <evidence-ref> <opaque-actor>`
 *   records the Client's existing contract contact route and responsible responder, and how they were checked
 *   outside WordPress. Only a `separate-device-drill`, a live contact made from a device separate from the
 *   installation, verifies it; an `attestation` is kept but stays unverified. Route and responder are restricted.
 *   Nothing here invents, sends to or tests a route: the Operator records what was observed.
 * - `inventory-readiness` lists every mapped Slot's contact blockers and the exact onboarding blocker, if any.
 * - `inventory <slot>` shows the Slot's inventory with its restricted contact details.
 * - `inventory-credentials` shows the stage's credential custody, with locations and evidence.
 */
export const runInventoryOperator = async (args: readonly string[], { query, mappings, now = Date.now(), inventory, release }: OperatorOptions): Promise<string> => {
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
    const { slots: [inventory], release: releases } = await slotInventory(db, [mapping], null, now, { restricted: true, release });
    return JSON.stringify({ ...inventory, release: releases });
  }
  if (command === "inventory-credentials" && args.length === 1) {
    if (!inventory) throw new Error("No reviewed inventory for this stage");
    return JSON.stringify({ stage: inventory.stage, credentials: credentialCustody(inventory, now, { restricted: true }) });
  }
  if (command === "inventory-contact" && args.length === 8) {
    const [, , route, responder, method, verified, reference, by] = args;
    if (!mappingFor(mappings, slot!)) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
    if (![route, responder].every((text) => ROUTE.test(text!) && text!.trim()) || !METHODS.includes(method!) || !EVIDENCE.test(reference!)
      || !ACTOR.test(by!)) throw new Error("Invalid contact verification");
    const verifiedAt = timeOf(verified!);
    await db.prepare(`INSERT INTO slot_contact_verification (slot, route, responder, method, evidence, verified_at, verified_by, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(slot, route, responder, method, reference, verifiedAt, by, now).run();
    return JSON.stringify({ slot, contact: method === "separate-device-drill" ? "verified" : "attested", verified_at: new Date(verifiedAt).toISOString() });
  }
  if (command === "inventory-readiness" && args.length === 1) {
    const { slots } = await slotInventory(db, mappings, null, now, { restricted: true });
    const ready = slots.map(({ slot, contact }) => ({ slot, blockers: contactBlockers(contact) }))
      .map(({ slot, blockers }) => ({ slot, ready: blockers.length === 0, blockers }));
    const blocked = ready.filter((slot) => !slot.ready);
    return JSON.stringify({ ready: blocked.length === 0,
      blocker: blocked.length === 0 ? null : `Onboarding blocked: ${blocked.map((slot) => `${slot.slot}: ${slot.blockers.join(", ")}`).join("; ")}`,
      slots: ready });
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
    + ` | inventory-contact <slot> <route> <responder> <${METHODS.join("|")}> <verified-at> <evidence-ref> <opaque-actor> | inventory-readiness`);
};
