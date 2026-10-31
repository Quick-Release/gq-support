import { REFRESH_DEFAULTS, refreshEligible } from "./status-refresh.ts";

/**
 * Routed operational signal rules (#138; docs/support-operations-design.md). Each
 * rule reads trusted durable records, never log text, and yields the causes it
 * currently observes with their affected Slots. The minute tick turns them into
 * grouped Operational incidents (src/operational-signals.ts), which the notification phase announces. The
 * same query is the incident's recovery check, so a claimant can resolve it
 * only once the rule no longer observes the cause. These reads overlap expiry of
 * resolved incidents and old metrics: rules must not depend on those expired rows.
 * Nothing here retries,
 * recreates or force-creates delivery work.
 */
export type SignalCategory = "delivery_unknown" | "delivery_deadline" | "delivery_rejected" | "webhook_rejected" | "webhook_failed"
  | "status_refresh_behind" | "status_sweep_behind" | "privacy_cleanup"
  | "suppression_ledger_behind" | "release_update_failed" | "release_migration_failed";

export interface Signal {
  readonly runbook: string;
  /**
   * SQL yielding the rows observed at `now`: `subject` (the grouping cause),
   * `slot` (an affected Slot, or NULL) and `detail` (one of `details`, or NULL).
   */
  readonly affected: (now: number) => string;
  /** The category's stages, least to most advanced; a cause takes its most advanced observed one. */
  readonly details?: readonly string[];
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A trusted clock value written into SQL as an integer literal, never caller input. */
const at = (time: number) => String(Math.trunc(time));
// Reconciliation found more than one candidate issue, or one that does not match what was sent (src/support-issues.ts).
const CONFLICT = `json_extract(i.review_json, '$.reason') IN ('multiple-matches', 'shifted-pages', 'suspicious')`;
/**
 * Known terminal rejections that need configuration or permission repair. Repository
 * safety failures are the `repository_suspended` incident instead, and transient
 * provider failures retry within their deadline.
 */
const REJECTED = ["AppAuthenticationFailed", "PermissionMissing", "ValidationRejected", "MappingUnavailable", "MissingIdentity"];
/**
 * GitHub's own deliveries our receiver answered with `outcome` (src/webhook-deliveries.ts):
 * genuine deliveries only, so one is enough. Observed until GitHub records an
 * acknowledged delivery after the last such failure; quiet traffic is not recovery.
 */
const webhookSignal = (outcome: "rejected" | "failed"): Signal => ({
  runbook: "docs/runbooks/missed-webhooks.md",
  affected: () => `SELECT '${outcome}' AS subject, NULL AS slot, NULL AS detail FROM operational_metric m
    WHERE m.metric = 'webhook' AND m.outcome = '${outcome}'
    GROUP BY m.outcome HAVING MAX(m.last_at) > COALESCE((SELECT MAX(a.last_at) FROM operational_metric a
      WHERE a.metric = 'webhook' AND a.outcome = 'accepted'), 0)`,
});
/**
 * The suppression ledger's mirror, run by every minute cleanup pass, has not
 * completed for this long since it last did: erasures, suspensions and
 * revocations recorded since then would not survive a restore. A provisional
 * rule, not a measured threshold. A stage that has never mirrored is not observed.
 */
const LEDGER_LAG_MS = 15 * MINUTE;
/**
 * The status sweep's existing one-hour lag alert (`SWEEP_DEFAULTS.lagAlertMs`,
 * src/status-sweep.ts), restated: importing the sweep here would close a module cycle.
 */
const SWEEP_LAG_ALERT_MS = 3_600_000;
const DELIVERY_RUNBOOK = "docs/runbooks/support-operations.md#github-outage-or-stalled-delivery";
const RELEASE_RUNBOOK = "docs/runbooks/support-operations.md#fleet-rollout-and-recovery";
/** The dispatched approved release: only it is being distributed. */
const DISPATCHED = "(SELECT MAX(sequence) FROM release_dispatch)";

export const SIGNALS: Readonly<Record<SignalCategory, Signal>> = {
  // An uncertain create unresolved for 15 minutes, or at once with duplicate or suspicious matches
  // (docs/support-delivery-design.md). At 24 hours automatic reconciliation stops and the attempt is
  // handed off to an Operator. Nothing recreates it: only trusted positive evidence or audited review resolves it.
  delivery_unknown: { runbook: DELIVERY_RUNBOOK, details: ["unresolved", "conflicting_evidence", "operator_handoff"],
    affected: (now) => `SELECT CAST(r.repository_id AS TEXT) AS subject, i.slot,
      CASE WHEN i.next_attempt_at IS NULL OR i.unknown_since <= ${at(now - DAY)} THEN 'operator_handoff'
        WHEN ${CONFLICT} THEN 'conflicting_evidence' ELSE 'unresolved' END AS detail
    FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
    WHERE i.kind = 'create' AND i.state = 'outcome_unknown' AND (i.unknown_since <= ${at(now - 15 * MINUTE)} OR ${CONFLICT})` },
  // Known not delivered by its 24-hour automatic retry deadline; the accepted report keeps its own retention.
  delivery_deadline: { runbook: DELIVERY_RUNBOOK, affected: () => `SELECT CAST(r.repository_id AS TEXT) AS subject, i.slot, NULL AS detail
    FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
    WHERE i.state = 'failed' AND i.last_error_class = 'DeliveryDeadline'` },
  // Immediate: the delivery cannot succeed until an Operator repairs its configuration or permissions, then resumes it.
  delivery_rejected: { runbook: DELIVERY_RUNBOOK, affected: () => `SELECT CAST(r.repository_id AS TEXT) AS subject, i.slot, NULL AS detail
    FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
    WHERE i.state = 'failed' AND i.last_error_class IN (${REJECTED.map((code) => `'${code}'`).join(", ")})` },
  // GitHub's deliveries answered 401, as in the broken-webhook drill: a secret or App configuration mismatch.
  webhook_rejected: webhookSignal("rejected"),
  // Answered 5xx or not at all: the Worker could not record them, and GitHub does not redeliver on its own.
  webhook_failed: webhookSignal("failed"),
  // The existing one-hour refresh-age and sweep-lag alerts, for the Slots whose tracked status is going stale.
  status_refresh_behind: { runbook: "docs/runbooks/missed-webhooks.md", affected: (now) => `SELECT 'refresh' AS subject, slot, NULL AS detail
    FROM support_request WHERE status_refresh_due_at < ${at(now - REFRESH_DEFAULTS.ageAlertMs)} AND ${refreshEligible}` },
  status_sweep_behind: { runbook: "docs/runbooks/missed-webhooks.md", affected: (now) => `SELECT CAST(rs.repository_id AS TEXT) AS subject,
      r.slot, NULL AS detail FROM repository_state rs
    JOIN support_request r ON r.repository_id = rs.repository_id AND r.issue_id IS NOT NULL AND r.tracking = 'active'
    WHERE COALESCE(rs.last_swept_at, rs.sweep_scheduled_at) < ${at(now - SWEEP_LAG_ALERT_MS)}` },
  // Retention, offboarding or erasure work that cannot confirm completion: an unconfirmed remote outcome,
  // residual copies of an open erasure, or an incomplete reference search. Settled only by the Operator's
  // audited reconcile, exception or erasure close, never by a timeout or content expiry.
  privacy_cleanup: { runbook: "docs/runbooks/support-operations.md#retention-erasure-or-private-data-exposure",
    affected: () => `SELECT c.purpose AS subject, c.slot, NULL AS detail FROM support_cleanup c WHERE c.state = 'unresolved'
      OR (c.purpose = 'erasure' AND c.state = 'resolved' AND c.residual != ''
        AND EXISTS (SELECT 1 FROM erasure e WHERE e.id = c.erasure_id AND e.closed_at IS NULL))
    UNION ALL SELECT 'erasure', slot, NULL FROM erasure WHERE closed_at IS NULL AND search_state IN ('incomplete', 'failed')` },
  // A confirmed failure to install the dispatched release (src/fleet-rollout.ts): a central read-back that found
  // other files, version or a deactivated plugin, or a native installation signing other files under its version.
  // Unknown, unreachable or stale Slots are not confirmed failures; fleet-status shows them.
  release_update_failed: { runbook: RELEASE_RUNBOOK, affected: () => `SELECT CAST(d.release_sequence AS TEXT) AS subject, d.slot, NULL AS detail
    FROM central_deployment d WHERE d.release_sequence = ${DISPATCHED} AND d.outcome = 'failed'
      AND NOT EXISTS (SELECT 1 FROM central_deployment n WHERE n.slot = d.slot AND n.release_sequence = d.release_sequence AND n.rowid > d.rowid)
    UNION ALL SELECT CAST(f.sequence AS TEXT), s.slot, NULL FROM fleet_launch f JOIN release_approval a ON a.sequence = f.sequence
      JOIN release_verification v ON v.package_version = a.package_version
      JOIN slot_installed_files s ON s.version = a.package_version AND s.files_sha256 <> v.files_sha256 AND s.observed_at >= f.launched_at
    WHERE f.sequence = ${DISPATCHED}` },
  // The live migration state an Operator command last read was not the reviewed migrations with their checksums.
  release_migration_failed: { runbook: RELEASE_RUNBOOK, details: ["unreadable", "unreviewed", "mismatch"],
    affected: () => `SELECT 'schema' AS subject, NULL AS slot, state AS detail FROM schema_observation
      WHERE rowid = (SELECT MAX(rowid) FROM schema_observation) AND state <> 'ok'` },
  suppression_ledger_behind: { runbook: "docs/runbooks/support-operations.md#retention-erasure-or-private-data-exposure",
    affected: (now) => `SELECT 'mirror' AS subject, NULL AS slot, NULL AS detail FROM restore_state
      WHERE id = 1 AND mirrored_at > 0 AND mirrored_at < ${at(now - LEDGER_LAG_MS)}` },
};

