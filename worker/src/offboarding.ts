import { OFFBOARDING_GRACE_MS } from "./cleanup.ts";
import { imageOf, ledgerStore } from "./ledger.ts";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { mappingFor } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
/** A reference to where the decision lives, such as a reviewed issue or contract notice URL; never a credential. */
const EVIDENCE = /^[\x21-\x7e]{1,256}$/;
const USAGE = "Usage: operator offboard <slot> <opaque-actor> <evidence-ref> | offboard-status <slot>";

type Query = OperatorOptions["query"];
const ids = (rows: readonly Record<string, unknown>[], column = "key_id") => rows.map((row) => String(row[column])).sort();

/**
 * Whether the suppression ledger offboarded the Slot: the record a restore of
 * the main database cannot drop. Paths that would give the Slot new access
 * (enrollment, an update grant, a central application) check it as well as
 * the main copy.
 */
export const ledgerOffboarded = async (ledger: QueryDatabase, slot: string) =>
  (await ledger.prepare(`SELECT 1 FROM ledger_entry WHERE payload IS NOT NULL
    AND ((kind = 'offboarding' AND reference = ?) OR (kind = 'suppression' AND reference = ?))`).bind(slot, `slot:${slot}`).first()) !== null;

/** The main database's own record, in SQL, for a statement whose Slot column is `column`. */
export const NOT_OFFBOARDED = (column: string) => `NOT EXISTS (SELECT 1 FROM offboarding WHERE slot = ${column})
  AND NOT EXISTS (SELECT 1 FROM delivery_suppression WHERE scope = 'slot' AND reference = ${column} AND reason = 'offboarding')`;

/**
 * What offboarding stopped and what it could not: accepted creates never
 * attempted are cancelled by the suppression; one in flight or with an
 * unknown outcome may still have created an issue, and stays for review.
 * A central application without a recorded outcome may have changed the
 * installation, and a package already served cannot be taken back.
 */
const outcomes = async (query: Query, slot: string, now: number) => {
  const [delivery] = await query(`SELECT
      COALESCE(SUM(CASE WHEN state = 'pending' AND (owner IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM delivery_intent WHERE slot = ? AND seq = 0`, [now, slot]);
  const uncertain = await query(`SELECT id FROM delivery_intent WHERE slot = ? AND seq = 0
    AND (state IN ('in_flight', 'outcome_unknown') OR (state = 'pending' AND owner IS NOT NULL AND lease_expires_at > ?)) ORDER BY id`, [slot, now]);
  const central = await query(`SELECT id FROM central_deployment WHERE slot = ? AND (outcome IS NULL OR outcome = 'unknown') ORDER BY id`, [slot]);
  const [served] = await query("SELECT version, attempted_at FROM slot_update_attempt WHERE slot = ?", [slot]);
  return {
    delivery: { cancelled: Number(delivery?.cancelled ?? 0), delivered: Number(delivery?.delivered ?? 0), uncertain: ids(uncertain, "id") },
    central: { uncertain: ids(central, "id") },
    // Not retracted: an installation that downloaded it may install it later.
    native: { last_served: served ? { version: served.version, at: new Date(Number(served.attempted_at)).toISOString() } : null },
  };
};

/**
 * Explicit offboarding (#147; docs/runbooks/support-operations.md#offboarding).
 * Independent Operator credentials authorize it; no HTTP route can. Each step
 * is one statement, applied in order, so any prefix is safe and a rerun
 * completes it:
 *
 * 1. The ledger audits the attempt, then records the Slot's suppression and
 *    offboarding, keeping the first grace period on a rerun.
 * 2. The main database suppresses the Slot: from here no create is dispatched,
 *    no enrollment completes, no update key is granted and no central
 *    application starts or reaches its install.
 * 3. The exact report and update keys still usable are revoked in the ledger,
 *    then in the main database with any pending download grants and unused
 *    enrollment codes. Nothing else is touched: no other Slot, shared
 *    repository state, release record or GitHub issue.
 * 4. The ledger audits what was revoked, cancelled and left uncertain.
 *
 * Content is purged after the 30-day grace (src/cleanup.ts). A rerun is
 * allowed once the ledger holds the offboarding, even with the mapping gone.
 */
export const runOffboardingOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, mappings, now = Date.now(), ledger, recordRevocation } = options;
  const [command, slot, actor, evidence] = args;
  if (!ledger) throw new Error("The suppression ledger database is required for this command");
  if (command === "offboard-status" && args.length === 2) return JSON.stringify(await offboardingStatus(query, ledger, slot!, now));
  if (command !== "offboard" || args.length !== 4 || !ACTOR.test(actor ?? "") || !EVIDENCE.test(evidence ?? "")) throw new Error(USAGE);
  if (!mappingFor(mappings, slot!) && !await ledgerOffboarded(asQueryDatabase(ledger), slot!)) throw new Error("Unknown Slot");
  const audit = (phase: "begin" | "complete", effects: unknown = null) => ledger(`INSERT INTO offboarding_audit
    (id, slot, actor, evidence, phase, effects, occurred_at) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?)`,
  [crypto.randomUUID(), slot!, actor!, evidence!, phase, effects === null ? "" : JSON.stringify(effects), now]);
  await audit("begin");
  const store = ledgerStore(asQueryDatabase(ledger));
  await store.record([imageOf("suppression", { scope: "slot", reference: slot, reason: "offboarding" }),
    imageOf("offboarding", { slot, recorded_at: now, purge_after: now + OFFBOARDING_GRACE_MS })], now);
  // The first ledger image wins across Operator checkouts as well as retries.
  // Read that canonical value before writing main or reporting an audit result.
  const [recorded] = await ledger("SELECT payload FROM ledger_entry WHERE kind = 'offboarding' AND reference = ? AND payload IS NOT NULL", [slot!]);
  if (!recorded) throw new Error("Offboarding was not recorded in the suppression ledger");
  const first = JSON.parse(String(recorded.payload)) as { recorded_at: number; purge_after: number };
  await query(`INSERT INTO delivery_suppression (scope, reference, reason, changed_at) VALUES ('slot', ?, 'offboarding', ?) ON CONFLICT DO NOTHING`, [slot!, now]);
  await query(`INSERT INTO offboarding (slot, recorded_at, purge_after, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [slot!, first.recorded_at, first.purge_after, now]);

  // Read only now: an enrollment or grant committing after the suppression above is refused by it.
  const reportKeys = ids(await query("SELECT key_id FROM installation_key WHERE slot = ? AND revoked_at IS NULL", [slot!]));
  const updateKeys = ids(await query(`SELECT g.key_id FROM update_access_grant g WHERE g.slot = ?
    AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, [slot!]));
  await store.record([...reportKeys, ...updateKeys].map((keyId) => imageOf("revocation", { key_id: keyId, revoked_at: now })), now);
  for (const keyId of reportKeys) await recordRevocation(keyId, now);
  const revokedReport = await query(`UPDATE installation_key SET revoked_at = ? WHERE slot = ? AND revoked_at IS NULL
    AND key_id IN (SELECT value FROM json_each(?)) RETURNING key_id`, [now, slot!, JSON.stringify(reportKeys)]);
  const revokedUpdate = await query(`INSERT INTO update_access_revocation (key_id, slot, evidence, revoked_by, revoked_at)
    SELECT g.key_id, g.slot, ?, ?, ? FROM update_access_grant g WHERE g.slot = ? AND g.key_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)
    RETURNING key_id`, [evidence!, actor!, now, slot!, JSON.stringify(updateKeys)]);
  const grants = await query(`DELETE FROM update_download_grant WHERE key_id IN (SELECT key_id FROM update_access_grant WHERE slot = ?)
    RETURNING grant_hash`, [slot!]);
  const codes = await query("DELETE FROM enrollment_code WHERE slot = ? AND consumed_at IS NULL RETURNING code_hash", [slot!]);
  const effects = {
    slot, suppressed: true,
    report_keys_revoked: ids(revokedReport), update_keys_revoked: ids(revokedUpdate),
    download_grants_revoked: grants.length, enrollment_codes_revoked: codes.length,
    offboarded_at: new Date(first.recorded_at).toISOString(), purge_after: new Date(first.purge_after).toISOString(),
    ...await outcomes(query, slot!, now),
  };
  await audit("complete", effects);
  return JSON.stringify(effects);
};

/** What the ledger and main database show about a Slot's offboarding, read-only. Works without the mapping. */
export const offboardingStatus = async (query: Query, ledger: Query, slot: string, now: number) => {
  const [image] = await ledger("SELECT payload FROM ledger_entry WHERE kind = 'offboarding' AND reference = ? AND payload IS NOT NULL", [slot]);
  if (!image) throw new Error("This Slot is not offboarded");
  const { recorded_at: recordedAt, purge_after: purgeAfter } = JSON.parse(String(image.payload)) as { recorded_at: number; purge_after: number };
  const audits = await ledger("SELECT actor, evidence, phase, occurred_at FROM offboarding_audit WHERE slot = ? ORDER BY occurred_at, rowid", [slot]);
  const usable = ids([...await query("SELECT key_id FROM installation_key WHERE slot = ? AND revoked_at IS NULL", [slot]),
    ...await query(`SELECT g.key_id FROM update_access_grant g WHERE g.slot = ?
      AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, [slot])]);
  const [main] = await query(`SELECT EXISTS (SELECT 1 FROM offboarding WHERE slot = ?) AS offboarded,
    EXISTS (SELECT 1 FROM delivery_suppression WHERE scope = 'slot' AND reference = ? AND reason = 'offboarding') AS suppressed`, [slot, slot]);
  const unresolved = await query("SELECT request_id FROM support_cleanup WHERE slot = ? AND state = 'unresolved' ORDER BY request_id", [slot]);
  return {
    slot, offboarded_at: new Date(recordedAt).toISOString(), purge_after: new Date(purgeAfter).toISOString(), purge_due: now >= purgeAfter,
    // Incomplete until the main database also holds the suppression and no key of the Slot is usable: rerun offboard.
    complete: Number(main?.offboarded) === 1 && Number(main?.suppressed) === 1 && usable.length === 0, usable_keys: usable,
    ...await outcomes(query, slot, now),
    cleanup_unresolved: ids(unresolved, "request_id"),
    audit: audits.map((row) => ({ actor: row.actor, evidence: row.evidence, phase: row.phase, at: new Date(Number(row.occurred_at)).toISOString() })),
  };
};
