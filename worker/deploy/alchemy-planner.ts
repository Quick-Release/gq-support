import * as Alchemist from "alchemy/Alchemist";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { PlannedRow, StackPlan, StackPlanner } from "./plan-gate.ts";

type Snapshot = Alchemist.StackPlan;

/** The rows the gate reviews: every planned resource and orphan deletion, with its prior state attributes. */
const stackPlan = (snapshot: Snapshot): StackPlan => {
  const nodes = [
    ...Object.values(snapshot.native.resources),
    ...Object.values(snapshot.native.deletions).filter((node) => node !== undefined),
  ];
  return {
    stack: snapshot.stack.name,
    stage: snapshot.stack.stage,
    destroy: snapshot.native.destroy === true,
    resources: nodes.map((node): PlannedRow => ({
      fqn: node.resource.FQN,
      logicalId: node.resource.LogicalId,
      type: node.resource.Type,
      action: node.action,
      attributes: (node.state as { attr?: unknown } | undefined)?.attr as PlannedRow["attributes"],
    })),
    actions: snapshot.actions.map((action) => ({ fqn: action.fqn, type: action.actionType, action: action.action })),
  };
};

/**
 * Progress for CI logs: resource names and statuses only, never notes, which
 * may carry provider output. A plan never bootstraps or upgrades the state
 * store; the gate dies rather than let it.
 */
const progress = (event: Alchemist.Event): Effect.Effect<void> => {
  if (event.type === "state.bootstrap.started") {
    return Effect.die(new Error("Refusing to bootstrap or upgrade the Alchemy state store from the deploy gate"));
  }
  if (event.type === "apply.resource.status") return Effect.sync(() => console.log(`${event.fqn}: ${event.status}`));
  if (event.type === "plan.phase") return Effect.sync(() => console.log(`Plan: ${event.phase}`));
  return Effect.void;
};

/**
 * Alchemy's programmatic plan and apply (alchemy/Alchemist), as `alchemy
 * deploy` runs them, without `--adopt`, `--force`, a resource selection or a
 * state-store upgrade (`updateStateStore` stays false, and the non-interactive
 * layer refuses the store's upgrade prompt). The applied plan is the reviewed
 * snapshot itself, not a second plan.
 */
export const alchemyPlanner: StackPlanner = (stage, review) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stack = yield* Alchemist.importStack("alchemy.run.ts");
      const snapshot = yield* Alchemist.plan({ stack, stage, operation: "deploy", updateStateStore: false });
      if (!(yield* Effect.promise(() => review(stackPlan(snapshot))))) return { applied: false };
      return { applied: true, output: yield* Alchemist.apply(snapshot) };
    }).pipe(
      Alchemist.onEvent(progress),
      Effect.scoped,
      Effect.provide(Alchemist.layer()),
      Effect.tapCause((cause) => Effect.sync(() => {
        const error = Cause.squash(cause);
        console.error(error instanceof Error ? error.message : "Alchemy failed");
      })),
    ),
  );
