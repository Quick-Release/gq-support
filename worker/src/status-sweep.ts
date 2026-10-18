import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GitHubReader, type GitHubIssue } from "./github-gateway.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";
import { suspendRepository, unsafeReason } from "./repository-suspension.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Sweep cadence and bounds (docs/research/github-webhook-sync.md, slice 1).
 * Configuration, so freshness can be traded against the shared rate limit.
 */
export interface SweepConfig {
  /** How often each Project repository is swept. */
  readonly intervalMs: number;
  /** How far before the last sweep each `since` window starts. */
  readonly skewMs: number;
  /** List calls per tick, across all repositories: the sweep's share of the rate limit. */
  readonly pagesPerTick: number;
  /** List calls per repository per tick, so one large repository cannot hold a tick. */
  readonly pagesPerRepository: number;
  /** No list call starts after this long into the sweep. */
  readonly executionMs: number;
  /** A repository not swept for longer than this raises the lag alert. */
  readonly lagAlertMs: number;
}

export const SWEEP_DEFAULTS: SweepConfig = {
  intervalMs: 900_000, skewMs: 300_000, pagesPerTick: 10, pagesPerRepository: 3, executionMs: 15_000, lagAlertMs: 3_600_000,
};

export interface StatusSweepOptions {
  readonly db: QueryDatabase;
  readonly botLogin: string;
  readonly mappings: readonly RepositoryMapping[];
  readonly config?: Partial<SweepConfig>;
  readonly now?: () => number;
}

/** D1 did not answer. The sweep is only bookkeeping: the next tick resumes it. */
export class SweepStorageFailed extends Data.TaggedError("SweepStorageFailed")<{}> {}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new SweepStorageFailed() });

/**
 * A mapped Project repository or one pinned on delivered requests, and its
 * App installation. Historical targets stay pinned after a Slot is remapped
 * (storage design, invariant 6).
 */
interface SweepTarget {
  readonly repositoryId: number;
  readonly installationId: number;
}

interface SweepState {
  repository_id: number;
  last_swept_at: number | null;
  sweep_scheduled_at: number;
  sweep_attempted_at: number | null;
  sweep_cursor: number | null;
  cooldown_until: number;
}

/** Where a sweep in progress resumes: issues updated at or after `cursor`, from `page`. */
interface Position {
  readonly startedAt: number;
  readonly cursor: number;
  readonly page: number;
}

/** Narrow, named cross-Slot queries for the sweep; HTTP handlers never get this API. */
const statusStore = (db: QueryDatabase) => {
  const statement = (sql: string, ...parameters: unknown[]) => db.prepare(sql).bind(...parameters);
  const fenced = `repository_id = ? AND sweep_started_at = ? AND sweep_cursor = ? AND sweep_page = ?`;
  return {
    /**
     * Approved mappings, including those without requests, plus repositories
     * pinned on tracked history. Conflicting installations are reported, not guessed at.
     */
    async targets(mappings: readonly RepositoryMapping[]): Promise<{ repositoryId: number; installationId: number | null }[]> {
      return (await statement(`SELECT repository_id AS repositoryId,
          CASE WHEN COUNT(DISTINCT installation_id) = 1 THEN MIN(installation_id) END AS installationId
        FROM (
          SELECT r.repository_id, i.github_installation_id AS installation_id
          FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.slot = r.slot AND i.seq = 0
          WHERE r.issue_id IS NOT NULL AND r.tracking = 'active' AND i.github_installation_id IS NOT NULL
          UNION ALL
          SELECT json_extract(value, '$.repositoryId'), json_extract(value, '$.githubInstallationId')
          FROM json_each(?) WHERE json_extract(value, '$.githubInstallationId') IS NOT NULL
        ) GROUP BY repository_id`, JSON.stringify(mappings))
        .all<{ repositoryId: number; installationId: number | null }>()).results;
    },
    /** Registers new repositories, then reads each one's sweep state and its installation's shared cooldown. */
    async states(targets: readonly SweepTarget[], now: number): Promise<SweepState[]> {
      const ids = JSON.stringify(targets.map((target) => target.repositoryId));
      const [, states] = await db.batch<SweepState>([
        statement(`INSERT INTO repository_state (repository_id, observed_at, sweep_scheduled_at)
          SELECT value, ?, ? FROM json_each(?) WHERE true
          ON CONFLICT (repository_id) DO UPDATE SET sweep_scheduled_at = COALESCE(sweep_scheduled_at, excluded.sweep_scheduled_at)`,
          now, now, ids),
        statement(`SELECT repository_id, last_swept_at, sweep_scheduled_at, sweep_attempted_at, sweep_cursor
          FROM repository_state WHERE repository_id IN (SELECT value FROM json_each(?))`, ids),
      ]);
      const cooldowns = await statement(`SELECT installation_id, provider_cooldown_until FROM delivery_permit
        WHERE installation_id IN (SELECT value FROM json_each(?))`, JSON.stringify(targets.map((target) => target.installationId)))
        .all<{ installation_id: number; provider_cooldown_until: number }>();
      return states!.results.map((state) => {
        const target = targets.find((candidate) => candidate.repositoryId === state.repository_id)!;
        const cooldown = cooldowns.results.find((row) => row.installation_id === target.installationId);
        return { ...state, cooldown_until: cooldown?.provider_cooldown_until ?? 0 };
      });
    },
    /** Resumes the sweep in progress, or starts one from the last sweep minus the skew allowance. */
    async begin(target: SweepTarget, now: number, skewMs: number): Promise<Position> {
      const row = await statement(`UPDATE repository_state SET sweep_attempted_at = ?2,
          sweep_started_at = COALESCE(sweep_started_at, ?2),
          sweep_cursor = COALESCE(sweep_cursor, MAX(0, COALESCE(last_swept_at,
            (SELECT MIN(created_at) FROM support_request WHERE repository_id = ?1), ?2) - ?3)),
          sweep_page = COALESCE(sweep_page, 1)
        WHERE repository_id = ?1 RETURNING sweep_started_at, sweep_cursor, sweep_page`, target.repositoryId, now, skewMs)
        .first<{ sweep_started_at: number; sweep_cursor: number; sweep_page: number }>();
      if (!row) throw new Error("Repository state missing");
      return { startedAt: row.sweep_started_at, cursor: row.sweep_cursor, page: row.sweep_page };
    },
    /**
     * Writes each listed status under the `updated_at` guard, and moves the
     * sweep to `next` (or completes it) only if no other sweep moved it first.
     */
    async apply(target: SweepTarget, issues: readonly GitHubIssue[], position: Position, next: Position | null, now: number) {
      const at = [target.repositoryId, position.startedAt, position.cursor, position.page] as const;
      await db.batch([
        // A changed listing invalidates the old ETag and requests an individual
        // refresh. An unchanged listing preserves its conditional-read cache.
        // Incrementing the generation fences a fetch already in progress.
        ...issues.map((issue) => statement(`UPDATE support_request SET status = ?1, status_source_updated_at = ?2, status_observed_at = ?3,
            status_etag = CASE WHEN status_source_updated_at IS NOT ?2 OR status IS NOT ?1 THEN NULL ELSE status_etag END,
            status_refresh_due_at = CASE WHEN status_source_updated_at IS NOT ?2 OR status IS NOT ?1
              THEN COALESCE(status_refresh_due_at, ?3) ELSE status_refresh_due_at END,
            status_refresh_generation = status_refresh_generation + CASE
              WHEN status_source_updated_at IS NOT ?2 OR status IS NOT ?1 THEN 1 ELSE 0 END
          WHERE repository_id = ?4 AND issue_id = ?5 AND tracking = 'active'
            AND (status_source_updated_at IS NULL OR status_source_updated_at <= ?2)
            AND NOT EXISTS (SELECT 1 FROM repository_state WHERE repository_id = ?4 AND suspended_reason IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM delivery_suppression s WHERE (s.scope = 'slot' AND s.reference = support_request.slot)
              OR (s.scope = 'request' AND s.reference = support_request.id))
            AND EXISTS (SELECT 1 FROM repository_state WHERE repository_id = ?4 AND sweep_started_at = ?6
              AND sweep_cursor = ?7 AND sweep_page = ?8)`,
          issue.state, Date.parse(issue.updatedAt), now, target.repositoryId, issue.id, ...at.slice(1))),
        next
          ? statement(`UPDATE repository_state SET sweep_cursor = ?, sweep_page = ? WHERE ${fenced}`, next.cursor, next.page, ...at)
          : statement(`UPDATE repository_state SET last_swept_at = MAX(COALESCE(last_swept_at, 0), sweep_started_at),
              sweep_started_at = NULL, sweep_cursor = NULL, sweep_page = NULL WHERE ${fenced}`, ...at),
      ]);
    },
    /** Record a passing check only if it began after the latest unsafe observation. */
    async verified(repositoryId: number, verifiedAt: number) {
      return statement(`UPDATE repository_state SET verified_safe_at = CASE
          WHEN suspended_reason IS NOT NULL AND COALESCE(unsafe_observed_at, suspended_at) < ?2
            THEN MAX(COALESCE(verified_safe_at, 0), ?2) ELSE verified_safe_at END
        WHERE repository_id = ?1 RETURNING suspended_reason, verified_safe_at`, repositoryId, verifiedAt)
        .first<{ suspended_reason: string | null; verified_safe_at: number | null }>();
    },
    /** GitHub's rate limit is shared with delivery: record it where delivery claims respect it. */
    async cooldown(installationId: number, until: number) {
      await statement(`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until)
        VALUES (?, '', 0, 0, ?) ON CONFLICT (installation_id) DO UPDATE SET
          provider_cooldown_until = MAX(provider_cooldown_until, excluded.provider_cooldown_until)`, installationId, until).run();
    },
  };
};

/** The next keyset position after a page sorted by `updated_at`, oldest first. */
const after = (position: Position, issues: readonly GitHubIssue[]): Position => {
  // Restart a second before the last change, so the rest of that second is
  // re-read whether GitHub's `since` is inclusive or strict. A page that is
  // all one second cannot move the cursor: take the next page instead.
  const restart = issues.length > 0 ? Date.parse(issues[issues.length - 1]!.updatedAt) - 1000 : position.cursor;
  return restart > position.cursor ? { ...position, cursor: restart, page: 1 } : { ...position, page: position.page + 1 };
};

/**
 * One bounded pass of the status sweep, after delivery in the minute tick.
 * Lists App-created issues updated since each due repository's last sweep and
 * writes only their open/closed status, never text, to the matching rows.
 */
export const sweepStatus = (options: StatusSweepOptions): Effect.Effect<void, SweepStorageFailed, GitHubReader> => Effect.gen(function* () {
  const now = options.now ?? Date.now;
  const config = { ...SWEEP_DEFAULTS, ...options.config };
  const deadline = now() + config.executionMs;
  const reader = yield* GitHubReader;
  const store = statusStore(options.db);
  const pinned = yield* io(() => store.targets(options.mappings));
  for (const conflict of pinned.filter((target) => target.installationId === null)) {
    yield* Effect.logError("Support status sweep skipped a repository").pipe(
      Effect.annotateLogs({ repository: conflict.repositoryId, reason: "ConflictingInstallations", alert: true }));
  }
  const targets = pinned.filter((target): target is SweepTarget => target.installationId !== null);
  if (targets.length === 0) return;
  const states = yield* io(() => store.states(targets, now()));
  // Per-repository sweep lag: the age of the last completed sweep, or of
  // scheduling while none has completed. Logged before any GitHub work, so a
  // failing or cut-off sweep still reports it. Alert once past the threshold.
  for (const state of states) {
    const lag = now() - (state.last_swept_at ?? state.sweep_scheduled_at);
    const alert = lag > config.lagAlertMs;
    yield* (alert ? Effect.logError("Support status sweep is behind") : Effect.logInfo("Support status sweep lag")).pipe(
      Effect.annotateLogs({ metric: "support.status.sweep.lag_ms", repository: state.repository_id, lag_ms: lag, alert }));
  }
  const cooling = new Set<number>();
  let pages = config.pagesPerTick;

  const due = states
    .filter((state) => state.cooldown_until <= now() &&
      (state.sweep_cursor !== null || state.last_swept_at === null || state.last_swept_at + config.intervalMs <= now()))
    .sort((a, b) => (a.sweep_attempted_at ?? -1) - (b.sweep_attempted_at ?? -1) || a.repository_id - b.repository_id);
  for (const state of due) {
    if (pages <= 0 || now() >= deadline) break;
    const target = targets.find((candidate) => candidate.repositoryId === state.repository_id)!;
    if (cooling.has(target.installationId)) continue;
    const sweep = Effect.gen(function* () {
      let position = yield* io(() => store.begin(target, now(), config.skewMs));
      const verifiedAt = now();
      const verification = yield* Effect.result(reader.verifyRepository(target));
      if (Result.isFailure(verification)) {
        // A failed mint still spends this repository's share of the tick.
        pages -= 1;
        const error = verification.failure;
        const reason = unsafeReason(error);
        if (reason) yield* suspendRepository(options.db, target.repositoryId, reason, now());
        if (error._tag === "RateLimited") {
          cooling.add(target.installationId);
          yield* io(() => store.cooldown(target.installationId, error.until));
        }
        return yield* Effect.logWarning("Support status sweep incomplete").pipe(
          Effect.annotateLogs({ repository: target.repositoryId, error: error._tag }));
      }
      const safety = yield* io(() => store.verified(target.repositoryId, verifiedAt));
      if (safety?.suspended_reason) {
        pages -= 1;
        if (safety.verified_safe_at === verifiedAt) {
          yield* Effect.logInfo("Suspended repository verified safe; Operator lift required").pipe(
            Effect.annotateLogs({ repository: target.repositoryId, verified_safe_at: verifiedAt, alert: true }));
        }
        yield* io(() => store.apply(target, [], position, null, now()));
        return;
      }
      for (let taken = 0; taken < config.pagesPerRepository && pages > 0 && now() < deadline; taken += 1) {
        pages -= 1;
        const listed = yield* Effect.result(reader.listIssuesSince(
          { installationId: target.installationId, repositoryId: target.repositoryId }, position.cursor, position.page));
        if (Result.isFailure(listed)) {
          const error = listed.failure;
          const reason = unsafeReason(error);
          if (reason) yield* suspendRepository(options.db, target.repositoryId, reason, now());
          if (error._tag === "RateLimited") {
            cooling.add(target.installationId);
            yield* io(() => store.cooldown(target.installationId, error.until));
          }
          return yield* Effect.logWarning("Support status sweep incomplete").pipe(
            Effect.annotateLogs({ repository: target.repositoryId, error: error._tag }));
        }
        const next = listed.success.hasNextPage ? after(position, listed.success.issues) : null;
        // The query already filters by creator; anything else is never the service's to project.
        const issues = listed.success.issues.filter((issue) => issue.creator === options.botLogin);
        yield* io(() => store.apply(target, issues, position, next, now()));
        if (!next) return;
        position = next;
      }
    }).pipe(Effect.withSpan("support.status.sweep.repository", { attributes: { repository: target.repositoryId } }));
    yield* sweep.pipe(Effect.catchCause(() => Effect.logError("Support status sweep failed for a repository").pipe(
      Effect.annotateLogs({ repository: target.repositoryId, alert: true }))));
  }
}).pipe(Effect.withSpan("support.status.sweep"));
