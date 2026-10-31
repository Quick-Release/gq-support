import type { OperatorOptions } from "./operator.ts";

/**
 * Operator commands that dispatch, authorize or lift something, refused while
 * maintenance holds or a recorded restore is not yet replayed: whatever they
 * wrote could be rewound by the restore or act on restored state. Protective
 * commands (revoke, erase, offboard, update-access-revoke) are not here: they
 * write the ledger first and keep applying. `release-withdraw` is allowed
 * during maintenance once replay is complete, since a restore can make a
 * withdrawn release current again (see maintenanceBlockers).
 */
export const GUARDED_COMMANDS: readonly string[] = ["enroll", "resume", "reconcile", "unsuspend", "release-candidate", "release-verify",
  "release-approve", "release-withdraw", "release-boundary", "fleet-launch", "fleet-run", "update-access-grant", "central-apply"];

/**
 * Refuses a guarded command unless the ledger shows the service serving and
 * the main database replayed to its restore epoch. A resume is also refused
 * for a request the ledger suppresses, even if the main copy was lost.
 */
export const guardOperatorMutation = async (args: readonly string[], query: OperatorOptions["query"], ledgerQuery: OperatorOptions["query"]) => {
  const [command] = args;
  const [control] = await ledgerQuery(`SELECT e.epoch, m.state FROM ledger_epoch e, maintenance m WHERE e.id = 1 AND m.id = 1`, []);
  const [main] = await query("SELECT epoch FROM restore_state WHERE id = 1", []);
  if (!control || !main) throw new Error("Refused: the restore epoch or maintenance boundary cannot be read; nothing was changed");
  if (Number(main.epoch) < Number(control.epoch)) throw new Error("Refused: a recorded restore is not replayed yet; see maintenance-status");
  if (control.state !== "serving" && command !== "release-withdraw") {
    throw new Error("Refused: maintenance is in effect; see maintenance-status. Nothing was changed");
  }
  if (command === "resume") {
    const [intent] = await query("SELECT request_id FROM delivery_intent WHERE slot = ? AND id = ?", [args[1] ?? "", args[2] ?? ""]);
    const suppressed = intent && await ledgerQuery(`SELECT 1 FROM ledger_entry WHERE kind = 'suppression' AND payload IS NOT NULL
      AND reference IN (?, ?)`, [`slot:${args[1]}`, `request:${String(intent.request_id)}`]);
    if (suppressed && suppressed.length > 0) throw new Error("Refused: this request is suppressed in the suppression ledger; nothing was changed");
  }
};

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = "Usage: operator maintenance-begin <opaque-actor> <restore|incident> <evidence-reference>; operator maintenance-status; " +
  "operator maintenance-end <opaque-actor> <generation> <evidence-reference>";
/**
 * How long after maintenance begins work admitted before it may still run:
 * a scheduled tick's phases end within 58 seconds, a request's background
 * delivery within 25 and its status refresh within 12. A restore is recorded,
 * and service resumed, only after this has passed.
 */
export const MAINTENANCE_DRAIN_MS = 120_000;

/**
 * The maintenance boundary (#146; docs/runbooks/support-operations.md). It
 * lives in the suppression ledger, so a restore of the main D1 never rewinds
 * or reopens it. While it holds, the Worker serves nothing but the
 * independent checker's probe, scheduled ticks only replay a recorded
 * restore, and no create is authorized. Independent Operator credentials
 * authorize it; no HTTP route can. Each transition writes its audit first and
 * then changes state in one conditional statement, so a concurrent or retried
 * command changes it at most once and every attempt stays attributed.
 */
export const runMaintenanceOperator = async (args: readonly string[], { query, ledger: ledgerQuery, now = Date.now() }: OperatorOptions) => {
  if (!ledgerQuery) throw new Error("The suppression ledger database is required for this command");
  const [command, actor, qualifier, evidence] = args;
  if (command === "maintenance-status" && args.length === 1) return JSON.stringify(await maintenanceStatus(query, ledgerQuery, now));
  if (!ACTOR.test(actor ?? "") || !ACTOR.test(evidence ?? "") || args.length !== 4) throw new Error(USAGE);
  const audit = async (action: "begin" | "end", reason: string, eligible: string, parameters: readonly (string | number)[]) => {
    const id = crypto.randomUUID();
    const recorded = await ledgerQuery(`INSERT INTO maintenance_audit (id, generation, actor, action, reason, evidence, occurred_at)
      SELECT ?, generation + 1, ?, ?, ?, ?, ? FROM maintenance WHERE id = 1 AND ${eligible} RETURNING id`,
    [id, actor!, action, reason, evidence!, now, ...parameters]);
    return recorded.length === 1 ? id : null;
  };
  if (command === "maintenance-begin" && (qualifier === "restore" || qualifier === "incident")) {
    const id = await audit("begin", qualifier, "state = 'serving'", []);
    const begun = id && await ledgerQuery(`UPDATE maintenance SET state = 'maintenance', generation = generation + 1, reason = ?,
      began_at = ?, began_epoch = (SELECT epoch FROM ledger_epoch WHERE id = 1), ended_at = NULL
      WHERE id = 1 AND state = 'serving' AND EXISTS (SELECT 1 FROM maintenance_audit WHERE id = ? AND generation = maintenance.generation + 1)
      RETURNING generation`, [qualifier, now, id]);
    if (!begun || begun.length !== 1) throw new Error("Maintenance is already in effect; inspect maintenance-status");
    return JSON.stringify(await maintenanceStatus(query, ledgerQuery, now));
  }
  if (command === "maintenance-end" && /^[1-9][0-9]{0,9}$/.test(qualifier ?? "")) {
    const generation = Number(qualifier);
    const status = await maintenanceStatus(query, ledgerQuery, now);
    if (status.state !== "maintenance" || status.generation !== generation) {
      throw new Error("Refused: that maintenance generation is not in effect; see maintenance-status");
    }
    const blockers = await maintenanceBlockers(query, ledgerQuery, now);
    if (blockers.length > 0) throw new Error(`Refused: service cannot resume: ${blockers.join(", ")}`);
    const id = await audit("end", String(status.reason), "state = 'maintenance' AND generation = ?", [generation]);
    const ended = id && await ledgerQuery(`UPDATE maintenance SET state = 'serving', generation = generation + 1, ended_at = ?
      WHERE id = 1 AND state = 'maintenance' AND generation = ?
        AND EXISTS (SELECT 1 FROM maintenance_audit WHERE id = ? AND generation = maintenance.generation + 1)
      RETURNING generation`, [now, generation, id]);
    if (!ended || ended.length !== 1) throw new Error("Refused: maintenance changed meanwhile; inspect maintenance-status and the audit");
    return JSON.stringify(await maintenanceStatus(query, ledgerQuery, now));
  }
  throw new Error(USAGE);
};

/** What the ledger and main database show about maintenance and restore replay, read-only. */
export const maintenanceStatus = async (query: OperatorOptions["query"], ledgerQuery: OperatorOptions["query"], now: number) => {
  const [control] = await ledgerQuery(`SELECT m.generation, m.state, m.reason, m.began_at, m.began_epoch, m.ended_at, e.epoch
    FROM maintenance m, ledger_epoch e WHERE m.id = 1 AND e.id = 1`, []);
  if (!control) throw new Error("The suppression ledger has no maintenance record; apply its migrations first");
  const [replayed] = await query("SELECT epoch FROM restore_state WHERE id = 1", []);
  const maintenance = control.state === "maintenance";
  const beganAt = typeof control.began_at === "number" ? control.began_at : null;
  return {
    state: control.state, generation: control.generation, reason: control.reason ?? null,
    began_at: maintenance && beganAt !== null ? new Date(beganAt).toISOString() : null,
    drained: maintenance && beganAt !== null ? now >= beganAt + MAINTENANCE_DRAIN_MS : null,
    drained_at: maintenance && beganAt !== null ? new Date(beganAt + MAINTENANCE_DRAIN_MS).toISOString() : null,
    restore_epoch: control.epoch, replayed_epoch: replayed?.epoch ?? null,
    restore_recorded: maintenance ? Number(control.epoch) > Number(control.began_epoch) : null,
  };
};

type Rows = Record<string, unknown>[];
const set = (rows: Rows, column: string) => new Set(rows.map((row) => String(row[column])));
const images = async (ledgerQuery: OperatorOptions["query"], kind: string) =>
  (await ledgerQuery("SELECT reference, payload FROM ledger_entry WHERE kind = ? AND payload IS NOT NULL", [kind]))
    .map((row) => ({ reference: String(row.reference), image: JSON.parse(String(row.payload)) as Record<string, unknown> }));

/**
 * Why service cannot resume yet, by bounded code; empty when it can. The
 * restore must be recorded and replayed, and the restored main database must
 * hold everything the ledger keeps: suppressions, erasures, offboardings,
 * suspensions and key revocations, with no usable key of an offboarded Slot,
 * no erased text left, no withdrawn
 * release current again, and every acknowledged checker episode back. A
 * ledger or database that cannot be read refuses rather than passing.
 */
export const maintenanceBlockers = async (query: OperatorOptions["query"], ledgerQuery: OperatorOptions["query"], now: number) => {
  const status = await maintenanceStatus(query, ledgerQuery, now);
  const blockers: string[] = [];
  if (status.drained !== true) blockers.push("not_drained");
  if (status.reason === "restore" && status.restore_recorded !== true) blockers.push("restore_not_recorded");
  if (status.replayed_epoch === null || Number(status.replayed_epoch) < Number(status.restore_epoch)) blockers.push("replay_pending");
  const suppressions = set(await query("SELECT scope || ':' || reference AS reference FROM delivery_suppression", []), "reference");
  if ((await images(ledgerQuery, "suppression")).some(({ reference }) => !suppressions.has(reference))) blockers.push("suppression_missing");
  const erasures = set(await query("SELECT id FROM erasure", []), "id");
  if ((await images(ledgerQuery, "erasure")).some(({ reference }) => !erasures.has(reference))) blockers.push("erasure_missing");
  const offboarded = set(await query("SELECT slot FROM offboarding", []), "slot");
  if ((await images(ledgerQuery, "offboarding")).some(({ reference }) => !offboarded.has(reference))) blockers.push("offboarding_missing");
  const suspended = set(await query("SELECT repository_id FROM repository_state WHERE suspended_reason IS NOT NULL", []), "repository_id");
  if ((await images(ledgerQuery, "suspension")).some(({ reference }) => !suspended.has(reference))) blockers.push("suspension_missing");
  // A revoked key may be absent after a restore; it must never be present and usable.
  const usable = set([...await query("SELECT key_id FROM installation_key WHERE revoked_at IS NULL", []),
    ...await query(`SELECT g.key_id FROM update_access_grant g
      WHERE NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, [])], "key_id");
  if ((await images(ledgerQuery, "revocation")).some(({ reference }) => usable.has(reference))) blockers.push("revocation_missing");
  // Nor may any key of an offboarded Slot, even one whose revocation the ledger never got to record.
  const offboardings = await images(ledgerQuery, "offboarding");
  if (offboardings.length > 0 && (await query(`SELECT k.slot FROM installation_key k WHERE k.revoked_at IS NULL
      UNION SELECT g.slot FROM update_access_grant g WHERE NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, []))
    .some((row) => offboardings.some(({ reference }) => reference === row.slot))) blockers.push("offboarded_access_present");
  const [text] = await query(`SELECT COUNT(*) AS count FROM support_request r WHERE r.erased_at IS NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = r.id)`, []);
  if (Number(text?.count ?? 1) > 0) blockers.push("erased_text_present");
  const withdrawn = set(await ledgerQuery("SELECT package_version FROM release_withdrawal", []), "package_version");
  const [current] = await query("SELECT package_version FROM release_approval ORDER BY sequence DESC LIMIT 1", []);
  if (current && withdrawn.has(String(current.package_version))) blockers.push("withdrawn_release_current");
  const episodes = set(await query("SELECT id FROM independent_episode", []), "id");
  if ([...set(await ledgerQuery("SELECT id FROM retained_episode", []), "id")].some((id) => !episodes.has(id))) blockers.push("episode_missing");
  return blockers;
};
