import { observeIncident } from "./incidents.ts";
import { SIGNALS, type Signal, type SignalCategory } from "./signal-rules.ts";
import type { QueryDatabase } from "./storage.ts";

/**
 * Records every cause each rule observes now as one grouped incident per
 * category and cause. A failing rule does not stop the others.
 */
export const observeSignals = async (db: QueryDatabase, now: number): Promise<void> => {
  for (const [category, signal] of Object.entries(SIGNALS) as [SignalCategory, Signal][]) {
    try {
      const rows = (await db.prepare(`SELECT subject, slot, detail FROM (${signal.affected(now)}) ORDER BY subject`)
        .bind().all<{ subject: string; slot: string | null; detail: string | null }>()).results;
      const causes = new Map<string, { slots: Set<string>; detail: string | null }>();
      const rank = (detail: string | null) => detail === null ? -1 : signal.details?.indexOf(detail) ?? -1;
      for (const row of rows) {
        const cause = causes.get(row.subject) ?? { slots: new Set<string>(), detail: null };
        if (row.slot !== null) cause.slots.add(row.slot);
        if (rank(row.detail) > rank(cause.detail)) cause.detail = row.detail;
        causes.set(row.subject, cause);
      }
      for (const [subject, { slots, detail }] of causes) {
        await db.batch(observeIncident(db, { category, subject, slots: [...slots], now, detail }));
      }
    } catch {
      // The next tick observes again; no rule's failure hides another's.
    }
  }
};
