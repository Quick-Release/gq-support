import * as Effect from "effect/Effect";
import { supportStack } from "../support-stack.ts";
import { acquireHttpSnapshot, productionEndpointContract, refusal, snapshotLayer } from "./planning-state.ts";

// No immutable production endpoint manifest is supplied. Refuse BEFORE
// opening credentials/network/stack; other integration gates remain incomplete.
// The factory seam below is independently testable, but cannot authorize a run.
export const protectedPlanningEntry = (_credentialFile: string): Effect.Effect<never> =>
  Effect.die(refusal());

export const planningStackFromSnapshot = (
  snapshot: Effect.Success<ReturnType<typeof acquireHttpSnapshot>>,
) => supportStack(snapshotLayer(snapshot), "planning");

export const planningPrerequisites = Object.freeze({
  endpointContract: productionEndpointContract,
  status: "blocked: reviewed endpoint metadata, provider confinement, approval and writer-exclusion adapters required",
});
