import * as Effect from "effect/Effect";
import { restoreGate } from "./ledger.ts";
import type { QueryDatabase } from "./storage.ts";

/** No expiry: an interrupted isolate must never silently count as drained. */
export const admitOperation = async (ledger: QueryDatabase, kind: "runtime" | "provider", target?: string): Promise<string | null> => {
  const id = crypto.randomUUID();
  const row = await ledger.prepare(`INSERT INTO maintenance_operation (id, kind, generation, started_at, target)
    SELECT ?, ?, generation, ?, ? FROM maintenance_control WHERE id = 1 AND mode = 'open' RETURNING id`)
    .bind(id, kind, Date.now(), target ?? null).first<{ id: string }>();
  return row?.id ?? null;
};
export const finishOperation = async (ledger: QueryDatabase, id: string) => {
  await ledger.prepare("DELETE FROM maintenance_operation WHERE id = ?").bind(id).run();
};

/** Covers ingress, Cron and each independently started background task. Errors
 * and interruption leave an obstruction. Provider attempts have separate rows:
 * a caught timeout must not make the enclosing runtime look remotely drained. */
export const contained = <A, E, R>(main: QueryDatabase, ledger: QueryDatabase, work: Effect.Effect<A, E, R>, denied: A) =>
  Effect.gen(function* () {
    const id = yield* Effect.promise(() => admitOperation(ledger, "runtime").catch(() => null));
    if (!id) return denied;
    if (!(yield* Effect.promise(() => restoreGate()(main, ledger, Date.now())))) {
      yield* Effect.promise(() => finishOperation(ledger, id));
      return denied;
    }
    // The registration is durable before work starts; containment waits for it.
    const result = yield* work;
    yield* Effect.promise(() => finishOperation(ledger, id));
    return result;
  });
