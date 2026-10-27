import * as Effect from "effect/Effect";
import { productionEndpointContract, refusal } from "./planning-state.ts";

// No immutable production endpoint manifest is supplied. Refuse BEFORE
// opening credentials/network/stack; other integration gates remain incomplete.
// The separate offline runtime never imports declarations in this launcher.
export const protectedPlanningEntry = (_credentialFile: string): Effect.Effect<never> =>
  Effect.die(refusal());

export const planningPrerequisites = Object.freeze({
  endpointContract: productionEndpointContract,
  status: "blocked: reviewed endpoint metadata, authenticated retained-process continuation, writer exclusion and live runtime verification required",
});
