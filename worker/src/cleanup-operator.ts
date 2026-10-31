import { ERASABLE, erasureImages, erasureStatements, erasureStatus, OFFBOARDING_GRACE_MS, OPEN_ERASURE, type Statement } from "./cleanup.ts";
import { imageOf, ledgerStore } from "./ledger.ts";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { mappingFor } from "./repository-mappings.ts";
import { MAINTENANCE_DRAIN_MS } from "./maintenance.ts";
import { reporterReference } from "./support-issues.ts";
import { ulid } from "./support-requests.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const USAGE = "Usage: operator erase <slot> <opaque-actor> <reporter-reference>; operator erasure-status <erasure>; " +
  "operator erasure-close <erasure> <opaque-actor>; operator restore-recorded <opaque-actor> <time-travel-restore>; " +
  "operator cleanup-reconcile <request> <opaque-actor> positive-evidence; " +
  "operator cleanup-exception <request> <opaque-actor> <client-instructed|operator-verified>; operator offboard <slot> <opaque-actor>";

/**
 * Erasure, cleanup review and offboarding. Independent CLI credentials
 * authorize this boundary; no HTTP route calls it. Every mutation writes its
 * audit row first, and reasons come from a fixed list, never free text.
 */
export const runCleanupOperator = async (args: readonly string[], { query, mappings, now = Date.now(), ledger: ledgerQuery }: OperatorOptions): Promise<string> => {
  // Every command reads <target> <opaque-actor> [qualifier].
  const [command, reference, actor, reason] = args;
  const run = async (statements: readonly Statement[]) => { for (const [sql, parameters] of statements) await query(sql, parameters as (string | number)[]); };
  const audit = async (action: string, target: string, why: string, eligible = "1 = 1", parameters: readonly (string | number)[] = []) =>
    (await query(`INSERT INTO cleanup_audit (id, reference, actor, action, reason, occurred_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${eligible} RETURNING id`, [crypto.randomUUID(), target, actor!, action, why, now, ...parameters])).length === 1;
  if (command === "erasure-status" && args.length === 2) {
    const status = await erasureStatus(query, reference!);
    if (!status) throw new Error("Unknown erasure");
    return JSON.stringify(status);
  }
  // Recording paths write the ledger first; without it a restore could revive what they suppress.
  const ledger = () => {
    if (!ledgerQuery) throw new Error("The suppression ledger database is required for this command");
    return ledgerStore(asQueryDatabase(ledgerQuery));
  };
  if (command === "restore-recorded" && args.length === 3 && ACTOR.test(reference ?? "") && actor === "time-travel-restore") {
    ledger();
    // Only inside a drained restore maintenance (src/maintenance.ts): nothing admitted before it can still write.
    const [boundary] = await ledgerQuery!("SELECT state, reason, began_at FROM maintenance WHERE id = 1", []);
    if (boundary?.state !== "maintenance" || boundary.reason !== "restore") {
      throw new Error("Refused: begin a restore maintenance (maintenance-begin <actor> restore <evidence>) before restoring; nothing was recorded");
    }
    const eligible = "EXISTS (SELECT 1 FROM maintenance WHERE id = 1 AND state = 'maintenance' AND reason = 'restore' AND began_at <= ?)";
    if (Number(boundary.began_at) > now - MAINTENANCE_DRAIN_MS) throw new Error("Refused: maintenance has not drained yet; see maintenance-status");
    // Every Worker replays the ledger into the restored database before serving traffic or sweeping again.
    const audited = await ledgerQuery!(`INSERT INTO ledger_audit (id, actor, action, reason, occurred_at) SELECT ?, ?, 'restore', ?, ?
      WHERE ${eligible} RETURNING id`, [crypto.randomUUID(), reference!, actor, now, now - MAINTENANCE_DRAIN_MS]);
    const recorded = audited.length === 1 && await ledgerQuery!(`UPDATE ledger_epoch SET epoch = epoch + 1, recorded_at = ?
      WHERE id = 1 AND ${eligible} RETURNING epoch`, [now, now - MAINTENANCE_DRAIN_MS]);
    if (!recorded || recorded.length !== 1) throw new Error("Refused: maintenance changed while recording; see maintenance-status");
    return "Restore recorded; Workers replay the ledger during maintenance, then verify and end it with maintenance-end";
  }
  if (!ACTOR.test(actor ?? "")) throw new Error(USAGE);
  if (command === "erase" && args.length === 4) {
    const slot = reference!;
    if (!mappingFor(mappings, slot) || !/^rs_[a-f0-9]{32}$/.test(reason ?? "")) throw new Error(USAGE);
    // The reference on the GitHub issue: a short hash of the Slot and Reporter subject.
    const rows = (await query(ERASABLE, [slot])) as { id: string; title: string; reporter_subject: string; intent_id: string }[];
    const matched = [];
    for (const row of rows) if (await reporterReference(slot, row.reporter_subject) === reason) matched.push(row);
    // With no request left, the reference search still finds the Reporter's older issues.
    const subject = matched[0]?.reporter_subject ?? "";
    const [open] = await query(OPEN_ERASURE, [slot, reason!]) as { id: string }[];
    const id = open?.id ?? `era_${ulid(now)}`;
    const targets = matched.map((row) => ({ requestId: row.id, titleDigest: null }));
    await ledger().record(erasureImages(id, slot, reason!, targets, now, !open), now);
    await audit("erase", id, "operator-request");
    // The CLI holds no digest key: the Worker's next pass purges the text and keeps the digest.
    await run(erasureStatements(id, slot, subject, reason!, targets, now, false));
    return id;
  }
  if (command === "erasure-close" && args.length === 3) {
    const status = await erasureStatus(query, reference!);
    if (!status || status.state === "in_progress" || status.state === "closed") throw new Error("Only a finished, open erasure can be closed");
    if (!await audit("close", reference!, status.state, "EXISTS (SELECT 1 FROM erasure WHERE id = ? AND closed_at IS NULL)", [reference!])) {
      throw new Error("Only a finished, open erasure can be closed");
    }
    // The reference is needed only while the erasure is open.
    await query("UPDATE erasure SET closed_at = ?, reporter_reference = NULL, changed_at = ? WHERE id = ? AND closed_at IS NULL", [now, now, reference!]);
    return "Erasure closed";
  }
  if (command === "offboard" && args.length === 3) {
    const slot = reference!;
    if (!mappingFor(mappings, slot)) throw new Error("Unknown Slot");
    await ledger().record([imageOf("suppression", { scope: "slot", reference: slot, reason: "offboarding" }),
      imageOf("offboarding", { slot, recorded_at: now, purge_after: now + OFFBOARDING_GRACE_MS })], now);
    await audit("offboard", slot, "offboarding");
    // Suppression first: no new create from the moment the Slot is offboarded.
    await query(`INSERT INTO delivery_suppression (scope, reference, reason, changed_at) VALUES ('slot', ?, 'offboarding', ?) ON CONFLICT DO NOTHING`, [slot, now]);
    await query(`INSERT INTO offboarding (slot, recorded_at, purge_after, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [slot, now, now + OFFBOARDING_GRACE_MS, now]);
    const [{ purge_after: purgeAfter }] = await query("SELECT purge_after FROM offboarding WHERE slot = ?", [slot]) as [{ purge_after: number }];
    return `Offboarded ${slot}; content is purged from ${new Date(purgeAfter).toISOString()}. Revoke its key with: operator revoke ${slot}`;
  }
  if (!REQUEST.test(reference ?? "") || args.length !== 4) throw new Error(USAGE);
  const unresolved = "EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND state = 'unresolved')";
  if (command === "cleanup-reconcile" && reason === "positive-evidence") {
    const pinned = `EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND state = 'unresolved'
      AND intent_id IS NOT NULL AND github_installation_id IS NOT NULL AND repository_id IS NOT NULL AND attempt_started_at IS NOT NULL)`;
    if (!await audit("reconcile", reference!, reason, pinned, [reference!])) throw new Error("Cleanup cannot be reconciled");
    // One more read-only hour. An erased request's known issue goes straight to
    // redaction; offboarding and retention never edit the Client's issues.
    await query(`UPDATE support_cleanup SET state = CASE WHEN purpose = 'erasure' AND COALESCE(issues_json, '[]') != '[]'
        THEN 'redacting' ELSE 'reconciling' END,
      window_until = ?, next_attempt_at = ?, reconciliation_json = NULL, last_error_class = NULL, changed_at = ?
      WHERE request_id = ? AND state = 'unresolved'`, [now + 3_600_000, now, now, reference!]);
    return "Cleanup reconciliation scheduled";
  }
  if (command === "cleanup-exception" && ["client-instructed", "operator-verified"].includes(reason ?? "")) {
    if (!await audit("exception", reference!, reason!, unresolved, [reference!])) throw new Error("Cleanup has no unresolved remote outcome");
    // Releases the restricted metadata. The erasure stays incomplete, and the tombstone window starts now.
    await query(`UPDATE support_cleanup SET state = 'excepted', resolved_at = ?, title_digest = NULL, next_attempt_at = NULL, owner = NULL,
      intent_id = NULL, github_installation_id = NULL, repository_id = NULL, attempt_started_at = NULL, attempt_ended_at = NULL,
      issues_json = NULL, reconciliation_json = NULL, changed_at = ? WHERE request_id = ? AND state = 'unresolved'`, [now, now, reference!]);
    return "Cleanup exception recorded";
  }
  throw new Error(USAGE);
};
