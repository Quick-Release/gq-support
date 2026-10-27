// Process-local, revocable, one-shot phase gate. This is mechanism, not human
// authorization. Only the retained runtime opens it after the trusted launcher
// has authenticated approval and independently revalidated all evidence.
import * as Effect from "effect/Effect";
import { requireEvidence, refusal } from "./planning-state.ts";
export function planningApplyCapability() {
  let phase: "planning" | "applying" | "closed" = "planning";
  return Object.freeze({
    check: () => { requireEvidence(phase === "applying"); },
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.suspend(() => {
      requireEvidence(phase === "planning");
      phase = "applying";
      return effect.pipe(Effect.ensuring(Effect.sync(() => { phase = "closed"; })));
    }),
    revoke: () => { phase = "closed"; },
    denied: () => Effect.die(refusal()),
  });
}
export type PlanningApplyCapability = ReturnType<typeof planningApplyCapability>;
