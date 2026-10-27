import { mirrorToLedger, replayLedger, restoreGate } from "./ledger.ts";
import { admitOperation, finishOperation } from "./maintenance.ts";
import { asQueryDatabase, runOperator, type OperatorOptions } from "./operator.ts";

/** CLI-only, independently authenticated. Every main-database access is either
 * admitted ordinary work or exclusive recovery; no HTTP maintenance bypass. */
export const executeOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  if (!options.ledger) throw new Error("The suppression ledger database is required for containment");
  const ledger = options.ledger;
  const db = asQueryDatabase(options.query), independent = asQueryDatabase(ledger);
  const [command, actor, reason] = args;
  const now = options.now ?? Date.now();
  const audit = async (action: string) => {
    await ledger(`INSERT INTO maintenance_audit (id, actor, action, generation, occurred_at)
      SELECT ?, ?, ?, generation, ? FROM maintenance_control WHERE id = 1`, [crypto.randomUUID(), actor!, action, now]);
  };
  if (command === "maintenance-status" && args.length === 1) {
    return JSON.stringify({ control: await ledger("SELECT * FROM maintenance_control", []),
      epoch: await ledger("SELECT * FROM ledger_epoch", []),
      operations: await ledger("SELECT * FROM maintenance_operation ORDER BY started_at, id", []) });
  }
  if (command?.startsWith("maintenance-") || command === "restore-recorded") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(actor ?? "")) throw new Error("An opaque actor is required");
    if (command === "maintenance-enter" && args.length === 2) {
      await audit("enter-requested");
      const changed = await ledger(`UPDATE maintenance_control SET mode = 'held', generation = generation + 1
        WHERE id = 1 AND mode = 'open' RETURNING generation`, []);
      if (changed.length !== 1) throw new Error("Already contained; inspect maintenance-status");
      return "Containment entered; NOT safe to restore. Inspect operations and remote outcomes.";
    }
    if (command === "maintenance-release" && args.length === 3 && /^\d+$/.test(reason ?? "")) {
      if (!await restoreGate()(db, independent, now)) throw new Error("Replay epoch is not verified");
      await audit("release-requested");
      const released = await ledger(`UPDATE maintenance_control SET mode = 'open' WHERE id = 1 AND mode = 'verified'
        AND generation = ? AND NOT EXISTS (SELECT 1 FROM maintenance_operation) RETURNING id`, [Number(reason)]);
      if (released.length !== 1) throw new Error("Release refused: generation, replay or drain changed");
      return "Containment released; delivery remains disabled until separately approved";
    }
    if (!((command === "restore-recorded" && args.length === 3 && reason === "time-travel-restore") ||
      (["maintenance-replay", "maintenance-mirror"].includes(command ?? "") && args.length === 2))) throw new Error("Invalid maintenance command");
    const id = crypto.randomUUID();
    const modes = command === "maintenance-mirror" ? "'held'" : "'held', 'recorded', 'verified'";
    const claimed = await ledger(`INSERT INTO maintenance_operation (id, kind, generation, started_at)
      SELECT ?, 'recovery', generation, ? FROM maintenance_control WHERE id = 1 AND mode IN (${modes})
      AND NOT EXISTS (SELECT 1 FROM maintenance_operation) RETURNING id`, [id, now]);
    if (claimed.length !== 1) throw new Error("Recovery refused: containment or exclusive drain missing");
    // Failures intentionally retain ownership; never race a retry against a
    // possibly live recovery writer. An operator must investigate outside CLI.
    await audit(command);
    await ledger("UPDATE maintenance_control SET mode = 'held' WHERE id = 1", []);
    if (command === "maintenance-mirror") {
      // Only before restore: force a full pass after all ordinary writers drain.
      await options.query("UPDATE restore_state SET full_mirrored_at = 0 WHERE id = 1", []);
      await mirrorToLedger(db, independent, now);
      await finishOperation(independent, id);
      return "Full mirror complete; still contained. This does not prove remote settlement.";
    }
    if (command === "restore-recorded") {
      await ledger("UPDATE ledger_epoch SET epoch = epoch + 1, recorded_at = ? WHERE id = 1", [now]);
      await ledger("UPDATE maintenance_control SET mode = 'recorded' WHERE id = 1", []);
      await finishOperation(independent, id);
      return "Restore recorded; containment remains held. Run maintenance-replay.";
    }
    const [epoch] = await ledger("SELECT epoch FROM ledger_epoch WHERE id = 1", []);
    if (typeof epoch?.epoch !== "number") throw new Error("Missing ledger epoch");
    await replayLedger(db, independent, epoch.epoch, now);
    await options.query("UPDATE delivery_control SET enabled = 0 WHERE id = 1", []);
    if (!await restoreGate()(db, independent, now)) throw new Error("Replay verification failed");
    const [delivery] = await options.query("SELECT enabled FROM delivery_control WHERE id = 1", []);
    if (delivery?.enabled !== 0) throw new Error("Replay did not disable delivery");
    await ledger("UPDATE maintenance_control SET mode = 'verified' WHERE id = 1", []);
    await finishOperation(independent, id);
    return "Replay verified; still contained. Verify suppression, revocations and remote outcomes before release.";
  }
  const id = await admitOperation(independent, "runtime");
  if (!id) throw new Error("Service is contained");
  if (!await restoreGate()(db, independent, now)) {
    await finishOperation(independent, id);
    throw new Error("Replay required under containment");
  }
  // Validation and reads cannot have changed durable state. Once any write is
  // attempted, a rejected response may conceal a completed side effect: retain
  // its owner rather than treating that uncertainty as a drained execution.
  let mutationAttempted = false;
  const trackQuery = (query: OperatorOptions["query"]): OperatorOptions["query"] => async (sql, params) => {
    if (!/^\s*SELECT\b/i.test(sql)) mutationAttempted = true;
    return query(sql, params);
  };
  try {
    const result = await runOperator(args, { ...options, query: trackQuery(options.query), ledger: trackQuery(ledger),
      recordRevocation: async (key, revokedAt) => {
        mutationAttempted = true;
        await options.recordRevocation(key, revokedAt);
      } });
    await finishOperation(independent, id);
    return result;
  } catch (error) {
    if (!mutationAttempted) await finishOperation(independent, id);
    throw error;
  }
};
