import * as Effect from "effect/Effect";
import type { RepositoryMapping } from "./repository-mappings.ts";
import { suspendRepository, SuspensionNotRecorded, type SuspensionReason } from "./repository-suspension.ts";
import { SWEEP_DEFAULTS } from "./status-sweep.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * GitHub App lifecycle webhooks (#40; docs/research/github-webhook-sync.md,
 * event matrix and lifecycle table). An unsafe signal suspends the mapping in
 * the request, before the `2xx`, because GitHub never redelivers on its own.
 * A safe signal only schedules verification: no webhook lifts a suspension.
 * The sweep's verification and the Operator's `unsuspend` are the only way back.
 */
export interface LifecycleChange {
  readonly suspend: readonly { readonly repositoryId: number; readonly reason: SuspensionReason }[];
  /** Repositories whose next sweep, and so their safety verification, is due now. */
  readonly verify: readonly number[];
}

const NONE: LifecycleChange = { suspend: [], verify: [] };
const REPOSITORY_UNSAFE: Readonly<Record<string, SuspensionReason>> = {
  publicized: "public", archived: "archived", deleted: "no_access", transferred: "no_access",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const positiveId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;

/**
 * What a verified lifecycle delivery changes, routed only by numeric IDs.
 * A repository counts only if a reviewed mapping pins it to the delivering
 * installation. A conflicting pin elsewhere still suspends: the safe direction.
 * Anything else, including every unknown event or action, changes nothing.
 */
export const lifecycleChange = (event: string, body: unknown, mappings: readonly RepositoryMapping[]): LifecycleChange => {
  const payload = record(body);
  const installationId = record(payload.installation).id;
  if (!positiveId(installationId)) return NONE;
  const mapped = (repositoryId: unknown): repositoryId is number => positiveId(repositoryId) &&
    mappings.some((mapping) => mapping.repositoryId === repositoryId && mapping.githubInstallationId === installationId);
  const onInstallation = [...new Set(mappings.filter((mapping) => mapping.githubInstallationId === installationId)
    .map((mapping) => mapping.repositoryId))];
  const listed = (key: string) => [...new Set((Array.isArray(payload[key]) ? payload[key] as unknown[] : [])
    .map((repository) => record(repository).id).filter(mapped))];
  const suspend = (ids: readonly number[], reason: SuspensionReason): LifecycleChange =>
    ({ suspend: ids.map((repositoryId) => ({ repositoryId, reason })), verify: ids });
  const action = payload.action;
  const repositoryId = record(payload.repository).id;

  if (event === "public") return mapped(repositoryId) ? suspend([repositoryId], "public") : NONE;
  if (event === "repository" && typeof action === "string" && mapped(repositoryId)) {
    if (Object.hasOwn(REPOSITORY_UNSAFE, action)) return suspend([repositoryId], REPOSITORY_UNSAFE[action]!);
    if (action === "privatized" || action === "unarchived") return { suspend: [], verify: [repositoryId] };
  }
  if (event === "installation") {
    if (action === "deleted" || action === "suspend") return suspend(onInstallation, "no_access");
    if (action === "unsuspend" || action === "new_permissions_accepted") return { suspend: [], verify: onInstallation };
  }
  if (event === "installation_repositories") {
    if (action === "removed") return suspend(listed("repositories_removed"), "no_access");
    if (action === "added") return { suspend: [], verify: listed("repositories_added") };
  }
  return NONE;
};

/**
 * Makes each repository due for its next sweep now, keeping a sweep already
 * in progress. A repository never swept is due anyway. The new window starts
 * a skew before the last sweep, as a scheduled sweep would.
 */
const scheduleVerification = (db: QueryDatabase, repositoryIds: readonly number[], now: number) =>
  Effect.tryPromise({
    try: () => db.prepare(`INSERT INTO repository_state (repository_id, observed_at, sweep_scheduled_at)
        SELECT value, ?1, ?1 FROM json_each(?2) WHERE true
        ON CONFLICT (repository_id) DO UPDATE SET
          sweep_scheduled_at = COALESCE(sweep_scheduled_at, excluded.sweep_scheduled_at),
          sweep_started_at = CASE WHEN last_swept_at IS NULL THEN sweep_started_at ELSE COALESCE(sweep_started_at, ?1) END,
          sweep_page = CASE WHEN last_swept_at IS NULL THEN sweep_page ELSE COALESCE(sweep_page, 1) END,
          sweep_cursor = CASE WHEN last_swept_at IS NULL THEN sweep_cursor ELSE COALESCE(sweep_cursor, MAX(0, last_swept_at - ?3)) END`)
      .bind(now, JSON.stringify(repositoryIds), SWEEP_DEFAULTS.skewMs).run(),
    catch: () => new SuspensionNotRecorded(),
  });

/** Records every suspension, then schedules verification. Any failure is a `503`, so the delivery can be redelivered. */
export const applyLifecycleChange = (db: QueryDatabase, change: LifecycleChange, now: number) => Effect.gen(function* () {
  for (const { repositoryId, reason } of change.suspend) yield* suspendRepository(db, repositoryId, reason, now);
  if (change.verify.length > 0) yield* scheduleVerification(db, change.verify, now);
});
