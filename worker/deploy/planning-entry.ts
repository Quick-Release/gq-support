import * as Effect from "effect/Effect";
import { supportStack } from "../support-stack.ts";
import { acquireHttpSnapshot, productionEndpointContract, refusal, snapshotLayer } from "./planning-state.ts";

// Not a deployable CLI entry: no supplied immutable endpoint manifest or live
// identity verifier exists. Refuse BEFORE opening credentials/network/stack.
// The factory seam below is independently testable, but cannot authorize a run.
export const protectedPlanningEntry = (_credentialFile: string): Effect.Effect<never> =>
  Effect.die(refusal());

export const planningStackFromSnapshot = (
  snapshot: Effect.Success<ReturnType<typeof acquireHttpSnapshot>>,
) => supportStack(snapshotLayer(snapshot), "planning");

export const planningPrerequisites = Object.freeze({
  endpointContract: productionEndpointContract,
  status: "blocked: endpoint identity, provider confinement, approval and writer-exclusion adapters required",
});
