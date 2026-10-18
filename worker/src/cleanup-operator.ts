import { ERASABLE, erasureStatements, erasureStatus, erasureTargets, OFFBOARDING_GRACE_MS, purgeStatements, type Statement } from "./cleanup.ts";
import type { OperatorOptions } from "./operator.ts";
import { mappingFor } from "./repository-mappings.ts";
import { sha256 } from "./signature.ts";
import { ulid } from "./support-requests.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const USAGE = "Usage: operator erase <slot> <opaque-actor> <reporter-reference>; operator erasure-status <erasure>; " +
  "operator cleanup-reconcile <request> <opaque-actor> positive-evidence; " +
  "operator cleanup-exception <request> <opaque-actor> <client-instructed|operator-verified>; operator offboard <slot> <opaque-actor>";

/**
 * Erasure, cleanup review and offboarding. Independent CLI credentials
 * authorize this boundary; no HTTP route calls it. Every mutation writes its
 * audit row first, and reasons come from a fixed list, never free text.
 */
export const runCleanupOperator = async (args: readonly string[], { query, mappings, now = Date.now() }: OperatorOptions): Promise<string> => {
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
  if (!ACTOR.test(actor ?? "")) throw new Error(USAGE);
  if (command === "erase" && args.length === 4) {
    const slot = reference!;
    if (!mappingFor(mappings, slot) || !/^rs_[a-f0-9]{32}$/.test(reason ?? "")) throw new Error(USAGE);
    // The reference on the GitHub issue: a short hash of the Slot and Reporter subject.
    const rows = (await query(ERASABLE, [slot])) as { id: string; title: string; reporter_subject: string; intent_id: string }[];
    const matched = [];
    for (const row of rows) if (`rs_${(await sha256(JSON.stringify([slot, row.reporter_subject]))).slice(0, 32)}` === reason) matched.push(row);
    const subject = matched[0]?.reporter_subject;
    if (!subject) throw new Error("No Support requests match that reporter reference");
    const id = `era_${ulid(now)}`;
    await audit("erase", id, "operator-request");
    await run(erasureStatements(id, slot, subject, await erasureTargets(matched), now));
    return id;
  }
  if (command === "offboard" && args.length === 3) {
    const slot = reference!;
    if (!mappingFor(mappings, slot)) throw new Error("Unknown Slot");
    await audit("offboard", slot, "offboarding");
    // Suppression first: no new create from the moment the Slot is offboarded.
    await query(`INSERT INTO delivery_suppression (scope, reference, reason) VALUES ('slot', ?, 'offboarding') ON CONFLICT DO NOTHING`, [slot]);
    await query(`INSERT INTO offboarding (slot, recorded_at, purge_after) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [slot, now, now + OFFBOARDING_GRACE_MS]);
    const [{ purge_after: purgeAfter }] = await query("SELECT purge_after FROM offboarding WHERE slot = ?", [slot]) as [{ purge_after: number }];
    return `Offboarded ${slot}; content is purged from ${new Date(purgeAfter).toISOString()}. Revoke its key with: operator revoke ${slot}`;
  }
  if (!REQUEST.test(reference ?? "") || args.length !== 4) throw new Error(USAGE);
  const unresolved = "EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND state = 'unresolved')";
  if (command === "cleanup-reconcile" && reason === "positive-evidence") {
    const pinned = `${unresolved} AND EXISTS (SELECT 1 FROM delivery_intent WHERE request_id = ? AND seq = 0
      AND github_installation_id IS NOT NULL AND attempt_started_at IS NOT NULL AND (owner IS NULL OR lease_expires_at <= ?))`;
    if (!await audit("reconcile", reference!, reason, pinned, [reference!, reference!, now])) throw new Error("Cleanup cannot be reconciled");
    // One more read-only hour. An erased request's known issue goes straight to
    // redaction; offboarding and retention never edit the Client's issues.
    await query(`UPDATE support_cleanup SET state = CASE WHEN purpose = 'erasure' AND EXISTS (SELECT 1 FROM support_request
        WHERE id = support_cleanup.request_id AND issue_id IS NOT NULL) THEN 'redacting' ELSE 'reconciling' END,
      window_until = ?, next_attempt_at = ?, reconciliation_json = NULL, last_error_class = NULL
      WHERE request_id = ? AND state = 'unresolved'`, [now + 3_600_000, now, reference!]);
    return "Cleanup reconciliation scheduled";
  }
  if (command === "cleanup-exception" && ["client-instructed", "operator-verified"].includes(reason ?? "")) {
    if (!await audit("exception", reference!, reason!, unresolved, [reference!])) throw new Error("Cleanup has no unresolved remote outcome");
    // Releases the restricted metadata. The erasure stays incomplete, and the tombstone window starts now.
    await query(`UPDATE support_cleanup SET state = 'excepted', resolved_at = ?, title_digest = NULL, next_attempt_at = NULL, owner = NULL
      WHERE request_id = ? AND state = 'unresolved'`, [now, reference!]);
    await run(purgeStatements(reference!));
    return "Cleanup exception recorded";
  }
  throw new Error(USAGE);
};
