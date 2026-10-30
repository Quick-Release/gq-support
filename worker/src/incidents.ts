import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { QueryDatabase } from "./storage.ts";

/**
 * Operational incidents (CONTEXT.md, docs/support-operations-design.md). The
 * service owns them durably; a staff dashboard and the Operator CLI only view,
 * claim and resolve them. Every observation of one cause updates the same open
 * incident and its affected Slots; another cause is another incident. Nothing
 * here reminds, times out a claim or escalates: an unclaimed incident simply
 * stays visible. An incident holds no report content, identity or credential.
 */
export type IncidentCategory = "repository_suspended";
export type Via = "service" | "api" | "operator";
const RESOLUTIONS = ["recovered"] as const;
export type Resolution = typeof RESOLUTIONS[number];
export const isResolution = (value: unknown): value is Resolution => RESOLUTIONS.includes(value as Resolution);

/** Kept until resolved, then for 90 days; projections never show an expired one. */
export const INCIDENT_RETENTION_MS = 90 * 86_400_000;

interface CategoryRule {
  readonly runbook: string;
  /** An SQL condition on incident `i` that holds only once trusted records show the cause recovered. */
  readonly recovered: string;
}
const CATEGORIES: Readonly<Record<IncidentCategory, CategoryRule>> = {
  // Only the Operator's audited `unsuspend` lifts a suspension (src/repository-suspension.ts).
  repository_suspended: { runbook: "worker/README.md#suspended-mappings",
    recovered: `NOT EXISTS (SELECT 1 FROM repository_state r
      WHERE r.repository_id = CAST(i.subject AS INTEGER) AND r.suspended_reason IS NOT NULL)` },
};
const ruleOf = (category: string): CategoryRule | undefined =>
  Object.hasOwn(CATEGORIES, category) ? CATEGORIES[category as IncidentCategory] : undefined;

export interface Observation {
  readonly category: IncidentCategory;
  /** The cause within the category, such as a repository ID: the grouping key. */
  readonly subject: string;
  readonly slots: readonly string[];
  readonly now: number;
}

/**
 * Statements recording one observation, for the caller's own batch so the
 * failure and its incident are written together. They open the cause's incident
 * if none is open, or extend the open one's last observation and affected Slots.
 */
export const observeIncident = (db: QueryDatabase, { category, subject, slots, now }: Observation): D1PreparedStatement[] => {
  const id = crypto.randomUUID();
  return [
    db.prepare(`INSERT INTO incident (id, category, subject, state, first_observed_at, last_observed_at) VALUES (?, ?, ?, 'open', ?, ?)
      ON CONFLICT (category, subject) WHERE state = 'open'
      DO UPDATE SET last_observed_at = MAX(last_observed_at, excluded.last_observed_at)`).bind(id, category, subject, now, now),
    // Only when this observation opened it.
    db.prepare(`INSERT INTO incident_audit (id, incident_id, actor, via, action, previous_state, new_state, occurred_at)
      SELECT ?, id, 'service', 'service', 'open', NULL, 'open', ? FROM incident WHERE id = ?`).bind(crypto.randomUUID(), now, id),
    db.prepare(`INSERT INTO incident_slot (incident_id, slot, first_observed_at, last_observed_at)
      SELECT i.id, s.value, ?, ? FROM incident i, json_each(?) s WHERE i.category = ? AND i.subject = ? AND i.state = 'open'
      ON CONFLICT (incident_id, slot) DO UPDATE SET last_observed_at = MAX(last_observed_at, excluded.last_observed_at)`)
      .bind(now, now, JSON.stringify(slots), category, subject),
  ];
};

interface IncidentRow {
  id: string; category: string; state: "open" | "resolved"; first_observed_at: number; last_observed_at: number;
  claimant: string | null; claimed_at: number | null; claim_audit_id: string | null;
  resolution: string | null; resolved_at: number | null; resolve_audit_id: string | null; slots: string;
}
/** The team-wide view: no cause subject, audit trail or anything else beyond what responders need. */
export interface IncidentProjection {
  readonly id: string;
  readonly category: string;
  readonly state: "open" | "claimed" | "resolved";
  readonly affected_slots: readonly string[];
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly claimant: string | null;
  readonly claimed_at: string | null;
  readonly resolution: string | null;
  readonly resolved_at: string | null;
  readonly runbook: string | null;
}
const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
const project = (row: IncidentRow): IncidentProjection => ({
  id: row.id, category: row.category,
  state: row.state === "resolved" ? "resolved" : row.claimant ? "claimed" : "open",
  affected_slots: JSON.parse(row.slots) as string[],
  first_observed_at: iso(row.first_observed_at)!, last_observed_at: iso(row.last_observed_at)!,
  claimant: row.claimant, claimed_at: iso(row.claimed_at), resolution: row.resolution, resolved_at: iso(row.resolved_at),
  runbook: ruleOf(row.category)?.runbook ?? null,
});

const SELECT = `SELECT i.id, i.category, i.state, i.first_observed_at, i.last_observed_at, i.claimant, i.claimed_at, i.claim_audit_id,
  i.resolution, i.resolved_at, i.resolve_audit_id,
  (SELECT json_group_array(slot) FROM (SELECT slot FROM incident_slot WHERE incident_id = i.id ORDER BY slot)) AS slots
  FROM incident i WHERE (i.state = 'open' OR i.resolved_at > ?)`;
const row = (db: QueryDatabase, id: string, now: number) =>
  db.prepare(`${SELECT} AND i.id = ?`).bind(now - INCIDENT_RETENTION_MS, id).first<IncidentRow>();

/** Open incidents first, oldest first, then unexpired resolved ones. */
// Positional `?` only: the Operator CLI's Wrangler adapter substitutes them in order (scripts/operator.ts).
export const listIncidents = async (db: QueryDatabase, now: number): Promise<IncidentProjection[]> =>
  (await db.prepare(`${SELECT} ORDER BY i.state = 'resolved', i.first_observed_at, i.id LIMIT 200`)
    .bind(now - INCIDENT_RETENTION_MS).all<IncidentRow>()).results.map(project);

export const findIncident = async (db: QueryDatabase, id: string, now: number): Promise<IncidentProjection | null> => {
  const found = await row(db, id, now);
  return found ? project(found) : null;
};

/** Each actor's incident history, for the restricted Operator view only. */
export const incidentAudit = async (db: QueryDatabase, id: string) =>
  (await db.prepare(`SELECT * FROM (SELECT actor, via, action, previous_state, new_state, occurred_at FROM incident_audit
    WHERE incident_id = ? AND action <> 'claim'
    UNION ALL SELECT claimant AS actor, claim_via AS via, 'claim' AS action, 'open' AS previous_state,
      'claimed' AS new_state, claimed_at AS occurred_at FROM incident WHERE id = ? AND claimant IS NOT NULL)
    ORDER BY occurred_at, CASE action WHEN 'open' THEN 0 WHEN 'claim' THEN 1 ELSE 2 END`)
    .bind(id, id).all<Record<string, unknown>>()).results;

export type ClaimOutcome = "claimed" | "not_found" | "claimed_by_other" | "resolved";
export type ResolveOutcome = "resolved" | "not_found" | "not_claimant" | "already_resolved" | "recovery_not_verified";
export interface Mutation<Outcome> { readonly outcome: Outcome; readonly incident: IncidentProjection | null }

/**
 * Self-claim: the immutable actor/channel/time and claim identity form its audit
 * in the same conditional write, also atomic through the remote Operator's
 * single-statement transport. Repeating your own claim adds no audit event.
 */
export const claimIncident = async (db: QueryDatabase, id: string, actor: string, via: Via, now: number): Promise<Mutation<ClaimOutcome>> => {
  const audit = crypto.randomUUID();
  await db.prepare(`UPDATE incident SET claimant = ?, claimed_at = ?, claim_audit_id = ?, claim_via = ?
    WHERE id = ? AND state = 'open' AND claimant IS NULL`).bind(actor, now, audit, via, id).run();
  const found = await row(db, id, now);
  if (!found) return { outcome: "not_found", incident: null };
  const outcome = found.state === "resolved" ? "resolved" : found.claimant === actor ? "claimed" : "claimed_by_other";
  return { outcome, incident: project(found) };
};

/**
 * Resolution by the incident's claimant, once trusted records show its cause
 * recovered. The recovery check is part of the same conditional write.
 */
export const resolveIncident = async (db: QueryDatabase, id: string, actor: string, via: Via, resolution: Resolution,
  now: number): Promise<Mutation<ResolveOutcome>> => {
  const before = await row(db, id, now);
  if (!before) return { outcome: "not_found", incident: null };
  const rule = ruleOf(before.category);
  if (before.state === "open" && before.claimant === actor && rule) {
    const audit = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO incident_audit (id, incident_id, actor, via, action, previous_state, new_state, occurred_at)
        SELECT ?, i.id, ?, ?, 'resolve', 'claimed', 'resolved', ? FROM incident i
        WHERE i.id = ? AND i.state = 'open' AND i.claimant = ? AND ${rule.recovered}`).bind(audit, actor, via, now, id, actor),
      db.prepare(`UPDATE incident SET state = 'resolved', resolution = ?, resolved_at = ?, resolve_audit_id = ?
        WHERE id = ? AND state = 'open' AND claimant = ? AND EXISTS (SELECT 1 FROM incident_audit WHERE id = ?)`)
        .bind(resolution, now, audit, id, actor, audit),
    ]);
    const after = (await row(db, id, now))!;
    if (after.resolve_audit_id === audit) return { outcome: "resolved", incident: project(after) };
    return { outcome: after.state === "resolved" ? "already_resolved" : after.claimant === actor ? "recovery_not_verified" : "not_claimant",
      incident: project(after) };
  }
  return { outcome: before.state === "resolved" ? "already_resolved" : before.claimant !== actor ? "not_claimant" : "recovery_not_verified",
    incident: project(before) };
};

/** Deletes a bounded batch of incidents resolved more than 90 days ago, with their Slots and audit. */
export const expireIncidents = async (db: QueryDatabase, now: number): Promise<void> => {
  const expired = `SELECT id FROM incident WHERE state = 'resolved' AND resolved_at <= ? ORDER BY resolved_at LIMIT 100`;
  const cutoff = now - INCIDENT_RETENTION_MS;
  await db.batch([
    db.prepare(`DELETE FROM incident_slot WHERE incident_id IN (${expired})`).bind(cutoff),
    db.prepare(`DELETE FROM incident_audit WHERE incident_id IN (${expired})`).bind(cutoff),
    db.prepare(`DELETE FROM incident WHERE id IN (${expired})`).bind(cutoff),
  ]);
};
