import { mappingFor } from "./repository-mappings.ts";
import type { OperatorOptions } from "./operator.ts";
import { DAY } from "./delivery-store.ts";

/** Independent CLI credentials authorize this boundary; no HTTP route calls it. */
export const recoverDelivery = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const [command, slot, intent] = args;
  const reconcile = command === 'reconcile';
  const [deadlineText, actor, reason] = reconcile ? [undefined, args[3], args[4]] : [args[3], args[4], args[5]];
  const now = options.now ?? Date.now();
  const deadline = Date.parse(deadlineText ?? "");
  if (args.length !== (reconcile ? 5 : 6) || !['resume', 'reconcile'].includes(command ?? '') || !/^int_[A-Z0-9]+$/.test(intent ?? '') ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(actor ?? '') ||
      !(reconcile ? ['positive-evidence'] : ['configuration-fixed', 'permissions-restored', 'provider-recovered']).includes(reason ?? '') ||
      (!reconcile && (!Number.isFinite(deadline) || deadline <= now || deadline > now + DAY))) {
    throw new Error('Usage: operator reconcile <slot> <intent> <opaque-actor> positive-evidence; or operator resume <slot> <intent> <ISO-deadline-within-24h> <opaque-actor> <configuration-fixed|permissions-restored|provider-recovered>');
  }
  const mapping = mappingFor(options.mappings, slot!);
  if (!mapping?.githubInstallationId || !mapping.clientOriginLabel) throw new Error('Delivery mapping unavailable');
  const id = crypto.randomUUID();
  const parameters = [slot!, intent!, mapping.githubInstallationId, mapping.repositoryId, mapping.environment,
    mapping.clientOriginLabel, mapping.defaultDeveloper, now] as const;
  const eligible = `i.slot = ? AND i.id = ? AND i.github_installation_id = ? AND r.repository_id = ?
    AND i.environment = ? AND i.client_origin_label = ? AND i.default_developer = ?
    AND ${reconcile ? "i.state = 'outcome_unknown' AND i.attempt_started_at IS NOT NULL" : "i.state = 'failed'"} AND i.owner IS NULL AND (i.drain_until IS NULL OR i.drain_until <= ?)
    AND ${reconcile ? '1 = 1' : "i.last_error_class NOT IN ('OutcomeUnknown', 'AbandonedAttempt', 'UnpinnedLegacyIntent')"}
    AND r.superseded_at IS NULL AND r.erased_at IS NULL
    AND EXISTS (SELECT 1 FROM delivery_control WHERE id = 1 AND enabled = 1)
    AND NOT EXISTS (SELECT 1 FROM delivery_suppression s WHERE (s.scope = 'slot' AND s.reference = i.slot)
      OR (s.scope = 'request' AND s.reference = i.request_id))
    AND NOT EXISTS (SELECT 1 FROM repository_state rs WHERE rs.repository_id = r.repository_id AND rs.suspended_reason IS NOT NULL)`;
  // Write-ahead audit: records an authorized resume attempt, including if the
  // subsequent conditional mutation loses a race or the command is interrupted.
  const audit = await options.query(`INSERT INTO delivery_audit (id, intent_id, actor, action, reason, occurred_at)
    SELECT ?, i.id, ?, ?, ?, ? FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
    WHERE ${eligible} RETURNING id`, [id, actor!, command!, reason!, now, ...parameters]);
  if (audit.length !== 1) throw new Error('Request cannot be resumed');
  const updated = await options.query(`UPDATE delivery_intent SET ${reconcile ? 'operator_reconcile_until = ?' : "state = 'pending', retry_deadline = ?"}, next_attempt_at = ?,
    generation = generation + 1, last_error_class = NULL, reconciliation_json = NULL
    WHERE id IN (SELECT i.id FROM delivery_intent i JOIN support_request r ON r.id = i.request_id AND r.slot = i.slot
      WHERE ${eligible}) AND EXISTS (SELECT 1 FROM delivery_audit WHERE id = ? AND intent_id = delivery_intent.id)
      RETURNING id`, [reconcile ? now + 3_600_000 : deadline, now, ...parameters, id]);
  if (updated.length !== 1) throw new Error('Resume lost eligibility; inspect the audit and current state');
  return reconcile ? 'Reconciliation scheduled' : 'Delivery resumed';
};
