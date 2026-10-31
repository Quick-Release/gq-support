import type { QueryDatabase } from "./storage.ts";
import { PURGED_TEXT } from "./support-requests.ts";
import { episodeWork, type Episode } from "./independent-check.ts";

/**
 * The suppression ledger (ADR 0016): a separate D1 that a restore of the main
 * database never rewinds. It keeps the current image of each suppression,
 * erasure, cleanup record, offboarding, repository suspension and runtime key
 * revocation, so they can be replayed into a restored main database before it
 * serves traffic.
 *
 * Writes go in one of two directions, both safe:
 * - recording paths (erasure, offboarding, a site's self-revocation) write
 *   the ledger first, so a failed main write leaves only what was asked for
 *   in the ledger, which a later restore carries out;
 * - every cleanup pass mirrors the main tables into the ledger. The mirror
 *   only adds or updates images, never removes one: after an unrecorded
 *   restore it can regress an image to an older, more conservative state but
 *   cannot drop a suppression. Removals come only from compaction and an
 *   Operator's lift, each recorded explicitly.
 *
 * It also holds the restore epoch, the maintenance boundary
 * (src/maintenance.ts), acknowledged checker episodes and withdrawn releases.
 */
export type LedgerKind = "suppression" | "erasure" | "cleanup" | "offboarding" | "suspension" | "revocation";
type Value = string | number | null;
export type LedgerImage = Readonly<Record<string, Value>>;
/** What the ledger says about service: the recorded restore epoch and the maintenance boundary (ledger-migrations/0003). */
export interface ServiceControl { readonly epoch: number; readonly generation: number; readonly maintenance: boolean }
export interface LedgerEntry {
  readonly kind: LedgerKind;
  readonly reference: string;
  /** Null records a removal. */
  readonly payload: LedgerImage | null;
}

/**
 * The mirrored columns: no text, subject or owner. `changed` is the column
 * every writer sets to the write time, so a pass reads only recent changes.
 */
const TABLES: Record<LedgerKind, { readonly table: string; readonly key: readonly string[]; readonly columns: readonly string[];
  readonly changed: string; readonly present?: string }> = {
  suppression: { table: "delivery_suppression", key: ["scope", "reference"], columns: ["scope", "reference", "reason"], changed: "changed_at" },
  erasure: { table: "erasure", key: ["id"], columns: ["id", "slot", "recorded_at", "reporter_reference", "closed_at", "search_state", "search_next_at",
    "search_ended_at"],
    changed: "changed_at" },
  offboarding: { table: "offboarding", key: ["slot"], columns: ["slot", "recorded_at", "purge_after"], changed: "changed_at" },
  cleanup: { table: "support_cleanup", key: ["request_id"], changed: "changed_at", columns: ["request_id", "slot", "purpose", "erasure_id", "recorded_at", "title_digest",
    "state", "outcome", "residual", "next_attempt_at", "window_started_at", "window_until", "reconciliation_count", "reconciliation_json",
    "last_error_class", "resolved_at", "intent_id", "github_installation_id", "repository_id", "attempt_started_at", "attempt_ended_at", "issues_json"] },
  suspension: { table: "repository_state", key: ["repository_id"], columns: ["repository_id", "suspended_reason", "suspended_at"],
    present: "suspended_reason IS NOT NULL", changed: "suspended_at" },
  // Key revocations made at runtime: never undone, so a restore cannot revive a revoked key. Native update key
  // revocations are recorded here explicitly, first, under the same kind (src/update-access-operator.ts).
  revocation: { table: "installation_key", key: ["key_id"], columns: ["key_id", "revoked_at"], present: "revoked_at IS NOT NULL", changed: "revoked_at" },
};
/** Replay order: an erasure before its cleanup records. */
const ORDER: readonly LedgerKind[] = ["suppression", "erasure", "offboarding", "cleanup", "suspension", "revocation"];
const CHUNK = 50;
/** Covers clock skew between isolates and writes that land while a pass runs. */
const MIRROR_SKEW_MS = 300_000;
/** A full pass also covers any write that left `changed_at` at its default. */
const FULL_MIRROR_MS = 86_400_000;

const referenceOf = (kind: LedgerKind, image: LedgerImage) => TABLES[kind].key.map((column) => String(image[column])).join(":");
/** A full image with every mirrored column, so a replay never mixes two versions of a row. */
export const imageOf = (kind: LedgerKind, row: Readonly<Record<string, unknown>>, defaults: LedgerImage = {}): LedgerEntry => {
  const image = Object.fromEntries(TABLES[kind].columns.map((column) => [column, (row[column] ?? defaults[column] ?? null) as Value]));
  return { kind, reference: referenceOf(kind, image), payload: image };
};
export const removal = (kind: LedgerKind, reference: string): LedgerEntry => ({ kind, reference, payload: null });
const statements = (db: QueryDatabase, list: readonly (readonly [string, readonly Value[]])[]) => list.map(([sql, parameters]) => db.prepare(sql).bind(...parameters));
const inChunks = async (db: QueryDatabase, list: readonly (readonly [string, readonly Value[]])[]) => {
  for (let index = 0; index < list.length; index += CHUNK) await db.batch(statements(db, list.slice(index, index + CHUNK)));
};

export const ledgerStore = (ledger: QueryDatabase) => ({
  async record(entries: readonly LedgerEntry[], now: number) {
    await inChunks(ledger, entries.map((entry) => [`INSERT INTO ledger_entry (kind, reference, payload, recorded_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, reference) DO UPDATE SET payload = excluded.payload, recorded_at = excluded.recorded_at`,
      [entry.kind, entry.reference, entry.payload === null ? null : JSON.stringify(entry.payload), now]] as const));
  },
  async epoch() {
    return (await ledger.prepare("SELECT epoch FROM ledger_epoch WHERE id = 1").first<{ epoch: number }>())?.epoch ?? 0;
  },
  /** The restore epoch and maintenance boundary, in one read; null when either row is missing. */
  async control(): Promise<ServiceControl | null> {
    const row = await ledger.prepare(`SELECT e.epoch, m.generation, m.state FROM ledger_epoch e, maintenance m
      WHERE e.id = 1 AND m.id = 1`).first<{ epoch: number; generation: number; state: string }>();
    return row ? { epoch: row.epoch, generation: row.generation, maintenance: row.state !== "serving" } : null;
  },
  /**
   * The last check before a create: no suppression recorded here, even if the
   * main copy was lost, and the service still serving under the same restore
   * epoch and maintenance generation as when this execution began.
   */
  async authorizes(slot: string, requestId: string, fence: ServiceControl) {
    return (await ledger.prepare(`SELECT 1 FROM ledger_epoch e, maintenance m WHERE e.id = 1 AND m.id = 1
      AND m.state = 'serving' AND m.generation = ? AND e.epoch = ?
      AND NOT EXISTS (SELECT 1 FROM ledger_entry WHERE kind = 'suppression' AND payload IS NOT NULL AND reference IN (?, ?))`)
      .bind(fence.generation, fence.epoch, `slot:${slot}`, `request:${requestId}`).first()) !== null;
  },
  /** Removals outlive the 30-day Time Travel window, then go. */
  async compact(now: number, keepMs: number) {
    await ledger.prepare("DELETE FROM ledger_entry WHERE payload IS NULL AND recorded_at <= ?").bind(now - keepMs).run();
    // Retained checker episodes go once no restore within the Time Travel window could need them.
    await ledger.prepare("DELETE FROM retained_episode WHERE received_at <= ?").bind(now - keepMs).run();
  },
});

/**
 * Adds or updates the ledger image of every main row changed since the last
 * pass, and of every row once a day. Never records a removal.
 */
export const mirrorToLedger = async (main: QueryDatabase, ledger: QueryDatabase, now: number) => {
  const marks = await main.prepare("SELECT mirrored_at, full_mirrored_at FROM restore_state WHERE id = 1")
    .first<{ mirrored_at: number; full_mirrored_at: number }>();
  const full = !marks || now - marks.full_mirrored_at >= FULL_MIRROR_MS;
  const changed: LedgerEntry[] = [];
  for (const kind of ORDER) {
    const { table, columns, present, changed: column } = TABLES[kind];
    const filters = [...(present ? [present] : []), ...(full ? [] : [`${column} >= ?`])];
    const rows = (await main.prepare(`SELECT ${columns.join(", ")} FROM ${table}${filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : ""}`)
      .bind(...(full ? [] : [marks.mirrored_at - MIRROR_SKEW_MS])).all()).results;
    const entries = rows.map((row) => imageOf(kind, row));
    const recorded = new Map<string, string | null>();
    if (full) {
      for (const entry of (await ledger.prepare("SELECT reference, payload FROM ledger_entry WHERE kind = ?").bind(kind)
        .all<{ reference: string; payload: string | null }>()).results) recorded.set(entry.reference, entry.payload);
    } else {
      for (let index = 0; index < entries.length; index += CHUNK) {
        const references = entries.slice(index, index + CHUNK).map((entry) => entry.reference);
        for (const entry of (await ledger.prepare(`SELECT reference, payload FROM ledger_entry WHERE kind = ?
          AND reference IN (${references.map(() => "?").join(", ")})`).bind(kind, ...references)
          .all<{ reference: string; payload: string | null }>()).results) recorded.set(entry.reference, entry.payload);
      }
    }
    changed.push(...entries.filter((entry) => recorded.get(entry.reference) !== JSON.stringify(entry.payload)));
  }
  await ledgerStore(ledger).record(changed, now);
  // Marked at this pass's start: writes landing during it are read again next time.
  await main.prepare(`UPDATE restore_state SET mirrored_at = ?, full_mirrored_at = CASE WHEN ? THEN ? ELSE full_mirrored_at END
    WHERE id = 1`).bind(now, full ? 1 : 0, now).run();
  return changed.length;
};

/**
 * Brings a restored main database back up to the ledger: removals and images
 * are reapplied, a suspension is never lifted, and every request that is not
 * delivered becomes an uncertain create reconciled by its marker, with an
 * attempt window reaching the restore. The epoch is written last, so an
 * interrupted replay runs again.
 */
export const replayLedger = async (main: QueryDatabase, ledger: QueryDatabase, epoch: number, now: number) => {
  const entries = (await ledger.prepare("SELECT kind, reference, payload FROM ledger_entry")
    .all<{ kind: LedgerKind; reference: string; payload: string | null }>()).results;
  const work: (readonly [string, readonly Value[]])[] = [];
  // Compacted removals first, children before parents.
  for (const kind of [...ORDER].reverse()) {
    if (kind === "suspension" || kind === "offboarding" || kind === "revocation") continue;
    const { table, key } = TABLES[kind];
    for (const entry of entries.filter((candidate) => candidate.kind === kind && candidate.payload === null)) {
      work.push([`DELETE FROM ${table} WHERE ${key.map((column) => `${column} = ?`).join(" AND ")}`, entry.reference.split(":", key.length)]);
    }
  }
  for (const kind of ORDER) {
    const { table, key, columns } = TABLES[kind];
    for (const entry of entries.filter((candidate) => candidate.kind === kind && candidate.payload !== null)) {
      const image = JSON.parse(entry.payload!) as LedgerImage;
      const values = columns.map((column) => image[column] ?? null);
      if (kind === "suspension") {
        // Only an Operator lifts a suspension; replay can add one but never drop or change one.
        work.push([`INSERT INTO repository_state (repository_id, suspended_reason, suspended_at, observed_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (repository_id) DO UPDATE SET suspended_reason = excluded.suspended_reason, suspended_at = excluded.suspended_at
          WHERE repository_state.suspended_reason IS NULL`, [...values, image.suspended_at ?? now]]);
        continue;
      }
      if (kind === "revocation") {
        // A key enrolled after the restore point is absent, and stays unusable until it enrolls again.
        work.push(["UPDATE installation_key SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL", [image.revoked_at ?? now, image.key_id ?? ""]]);
        // The same image revokes a native update key (src/update-access-operator.ts); its grant may be absent too.
        work.push([`INSERT INTO update_access_revocation (key_id, slot, evidence, revoked_by, revoked_at)
          SELECT key_id, slot, 'ledger-replay', 'ledger', ? FROM update_access_grant WHERE key_id = ? ON CONFLICT (key_id) DO NOTHING`,
        [image.revoked_at ?? now, image.key_id ?? ""]]);
        continue;
      }
      if (kind === "offboarding") {
        // An offboarded Slot keeps no usable key, even one whose revocation the ledger never got to record.
        work.push(["UPDATE installation_key SET revoked_at = ? WHERE slot = ? AND revoked_at IS NULL", [now, image.slot ?? ""]]);
        work.push([`INSERT INTO update_access_revocation (key_id, slot, evidence, revoked_by, revoked_at)
          SELECT key_id, slot, 'ledger-replay', 'ledger', ? FROM update_access_grant WHERE slot = ? ON CONFLICT (key_id) DO NOTHING`,
        [now, image.slot ?? ""]]);
      }
      const updates = columns.filter((column) => !key.includes(column)).map((column) => `${column} = excluded.${column}`);
      work.push([`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
        ON CONFLICT (${key.join(", ")}) DO ${updates.length > 0 ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`, values]);
    }
  }
  // A restored row whose cleanup already began loses its text before any traffic; the next cleanup pass deletes it.
  work.push([`UPDATE support_request SET ${PURGED_TEXT}, erased_at = ? WHERE erased_at IS NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = support_request.id)`, [now]]);
  work.push([`UPDATE delivery_intent SET context_json = NULL WHERE context_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = delivery_intent.request_id)`, []]);
  work.push([`UPDATE delivery_intent SET state = 'outcome_unknown', owner = NULL, lease_expires_at = NULL, unknown_since = ?,
      next_attempt_at = ?, reconciliation_count = 0, reconciliation_json = NULL, last_error_class = 'RestoredIntent',
      attempt_started_at = COALESCE(attempt_started_at, (SELECT created_at FROM support_request r WHERE r.id = delivery_intent.request_id)),
      drain_until = MAX(COALESCE(drain_until, 0), ?)
    WHERE state != 'delivered'`, [now, now + 60_000, now]]);
  // Checker episodes the service acknowledged before the restore point's loss: each comes back, reopening its
  // component's incident for review rather than being silently treated as settled.
  for (const row of (await ledger.prepare(`SELECT id, component, code, first_failed_at, last_failed_at, recovered_at FROM retained_episode`)
    .all<{ id: string; component: Episode["component"]; code: Episode["code"]; first_failed_at: number; last_failed_at: number;
      recovered_at: number | null }>()).results) {
    work.push(...episodeWork({ id: row.id, component: row.component, code: row.code, first: row.first_failed_at,
      last: row.last_failed_at, recovered: row.recovered_at }, now));
  }
  work.push(["UPDATE restore_state SET epoch = ?, replayed_at = ? WHERE id = 1", [epoch, now]]);
  await inChunks(main, work);
};

/**
 * The gate before any traffic or sweep. Every call reads the ledger's restore
 * epoch and maintenance boundary: no verdict is cached, so no isolate keeps
 * serving after maintenance begins, and an unreachable ledger closes it. If
 * the Operator recorded a restore since the main database last replayed, it
 * replays first, during maintenance too, so the replay can be verified before
 * service resumes. Only the replayed epoch is kept per isolate, to skip
 * rereading the main database while the ledger's epoch is unchanged.
 */
export const restoreGate = () => {
  let replayed: number | undefined;
  return async (mainDb: QueryDatabase, ledgerDb: QueryDatabase, now: number): Promise<boolean> => {
    try {
      const control = await ledgerStore(ledgerDb).control();
      if (!control) return false;
      if (replayed !== control.epoch) {
        const epoch = (await mainDb.prepare("SELECT epoch FROM restore_state WHERE id = 1").first<{ epoch: number }>())?.epoch ?? 0;
        if (epoch < control.epoch) await replayLedger(mainDb, ledgerDb, control.epoch, now);
        replayed = control.epoch;
      }
      return !control.maintenance;
    } catch {
      return false;
    }
  };
};
