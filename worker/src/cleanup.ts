import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GitHubGateway, OutcomeUnknown, type GitHubTarget } from "./github-gateway.ts";
import { supportIssues, type IssueIdentity, type ReconciliationProgress, type ResidualCopy } from "./support-issues.ts";
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
const RETRY_MS = 60_000;
const ALERT_AFTER_MS = 900_000;
const reconcileAt = (since: number, count: number) => since + ([60_000, 300_000, 900_000, 3_600_000][count] ?? (count - 2) * 3_600_000);

export type Statement = readonly [sql: string, parameters: readonly (string | number | null)[]];
type CleanupState = "draining" | "reconciling" | "redacting" | "unresolved" | "resolved" | "excepted";
type Outcome = "purged" | "redacted" | "lost" | "found";
type Residual = ResidualCopy | "multiple_matches";

const encoder = new TextEncoder();
/**
 * The title-digest key, derived from a Worker-held secret. A copy of D1
 * alone cannot test guessed titles against a stored digest.
 */
export const digestKey = async (secret: string): Promise<CryptoKey> => crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("gq-support title digest v1") },
  await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]),
  { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
/** Keyed by the intent too, so equal titles of different requests never compare equal. */
export const titleDigest = async (key: CryptoKey, intentId: string, title: string) =>
  Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([intentId, title])))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Submitted text, subject, Submission ID and digest. */
const BLANK = `summary = '', description = '', title = '', reporter_subject = '', submission_id = id, body_digest = ''`;
const SUPPRESS = `INSERT INTO delivery_suppression (scope, reference, reason) VALUES ('request', ?, 'erasure') ON CONFLICT DO NOTHING`;

/**
 * Deletes a request's rows once its cleanup row holds everything the cleanup
 * still needs. Every statement repeats the guard, since a zero-row statement
 * never fails a batch.
 */
export const purgeStatements = (requestId: string): Statement[] => {
  const guard = `EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND state != 'draining')`;
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
  /** Null when the caller holds no digest key; the Worker's next pass then purges the text. */
  readonly titleDigest: string | null;
}

/**
 * Records an erasure of one Reporter's requests in one Slot. Ordered so that
 * any applied prefix is safe: suppression comes before every other step, and
 * each statement is idempotent, so an interrupted sequence can be rerun.
 */
export const erasureStatements = (erasureId: string, slot: string, subject: string, targets: readonly ErasureTarget[], now: number): Statement[] => [
  ...targets.map(({ requestId }): Statement => [SUPPRESS, [requestId]]),
  [`INSERT INTO erasure (id, slot, recorded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [erasureId, slot, now]],
  ...targets.map(({ requestId, titleDigest }): Statement => [`INSERT INTO support_cleanup
    (request_id, slot, purpose, erasure_id, recorded_at, title_digest, state, next_attempt_at)
    VALUES (?, ?, 'erasure', ?, ?, ?, 'draining', ?) ON CONFLICT DO NOTHING`, [requestId, slot, erasureId, now, titleDigest, now]]),
  // An active attempt already holds its own copy, so the text goes at once.
  ...(targets.every((target) => target.titleDigest !== null) ? [[`UPDATE support_request SET ${BLANK}, erased_at = ?
    WHERE slot = ? AND reporter_subject = ? AND erased_at IS NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = support_request.id AND c.purpose = 'erasure')`, [now, slot, subject]] as Statement] : []),
  // Any erasure's rows, so a rerun after an interrupted sequence still clears them.
  [`UPDATE delivery_intent SET context_json = NULL WHERE slot = ? AND context_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM support_cleanup c WHERE c.request_id = delivery_intent.request_id AND c.purpose = 'erasure')`, [slot]],
  [`DELETE FROM intake_debit WHERE slot = ? AND subject = ?`, [slot, subject]],
  [`DELETE FROM request_rate WHERE slot = ? AND subject = ?`, [slot, subject]],
];

export const ERASABLE = `SELECT r.id, r.title, r.reporter_subject, i.id AS intent_id FROM support_request r
  JOIN delivery_intent i ON i.request_id = r.id AND i.slot = r.slot AND i.seq = 0
  WHERE r.slot = ? AND r.erased_at IS NULL`;

/**
 * Records a Reporter erasure in one batch: new creates are suppressed and the
 * text purged when it commits. Like the fixed SQL in storage.ts, its
 * subqueries cannot pass the storageFor checker, so every statement binds the
 * verified Slot the caller supplies by hand.
 */
export const recordErasure = async (db: QueryDatabase, slot: string, subject: string, now: number, key: CryptoKey): Promise<string> => {
  const rows = (await db.prepare(`${ERASABLE} AND r.reporter_subject = ?`).bind(slot, subject)
    .all<{ id: string; title: string; intent_id: string }>()).results;
  const targets = await Promise.all(rows.map(async (row): Promise<ErasureTarget> =>
    ({ requestId: row.id, titleDigest: await titleDigest(key, row.intent_id, row.title) })));
  const id = `era_${ulid(now)}`;
  await db.batch(erasureStatements(id, slot, subject, targets, now).map(([sql, parameters]) => db.prepare(sql).bind(...parameters)));
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
  const resolved = targets.filter((row) => row.state === "resolved");
  const residual = new Set(targets.flatMap((row) => row.residual ? row.residual.split(",") : []));
  if (targets.some((row) => row.state === "unresolved" || row.state === "excepted")) residual.add("remote_outcome");
  const pending = targets.filter((row) => ["draining", "reconciling", "redacting"].includes(row.state!)).length;
  return {
    id,
    state: pending > 0 ? "in_progress" : residual.size > 0 ? "needs_review" : "completed",
    counts: { purged: resolved.filter((row) => row.outcome !== "redacted").length,
      redacted: resolved.filter((row) => row.outcome === "redacted").length, pending },
    residual: [...residual].sort(),
  };
};

/** A queued request with its last delivery state, as read before capture. */
interface DrainedRequest {
  request_id: string; purpose: string; state: string | null; generation: number | null; intent_id: string | null;
  github_installation_id: number | null; repository_id: number | null; attempt_started_at: number | null; drain_until: number | null;
  issue_id: number | null; issue_number: number | null; issue_node_id: string | null;
}
/** A captured cleanup record: everything needed to find and redact a possible issue, and nothing else. */
interface CleanupRecord {
  request_id: string; purpose: string; state: "reconciling" | "redacting"; title_digest: string | null;
  window_started_at: number | null; window_until: number | null; reconciliation_count: number; reconciliation_json: string | null;
  next_attempt_at: number; intent_id: string | null; github_installation_id: number | null; repository_id: number | null;
  attempt_started_at: number | null; attempt_ended_at: number | null; issues_json: string | null; residual: string; outcome: Outcome | null;
}
interface Transition {
  state: CleanupState; next: number | null; outcome?: Outcome | null; residual?: readonly string[]; error?: string;
  progress?: string | null; count?: number; issues?: readonly IssueIdentity[]; providerUntil?: number;
}
const issuesOf = (record: { issues_json: string | null }): IssueIdentity[] => record.issues_json ? JSON.parse(record.issues_json) : [];
const merged = (existing: string, added: readonly string[]) => [...new Set([...existing.split(",").filter(Boolean), ...added])].sort();
const ended = (state: CleanupState) => state === "resolved" || state === "unresolved";

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
    /**
     * Request rows that should no longer exist: brought back by a restore, or
     * left for this pass by an Operator erase, which holds no digest key.
     */
    async repurge(now: number, key: CryptoKey | null) {
      const rows = (await db.prepare(`SELECT c.request_id, c.purpose, c.state, c.title_digest, r.title, r.erased_at, i.id AS intent_id
        FROM support_cleanup c JOIN support_request r ON r.id = c.request_id
        LEFT JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
        WHERE r.erased_at IS NULL OR c.state != 'draining' LIMIT 50`).all<{ request_id: string; purpose: string; state: CleanupState;
          title_digest: string | null; title: string; erased_at: number | null; intent_id: string | null }>()).results;
      const statements: Statement[] = [];
      for (const row of rows) {
        if (row.purpose === "erasure") statements.push([SUPPRESS, [row.request_id]]);
        if (row.state === "draining" && row.purpose === "erasure" && row.title_digest === null && row.erased_at === null && key && row.intent_id) {
          statements.push([`UPDATE support_cleanup SET title_digest = ? WHERE request_id = ? AND state = 'draining' AND title_digest IS NULL`,
            [await titleDigest(key, row.intent_id, row.title), row.request_id]]);
        }
        statements.push(...blankStatements(row.request_id, now), ...purgeStatements(row.request_id));
      }
      if (statements.length > 0) await run(statements);
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
      return (await db.prepare(`SELECT c.request_id, c.purpose, i.state, i.generation, i.id AS intent_id, i.github_installation_id,
          r.repository_id, i.attempt_started_at, i.drain_until, r.issue_id, r.issue_number, r.issue_node_id
        FROM support_cleanup c LEFT JOIN support_request r ON r.id = c.request_id
        LEFT JOIN delivery_intent i ON i.request_id = c.request_id AND i.seq = 0
        WHERE c.state = 'draining' AND (i.id IS NULL OR i.owner IS NULL OR i.lease_expires_at <= ?)
          AND (c.purpose = 'retention' OR EXISTS (SELECT 1 FROM delivery_suppression s
            WHERE (s.scope = 'request' AND s.reference = c.request_id) OR (s.scope = 'slot' AND s.reference = c.slot)))
        LIMIT 50`).bind(now).all<DrainedRequest>()).results;
    },
    /** Moves the restricted fields onto the cleanup row, then deletes the request's rows. */
    async capture(row: DrainedRequest, now: number, change: Transition) {
      await run([
        [`UPDATE support_cleanup SET state = ?, outcome = ?, next_attempt_at = ?, window_started_at = ?, resolved_at = ?,
          title_digest = CASE WHEN ? THEN NULL ELSE title_digest END, intent_id = ?, github_installation_id = ?,
          repository_id = ?, attempt_started_at = ?, attempt_ended_at = ?, issues_json = ?
          WHERE request_id = ? AND state = 'draining' AND NOT EXISTS (SELECT 1 FROM delivery_intent WHERE request_id = ?
            AND (generation IS NOT ? OR state IS NOT ? OR (owner IS NOT NULL AND lease_expires_at > ?)))`,
          [change.state, change.outcome ?? null, change.next, now, change.state === "resolved" ? now : null, ended(change.state) ? 1 : 0,
            row.intent_id, row.github_installation_id, row.repository_id, row.attempt_started_at, row.drain_until ?? row.attempt_started_at,
            change.issues ? JSON.stringify(change.issues) : null,
            row.request_id, row.request_id, row.generation, row.state, now]],
        ...purgeStatements(row.request_id),
      ]);
    },
    async due(now: number) {
      return (await db.prepare(`SELECT request_id, purpose, state, title_digest, window_started_at, window_until, reconciliation_count,
          reconciliation_json, next_attempt_at, intent_id, github_installation_id, repository_id, attempt_started_at, attempt_ended_at,
          issues_json, residual, outcome
        FROM support_cleanup c WHERE state IN ('reconciling', 'redacting') AND next_attempt_at <= ?1
          AND NOT EXISTS (SELECT 1 FROM delivery_permit p WHERE p.installation_id = c.github_installation_id AND (p.provider_cooldown_until > ?1
            OR (c.state = 'redacting' AND (p.drain_until > ?1 OR p.next_mutation_at > ?1))))
          AND (state = 'reconciling' OR EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND next_mutation_at <= ?1))
        ORDER BY next_attempt_at, request_id LIMIT 8`).bind(now).all<CleanupRecord>()).results;
    },
    /** The next due time doubles as a lease; the owner fences every later write. */
    async claim(record: CleanupRecord, owner: string, now: number) {
      const result = await db.prepare(`UPDATE support_cleanup SET owner = ?, next_attempt_at = ?
        WHERE request_id = ? AND state = ? AND next_attempt_at = ?`).bind(owner, now + LEASE_MS, record.request_id, record.state, record.next_attempt_at).run();
      return result.meta.changes === 1;
    },
    /** Paces a redaction PATCH like any other mutation of the shared installation. */
    async authorized(record: CleanupRecord, owner: string, now: number) {
      const [fleet] = await run([
        [`UPDATE delivery_fleet_budget SET owner = ?, next_mutation_at = ? WHERE id = 1 AND next_mutation_at <= ?
          AND EXISTS (SELECT 1 FROM support_cleanup WHERE request_id = ? AND owner = ? AND state = 'redacting')
          AND NOT EXISTS (SELECT 1 FROM delivery_permit WHERE installation_id = ? AND (drain_until > ? OR next_mutation_at > ? OR provider_cooldown_until > ?))`,
          [owner, now + MUTATION_INTERVAL_MS, now, record.request_id, owner, record.github_installation_id, now, now, now]],
        [`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at)
          SELECT ?, '', 0, ? WHERE EXISTS (SELECT 1 FROM delivery_fleet_budget WHERE id = 1 AND owner = ?)
          ON CONFLICT (installation_id) DO UPDATE SET next_mutation_at = excluded.next_mutation_at
          WHERE delivery_permit.drain_until <= ? AND delivery_permit.next_mutation_at <= ?`,
          [record.github_installation_id, now + MUTATION_INTERVAL_MS, owner, now, now]],
      ]);
      return fleet!.meta.changes === 1;
    },
    async finish(record: CleanupRecord, owner: string, now: number, change: Transition) {
      await run([
        // A longer cooldown is the safe direction, so this one needs no ownership fence.
        ...(change.providerUntil !== undefined && record.github_installation_id ? [[`INSERT INTO delivery_permit
          (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until) VALUES (?, '', 0, ?, ?)
          ON CONFLICT (installation_id) DO UPDATE SET next_mutation_at = MAX(next_mutation_at, excluded.next_mutation_at),
            provider_cooldown_until = MAX(provider_cooldown_until, excluded.provider_cooldown_until)`,
          [record.github_installation_id, change.providerUntil, change.providerUntil]] as Statement] : []),
        [`UPDATE support_cleanup SET state = ?, next_attempt_at = ?, outcome = ?, residual = ?, last_error_class = ?,
          reconciliation_json = ?, reconciliation_count = ?, issues_json = ?, resolved_at = ?, owner = NULL,
          title_digest = CASE WHEN ? THEN NULL ELSE title_digest END WHERE request_id = ? AND owner = ?`,
          [change.state, change.next, change.outcome === undefined ? record.outcome : change.outcome,
            merged(record.residual, change.residual ?? []).join(","), change.error ?? null, change.progress ?? null,
            change.count ?? record.reconciliation_count, change.issues ? JSON.stringify(change.issues) : record.issues_json,
            change.state === "resolved" ? now : null, ended(change.state) ? 1 : 0, record.request_id, owner]],
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
  /** Without it, no derived title can be verified and every redacted title needs review. */
  readonly digestKey: CryptoKey | null;
  readonly now?: () => number;
}
type Store = ReturnType<typeof cleanupStore>;
class CleanupStorageFailed extends Error {}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new CleanupStorageFailed() });
const log = (requestId: string, outcome: string, alert = false) =>
  (alert ? Effect.logError("Support cleanup requires review") : Effect.logInfo("Support cleanup outcome")).pipe(
    Effect.annotateLogs({ request: requestId, outcome, alert }),
  );
/** Runs one step so that its failure is logged and never stops the rest of the pass. */
const isolated = <R>(step: string, effect: Effect.Effect<unknown, unknown, R>) =>
  effect.pipe(Effect.asVoid, Effect.catchCause(() => Effect.logError("Support cleanup step failed").pipe(Effect.annotateLogs({ step, alert: true }))));

/** Where a drained request goes next. Delivered issues stay with the Client unless an erasure redacts them. */
const afterDrain = (row: DrainedRequest, now: number): Transition => {
  const issue = row.issue_id !== null && row.issue_number !== null && row.issue_node_id !== null
    ? { id: row.issue_id, nodeId: row.issue_node_id, number: row.issue_number } : null;
  if (row.state === null || row.state === "pending" || row.state === "failed" || (row.state === "delivered" && row.purpose !== "erasure")) {
    return { state: "resolved", next: null, outcome: "purged" };
  }
  if (row.state === "delivered" && issue) return { state: "redacting", next: now, issues: [issue] };
  if (row.purpose === "erasure") return { state: "reconciling", next: reconcileAt(now, 0) };
  // Offboarding and retention leave the Client's issues alone, but keep the uncertain attempt for review.
  return { state: "unresolved", next: null };
};

/** One read-only marker scan page for a possible create. */
const reconcileRecord = (record: CleanupRecord, target: GitHubTarget, botLogin: string, now: () => number, since: number, retry: (at: number) => number) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(supportIssues.reconcile({ target, intentId: record.intent_id!, botLogin,
      attemptStartedAt: record.attempt_started_at ?? since, attemptEndedAt: record.attempt_ended_at ?? record.attempt_started_at ?? since,
      // Erased text is never kept for comparison; the marker and window identify the issue.
      expectedIssue: null, erasurePending: true,
    }, record.reconciliation_json ? JSON.parse(record.reconciliation_json) as ReconciliationProgress : undefined));
    if (Result.isFailure(result)) {
      const error = result.failure;
      return { state: "reconciling", error: error._tag,
        next: retry(error._tag === "RateLimited" ? error.until : now() + RETRY_MS),
        ...(error._tag === "RateLimited" ? { providerUntil: error.until } : {}),
        // A rejected checkpoint restarts the scan; any other failure keeps it.
        progress: error._tag === "ValidationRejected" ? null : record.reconciliation_json } satisfies Transition;
    }
    const found = result.success;
    if (found._tag === "RedactionRequired") {
      return record.purpose === "erasure"
        ? { state: "redacting", next: now(), issues: found.issues, residual: found.issues.length > 1 ? ["multiple_matches"] : [] } satisfies Transition
        : { state: "resolved", next: null, outcome: "found" } satisfies Transition;
    }
    if (found._tag === "Continue") return { state: "reconciling", next: now(), progress: JSON.stringify(found.progress) } satisfies Transition;
    const count = record.reconciliation_count + 1;
    if (now() - since >= ALERT_AFTER_MS || (found._tag === "Unknown" && found.alert)) yield* log(record.request_id, "ReconciliationPending", true);
    return { state: "reconciling", next: retry(reconcileAt(since, count)), count,
      error: found._tag === "Unknown" ? found.reason : "Unexpected" } satisfies Transition;
  });

/** One redaction PATCH at most, for the first issue still to redact. */
const redactRecord = (record: CleanupRecord, target: GitHubTarget, options: CleanupOptions, authorize: Effect.Effect<void, OutcomeUnknown>,
  now: () => number, retry: (at: number) => number) => Effect.gen(function* () {
  const [issue, ...rest] = issuesOf(record);
  if (!issue) return { state: "unresolved", next: null, error: "MissingIdentity" } satisfies Transition;
  const key = options.digestKey, digest = record.title_digest;
  const isDerivedTitle = key && digest ? async (title: string) => await titleDigest(key, record.intent_id!, title) === digest : null;
  const result = yield* Effect.result(supportIssues.redact(target, record.intent_id!, issue, isDerivedTitle, authorize));
  if (Result.isSuccess(result)) {
    const done = result.success;
    if (done._tag === "NeedsReview") return { state: "unresolved", next: null, error: `Redaction:${done.reason}` } satisfies Transition;
    const outcome: Outcome = done._tag === "Redacted" || record.outcome === "redacted" ? "redacted" : "lost";
    // Pacing spaces the remaining copies' PATCHes.
    return rest.length > 0 ? { state: "redacting", next: now(), outcome, residual: done.residual, issues: rest } satisfies Transition
      : { state: "resolved", next: null, outcome, residual: done.residual, issues: [] } satisfies Transition;
  }
  const error = result.failure;
  const reason = unsafeReason(error);
  if (reason) {
    yield* suspendRepository(options.db, target.repositoryId, reason, now()).pipe(Effect.ignore);
    return { state: "unresolved", next: null, error: error._tag } satisfies Transition;
  }
  // A redaction can be repeated; an unauthorized one was never sent.
  if (error._tag === "RateLimited" || error._tag === "ProviderUnavailable" || error._tag === "OutcomeUnknown") {
    return { state: "redacting", error: error._tag,
      next: retry(error._tag === "RateLimited" ? error.until : now() + (error._tag === "OutcomeUnknown" ? MUTATION_INTERVAL_MS : RETRY_MS)),
      ...(error._tag === "RateLimited" ? { providerUntil: error.until } : {}) } satisfies Transition;
  }
  return { state: "unresolved", next: null, error: error._tag } satisfies Transition;
});

/** Claims one due record, does its remote step, and records the transition. */
const processRecord = (record: CleanupRecord, store: Store, options: CleanupOptions, now: () => number, deadline: number) => Effect.gen(function* () {
  const owner = crypto.randomUUID();
  if (!(yield* io(() => store.claim(record, owner, now())))) return;
  const since = record.window_started_at ?? now();
  const windowEnd = Math.max(since + DAY, record.window_until ?? 0);
  const pinned = record.github_installation_id && record.repository_id && record.intent_id;
  const change: Transition = now() >= windowEnd || !pinned
    ? { state: "unresolved", next: null, error: pinned ? "ReviewRequired" : "MappingUnavailable" }
    : yield* Effect.gen(function* () {
      const target = { installationId: record.github_installation_id!, repositoryId: record.repository_id! };
      const retry = (at: number) => Math.min(windowEnd, Math.max(now() + 1000, at));
      if (record.state === "reconciling") return yield* reconcileRecord(record, target, options.botLogin, now, since, retry);
      const authorize = Effect.gen(function* () {
        if (now() >= deadline || !(yield* io(() => store.authorized(record, owner, now())).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.fail(new OutcomeUnknown());
        }
      });
      return yield* redactRecord(record, target, options, authorize, now, retry);
    });
  yield* io(() => store.finish(record, owner, now(), change));
  yield* log(record.request_id, change.error ?? change.outcome ?? change.state, change.state === "unresolved");
}).pipe(Effect.withSpan("support.cleanup", { attributes: { request: record.request_id } }));

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
  yield* isolated("repurge", io(() => store.repurge(now(), options.digestKey)));
  yield* isolated("offboarding", io(() => store.offboard(now())));
  yield* isolated("retention", io(() => store.retain(now())));
  yield* isolated("capture", Effect.gen(function* () {
    for (const row of yield* io(() => store.drained(now()))) {
      const change = afterDrain(row, now());
      yield* isolated("capture", io(() => store.capture(row, now(), change)).pipe(
        Effect.andThen(log(row.request_id, change.state, change.state === "unresolved"))));
    }
  }));
  // A few rounds, so a scan continuation or a found issue's redaction need not wait a minute.
  for (let round = 0; round < 3 && now() < deadline; round++) {
    const due = yield* io(() => store.due(now())).pipe(Effect.orElseSucceed(() => []));
    if (due.length === 0) break;
    for (const record of due) {
      if (now() >= deadline) break;
      yield* isolated("remote", processRecord(record, store, options, now, deadline));
    }
  }
  yield* isolated("compaction", io(() => store.compact(now())));
}).pipe(Effect.withSpan("support.cleanup.sweep"));
