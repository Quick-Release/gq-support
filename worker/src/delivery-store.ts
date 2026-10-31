import type { QueryDatabase } from "./storage.ts";
import type { GitHubIssue } from "./github-gateway.ts";

export const DAY = 86_400_000;
export const EXECUTION_MS = 20_000;
// No dispatch can begin after 20s. Gateway requests time out at 15s. Allow
// 60s from invocation start before another execution can obtain the permit.
export const DRAIN_MS = 60_000;
// At most 360 mutations/hour per installation, including metadata repairs.
export const MUTATION_INTERVAL_MS = 10_000;
export type DeliveryState = "pending" | "in_flight" | "delivered" | "failed" | "outcome_unknown";
export interface DeliveryRow {
  id: string; slot: string; request_id: string; state: DeliveryState; seq: number;
  /** A create, or a Reporter status change after it (ADR 0020). */
  kind: "create" | "close" | "reopen"; change_id: string | null;
  attempts: number; generation: number; owner: string | null; lease_expires_at: number | null;
  github_installation_id: number | null; environment: string | null; client_origin_label: string | null;
  default_developer: string | null; attempt_started_at: number | null; drain_until: number | null;
  retry_deadline: number; unknown_since: number | null; reconciliation_count: number; reconciliation_json: string | null;
  review_json: string | null; operator_reconcile_until: number | null; repair_pending: number; context_json: string | null;
  title: string; description: string; created_at: number; installation_id: string;
  repository_id: number; reporter_subject: string; issue_id: number | null; issue_number: number | null; issue_node_id: string | null;
}
const columns = `i.*, r.title, r.description, r.created_at, r.installation_id, r.repository_id, r.reporter_subject,
  r.issue_id, r.issue_number, r.issue_node_id`;
const unsuppressed = `EXISTS (SELECT 1 FROM delivery_control WHERE id = 1 AND enabled = 1)
  AND NOT EXISTS (SELECT 1 FROM delivery_suppression s WHERE (s.scope = 'slot' AND s.reference = i.slot)
    OR (s.scope = 'request' AND s.reference = i.request_id))
  AND EXISTS (SELECT 1 FROM support_request r WHERE r.id = i.request_id AND r.slot = i.slot AND r.superseded_at IS NULL
    AND r.erased_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM repository_state rs JOIN support_request r ON r.repository_id = rs.repository_id
    WHERE r.id = i.request_id AND rs.suspended_reason IS NOT NULL)`;
// Nothing runs ahead of an unresolved earlier intent. A failed status change is resolved (ADR 0020);
// a failed create is not, since no later change has an issue to act on.
const ordered = `NOT EXISTS (SELECT 1 FROM delivery_intent earlier WHERE earlier.request_id = i.request_id
  AND earlier.seq < i.seq AND earlier.state != 'delivered' AND NOT (earlier.seq > 0 AND earlier.state = 'failed'))`;

/** Narrow, named cross-Slot queries; HTTP request handlers never get this API. */
export const deliveryStore = (db: QueryDatabase) => {
  const statement = (sql: string, ...parameters: unknown[]) => db.prepare(sql).bind(...parameters);
  const owned = (row: DeliveryRow) => statement(`SELECT ${columns} FROM delivery_intent i JOIN support_request r ON r.id = i.request_id
    WHERE i.id = ? AND i.slot = ? AND i.owner = ? AND i.generation = ?`, row.id, row.slot, row.owner, row.generation).first<DeliveryRow>();
  return {
    async recover(now: number) {
      // The old owner loses all writes. Keep the uncertain attempt's original
      // dispatch window, even if recovery is much later than expiry.
      await statement(`UPDATE delivery_intent SET state = 'outcome_unknown', owner = NULL, lease_expires_at = NULL,
        unknown_since = COALESCE(unknown_since, ?), next_attempt_at = ?, last_error_class = 'AbandonedAttempt'
        WHERE id IN (SELECT id FROM delivery_intent WHERE state = 'in_flight' AND lease_expires_at <= ? LIMIT 100)`, now, now, now).run();
    },
    async expire(now: number) {
      return (await statement(`UPDATE delivery_intent AS i SET state = 'failed', next_attempt_at = NULL,
        owner = NULL, lease_expires_at = NULL, last_error_class = 'DeliveryDeadline', context_json = NULL
        WHERE i.id IN (SELECT i.id FROM delivery_intent i WHERE i.state = 'pending' AND i.retry_deadline <= ?
          AND (i.owner IS NULL OR i.lease_expires_at <= ?) AND ${unsuppressed} LIMIT 100)
        AND i.state = 'pending' AND i.retry_deadline <= ? RETURNING id, slot, request_id, generation`, now, now, now)
        .all<{ id: string; slot: string; request_id: string; generation: number }>()).results;
    },
    async due(now: number): Promise<DeliveryRow[]> {
      // One candidate per Slot before the global bound. Persisted least-recently
      // served order prevents a busy/poisoned Slot from occupying the frontier.
      const result = await statement(`WITH ranked AS (
        SELECT ${columns}, COALESCE(s.last_served_at, 0) AS served,
          ROW_NUMBER() OVER (PARTITION BY i.slot ORDER BY i.next_attempt_at, i.id) AS rank
        FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
        LEFT JOIN delivery_slot_schedule s ON s.slot = i.slot
        LEFT JOIN delivery_permit p ON p.installation_id = i.github_installation_id
        WHERE i.next_attempt_at <= ? AND (i.owner IS NULL OR i.lease_expires_at <= ?)
          AND (i.state IN ('pending', 'outcome_unknown') OR (i.state = 'delivered' AND i.repair_pending = 1))
          AND (p.installation_id IS NULL OR p.provider_cooldown_until <= ?)
          AND (i.state = 'outcome_unknown' OR ((p.installation_id IS NULL OR (p.drain_until <= ? AND p.next_mutation_at <= ?))
            AND EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND next_mutation_at <= ?)))
          AND ${ordered} AND ${unsuppressed}
      ) SELECT * FROM ranked WHERE rank = 1 ORDER BY served, next_attempt_at, id LIMIT 16`, now, now, now, now, now, now).all<DeliveryRow>();
      return result.results;
    },
    async claim(row: DeliveryRow, owner: string, now: number, drain: number): Promise<DeliveryRow | null> {
      const mutation = row.state !== 'outcome_unknown';
      const operation = row.state === 'pending' ? (row.kind === 'create' ? 'create' : 'status') : row.state === 'delivered' ? 'repair' : 'reconcile';
      const batch = await db.batch([
        ...(mutation ? [statement(`UPDATE delivery_fleet_budget SET owner = ?, next_mutation_at = ?
          WHERE id = 1 AND next_mutation_at <= ?
          AND EXISTS (SELECT 1 FROM delivery_intent i WHERE i.id = ? AND i.slot = ? AND i.generation = ?
            AND i.state = ? AND (i.owner IS NULL OR i.lease_expires_at <= ?) AND ${unsuppressed})
          AND NOT EXISTS (SELECT 1 FROM delivery_permit WHERE installation_id = ? AND (drain_until > ? OR next_mutation_at > ? OR provider_cooldown_until > ?))`,
          owner, now + MUTATION_INTERVAL_MS, now, row.id, row.slot, row.generation, row.state, now, row.github_installation_id ?? 0, now, now, now),
          statement(`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND owner = ?)
          ON CONFLICT (installation_id) DO UPDATE SET owner = excluded.owner,
            drain_until = excluded.drain_until, next_mutation_at = excluded.next_mutation_at
          WHERE delivery_permit.drain_until <= ? AND delivery_permit.next_mutation_at <= ?`,
          row.github_installation_id ?? 0, owner, drain, now + MUTATION_INTERVAL_MS, owner, now, now)] : []),
        statement(`UPDATE delivery_intent AS i SET owner = ?, generation = generation + 1, lease_expires_at = ?,
          state = CASE WHEN state = 'pending' THEN 'in_flight' ELSE state END,
          attempts = attempts + CASE WHEN state = 'pending' THEN 1 ELSE 0 END,
          first_attempt_at = CASE WHEN state = 'pending' THEN COALESCE(first_attempt_at, ?) ELSE first_attempt_at END,
          attempt_started_at = CASE WHEN state = 'pending' THEN ? ELSE attempt_started_at END,
          drain_until = CASE WHEN state = 'pending' THEN ? ELSE drain_until END
          WHERE i.id = ? AND i.slot = ? AND i.generation = ? AND i.state = ? AND i.next_attempt_at <= ?
            AND (i.owner IS NULL OR i.lease_expires_at <= ?) AND ${ordered} AND ${unsuppressed}
            AND NOT EXISTS (SELECT 1 FROM delivery_permit p WHERE p.installation_id = i.github_installation_id AND p.provider_cooldown_until > ?)
            AND (? = 0 OR EXISTS (SELECT 1 FROM delivery_permit p WHERE p.installation_id = ? AND p.owner = ?))`,
          owner, drain, now, now, drain, row.id, row.slot, row.generation, row.state, now, now, now,
          mutation ? 1 : 0, row.github_installation_id ?? 0, owner),
        statement(`INSERT INTO delivery_attempt (intent_id, generation, owner, operation, started_at, drain_until)
          SELECT id, generation, owner, ?, ?, ? FROM delivery_intent WHERE id = ? AND slot = ? AND owner = ?`,
          operation, now, drain, row.id, row.slot, owner),
        statement(`INSERT INTO delivery_slot_schedule (slot, last_served_at)
          SELECT slot, ? FROM delivery_intent WHERE id = ? AND slot = ? AND owner = ?
          ON CONFLICT (slot) DO UPDATE SET last_served_at = excluded.last_served_at`, now, row.id, row.slot, owner),
      ]);
      const won = batch[mutation ? 2 : 0]!.meta.changes === 1;
      return won ? owned({ ...row, owner, generation: row.generation + 1 }) : null;
    },
    async authorized(row: DeliveryRow, now: number): Promise<boolean> {
      const found = await statement(`SELECT i.id FROM delivery_intent i JOIN delivery_permit p ON p.installation_id = i.github_installation_id
        WHERE i.id = ? AND i.slot = ? AND i.owner = ? AND i.generation = ? AND i.lease_expires_at > ?
          AND p.owner = ? AND p.drain_until > ? AND p.provider_cooldown_until <= ? AND ${unsuppressed} AND ${ordered}
          AND (i.state = 'delivered' OR (i.state = 'in_flight' AND i.retry_deadline > ?))`,
        row.id, row.slot, row.owner, row.generation, now, row.owner, now, now, now).first();
      return found !== null;
    },
    async finish(row: DeliveryRow, now: number, outcome: {
      state: DeliveryState; next: number | null; error?: string; providerUntil?: number; issue?: GitHubIssue;
      progress?: string | null; review?: string | null; repair?: boolean; unknownSince?: number;
      /** A status change proven not applied starts over: its next ambiguity has its own reconciliation window. */
      clearUnknown?: boolean;
    }) {
      const issue = outcome.issue;
      // Check ownership separately for EVERY dependent write. The intent update
      // is last so a zero-row result never permits an unfenced request write.
      await db.batch([
        // A status observation never replaces a newer one, such as a sweep's.
        ...(issue ? [statement(`UPDATE support_request SET issue_id = ?1, issue_number = ?2, issue_node_id = ?3,
          status = CASE WHEN status_source_updated_at IS NULL OR status_source_updated_at <= ?4 THEN ?5 ELSE status END,
          status_observed_at = CASE WHEN status_source_updated_at IS NULL OR status_source_updated_at <= ?4 THEN ?6 ELSE status_observed_at END,
          -- A stored ETag describes an older representation: a refresh must not take it as unchanged.
          status_etag = CASE WHEN status_source_updated_at IS NULL OR status_source_updated_at <= ?4 THEN NULL ELSE status_etag END,
          status_source_updated_at = MAX(COALESCE(status_source_updated_at, ?4), ?4)
          WHERE id = ?7 AND slot = ?8 AND (issue_id IS NULL OR issue_id = ?1)
          AND EXISTS (SELECT 1 FROM delivery_intent WHERE id = ?9 AND slot = ?8 AND owner = ?10 AND generation = ?11 AND lease_expires_at > ?6)`,
          issue.id, issue.number, issue.nodeId, Date.parse(issue.updatedAt), issue.state, now, row.request_id, row.slot,
          row.id, row.owner, row.generation)] : []),
        statement(`UPDATE delivery_attempt SET outcome = ? WHERE intent_id = ? AND generation = ? AND owner = ?
          AND EXISTS (SELECT 1 FROM delivery_intent WHERE id = ? AND owner = ? AND generation = ? AND lease_expires_at > ?)`,
          outcome.error ?? outcome.state, row.id, row.generation, row.owner, row.id, row.owner, row.generation, now),
        statement(`UPDATE delivery_permit SET drain_until = ?, next_mutation_at = MAX(next_mutation_at, ?)
          WHERE installation_id = ? AND owner = ? AND EXISTS (SELECT 1 FROM delivery_intent
            WHERE id = ? AND owner = ? AND generation = ? AND lease_expires_at > ?)`,
          outcome.state === 'outcome_unknown' ? row.drain_until ?? now : now,
          outcome.providerUntil ?? now + MUTATION_INTERVAL_MS,
          row.github_installation_id, row.owner, row.id, row.owner, row.generation, now),
        ...(outcome.providerUntil !== undefined ? [statement(`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until)
          SELECT github_installation_id, '', 0, ?, ? FROM delivery_intent WHERE id = ? AND owner = ? AND generation = ? AND lease_expires_at > ?
          ON CONFLICT (installation_id) DO UPDATE SET next_mutation_at = MAX(next_mutation_at, excluded.next_mutation_at),
            provider_cooldown_until = MAX(provider_cooldown_until, excluded.provider_cooldown_until)`,
          outcome.providerUntil!, outcome.providerUntil!, row.id, row.owner, row.generation, now)] : []),
        // Report context lives only until a terminal outcome: delivered or failed.
        statement(`UPDATE delivery_intent SET state = ?1, next_attempt_at = ?2, last_error_class = ?3, owner = NULL,
          lease_expires_at = NULL, unknown_since = CASE WHEN ?16 THEN NULL ELSE COALESCE(unknown_since, ?4) END, reconciliation_json = ?5,
          review_json = ?6, reconciliation_count = CASE WHEN ?16 THEN 0
            ELSE reconciliation_count + CASE WHEN state = 'outcome_unknown' AND ?5 IS NULL THEN 1 ELSE 0 END END,
          repair_pending = ?7, context_json = CASE WHEN ?1 IN ('delivered', 'failed') THEN NULL ELSE context_json END
          WHERE id = ?8 AND slot = ?9 AND owner = ?10 AND generation = ?11 AND lease_expires_at > ?12
          AND (?13 IS NULL OR EXISTS (SELECT 1 FROM support_request WHERE id = ?14 AND slot = ?9 AND issue_id = ?13 AND issue_node_id = ?15))`,
          outcome.state, outcome.next, outcome.error ?? null, outcome.unknownSince ?? null, outcome.progress ?? null,
          outcome.review ?? null, outcome.repair ? 1 : 0, row.id, row.slot, row.owner, row.generation, now,
          issue?.id ?? null, row.request_id, issue?.nodeId ?? null, outcome.clearUnknown ? 1 : 0),
      ]);
    },
  };
};
