import type { OperatorOptions } from "./operator.ts";
import { refreshEligible } from "./status-refresh.ts";
import { SWEEP_DEFAULTS } from "./status-sweep.ts";

/**
 * Operator status recovery after missed webhooks (docs/runbooks/missed-webhooks.md).
 * Independent CLI credentials authorize these commands; no HTTP route calls them.
 * They write only sweep bookkeeping and a counts-only audit: never GitHub, never content.
 */

/** A repository is current when its last completed sweep is within the sweep bound: interval, Cron minute and fetch. */
const SWEEP_BOUND_MS = SWEEP_DEFAULTS.intervalMs + 2 * 60_000;
const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = {
  reconcile: "Usage: operator status-reconcile <ISO-outage-start> <opaque-actor>",
  health: "Usage: operator status-health",
  repair: "Usage: operator status-repair <ISO-window-start> <ISO-window-end> <opaque-actor>",
};

/** Mapped repositories and those pinned on tracked requests: the sweep's targets. */
const targets = (mappings = "?") => `SELECT json_extract(value, '$.repositoryId') AS repository_id FROM json_each(${mappings})
  WHERE json_extract(value, '$.githubInstallationId') IS NOT NULL
  UNION SELECT repository_id FROM support_request WHERE issue_id IS NOT NULL AND tracking = 'active'`;

interface Health {
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly dueRefreshes: number;
  readonly oldestDueAgeMs: number;
  readonly repositories: readonly { repositoryId: number; lastSweptAt: string | null; sweepAgeMs: number | null; sweeping: boolean;
    suspended: boolean; withinInterval: boolean }[];
  readonly suspensions: readonly { repositoryId: number; reason: string; suspendedAt: string | null; verifiedSafeAt: string | null; acknowledged: boolean }[];
  /** The pass that re-reads every open request, the only check that sees deleted and transferred issues. */
  readonly openRequestPass: { inProgress: boolean; startedAt: string | null; lastCompletedAt: string | null };
}

const iso = (time: unknown) => typeof time === "number" ? new Date(time).toISOString() : null;
const instant = (text: string | undefined) => /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(text ?? "") ? Date.parse(text!) : NaN;

const health = async ({ query, mappings, now = Date.now() }: OperatorOptions): Promise<Health> => {
  const configured = JSON.stringify(mappings);
  const [due] = await query(`SELECT COUNT(*) AS count, MIN(status_refresh_due_at) AS oldest FROM support_request
    WHERE status_refresh_due_at IS NOT NULL AND ${refreshEligible}`, []);
  const repositories = await query(`SELECT t.repository_id, s.last_swept_at, s.sweep_cursor IS NOT NULL AS sweeping,
      s.suspended_reason IS NOT NULL AS suspended
    FROM (${targets()}) t LEFT JOIN repository_state s ON s.repository_id = t.repository_id ORDER BY t.repository_id`, [configured]);
  // A repair audit recorded after a suspension began, naming its repository, acknowledges it.
  const suspensions = await query(`SELECT s.repository_id, s.suspended_reason, s.suspended_at, s.verified_safe_at,
      EXISTS (SELECT 1 FROM status_audit a, json_each(a.suspended_repositories) j WHERE a.action = 'repair'
        AND j.value = s.repository_id AND a.occurred_at >= COALESCE(s.suspended_at, 0)) AS acknowledged
    FROM repository_state s WHERE s.suspended_reason IS NOT NULL ORDER BY s.repository_id`, []);
  const [pass] = await query("SELECT started_at, completed_at FROM status_refresh_pass WHERE id = 1", []);
  const report = {
    checkedAt: new Date(now).toISOString(),
    dueRefreshes: Number(due?.count ?? 0),
    oldestDueAgeMs: typeof due?.oldest === "number" ? Math.max(0, now - due.oldest) : 0,
    repositories: repositories.map((row) => {
      const age = typeof row.last_swept_at === "number" ? Math.max(0, now - row.last_swept_at) : null;
      return { repositoryId: Number(row.repository_id), lastSweptAt: iso(row.last_swept_at), sweepAgeMs: age,
        sweeping: Boolean(row.sweeping), suspended: Boolean(row.suspended), withinInterval: !row.sweeping && age !== null && age <= SWEEP_BOUND_MS };
    }),
    suspensions: suspensions.map((row) => ({ repositoryId: Number(row.repository_id), reason: String(row.suspended_reason),
      suspendedAt: iso(row.suspended_at), verifiedSafeAt: iso(row.verified_safe_at), acknowledged: Boolean(row.acknowledged) })),
    openRequestPass: { inProgress: pass?.started_at != null, startedAt: iso(pass?.started_at), lastCompletedAt: iso(pass?.completed_at) },
  };
  return { healthy: report.dueRefreshes === 0 && behind(report.repositories) === 0 && !report.openRequestPass.inProgress &&
    report.suspensions.every((suspension) => suspension.acknowledged), ...report };
};

/**
 * Unsuspended repositories whose sweep is not current. A suspended one is
 * excluded: its status is frozen, and while it stays unsafe its sweep cannot
 * complete. The suspension list accounts for it instead.
 */
const behind = (repositories: Health["repositories"]) =>
  repositories.filter((repository) => !repository.suspended && !repository.withinInterval).length;

/**
 * `status-reconcile` starts a full reconciliation: every target repository's
 * next sweep lists from the outage start minus the usual skew, and verifies the
 * repository first, as every sweep does. A sweep already in progress from an
 * earlier position keeps it, and its start, so completing it records the
 * sweep as of when it began. Deleted and transferred issues never appear in a
 * listing, so the open-request pass also restarts now rather than at its daily
 * time; restarting one in progress makes it revisit rows it passed before.
 */
const reconcile = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, mappings, now = Date.now() } = options;
  const [, startText, actor] = args;
  const start = instant(startText);
  if (args.length !== 3 || !Number.isFinite(start) || start > now || !ACTOR.test(actor ?? "")) throw new Error(USAGE.reconcile);
  const cursor = Math.max(0, start - SWEEP_DEFAULTS.skewMs);
  const configured = JSON.stringify(mappings);
  const { dueRefreshes } = await health(options);
  // Write-ahead audit, as for other Operator commands: it records the attempt even if the update is interrupted.
  const id = crypto.randomUUID();
  const [audit] = await query(`INSERT INTO status_audit (id, actor, action, window_start, repositories, due_refreshes, occurred_at)
    SELECT ?, ?, 'reconcile', ?, COUNT(*), ?, ? FROM (${targets()}) RETURNING repositories`, [id, actor!, start, dueRefreshes, now, configured]);
  const scheduled = await query(`INSERT INTO repository_state (repository_id, observed_at, sweep_scheduled_at, sweep_started_at, sweep_cursor, sweep_page)
    SELECT repository_id, ?1, ?1, ?1, ?2, 1 FROM (${targets("?3")}) WHERE true
    ON CONFLICT (repository_id) DO UPDATE SET
      sweep_scheduled_at = COALESCE(sweep_scheduled_at, excluded.sweep_scheduled_at),
      sweep_started_at = COALESCE(sweep_started_at, excluded.sweep_started_at),
      sweep_page = CASE WHEN sweep_cursor <= excluded.sweep_cursor THEN sweep_page ELSE 1 END,
      sweep_cursor = CASE WHEN sweep_cursor <= excluded.sweep_cursor THEN sweep_cursor ELSE excluded.sweep_cursor END
    RETURNING repository_id`, [now, cursor, configured]);
  if (scheduled.length !== Number(audit?.repositories)) throw new Error("Reconciliation partly scheduled; inspect the audit and run it again");
  await query("UPDATE status_refresh_pass SET started_at = ?, cursor = '' WHERE id = 1", [now]);
  return `Full reconciliation sweep scheduled for ${scheduled.length} repositories from ${new Date(start).toISOString()}`;
};

/**
 * `status-repair` records that recovery is confirmed for an outage window:
 * the due backlog is drained, no open-request pass is in progress, and every
 * repository was swept within one interval, apart from suspended ones. It
 * acknowledges the suspensions present at that time, including ones whose
 * repository is still unsafe.
 */
const repair = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, now = Date.now() } = options;
  const [, startText, endText, actor] = args;
  const start = instant(startText), end = instant(endText);
  if (args.length !== 4 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now || !ACTOR.test(actor ?? "")) {
    throw new Error(USAGE.repair);
  }
  const report = await health(options);
  const lagging = behind(report.repositories);
  if (report.dueRefreshes > 0 || lagging > 0 || report.openRequestPass.inProgress) {
    throw new Error(`Status not yet repaired: ${report.dueRefreshes} due refreshes, ${lagging} repositories behind` +
      (report.openRequestPass.inProgress ? ", open-request pass in progress" : ""));
  }
  await query(`INSERT INTO status_audit (id, actor, action, window_start, window_end, repositories, due_refreshes, suspended_repositories, occurred_at)
    VALUES (?, ?, 'repair', ?, ?, ?, 0, ?, ?)`, [crypto.randomUUID(), actor!, start, end, report.repositories.length,
    JSON.stringify(report.suspensions.map((suspension) => suspension.repositoryId)), now]);
  return `Recorded status repair for ${report.repositories.length} repositories`;
};

export const runStatusOperation = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  if (args[0] === "status-reconcile") return reconcile(args, options);
  if (args[0] === "status-repair") return repair(args, options);
  if (args[0] !== "status-health" || args.length !== 1) throw new Error(USAGE.health);
  return JSON.stringify(await health(options), null, 2);
};
