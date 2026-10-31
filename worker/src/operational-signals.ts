import { observeIncident } from "./incidents.ts";
import { SIGNALS, type Signal, type SignalCategory } from "./signal-rules.ts";
import type { QueryDatabase } from "./storage.ts";

type Cause = { subject: string; slots: string[]; detail: string | null };
type Row = { subject: string; slot: string | null; detail: string | null };

/** Groups one rule's rows by cause, keeping each cause's furthest detail. */
const causesOf = (signal: Signal, rows: readonly Row[]): Cause[] => {
  const causes = new Map<string, { slots: Set<string>; detail: string | null }>();
  const rank = (detail: string | null) => detail === null ? -1 : signal.details?.indexOf(detail) ?? -1;
  for (const row of rows) {
    const cause = causes.get(row.subject) ?? { slots: new Set<string>(), detail: null };
    if (row.slot !== null) cause.slots.add(row.slot);
    if (rank(row.detail) > rank(cause.detail)) cause.detail = row.detail;
    causes.set(row.subject, cause);
  }
  return [...causes].map(([subject, { slots, detail }]) => ({ subject, slots: [...slots], detail }));
};

/**
 * Records every cause each rule observes now as one grouped incident per
 * category and cause. A failing rule, or a cause that fails to record, does
 * not stop the others.
 *
 * The rules' reads are independent, so they go to D1 together: one roundtrip
 * of wall time instead of one per rule, which a distant database cannot fit
 * in the signal phase's bound. Incident writes stay one at a time, taking one
 * cause of each rule before any rule's next, so no rule's many causes hold
 * back another rule's first.
 */
export const observeSignals = async (db: QueryDatabase, now: number): Promise<void> => {
  const rules = Object.entries(SIGNALS) as [SignalCategory, Signal][];
  const reads = await Promise.allSettled(rules.map(async ([, signal]) =>
    db.prepare(`SELECT subject, slot, detail FROM (${signal.affected(now)}) ORDER BY subject`).bind().all<Row>()));
  // The next tick observes again; no rule's failure hides another's.
  const observed = rules.map(([category, signal], index) => {
    const read = reads[index]!;
    return read.status === "fulfilled" ? causesOf(signal, read.value.results).map((cause) => ({ category, ...cause })) : [];
  });
  for (let round = 0; observed.some((causes) => round < causes.length); round++) {
    for (const causes of observed) {
      const cause = causes[round];
      if (!cause) continue;
      try {
        await db.batch(observeIncident(db, { ...cause, now }));
      } catch {
        // Observed again next tick.
      }
    }
  }
};
