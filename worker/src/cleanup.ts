import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GitHubGateway, OutcomeUnknown } from "./github-gateway.ts";
import { supportIssues, titleDigest, type IssueIdentity, type ReconciliationProgress, type ResidualCopy } from "./support-issues.ts";
import { DAY, MUTATION_INTERVAL_MS } from "./delivery-store.ts";
import { suspendRepository, unsafeReason } from "./repository-suspension.ts";
import type { OperatorOptions } from "./operator.ts";
import type { QueryDatabase } from "./storage.ts";
import { ulid } from "./support-requests.ts";

/** Never-confirmed-delivered text, and closed delivered requests after their last observed close. */
export const RETENTION_MS = 365 * DAY;
/** Resolved erasure tombstones outlive the 30-day Time Travel window. */
export const TOMBSTONE_MS = 45 * DAY;
export const OFFBOARDING_GRACE_MS = 30 * DAY;
const EXECUTION_MS = 4_000;
const LEASE_MS = 60_000;
const reconcileAt = (since: number, count: number) => since + ([60_000, 300_000, 900_000, 3_600_000][count] ?? (count - 2) * 3_600_000);

export type Statement = readonly [sql: string, parameters: readonly (string | number | null)[]];
type CleanupState = "draining" | "reconciling" | "redacting" | "unresolved" | "resolved" | "excepted";
type Outcome = "purged" | "redacted" | "lost" | "found";

/** Submitted text, subject, Submission ID and digest. The row keeps opaque IDs and provider identity. */
const BLANK = `summary = '', description = '', title = '', reporter_subject = '', submission_id = id, body_digest = ''`;

/**
 * Deletes the request's remaining rows, only once its cleanup no longer needs
 * them. Every statement repeats the guard, since a zero-row statement never
 * fails a batch. The cleanup row itself stays as the tombstone.
 */
export const purgeStatements = (requestId: string): Statement[] => {
  const guard = `EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND state IN ('resolved', 'excepted'))`;
  return [
    [`DELETE FROM delivery_attempt WHERE intent_id IN (SELECT id FROM delivery_intent WHERE request_id = ?) AND ${guard}`, [requestId, requestId]],
    [`DELETE FROM delivery_intent WHERE request_id = ? AND ${guard}`, [requestId, requestId]],
    [`UPDATE support_request SET supersedes_id = NULL WHERE supersedes_id = ? AND ${guard}`, [requestId, requestId]],
    [`DELETE FROM support_request WHERE id = ? AND ${guard}`, [requestId, requestId]],
  ];
};

/** Text purge for one request that already has its cleanup row. */
const blankStatements = (requestId: string, now: number): Statement[] => [
  [`UPDATE support_request SET ${BLANK}, erased_at = ? WHERE id = ? AND erased_at IS NULL
    AND EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ?)`, [now, requestId, requestId]],
  [`UPDATE delivery_intent SET context_json = NULL WHERE request_id = ? AND context_json IS NOT NULL`, [requestId]],
];

export interface ErasureTarget {
  readonly requestId: string;
  readonly titleDigest: string;
}

/**
 * Records an erasure of one Reporter's requests in one Slot. Ordered so that
 * any applied prefix is safe: suppression comes before every other step, and
 * each statement is idempotent, so an interrupted sequence can be rerun.
 */
export const erasureStatements = (erasureId: string, slot: string, subject: string, targets: readonly ErasureTarget[], now: number): Statement[] => [
  ...targets.map(({ requestId }): Statement => [`INSERT INTO delivery_suppression (scope, reference, reason)
    VALUES ('request', ?, 'erasure') ON CONFLICT DO NOTHING`, [requestId]]),
  [`INSERT INTO erasure (id, slot, recorded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [erasureId, slot, now]],
  ...targets.map(({ requestId, titleDigest }): Statement => [`INSERT INTO support_cleanup
    (request_id, slot, purpose, erasure_id, recorded_at, title_digest, state, next_attempt_at)
    VALUES (?, ?, 'erasure', ?, ?, ?, 'draining', ?) ON CONFLICT DO NOTHING`, [requestId, slot, erasureId, now, titleDigest, now]]),
  // An active attempt already holds its own copy, so the text goes at once.
  [`UPDATE support_request SET ${BLANK}, erased_at = ? WHERE slot = ? AND reporter_subject = ? AND erased_at IS NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = support_request.id AND c.purpose = 'erasure')`, [now, slot, subject]],
  // Any erasure's rows, so a rerun after an interrupted sequence still clears them.
  [`UPDATE delivery_intent SET context_json = NULL WHERE slot = ? AND context_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = delivery_intent.request_id AND c.purpose = 'erasure')`, [slot]],
  [`DELETE FROM intake_debit WHERE slot = ? AND subject = ?`, [slot, subject]],
  [`DELETE FROM request_rate WHERE slot = ? AND subject = ?`, [slot, subject]],
];

/** The rows an erasure covers, with the digest that lets automatic redaction replace a derived title. */
export const erasureTargets = (rows: readonly { readonly id: string; readonly title: string; readonly intent_id: string }[]) =>
  Promise.all(rows.map(async (row): Promise<ErasureTarget> => ({ requestId: row.id, titleDigest: await titleDigest(row.intent_id, row.title) })));

export const ERASABLE = `SELECT r.id, r.title, r.reporter_subject, i.id AS intent_id FROM support_request r
  JOIN delivery_intent i ON i.request_id = r.id AND i.slot = r.slot AND i.seq = 0
  WHERE r.slot = ? AND r.erased_at IS NULL`;

/**
 * Records a Reporter erasure in one batch: new creates are suppressed and the
 * text purged when it commits. Like the fixed SQL in storage.ts, its
 * subqueries cannot pass the storageFor checker, so every statement binds the
 * verified Slot the caller supplies by hand.
 */
export const recordErasure = async (db: QueryDatabase, slot: string, subject: string, now: number): Promise<string> => {
  const rows = (await db.prepare(`${ERASABLE} AND r.reporter_subject = ?`).bind(slot, subject)
    .all<{ id: string; title: string; intent_id: string }>()).results;
  const id = `era_${ulid(now)}`;
  await db.batch(erasureStatements(id, slot, subject, await erasureTargets(rows), now)
    .map(([sql, parameters]) => db.prepare(sql).bind(...parameters)));
  return id;
};

export interface ErasureStatus {
  readonly id: string;
  readonly state: "in_progress" | "needs_review" | "completed";
  readonly counts: { readonly purged: number; readonly redacted: number; readonly pending: number };
  /** Residual-copy kinds; `remote_outcome` is a possible issue nobody could find or redact. */
  readonly residual: readonly string[];
}

/** Never includes text. An unresolved remote outcome keeps the erasure from completing. */
export const erasureStatus = async (db: QueryDatabase | OperatorOptions["query"], id: string): Promise<ErasureStatus | null> => {
  const sql = `SELECT c.state, c.outcome, c.residual FROM erasure e LEFT JOIN support_cleanup c ON c.erasure_id = e.id WHERE e.id = ?`;
  const rows = (typeof db === "function" ? await db(sql, [id]) : (await db.prepare(sql).bind(id).all()).results) as
    { state: CleanupState | null; outcome: Outcome | null; residual: string | null }[];
  if (rows.length === 0) return null;
  const targets = rows.filter((row) => row.state !== null);
  const residual = new Set(targets.flatMap((row) => row.residual ? row.residual.split(",") : []));
  if (targets.some((row) => row.state === "unresolved" || row.state === "excepted")) residual.add("remote_outcome");
  const pending = targets.filter((row) => ["draining", "reconciling", "redacting"].includes(row.state!)).length;
  return {
    id,
    state: pending > 0 ? "in_progress" : residual.size > 0 ? "needs_review" : "completed",
    counts: { purged: targets.filter((row) => row.outcome === "purged" || row.outcome === "lost").length,
      redacted: targets.filter((row) => row.outcome === "redacted").length, pending },
    residual: [...residual].sort(),
  };
};

interface Captured {
  request_id: string; purpose: string; state: string | null; generation: number | null;
  issue_id: number | null; issue_number: number | null; issue_node_id: string | null;
}
interface Due {
  request_id: string; purpose: string; state: "reconciling" | "redacting"; title_digest: string | null;
  window_started_at: number | null; window_until: number | null; reconciliation_count: number; reconciliation_json: string | null;
  next_attempt_at: number; intent_id: string; github_installation_id: number | null; attempt_started_at: number | null;
  drain_until: number | null; repository_id: number; issue_id: number | null; issue_number: number | null; issue_node_id: string | null;
}
interface Finish {
  state: CleanupState; next: number | null; outcome?: Outcome; residual?: readonly ResidualCopy[]; error?: string;
  progress?: string | null; count?: number; issue?: IssueIdentity; providerUntil?: number;
}

/** Narrow, named cross-Slot queries; HTTP request handlers never get this API. */
const cleanupStore = (db: QueryDatabase) => {
  const run = (statements: readonly Statement[]) => db.batch(statements.map(([sql, parameters]) => db.prepare(sql).bind(...parameters)));
  const queue = (purpose: string, rows: readonly { id: string; slot: string }[], now: number) => rows.length === 0 ? Promise.resolve() :
    run(rows.flatMap(({ id, slot }): Statement[] => [
      [`INSERT INTO support_cleanup (request_id, slot, purpose, recorded_at, state, next_attempt_at)
        VALUES (?, ?, ?, ?, 'draining', ?) ON CONFLICT DO NOTHING`, [id, slot, purpose, now, now]],
      ...blankStatements(id, now),
    ])).then(() => undefined);
  return {
    /** A restore can bring back purged rows: the ledger's tombstones purge them again. */
    async repurge(now: number) {
      const rows = (await db.prepare(`SELECT c.request_id AS id, c.purpose FROM support_cleanup c
        JOIN support_request r ON r.id = c.request_id WHERE r.erased_at IS NULL LIMIT 50`).all<{ id: string; purpose: string }>()).results;
      if (rows.length > 0) await run(rows.flatMap(({ id, purpose }): Statement[] => [
        ...(purpose === "erasure" ? [[`INSERT INTO delivery_suppression (scope, reference, reason)
          VALUES ('request', ?, 'erasure') ON CONFLICT DO NOTHING`, [id]] as Statement] : []),
        ...blankStatements(id, now),
        ...purgeStatements(id),
      ]));
      return rows;
    },
    /** After the grace period, every request of an offboarded Slot loses its content. */
    async offboard(now: number) {
      const rows = (await db.prepare(`SELECT r.id, r.slot FROM offboarding o JOIN support_request r ON r.slot = o.slot
        WHERE o.purge_after <= ? AND NOT EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = r.id) LIMIT 100`)
        .bind(now).all<{ id: string; slot: string }>()).results;
      await queue("offboarding", rows, now);
    },
    /** Two index-bounded passes: never-confirmed-delivered by acceptance, delivered by last observed close. */
    async retain(now: number) {
      const expired = (age: string, delivered: string) => db.prepare(`SELECT r.id, r.slot FROM support_request r
        JOIN delivery_intent i ON i.request_id = r.id AND i.slot = r.slot AND i.seq = 0
        WHERE ${age} AND ${delivered} AND r.erased_at IS NULL AND (i.owner IS NULL OR i.lease_expires_at <= ?2)
          AND NOT EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = r.id) LIMIT 100`)
        .bind(now - RETENTION_MS, now).all<{ id: string; slot: string }>();
      await queue("retention", (await expired("r.created_at <= ?1", "i.state != 'delivered'")).results, now);
      await queue("retention", (await expired("r.status = 'closed' AND r.status_observed_at <= ?1", "i.state = 'delivered'")).results, now);
    },
    /** Queued requests whose last authorized execution has drained. Suppression comes first, except for retention. */
    async drained(now: number) {
      return (await db.prepare(`SELECT c.request_id, c.purpose, i.state, i.generation, r.issue_id, r.issue_number, r.issue_node_id
        FROM support_cleanup c LEFT JOIN support_request r ON r.id = c.request_id
        LEFT JOIN delivery_intent i ON i.request_id = c.request_id AND i.seq = 0
        WHERE c.state = 'draining' AND (i.id IS NULL OR i.owner IS NULL OR i.lease_expires_at <= ?)
          AND (c.purpose = 'retention' OR EXISTS (SELECT 1 FROM delivery_suppression s
            WHERE (s.scope = 'request' AND s.reference = c.request_id) OR (s.scope = 'slot' AND s.reference = c.slot)))
        LIMIT 50`).bind(now).all<Captured>()).results;
    },
    async capture(row: Captured, now: number, change: { state: CleanupState; next: number | null; outcome?: Outcome }) {
      const ended = change.state === "resolved" || change.state === "unresolved";
      await run([
        [`UPDATE support_cleanup SET state = ?, outcome = ?, next_attempt_at = ?, window_started_at = ?, resolved_at = ?,
          title_digest = CASE WHEN ? THEN NULL ELSE title_digest END
          WHERE request_id = ? AND state = 'draining' AND NOT EXISTS (SELECT 1 FROM delivery_intent WHERE request_id = ?
            AND (generation IS NOT ? OR state IS NOT ? OR (owner IS NOT NULL AND lease_expires_at > ?)))`,
          [change.state, change.outcome ?? null, change.next, now, change.state === "resolved" ? now : null, ended ? 1 : 0,
            row.request_id, row.request_id, row.generation, row.state, now]],
        ...purgeStatements(row.request_id),
      ]);
    },
    async due(now: number) {
      return (await db.prepare(`SELECT c.request_id, c.purpose, c.state, c.title_digest, c.window_started_at, c.window_until,
          c.reconciliation_count, c.reconciliation_json, c.next_attempt_at, i.id AS intent_id, i.github_installation_id,
          i.attempt_started_at, i.drain_until, r.repository_id, r.issue_id, r.issue_number, r.issue_node_id
        FROM support_cleanup c JOIN support_request r ON r.id = c.request_id
        JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
        WHERE c.state IN ('reconciling', 'redacting') AND c.next_attempt_at <= ?1
          AND NOT EXISTS (SELECT 1 FROM delivery_permit p WHERE p.installation_id = i.github_installation_id AND (p.provider_cooldown_until > ?1
            OR (c.state = 'redacting' AND (p.drain_until > ?1 OR p.next_mutation_at > ?1))))
          AND (c.state = 'reconciling' OR EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND next_mutation_at <= ?1))
        ORDER BY c.next_attempt_at, c.request_id LIMIT 8`).bind(now).all<Due>()).results;
    },
    /** The next due time doubles as a lease; the owner fences every later write. */
    async claim(row: Due, owner: string, now: number) {
      const result = await db.prepare(`UPDATE support_cleanup SET owner = ?, next_attempt_at = ?
        WHERE request_id = ? AND state = ? AND next_attempt_at = ?`).bind(owner, now + LEASE_MS, row.request_id, row.state, row.next_attempt_at).run();
      return result.meta.changes === 1;
    },
    /** Paces a redaction PATCH like any other mutation of the shared installation. */
    async authorized(row: Due, owner: string, now: number) {
      const [fleet] = await run([
        [`UPDATE delivery_fleet_budget SET owner = ?, next_mutation_at = ? WHERE id = 1 AND next_mutation_at <= ?
          AND EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND owner = ? AND state = 'redacting')
          AND NOT EXISTS (SELECT 1 FROM delivery_permit WHERE installation_id = ? AND (drain_until > ? OR next_mutation_at > ? OR provider_cooldown_until > ?))`,
          [owner, now + MUTATION_INTERVAL_MS, now, row.request_id, owner, row.github_installation_id, now, now, now]],
        [`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at)
          SELECT ?, '', 0, ? WHERE EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND owner = ?)
          ON CONFLICT (installation_id) DO UPDATE SET next_mutation_at = excluded.next_mutation_at
          WHERE delivery_permit.drain_until <= ? AND delivery_permit.next_mutation_at <= ?`,
          [row.github_installation_id, now + MUTATION_INTERVAL_MS, owner, now, now]],
      ]);
      return fleet!.meta.changes === 1;
    },
    async finish(row: Due, owner: string, now: number, change: Finish) {
      const ended = change.state === "resolved" || change.state === "unresolved";
      const issue = change.issue;
      await run([
        ...(issue ? [[`UPDATE support_request SET issue_id = ?, issue_number = ?, issue_node_id = ?
          WHERE id = ? AND (issue_id IS NULL OR issue_id = ?) AND EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND owner = ?)`,
          [issue.id, issue.number, issue.nodeId, row.request_id, issue.id, row.request_id, owner]] as Statement] : []),
        ...(change.providerUntil !== undefined && row.github_installation_id ? [[`INSERT INTO delivery_permit
          (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until) VALUES (?, '', 0, ?, ?)
          ON CONFLICT (installation_id) DO UPDATE SET next_mutation_at = MAX(next_mutation_at, excluded.next_mutation_at),
            provider_cooldown_until = MAX(provider_cooldown_until, excluded.provider_cooldown_until)`,
          [row.github_installation_id, change.providerUntil, change.providerUntil]] as Statement] : []),
        [`UPDATE support_cleanup SET state = ?, next_attempt_at = ?, outcome = ?, residual = ?, last_error_class = ?,
          reconciliation_json = ?, reconciliation_count = ?, resolved_at = ?, owner = NULL,
          title_digest = CASE WHEN ? THEN NULL ELSE title_digest END WHERE request_id = ? AND owner = ?`,
          [change.state, change.next, change.outcome ?? null, (change.residual ?? []).join(","), change.error ?? null,
            change.progress ?? null, change.count ?? row.reconciliation_count, change.state === "resolved" ? now : null,
            ended ? 1 : 0, row.request_id, owner]],
        ...(change.state === "resolved" ? purgeStatements(row.request_id) : []),
      ]);
    },
    /**
     * Resolved erasure tombstones go after 45 days, counted from resolution.
     * Unresolved cleanup is never compacted. Other purposes have the Slot
     * suppression or no ledger entry at all, so their rows go at once.
     */
    async compact(now: number) {
      const cutoff = now - TOMBSTONE_MS;
      await run([
        [`DELETE FROM delivery_suppression WHERE scope = 'request' AND reason = 'erasure' AND reference IN (SELECT request_id
          FROM support_cleanup WHERE purpose = 'erasure' AND state IN ('resolved', 'excepted') AND resolved_at <= ?)`, [cutoff]],
        [`DELETE FROM support_cleanup WHERE state IN ('resolved', 'excepted') AND (purpose != 'erasure' OR resolved_at <= ?)`, [cutoff]],
        [`DELETE FROM erasure WHERE recorded_at <= ? AND NOT EXISTS (SELECT 1 FROM support_cleanup c WHERE c.erasure_id = erasure.id)`, [cutoff]],
      ]);
    },
  };
};

export interface CleanupOptions {
  readonly db: QueryDatabase;
  readonly botLogin: string;
  readonly now?: () => number;
}
class CleanupStorageFailed extends Error {}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new CleanupStorageFailed() });
const log = (requestId: string, outcome: string, alert = false) =>
  (alert ? Effect.logError("Support cleanup requires review") : Effect.logInfo("Support cleanup outcome")).pipe(
    Effect.annotateLogs({ request: requestId, outcome, alert }),
  );
const isolated = <R>(name: string, effect: Effect.Effect<unknown, unknown, R>) =>
  effect.pipe(Effect.asVoid, Effect.catchCause(() => Effect.logError("Support cleanup step failed").pipe(Effect.annotateLogs({ step: name, alert: true }))));

/**
 * One bounded pass of erasure, offboarding and retention cleanup. It never
 * creates an issue. An empty, failed or incomplete scan never resolves a
 * possible create: after 24 hours it hands off to an Operator, keeping only
 * the restricted record needed to find and redact it later.
 */
export const sweepCleanup = (options: CleanupOptions): Effect.Effect<void, never, GitHubGateway> => Effect.gen(function* () {
  const now = options.now ?? Date.now;
  const deadline = now() + EXECUTION_MS;
  const store = cleanupStore(options.db);
  yield* isolated("repurge", io(() => store.repurge(now())));
  yield* isolated("offboarding", io(() => store.offboard(now())));
  yield* isolated("retention", io(() => store.retain(now())));
  yield* isolated("capture", Effect.gen(function* () {
    for (const row of yield* io(() => store.drained(now()))) {
      const identified = row.state === "delivered" && row.issue_id !== null && row.issue_number !== null && row.issue_node_id !== null;
      // Delivered issues stay with the Client unless an erasure redacts them.
      const change = row.state === null || row.state === "pending" || row.state === "failed" || (row.state === "delivered" && row.purpose !== "erasure")
        ? { state: "resolved" as const, next: null, outcome: "purged" as const }
        : identified ? { state: "redacting" as const, next: now() }
        : row.purpose === "erasure" ? { state: "reconciling" as const, next: reconcileAt(now(), 0) }
        // Offboarding and retention leave the Client's issues alone, but keep the uncertain attempt for review.
        : { state: "unresolved" as const, next: null };
      yield* isolated("capture", io(() => store.capture(row, now(), change)).pipe(
        Effect.andThen(log(row.request_id, change.state, change.state === "unresolved"))));
    }
  }));
  // A few rounds, so a scan continuation or a found issue's redaction need not wait a minute.
  for (let round = 0; round < 3 && now() < deadline; round++) {
    const due = yield* io(() => store.due(now())).pipe(Effect.orElseSucceed(() => []));
    if (due.length === 0) break;
    for (const row of due) {
      if (now() >= deadline) break;
      yield* isolated("remote", Effect.gen(function* () {
        const owner = crypto.randomUUID();
        if (!(yield* io(() => store.claim(row, owner, now())))) return;
        const finish = (change: Finish) => io(() => store.finish(row, owner, now(), change)).pipe(
          Effect.andThen(log(row.request_id, change.error ?? change.outcome ?? change.state, change.state === "unresolved")));
        const since = row.window_started_at ?? now();
        const windowEnd = Math.max(since + DAY, row.window_until ?? 0);
        if (now() >= windowEnd || !row.github_installation_id) {
          return yield* finish({ state: "unresolved", next: null, error: row.github_installation_id ? "ReviewRequired" : "MappingUnavailable" });
        }
        const target = { installationId: row.github_installation_id, repositoryId: row.repository_id };
        const retry = (at: number) => Math.min(windowEnd, Math.max(now() + 1000, at));
        if (row.state === "reconciling") {
          const result = yield* Effect.result(supportIssues.reconcile({ target, intentId: row.intent_id, botLogin: options.botLogin,
            attemptStartedAt: row.attempt_started_at ?? since, attemptEndedAt: row.drain_until ?? row.attempt_started_at ?? since,
            // Erased text is never kept for comparison; the marker and window identify the issue.
            expectedIssue: null, erasurePending: true,
            ...(row.issue_id && row.issue_node_id && row.issue_number ? { knownIdentity: { id: row.issue_id, nodeId: row.issue_node_id, number: row.issue_number } } : {}),
          }, row.reconciliation_json ? JSON.parse(row.reconciliation_json) as ReconciliationProgress : undefined));
          if (Result.isSuccess(result)) {
            const found = result.success;
            if (found._tag === "RedactionRequired") {
              return yield* finish(row.purpose === "erasure"
                ? { state: "redacting", next: now(), issue: found.issue }
                : { state: "resolved", next: null, outcome: "found", issue: found.issue });
            }
            if (found._tag === "Continue") return yield* finish({ state: "reconciling", next: now(), progress: JSON.stringify(found.progress) });
            const count = row.reconciliation_count + 1;
            yield* finish({ state: "reconciling", next: retry(reconcileAt(since, count)), count,
              error: found._tag === "Unknown" ? found.reason : "Unexpected" });
            if (now() - since >= 900_000 || (found._tag === "Unknown" && found.alert)) yield* log(row.request_id, "ReconciliationPending", true);
            return;
          }
          const error = result.failure;
          return yield* finish({ state: "reconciling", error: error._tag,
            next: retry(error._tag === "RateLimited" ? error.until : now() + 60_000),
            ...(error._tag === "RateLimited" ? { providerUntil: error.until } : {}),
            // A rejected checkpoint restarts the scan; any other failure keeps it.
            progress: error._tag === "ValidationRejected" ? null : row.reconciliation_json });
        }
        if (!row.issue_id || !row.issue_number || !row.issue_node_id) return yield* finish({ state: "unresolved", next: null, error: "MissingIdentity" });
        const authorize = Effect.gen(function* () {
          if (now() >= deadline || !(yield* io(() => store.authorized(row, owner, now())).pipe(Effect.orElseSucceed(() => false)))) {
            return yield* Effect.fail(new OutcomeUnknown());
          }
        });
        const result = yield* Effect.result(supportIssues.redact(target, row.intent_id,
          { id: row.issue_id, nodeId: row.issue_node_id, number: row.issue_number }, row.title_digest, authorize));
        if (Result.isSuccess(result)) {
          const done = result.success;
          return yield* finish(done._tag === "NeedsReview" ? { state: "unresolved", next: null, error: `Redaction:${done.reason}` }
            : { state: "resolved", next: null, outcome: done._tag === "Redacted" ? "redacted" : "lost", residual: done.residual });
        }
        const error = result.failure;
        const reason = unsafeReason(error);
        if (reason) {
          yield* suspendRepository(options.db, row.repository_id, reason, now()).pipe(Effect.ignore);
          return yield* finish({ state: "unresolved", next: null, error: error._tag });
        }
        // A redaction can be repeated; an unauthorized one was never sent.
        if (error._tag === "RateLimited" || error._tag === "ProviderUnavailable" || error._tag === "OutcomeUnknown") {
          return yield* finish({ state: "redacting", error: error._tag,
            next: retry(error._tag === "RateLimited" ? error.until : now() + (error._tag === "OutcomeUnknown" ? MUTATION_INTERVAL_MS : 60_000)),
            ...(error._tag === "RateLimited" ? { providerUntil: error.until } : {}) });
        }
        return yield* finish({ state: "unresolved", next: null, error: error._tag });
      }).pipe(Effect.withSpan("support.cleanup", { attributes: { request: row.request_id } })));
    }
  }
  yield* isolated("compaction", io(() => store.compact(now())));
}).pipe(Effect.withSpan("support.cleanup.sweep"));
