import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GitHubReader, type IssueRead } from "./github-gateway.ts";
import type { QueryDatabase } from "./storage.ts";

export interface RefreshConfig {
  readonly dailyIntervalMs: number;
  readonly dailyBatchSize: number;
  readonly readsPerTick: number;
  readonly executionMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly attemptsAlert: number;
  readonly ageAlertMs: number;
}
export const REFRESH_DEFAULTS: RefreshConfig = {
  dailyIntervalMs: 86_400_000, dailyBatchSize: 100, readsPerTick: 10, executionMs: 10_000,
  retryBaseMs: 60_000, retryMaxMs: 3_600_000, attemptsAlert: 5, ageAlertMs: 3_600_000,
};
export interface StatusRefreshOptions {
  readonly db: QueryDatabase;
  readonly config?: Partial<RefreshConfig>;
  readonly now?: () => number;
  readonly random?: () => number;
}
class RefreshStorageFailed extends Data.TaggedError("RefreshStorageFailed")<{}> {}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new RefreshStorageFailed() });
/** Rows the refresher drains: actively tracked, on an unsuspended repository, not suppressed. */
export const refreshEligible = `tracking = 'active' AND issue_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM repository_state rs WHERE rs.repository_id = support_request.repository_id AND rs.suspended_reason IS NOT NULL)
  AND NOT EXISTS
  (SELECT 1 FROM delivery_suppression s WHERE (s.scope = 'slot' AND s.reference = support_request.slot)
    OR (s.scope = 'request' AND s.reference = support_request.id))`;

/** Trusted, target-keyed wake-up shared by the sweep and future webhook receiver.
 * Every call changes the generation, even if the timestamp has not changed.
 * Existing backoff/ownership survives another notification. */
export const requestStatusRefresh = (db: QueryDatabase, repositoryId: number, issueId: number, now: number) =>
  db.prepare(`UPDATE support_request SET status_refresh_due_at = COALESCE(status_refresh_due_at, ?3),
      status_refresh_generation = status_refresh_generation + 1
    WHERE repository_id = ?1 AND issue_id = ?2 AND ${refreshEligible}`).bind(repositoryId, issueId, now).run();

interface Candidate {
  id: string;
  repository_id: number;
  issue_id: number;
  issue_number: number;
  installationId: number;
}
interface Claim {
  status_etag: string | null;
  status_refresh_generation: number;
  status_refresh_attempts: number;
}

/** Named cross-Slot operations; never exposed to installation HTTP handlers. */
const refreshStore = (db: QueryDatabase) => {
  const sql = (query: string, ...args: unknown[]) => db.prepare(query).bind(...args);
  return {
    /** The cursor and queued rows commit together. An interrupted pass resumes next tick. */
    async daily(now: number, config: RefreshConfig) {
      await sql(`UPDATE status_refresh_pass SET started_at = ?, cursor = '' WHERE id = 1 AND started_at IS NULL
        AND (completed_at IS NULL OR completed_at + ? <= ?)`, now, config.dailyIntervalMs, now).run();
      const pass = await sql(`SELECT started_at, cursor FROM status_refresh_pass WHERE id = 1 AND started_at IS NOT NULL`)
        .first<{ started_at: number; cursor: string }>();
      if (!pass) return;
      const rows = (await sql(`SELECT id FROM support_request WHERE id > ? AND created_at <= ?
        AND status = 'open' AND tracking = 'active' AND issue_id IS NOT NULL ORDER BY id LIMIT ?`,
        pass.cursor, pass.started_at, config.dailyBatchSize).all<{ id: string }>()).results;
      const fence = `EXISTS (SELECT 1 FROM status_refresh_pass WHERE id = 1 AND started_at = ? AND cursor = ?)`;
      await db.batch([
        sql(`UPDATE support_request SET status_refresh_due_at = ?, status_refresh_generation = status_refresh_generation + 1
          WHERE id IN (SELECT value FROM json_each(?)) AND status_refresh_due_at IS NULL AND ${refreshEligible} AND ${fence}`,
          now, JSON.stringify(rows.map((row) => row.id)), pass.started_at, pass.cursor),
        rows.length === config.dailyBatchSize
          ? sql(`UPDATE status_refresh_pass SET cursor = ? WHERE id = 1 AND started_at = ? AND cursor = ?`,
            rows.at(-1)!.id, pass.started_at, pass.cursor)
          : sql(`UPDATE status_refresh_pass SET completed_at = started_at, started_at = NULL, cursor = ''
            WHERE id = 1 AND started_at = ? AND cursor = ?`, pass.started_at, pass.cursor),
      ]);
    },
    async age(now: number) {
      const row = await sql(`SELECT MIN(status_refresh_due_at) AS oldest FROM support_request
        WHERE status_refresh_due_at IS NOT NULL AND ${refreshEligible}`).first<{ oldest: number | null }>();
      return row?.oldest == null ? 0 : Math.max(0, now - row.oldest);
    },
    async candidates(now: number, limit: number) {
      return (await sql(`SELECT r.id, r.repository_id, r.issue_id, r.issue_number, i.github_installation_id AS installationId
        FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.slot = r.slot AND i.seq = 0
        WHERE r.status_refresh_due_at IS NOT NULL AND r.status_refresh_next_at <= ? AND r.tracking = 'active'
          AND r.issue_id IS NOT NULL AND i.github_installation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM repository_state rs WHERE rs.repository_id = r.repository_id AND rs.suspended_reason IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM delivery_permit p WHERE p.installation_id = i.github_installation_id AND p.provider_cooldown_until > ?)
          AND NOT EXISTS (SELECT 1 FROM delivery_suppression s WHERE (s.scope = 'slot' AND s.reference = r.slot)
            OR (s.scope = 'request' AND s.reference = r.id))
        ORDER BY COALESCE(r.status_refresh_attempted_at, r.status_refresh_due_at), r.status_refresh_due_at, r.id LIMIT ?`, now, now, limit)
        .all<Candidate>()).results;
    },
    async claim(row: Candidate, owner: string, now: number) {
      return sql(`UPDATE support_request SET status_refresh_owner = ?, status_refresh_attempted_at = ?,
          status_refresh_next_at = ?, status_refresh_attempts = status_refresh_attempts + 1
        WHERE id = ? AND status_refresh_due_at IS NOT NULL AND status_refresh_next_at <= ? AND ${refreshEligible}
          AND NOT EXISTS (SELECT 1 FROM delivery_permit WHERE installation_id = ? AND provider_cooldown_until > ?)
        RETURNING status_etag, status_refresh_generation, status_refresh_attempts`,
        owner, now, now + 60_000, row.id, now, row.installationId, now).first<Claim>();
    },
    async apply(row: Candidate, claim: Claim, owner: string, result: IssueRead | "lost", now: number) {
      const observe = result === "lost"
        ? sql(`UPDATE support_request SET status = 'closed', tracking = 'lost', status_etag = NULL, status_observed_at = ?
            WHERE id = ? AND status_refresh_owner = ? AND status_refresh_generation = ? AND ${refreshEligible}`,
            now, row.id, owner, claim.status_refresh_generation)
        : result._tag === "NotModified"
          ? sql(`UPDATE support_request SET status_observed_at = MAX(COALESCE(status_observed_at, 0), ?)
              WHERE id = ? AND status_etag IS ? AND ${refreshEligible}`, now, row.id, claim.status_etag)
          : sql(`UPDATE support_request SET status = ?, status_source_updated_at = ?, status_etag = ?,
                status_observed_at = MAX(COALESCE(status_observed_at, 0), ?)
              WHERE id = ? AND issue_id = ? AND ${refreshEligible}
                AND (status_source_updated_at IS NULL OR status_source_updated_at <= ?)`,
            result.issue.state, Date.parse(result.issue.updatedAt), result.etag, now, row.id, result.issue.id, Date.parse(result.issue.updatedAt));
      const results = await db.batch([
        observe,
        sql(`UPDATE support_request SET status_refresh_due_at = NULL, status_refresh_attempts = 0,
            status_refresh_next_at = 0, status_refresh_owner = NULL
          WHERE id = ? AND status_refresh_owner = ? AND status_refresh_generation = ? AND ${result === "lost" ? "tracking = 'lost'" : refreshEligible}`,
          row.id, owner, claim.status_refresh_generation),
        // A newer wake-up is still owed, but need not wait for the old claim to expire.
        sql(`UPDATE support_request SET status_refresh_next_at = 0, status_refresh_owner = NULL
          WHERE id = ? AND status_refresh_owner = ?`, row.id, owner),
      ]);
      return results[0]!.meta.changes > 0;
    },
    async retry(row: Candidate, owner: string, until: number, cooldown: number | null) {
      await db.batch([
        sql(`UPDATE support_request SET status_refresh_next_at = ?, status_refresh_owner = NULL
          WHERE id = ? AND status_refresh_owner = ?`, until, row.id, owner),
        ...(cooldown === null ? [] : [sql(`INSERT INTO delivery_permit
          (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until) VALUES (?, '', 0, 0, ?)
          ON CONFLICT (installation_id) DO UPDATE SET provider_cooldown_until = MAX(provider_cooldown_until, excluded.provider_cooldown_until)`,
          row.installationId, cooldown)]),
      ]);
    },
  };
};

/** Daily discovery then bounded, least-recently-attempted refreshes. Claims are
 * durable before I/O; interruption leaves a due row recoverable next minute. */
export const refreshStatus = (options: StatusRefreshOptions): Effect.Effect<void, RefreshStorageFailed, GitHubReader> => Effect.gen(function* () {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const config = { ...REFRESH_DEFAULTS, ...options.config };
  const deadline = now() + config.executionMs;
  const store = refreshStore(options.db);
  const reader = yield* GitHubReader;
  yield* io(() => store.daily(now(), config));
  const age = yield* io(() => store.age(now()));
  yield* (age > config.ageAlertMs ? Effect.logError("Support status refresh is behind") : Effect.logInfo("Support status refresh age")).pipe(
    Effect.annotateLogs({ metric: "support.status.refresh.oldest_due_age_ms", age_ms: age, alert: age > config.ageAlertMs }));
  const candidates = yield* io(() => store.candidates(now(), config.readsPerTick));
  for (const row of candidates) {
    if (now() >= deadline) break;
    const owner = crypto.randomUUID();
    const claim = yield* io(() => store.claim(row, owner, now()));
    if (!claim) continue;
    const read = yield* Effect.result(reader.readIssue({ installationId: row.installationId, repositoryId: row.repository_id },
      row.issue_number, claim.status_etag ?? undefined));
    if (Result.isSuccess(read)) {
      // A reused issue number must never bind a different provider identity.
      if (read.success._tag === "NotModified" || read.success.issue.id === row.issue_id) {
        yield* io(() => store.apply(row, claim, owner, read.success, now()));
        continue;
      }
    } else if (read.failure._tag === "IssueGone" || read.failure._tag === "IssueMoved") {
      const changed = yield* io(() => store.apply(row, claim, owner, "lost", now()));
      if (changed) yield* Effect.logError("Support status tracking lost").pipe(
        Effect.annotateLogs({ request: row.id, repository: row.repository_id, alert: true }));
      continue;
    }
    const cooldown = Result.isFailure(read) && read.failure._tag === "RateLimited" ? read.failure.until : null;
    const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(claim.status_refresh_attempts - 1, 16));
    yield* io(() => store.retry(row, owner, Math.max(now() + delay * (1 + random()), cooldown ?? 0), cooldown));
    yield* Effect.logWarning("Support status refresh retry").pipe(Effect.annotateLogs({ request: row.id,
      attempts: claim.status_refresh_attempts, alert: claim.status_refresh_attempts >= config.attemptsAlert,
      error: Result.isFailure(read) ? read.failure._tag : "IssueIdentityMismatch" }));
  }
}).pipe(Effect.withSpan("support.status.refresh"));
