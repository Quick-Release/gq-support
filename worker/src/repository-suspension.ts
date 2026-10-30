import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { ledgerStore, removal } from "./ledger.ts";
import { mappingFor } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";
import { observeIncident } from "./incidents.ts";

/**
 * Suspended mappings (CONTEXT.md). A suspension is per repository, so every
 * Slot mapped to it stops sending new Support requests, while existing
 * requests keep their last-known status. No check ever lifts one: only the
 * Operator's `unsuspend` command does.
 *
 * Callers: the delivery path before each create, the status sweep (#53) and
 * the webhook lifecycle handlers (#40).
 */
export type SuspensionReason = "public" | "archived" | "no_access";

/** D1 did not confirm the write; a webhook should answer 503 so GitHub redelivers. */
export class SuspensionNotRecorded extends Data.TaggedError("SuspensionNotRecorded")<{}> {}

/**
 * The suspension a failed repository check proves, if any. Rate limits,
 * outages and permission mismatches prove nothing about the repository.
 */
export const unsafeReason = (error: { readonly _tag: string; readonly reason?: string }): SuspensionReason | undefined =>
  error._tag === "RepositoryNotPrivate" ? "public"
  : error._tag === "RepositoryArchived" ? "archived"
  // A transfer, removal from the installation, deletion, or an uninstalled or suspended App.
  : error._tag === "InstallationUnavailable" || (error._tag === "RepositoryUnavailable" && error.reason === "not-accessible") ? "no_access"
  : undefined;

/**
 * Suspends the repository and alerts the Operator. Idempotent: an existing
 * suspension keeps its first cause and time, and alerts only once. Each unsafe
 * observation also records the repository's Operational incident, listing every
 * Slot mapped to it, in the same batch.
 */
export const suspendRepository = (db: QueryDatabase, repositoryId: number, reason: SuspensionReason, now: number,
  slots: readonly string[]) => Effect.gen(function* () {
  const suspended = yield* Effect.tryPromise({
    try: async () => {
      const [changed] = await db.batch([
        db.prepare(`INSERT INTO repository_state (repository_id, suspended_reason, suspended_at, observed_at) VALUES (?1, ?2, ?3, ?3)
          ON CONFLICT (repository_id) DO UPDATE SET suspended_reason = excluded.suspended_reason, suspended_at = excluded.suspended_at
          WHERE repository_state.suspended_reason IS NULL RETURNING repository_id`).bind(repositoryId, reason, now),
        // Any renewed unsafe observation invalidates a previous passing check,
        // including when the first suspension's cause and time are retained.
        db.prepare(`UPDATE repository_state SET verified_safe_at = NULL, unsafe_observed_at = MAX(COALESCE(unsafe_observed_at, 0), ?)
          WHERE repository_id = ?`).bind(now, repositoryId),
        ...observeIncident(db, { category: "repository_suspended", subject: String(repositoryId), slots, now }),
      ]);
      return changed!.results.length > 0;
    },
    catch: () => new SuspensionNotRecorded(),
  });
  if (suspended) {
    yield* Effect.logError("Repository mapping suspended").pipe(Effect.annotateLogs({ repository: repositoryId, reason, alert: true }));
  }
  return suspended;
});

/** The evidence an Operator states for each cause, after verifying it. */
const EVIDENCE: Readonly<Record<SuspensionReason, string>> = {
  public: "verified-private", archived: "verified-unarchived", no_access: "access-restored",
};

/**
 * `operator unsuspend <slot> <opaque-actor> <evidence>` lifts the suspension
 * of the Slot's repository, so for every Slot mapped to it. Independent CLI
 * credentials authorize it; no HTTP route calls it. The next create still
 * checks the repository first. A passing sweep after suspension is required.
 */
export const unsuspendRepository = async (args: readonly string[], { query, mappings, now = Date.now(), ledger }: OperatorOptions): Promise<string> => {
  const [, slot, actor, evidence] = args;
  if (args.length !== 4 || !/^[A-Za-z0-9_-]{1,64}$/.test(actor ?? "") || !Object.values(EVIDENCE).includes(evidence ?? "")) {
    throw new Error(`Usage: operator unsuspend <slot> <opaque-actor> <${Object.values(EVIDENCE).join("|")}>`);
  }
  const mapping = mappingFor(mappings, slot!);
  if (!mapping) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
  const reason = Object.entries(EVIDENCE).find(([, value]) => value === evidence)![0];
  const id = crypto.randomUUID();
  // Write-ahead audit, as for delivery resume: it records the attempt even if the update loses a race.
  const audit = await query(`INSERT INTO repository_audit (id, repository_id, actor, action, evidence, suspended_reason, suspended_at, occurred_at)
    SELECT ?, repository_id, ?, 'unsuspend', ?, suspended_reason, suspended_at, ? FROM repository_state
    WHERE repository_id = ? AND suspended_reason = ? AND verified_safe_at > suspended_at RETURNING id`, [id, actor!, evidence!, now, mapping.repositoryId, reason]);
  if (audit.length !== 1) throw new Error("Repository cannot be unsuspended: it is not suspended for that cause with a later passing verification");
  const updated = await query(`UPDATE repository_state SET suspended_reason = NULL, suspended_at = NULL
    WHERE repository_id = ? AND suspended_reason = ? AND verified_safe_at > suspended_at AND EXISTS (SELECT 1 FROM repository_audit a
      WHERE a.id = ? AND a.suspended_at IS repository_state.suspended_at) RETURNING repository_id`, [mapping.repositoryId, reason, id]);
  if (updated.length !== 1) throw new Error("Unsuspend lost eligibility; inspect the audit and current state");
  // After the lift: a lost ledger write keeps the suspension there, the safe direction.
  if (ledger) await ledgerStore(asQueryDatabase(ledger)).record([removal("suspension", String(mapping.repositoryId))], now);
  const slots = mappings.filter((other) => other.repositoryId === mapping.repositoryId).map((other) => other.slot);
  return `Unsuspended repository ${mapping.repositoryId} for ${slots.join(", ")}`;
};
