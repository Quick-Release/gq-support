import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { QueryDatabase } from "./storage.ts";

export type PhaseOutcome = "ok" | "failed" | "timed_out" | "contained" | "not_run";
export type Phase = "delivery" | "cleanup" | "refresh" | "sweep" | "drain";
export type Phases = Record<Phase, PhaseOutcome>;
export const emptyPhases = (): Phases => ({ delivery: "not_run", cleanup: "not_run", refresh: "not_run", sweep: "not_run", drain: "not_run" });
export interface ProgressIdentity { stage: "staging" | "prod"; candidate: string }
interface Attempt extends ProgressIdentity { cell: number; generation: number; minute: number; attempt: number; started: number }
export const progressIdentity = (stage: unknown, candidate: unknown): ProgressIdentity | null =>
  (stage === "staging" || stage === "prod") && typeof candidate === "string" && /^[a-f0-9]{40}$/.test(candidate) ? { stage, candidate } : null;
const MINUTE = 60_000;
/** One atomic D1 batch. 240 fixed cells, four distinct attempts per scheduled
 * minute. Evicting unresolved/failed evidence latches partial forever. No write
 * grants runtime/provider admission, changes epochs, or repairs SupportDB. */
export async function startProgress(db: QueryDatabase, identity: ProgressIdentity, scheduled: number, started: number): Promise<Attempt | null> {
  if (!progressIdentity(identity.stage, identity.candidate) || !Number.isSafeInteger(scheduled) || scheduled < 0 || !Number.isSafeInteger(started) || started < scheduled) return null;
  const minute = Math.floor(scheduled / MINUTE) * MINUTE;
  const base = (Math.floor(minute / MINUTE) % 60) * 4;
  const results = await db.batch([
    db.prepare(`UPDATE cron_progress_control SET watermark = MAX(watermark, ?), partial = CASE WHEN EXISTS
      (SELECT 1 FROM cron_progress WHERE minute <= ? AND (terminal IS NULL OR outcome != 'settled'
       OR delivery != 'ok' OR cleanup != 'ok' OR refresh != 'ok' OR sweep != 'ok' OR drain NOT IN ('ok', 'not_run')))
      THEN 1 ELSE partial END WHERE id = 1`).bind(minute, minute - 60 * MINUTE),
    db.prepare(`INSERT INTO cron_progress (cell, stage, candidate, generation, minute, attempt, started, delivery, cleanup, refresh, sweep, drain)
      SELECT ? + n - 1, ?, ?, generation, ?, n, ?, 'not_run', 'not_run', 'not_run', 'not_run', 'not_run'
      FROM maintenance_control CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)
      WHERE id = 1 AND ? > (SELECT watermark FROM cron_progress_control WHERE id = 1) - ?
      AND NOT EXISTS (SELECT 1 FROM cron_progress WHERE cell = ? + n - 1 AND minute >= ?)
      ORDER BY n LIMIT 1
      ON CONFLICT(cell) DO UPDATE SET stage = excluded.stage, candidate = excluded.candidate, generation = excluded.generation,
        minute = excluded.minute, attempt = excluded.attempt, started = excluded.started, terminal = NULL, outcome = NULL,
        delivery = 'not_run', cleanup = 'not_run', refresh = 'not_run', sweep = 'not_run', drain = 'not_run'
      WHERE cron_progress.minute < excluded.minute RETURNING cell, generation, minute, attempt, started`)
      .bind(base, identity.stage, identity.candidate, minute, started, minute, 60 * MINUTE, base, minute),
  ]);
  const row = results[1]?.results?.[0] as Omit<Attempt, keyof ProgressIdentity> | undefined;
  if (!row) {
    await db.prepare("UPDATE cron_progress_control SET partial = 1 WHERE id = 1").run();
    return null;
  }
  return { ...identity, ...row };
}
/** Compare the complete immutable owner, never upsert. A late phase cannot
 * overwrite terminal, another attempt, candidate, or maintenance generation. */
export async function writeProgress(db: QueryDatabase, owner: Attempt, phases: Phases,
  terminal: number | null = null, outcome: "settled" | "failed" | "interrupted" | null = null) {
  const result = await db.prepare(`UPDATE cron_progress SET delivery = CASE WHEN delivery = 'not_run' THEN ? ELSE delivery END, cleanup = CASE WHEN cleanup = 'not_run' THEN ? ELSE cleanup END, refresh = CASE WHEN refresh = 'not_run' THEN ? ELSE refresh END, sweep = CASE WHEN sweep = 'not_run' THEN ? ELSE sweep END, drain = CASE WHEN drain = 'not_run' THEN ? ELSE drain END, terminal = ?, outcome = ?
    WHERE cell = ? AND stage = ? AND candidate = ? AND generation = ? AND minute = ? AND attempt = ? AND started = ? AND terminal IS NULL
    AND minute > (SELECT watermark FROM cron_progress_control WHERE id = 1) - 3600000
    AND generation = (SELECT generation FROM maintenance_control WHERE id = 1) RETURNING cell`)
    .bind(phases.delivery, phases.cleanup, phases.refresh, phases.sweep, phases.drain, terminal, outcome,
      owner.cell, owner.stage, owner.candidate, owner.generation, owner.minute, owner.attempt, owner.started).first();
  if (!result) throw new Error("progress unavailable");
}
/** Promise interruption cannot cancel already dispatched D1. Late writes remain
 * fenced by SQL. At most 100ms cooperative overhead per observation; no recovery
 * obstruction, retry, or support work is attached to these independent writes. */
export const progressIO = <A>(write: () => Promise<A>) => Effect.tryPromise({ try: write, catch: () => null }).pipe(
  Effect.timeoutOption(100), Effect.catchCause(() => Effect.succeed(Option.none<A>())),
  Effect.flatMap((result) => Option.isSome(result) && result.value !== null
    ? Effect.succeed(result.value) : Effect.logError("Support Cron progress unavailable").pipe(Effect.as(null))),
);
